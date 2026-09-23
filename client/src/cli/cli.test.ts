/**
 * The headless client, end to end.
 *
 * Two directories on a real disk, a real Go server, and the CLI driven the way a
 * person drives it: pair, invite, sync. Nothing is in memory here and nothing is
 * stubbed, so what this covers is the whole client except the terminal.
 *
 * The engine tests use in-memory vaults, which is what makes them fast enough to
 * run a mutation pass over. This is the other half: it is the one that would
 * notice if the filesystem adapter, the config on disk, the invite or the
 * argument parsing were wrong, none of which those tests touch.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { cleanupBinary, removeTree, serverBinary, TestServer } from "../core/test-server.ts";
import { MAX_NAME_BYTES, ProtocolError, Transport, checkName } from "../core/transport.ts";
import { base64urlDecode, base64urlEncode } from "../core/digest.ts";
import { formatInviteString } from "../core/invite-string.ts";
import {
  generateDeviceId,
  generateDeviceToken,
  isPendingPairing,
  parseInvite,
  startPairing,
} from "../core/pairing.ts";
import type { SyncReport } from "../core/engine.ts";
import { loadConfig, saveConfig } from "./config.ts";
import {
  deviceNameFor,
  run,
  exitCodeFor,
  normaliseUrl,
  parseArgs,
  renderReport,
  USAGE,
  type Console,
} from "./cli.ts";
import { NodeVault } from "./vault.ts";

beforeAll(async () => {
  await serverBinary();
}, 180_000);

afterAll(async () => {
  await cleanupBinary();
});

/** Captures what the CLI printed, and what it exited with. */
class Run {
  readonly out: string[] = [];
  readonly err: string[] = [];
  code = -1;

  get stdout(): string {
    return this.out.join("\n");
  }
  get stderr(): string {
    return this.err.join("\n");
  }
  get all(): string {
    return this.stdout + "\n" + this.stderr;
  }
  json(): Record<string, unknown> {
    return JSON.parse(this.stdout) as Record<string, unknown>;
  }
}

async function cli(...argv: string[]): Promise<Run> {
  const r = new Run();
  const io: Console = { out: (l) => r.out.push(l), err: (l) => r.err.push(l) };
  r.code = await run(argv, io);
  return r;
}

let server: TestServer;
const dirs: string[] = [];

async function vaultDir(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `trew-${name}-`));
  dirs.push(dir);
  return dir;
}

async function fresh(): Promise<void> {
  server = new TestServer();
  await server.start();
}

afterEach(async () => {
  // Retried, because `rm` lists a directory and then removes it, and with
  // twenty-one test files running at once against the same /tmp it can find
  // the directory repopulated in between and throw ENOTEMPTY. Node retries
  // that error specifically when asked to. It showed up once in twelve full
  // runs, on `.trew`.
  //
  // This is not covering for a write that outlived the command, which was the
  // first suspicion and would have been a real bug. save() is awaited, the
  // sync is awaited before close(), close() is synchronous, and neither the
  // CLI nor the engine leaves anything running. Nothing of ours is still
  // writing by the time this runs.
  while (dirs.length) await removeTree(dirs.pop()!);
  if (server) await server.cleanup();
});

/**
 * Pairs a directory as the vault's first device, from the invite `trew serve`
 * wrote to `<data>/first-invite`, which is how a first device pairs.
 */
async function firstDevice(name = "a"): Promise<string> {
  const dir = await vaultDir(name);
  const invite = await server.firstInvite();
  const paired = await cli("pair", invite, "--dir", dir, "--device", name, "--json");
  expect(paired.code, paired.all).toBe(0);
  return dir;
}

/** An invite minted by a paired device, as `trew invite --json` hands it over. */
async function inviteFrom(dir: string): Promise<string> {
  const issued = await cli("invite", "--dir", dir, "--json");
  expect(issued.code, issued.all).toBe(0);
  return issued.json()["invite"] as string;
}

/** Pairs two directories against the running server and returns them. */
async function twoDevices(): Promise<{ a: string; b: string }> {
  const a = await firstDevice("a");
  const b = await vaultDir("b");
  const paired = await cli("pair", await inviteFrom(a), "--dir", b, "--device", "b", "--json");
  expect(paired.code, paired.all).toBe(0);
  return { a, b };
}

/**
 * Redeems an invite over the wire and then never connects as the device, which
 * is what a pairing interrupted after the server answered leaves on the server:
 * a row, with a token nothing holds any more.
 */
async function redeemAndVanish(invite: string, device: string): Promise<string> {
  const parsed = parseInvite(invite);
  const deviceId = generateDeviceId();
  const transport = new Transport(parsed.url, { onBatch: () => {}, timeoutMs: 15_000 });
  try {
    await transport.connect();
    await transport.redeem({
      vault: parsed.vault,
      device,
      invite: base64urlEncode(parsed.token),
      deviceId,
      token: generateDeviceToken(),
    });
  } finally {
    transport.close();
  }
  return deviceId;
}

/**
 * A redemption with `token` as its invite, asked over the wire and answered.
 *
 * What a person holding only what a listing shows could try, which is the only
 * way to prove a listed field redeems nothing: looking at it proves nothing.
 */
async function redeemWith(url: string, vault: string, token: string): Promise<unknown> {
  const transport = new Transport(url, { onBatch: () => {}, timeoutMs: 15_000 });
  try {
    await transport.connect();
    await transport.redeem({
      vault,
      device: "prober",
      invite: token,
      deviceId: generateDeviceId(),
      token: generateDeviceToken(),
    });
    return "redeemed";
  } catch (err) {
    return err;
  } finally {
    transport.close();
  }
}

/**
 * A TCP relay in front of the server that can lose the server's answer to a
 * redemption, which is the lost reply protocol.md's "Invite redemption" is
 * written around.
 *
 * `losing` set: everything the device sends reaches the server, the server's
 * WebSocket upgrade reaches the device, and the first frame after it, which is
 * `redeemed`, is dropped and the device's connection closed. So the server has
 * committed the redemption and the device has heard nothing, exactly as when a
 * reply is lost in flight. `losing` clear: a plain relay.
 */
class LossyRelay {
  losing = true;
  private readonly net: Server;
  private readonly open = new Set<Socket>();
  port = 0;

  constructor(private readonly upstream: number) {
    this.net = createServer((device) => this.relay(device));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.net.listen(0, "127.0.0.1", resolve));
    const address = this.net.address();
    this.port = typeof address === "object" && address !== null ? address.port : 0;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  private relay(device: Socket): void {
    const server = connect(this.upstream, "127.0.0.1");
    this.open.add(device).add(server);
    const losing = this.losing;
    let upgraded = false;
    let head = "";
    device.pipe(server);
    server.on("data", (chunk: Buffer) => {
      if (!losing) {
        device.write(chunk);
        return;
      }
      if (upgraded) {
        // The answer to the redemption. Never delivered.
        device.destroy();
        server.destroy();
        return;
      }
      device.write(chunk);
      head += chunk.toString("latin1");
      upgraded = head.includes("\r\n\r\n");
    });
    const end = () => {
      device.destroy();
      server.destroy();
    };
    device.on("close", end).on("error", end);
    server.on("close", end).on("error", end);
  }

  async stop(): Promise<void> {
    for (const socket of this.open) socket.destroy();
    await new Promise<void>((resolve) => this.net.close(() => resolve()));
  }
}

const read = (dir: string, path: string) => readFile(join(dir, path), "utf8");
const write = async (dir: string, path: string, text: string) => {
  await mkdir(join(dir, path, ".."), { recursive: true });
  await writeFile(join(dir, path), text);
};

describe("pairing a vault", () => {
  /**
   * cli.test.ts:160 in the ledger (SPLIT). Both ends agree about the vault
   * and have their own names; what they no longer share is a secret. Each
   * holds its own row id and its own token, and nothing that opens the other.
   */
  it("pairs a second device from the invite the first one printed", async () => {
    await fresh();
    const { a, b } = await twoDevices();

    const configA = JSON.parse(await read(a, ".trew/config.json")) as Record<string, string>;
    const configB = JSON.parse(await read(b, ".trew/config.json")) as Record<string, string>;
    expect(configB["url"]).toBe(configA["url"]);
    expect(configB["vaultId"]).toBe(configA["vaultId"]);
    expect(configB["device"]).toBe("b");
    expect(configA["device"]).toBe("a");
    // Two credentials, not one shared between them.
    expect(configB["deviceId"]).not.toBe(configA["deviceId"]);
    expect(configB["deviceToken"]).not.toBe(configA["deviceToken"]);
    // And a finished pairing keeps no invite: the one it redeemed is spent.
    expect(configA["invite"]).toBeUndefined();
    expect(configB["invite"]).toBeUndefined();
  }, 240_000);

  /**
   * cli.test.ts:173 in the ledger (SPLIT). `pair` takes the invite exactly as
   * it was handed over: the first device's straight out of the file serve
   * wrote, trailing newline and all, and a later one as `trew invite` on the
   * server prints it, indented inside its sentence.
   */
  it("takes the invite as serve wrote it and as trew invite printed it", async () => {
    await fresh();
    const a = await vaultDir("a");
    const first = await cli("pair", "--key-file", server.firstInvitePath, "--dir", a, "--json");
    expect(first.code, first.all).toBe(0);
    const config = JSON.parse(await read(a, ".trew/config.json")) as Record<string, string>;
    expect(config["url"]).toBe(server.wsUrl);

    const printed = await server.cli("invite");
    const line = printed.split("\n").find((l) => l.includes("trew1i_"));
    expect(line, printed).toMatch(/^\s+trew1i_/);
    const b = await vaultDir("b");
    const second = await cli("pair", line!, "--dir", b, "--json");
    expect(second.code, second.all).toBe(0);
    expect((await cli("sync", "--dir", b)).code).toBe(0);
  }, 240_000);

  it("keeps the credential out of everybody else's reach", async () => {
    // It connects as this device, and so reads the whole vault. A config that
    // lands world-readable in a shared home directory is the quiet way to lose
    // one.
    await fresh();
    const { a } = await twoDevices();
    const mode = (await stat(join(a, ".trew", "config.json"))).mode & 0o777;
    expect(mode.toString(8)).toBe("600");
  }, 240_000);

  /**
   * Pairing over a paired vault would replace this device's credential, the
   * only copy of its row's token, and strand that row on the server with
   * nothing here left to revoke it. So it is refused, and the config is left
   * exactly as it was.
   */
  it("refuses to pair a vault that is already paired", async () => {
    await fresh();
    const { a, b } = await twoDevices();
    const before = await read(b, ".trew/config.json");
    const again = await cli("pair", await inviteFrom(a), "--dir", b);
    expect(again.code).toBe(1);
    expect(again.all).toMatch(/already paired/);
    expect(await read(b, ".trew/config.json"), "the refusal rewrote the config").toBe(before);
  }, 240_000);

  it("refuses an invite that was mangled on the way", async () => {
    await fresh();
    const a = await firstDevice();
    const invite = await inviteFrom(a);
    const c = await vaultDir("c");

    const truncated = await cli("pair", invite.slice(0, -4), "--dir", c);
    expect(truncated.code).toBe(1);
    expect(truncated.all).toMatch(/damaged|too short/);

    // Somebody's Basalt string, named as that rather than as a damaged invite.
    const basalt = await cli("pair", "basalt3i_somethingfromtheoldplugin", "--dir", c);
    expect(basalt.code).toBe(1);
    expect(basalt.all).toMatch(/Basalt string/);

    const nonsense = await cli("pair", "have-a-nice-day", "--dir", c);
    expect(nonsense.code).toBe(1);
    expect(nonsense.all).toMatch(/trew1i_/);

    // And nothing was written, so a failed pair leaves no half-configured vault.
    await expect(read(c, ".trew/config.json")).rejects.toThrow();
    // Nothing reached the server either: the invite still works.
    expect((await cli("pair", invite, "--dir", c)).code).toBe(0);
  }, 240_000);

  /**
   * The first-invite file holds one line per address serve found, all one
   * invite. Handed over whole, that is several invites in one string, and the
   * codec's answer to it would be "damaged", which sends somebody looking for
   * a copying mistake that was not made.
   */
  it("says which line to use when handed a file of invites", async () => {
    await fresh();
    const one = await server.firstInvite();
    const parsed = parseInvite(one);
    const other = formatInviteString({ ...parsed, url: "ws://192.0.2.1:3003" });
    const file = join(await vaultDir("lines"), "first-invite");
    await writeFile(file, `${one}\n${other}\n`);
    const a = await vaultDir("a");
    const r = await cli("pair", "--key-file", file, "--dir", a);
    expect(r.code, r.all).toBe(1);
    expect(r.all).toMatch(/2 invites/);
    expect(r.all).toMatch(/one line/);
    await expect(read(a, ".trew/config.json")).rejects.toThrow();
  }, 240_000);
});

describe("syncing real files on a real disk", () => {
  it("carries a vault from one directory to another", async () => {
    await fresh();
    const { a, b } = await twoDevices();

    await write(a, "note.md", "# Hello\n\nFrom device a.\n");
    await write(a, "folder/deep/nested.md", "Nested.\n");
    await writeFile(join(a, "picture.bin"), Buffer.from([0, 1, 2, 253, 254, 255]));

    const up = await cli("sync", "--dir", a, "--json");
    expect(up.code, up.all).toBe(0);
    // Three files and the two folders above them. Folders are entries of
    // their own, which is what lets an empty one exist on both devices.
    expect(up.json()["uploaded"], up.all).toBe(5);

    const down = await cli("sync", "--dir", b, "--json");
    expect(down.code, down.all).toBe(0);
    expect(down.json()["downloaded"], down.all).toBe(3);
    expect(down.json()["foldersCreated"], down.all).toBe(2);

    expect(await read(b, "note.md")).toBe("# Hello\n\nFrom device a.\n");
    expect(await read(b, "folder/deep/nested.md")).toBe("Nested.\n");
    expect([...(await readFile(join(b, "picture.bin")))]).toEqual([0, 1, 2, 253, 254, 255]);
  }, 300_000);

  it("says there is nothing to do when there is nothing to do", async () => {
    await fresh();
    const { a, b } = await twoDevices();
    await write(a, "note.md", "one\n");
    await cli("sync", "--dir", a);
    await cli("sync", "--dir", b);

    const again = await cli("sync", "--dir", b);
    expect(again.code).toBe(0);
    expect(again.stdout).toMatch(/Nothing to do/);
  }, 300_000);

  /**
   * The debounce holds back a file written moments ago, which is right for a
   * client that stays running and wrong for one that exits: there is no next
   * pass, so "unchanged" would mean "silently skipped the file you just saved".
   */
  it("syncs a file saved a second ago rather than deferring it", async () => {
    await fresh();
    const { a, b } = await twoDevices();
    await write(a, "just-typed.md", "written right now\n");

    const up = await cli("sync", "--dir", a, "--json");
    expect(up.json()["uploaded"], up.all).toBe(1);
    expect(up.json()["waiting"]).toBe(0);

    await cli("sync", "--dir", b);
    expect(await read(b, "just-typed.md")).toBe("written right now\n");
  }, 300_000);

  it("carries an edit back the other way", async () => {
    await fresh();
    const { a, b } = await twoDevices();
    await write(a, "note.md", "first\n");
    await cli("sync", "--dir", a);
    await cli("sync", "--dir", b);

    await write(b, "note.md", "second\n");
    await cli("sync", "--dir", b);
    const back = await cli("sync", "--dir", a, "--json");
    expect(back.json()["downloaded"], back.all).toBe(1);
    expect(await read(a, "note.md")).toBe("second\n");
  }, 300_000);

  it("carries a deletion", async () => {
    await fresh();
    const { a, b } = await twoDevices();
    await write(a, "doomed.md", "here for now\n");
    await cli("sync", "--dir", a);
    await cli("sync", "--dir", b);
    expect(await read(b, "doomed.md")).toBe("here for now\n");

    await rm(join(a, "doomed.md"));
    await cli("sync", "--dir", a);
    const gone = await cli("sync", "--dir", b, "--json");
    expect(gone.json()["deletedLocally"], gone.all).toBe(1);
    await expect(read(b, "doomed.md")).rejects.toThrow();
  }, 300_000);

  it("cuts the deleted list to --limit and says there is more", async () => {
    // --limit was passed through only above 20, so `--limit 1` showed every
    // deletion and the "older deletions" line never appeared.
    await fresh();
    const { a } = await twoDevices();
    for (const name of ["one.md", "two.md", "three.md"]) await write(a, name, `${name}\n`);
    await cli("sync", "--dir", a);
    for (const name of ["one.md", "two.md", "three.md"]) await rm(join(a, name));
    await cli("sync", "--dir", a);

    const all = await cli("deleted", "--dir", a, "--json");
    expect((all.json()["deleted"] as unknown[]).length, all.all).toBe(3);
    expect(all.json()["more"]).toBe(false);

    const one = await cli("deleted", "--dir", a, "--limit", "1", "--json");
    expect((one.json()["deleted"] as unknown[]).length, one.all).toBe(1);
    expect(one.json()["more"]).toBe(true);

    const plain = await cli("deleted", "--dir", a, "--limit", "1");
    expect(plain.stdout).toMatch(/older deletions/);
  }, 300_000);

  /**
   * Rule 10 of docs/design.md: the property is not that the devices agree,
   * it is that neither edit was lost. Both are asserted by name.
   */
  it("keeps both versions when two devices rewrite the same line", async () => {
    await fresh();
    const { a, b } = await twoDevices();
    await write(a, "note.md", "# Note\n\nThe original sentence.\n");
    await cli("sync", "--dir", a);
    await cli("sync", "--dir", b);

    await write(a, "note.md", "# Note\n\nA's completely different sentence.\n");
    await write(b, "note.md", "# Note\n\nB's entirely other sentence.\n");
    await cli("sync", "--dir", a);
    const conflict = await cli("sync", "--dir", b, "--json");
    expect(conflict.json()["conflicted"], conflict.all).toBe(1);
    await cli("sync", "--dir", a);
    await cli("sync", "--dir", b);

    const { readdir } = await import("node:fs/promises");
    for (const dir of [a, b]) {
      const names = await readdir(dir);
      const texts = await Promise.all(
        names.filter((n) => n.endsWith(".md")).map((n) => read(dir, n)),
      );
      const all = texts.join("\n---\n");
      expect(all, `${dir} lost A's version`).toContain("A's completely different sentence");
      expect(all, `${dir} lost B's version`).toContain("B's entirely other sentence");
      expect(
        names.some((n) => n.includes("Conflicted copy")),
        `${dir} has no conflict copy`,
      ).toBe(true);
    }
  }, 300_000);

  it("merges edits to different parts of one note", async () => {
    await fresh();
    const { a, b } = await twoDevices();
    const base = [
      "# Note",
      "",
      "First paragraph.",
      "",
      "Second paragraph.",
      "",
      "Third paragraph.",
    ].join("\n");
    await write(a, "note.md", base);
    await cli("sync", "--dir", a);
    await cli("sync", "--dir", b);

    await write(a, "note.md", base.replace("First paragraph.", "First paragraph, edited on A."));
    await write(b, "note.md", base.replace("Third paragraph.", "Third paragraph, edited on B."));
    await cli("sync", "--dir", a);
    await cli("sync", "--dir", b);
    await cli("sync", "--dir", a);

    for (const dir of [a, b]) {
      const text = await read(dir, "note.md");
      expect(text, `${dir} lost A's edit`).toContain("edited on A");
      expect(text, `${dir} lost B's edit`).toContain("edited on B");
    }
  }, 300_000);

  it("leaves its own state folder out of the vault it syncs", async () => {
    // .trew holds this device's credential. Syncing it would hand every
    // device the token that connects as this one, and revoking this device
    // would then stop nothing.
    await fresh();
    const { a, b } = await twoDevices();
    await write(a, "note.md", "x\n");
    await cli("sync", "--dir", a);
    await cli("sync", "--dir", b);

    const configB = JSON.parse(await read(b, ".trew/config.json")) as Record<string, string>;
    expect(configB["device"]).toBe("b");
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(join(b, ".trew"))).not.toContain("config.json.tmp");
  }, 300_000);
});

describe("status", () => {
  it("says where things stand, and admits when it cannot tell", async () => {
    await fresh();
    const { a } = await twoDevices();
    await write(a, "one.md", "1\n");
    await write(a, "two.md", "2\n");
    await cli("sync", "--dir", a);

    const ok = await cli("status", "--dir", a, "--json");
    expect(ok.code, ok.all).toBe(0);
    const s = ok.json();
    expect(s["tracked"]).toBe(2);
    expect(s["device"]).toBe("a");
    expect((s["server"] as Record<string, unknown>)["reachable"]).toBe(true);
    expect((s["server"] as Record<string, unknown>)["behind"]).toBe(0);

    // And with the server gone it says so rather than reporting up to date,
    // which is rule 7: a status that cannot tell must not pretend.
    await server.cleanup();
    const down = await cli("status", "--dir", a, "--json");
    expect(down.code).toBe(1);
    expect((down.json()["server"] as Record<string, unknown>)["reachable"]).toBe(false);

    const human = await cli("status", "--dir", a);
    expect(human.stdout).toMatch(/cannot reach the server/);
    expect(human.stdout).not.toMatch(/up to date/);
  }, 300_000);

  /**
   * R1. Status asks for one number and closes, so it connects only as far as
   * the handshake. The number has to stay the server's own: a device that has
   * never synced has the whole vault as backlog, and reading the cursor off
   * its own index instead would print zero and call it up to date.
   */
  it("reports the server's cursor from a device that has not caught up (R1)", async () => {
    await fresh();
    const { a, b } = await twoDevices();
    await write(a, "one.md", "1\n");
    await write(a, "two.md", "2\n");
    await write(a, "three.md", "3\n");
    await cli("sync", "--dir", a);

    const s = await cli("status", "--dir", b, "--json");
    expect(s.code, s.all).toBe(0);
    const server_ = s.json()["server"] as Record<string, unknown>;
    expect(server_["reachable"]).toBe(true);
    expect(server_["cursor"]).toBe(3);
    expect(s.json()["cursor"]).toBe(0);
    expect(server_["behind"]).toBe(3);
    // And it stayed a question: nothing of the backlog was written here.
    expect((await readdir(b)).sort()).toEqual([".trew"]);
  }, 300_000);

  /**
   * The cursor says what has been seen, not what has been applied.
   *
   * A path that is a file here and a folder on the other device is applied by
   * nobody and never will be, and the cursor moves past it regardless. Status
   * printed "1 files with work outstanding" and "up to date with the server"
   * on the same screen, and the second line is the one people read. Rule 7:
   * "everything is here" and "everything I chose to look at is here" have to
   * read differently.
   */
  it("does not call a vault up to date while work is outstanding", async () => {
    await fresh();
    const { a, b } = await twoDevices();
    await write(a, "thing.md", "a file on a\n");
    await cli("sync", "--dir", a);
    await cli("sync", "--dir", b);

    // The same name, a folder on a. b can never apply it: it holds the file.
    await rm(join(a, "thing.md"));
    await mkdir(join(a, "thing.md"), { recursive: true });
    await write(a, "thing.md/inner.md", "inside\n");
    for (let i = 0; i < 3; i++) await cli("sync", "--dir", a);
    for (let i = 0; i < 3; i++) await cli("sync", "--dir", b);

    const s = await cli("status", "--dir", b, "--json");
    expect((s.json()["server"] as Record<string, unknown>)["behind"]).toBe(0);
    expect(s.json()["pending"]).toBeGreaterThan(0);

    const human = await cli("status", "--dir", b);
    expect(human.stdout, human.all).toMatch(/work outstanding/);
    expect(human.stdout, human.all).not.toMatch(/up to date/);
  }, 300_000);

  /**
   * N3. A server that answers and will not have this device is not a server
   * that is down, and the two used to land in the same field. After a restore
   * from an older backup that is the difference between "the box is off" and
   * "the box is up and has lost history", and a cron job keying on
   * `reachable` read the second as the first.
   */
  /**
   * Rule 7, and the third state this field has to keep apart from the other
   * two (cli.test.ts:552 in the ledger, SPLIT). A pairing that has not
   * finished has asked nothing of the server that has been answered, so it is
   * neither reachable nor refused, and reporting either would be a status
   * about a connection that was never made. "Not authorised" in particular
   * sends somebody hunting a server problem that is not there.
   *
   * The pending pairing is written as `pairWithInvite` writes it before it
   * sends anything, for a real invite that is still outstanding.
   */
  it("says a pairing has not finished, rather than blaming the server", async () => {
    await fresh();
    const a = await firstDevice();
    const dir = await vaultDir("pending");
    await saveConfig(dir, startPairing(parseInvite(await inviteFrom(a)), "pending"));

    const s = await cli("status", "--dir", dir, "--json");
    expect(s.code, s.all).toBe(1);
    const answer = s.json()["server"] as Record<string, unknown>;
    expect(answer["reachable"], s.all).toBe(false);
    expect(answer["refused"], s.all).toBe(false);
    expect(String(answer["error"])).toMatch(/has not finished/);
    expect(String(answer["error"]), "the way to finish it was not named").toMatch(/trew pair/);

    // And it says the same thing in words, with the way out named.
    const human = await cli("status", "--dir", dir);
    expect(human.code).toBe(1);
    expect(human.all).toMatch(/has not finished/);
    expect(human.all).toMatch(/trew pair/);
    expect(human.all, "a pending pairing was reported as an outage").not.toMatch(
      /cannot reach the server/,
    );
    expect(human.all, "a pending pairing was reported as refused").not.toMatch(/refused/);

    // Every other command that would connect says it too, and connects as
    // nobody: the pairing is still exactly as it was saved.
    const saved = await read(dir, ".trew/config.json");
    for (const command of [
      ["sync"],
      ["devices"],
      ["invite"],
      ["preview"],
      ["repair"],
      ["deleted"],
      ["history", "note.md"],
      ["restore", "note.md"],
      ["rename", "other"],
      ["revoke", "some-device"],
      ["uninvite", "some-invite"],
    ]) {
      const r = await cli(...command, "--dir", dir);
      expect(r.code, `${command[0]}: ${r.all}`).toBe(1);
      expect(r.all, command[0]).toMatch(/has not finished/);
      expect(r.all, command[0]).toMatch(/trew pair/);
      expect(r.all, command[0]).not.toMatch(/not authorised/);
    }
    expect(await read(dir, ".trew/config.json"), "a refusal changed the pairing").toBe(saved);
  }, 120_000);

  /**
   * The other half, and the one the words have to get right (cli.test.ts:588
   * in the ledger, GUARANTEE): a config with an id and no token is nothing
   * this client can finish, so it says how to pair rather than how to retry,
   * and names the half that is missing.
   */
  it("tells a device with no credential at all to pair again", async () => {
    await fresh();
    const dir = await firstDevice();
    const held = (await loadConfig(dir))!;
    // A credential half written: an id and nothing to prove it with. Nothing
    // here writes this, and a hand-edited config can hold it.
    await saveConfig(dir, {
      url: held.url,
      vaultId: held.vaultId,
      device: held.device,
      deviceId: held.deviceId!,
    });

    const sync = await cli("sync", "--dir", dir);
    expect(sync.code, sync.all).toBe(1);
    expect(sync.all).toMatch(/no credential for the vault/);
    expect(sync.all).toMatch(/missing a device token/);
    expect(sync.all).toMatch(/with an invite/);
  }, 60_000);

  it("tells a refusal apart from an outage (N3)", async () => {
    await fresh();
    const { a } = await twoDevices();
    await write(a, "one.md", "1\n");
    await cli("sync", "--dir", a);

    // This device has applied more than the server ever issued, which is what
    // a server restored from an older backup looks like from here.
    const index = join(a, ".trew", "index.json");
    const stored = JSON.parse(await readFile(index, "utf8")) as Record<string, unknown>;
    await writeFile(index, JSON.stringify({ ...stored, cursor: 9_999 }));

    const s = await cli("status", "--dir", a, "--json");
    expect(s.code, s.all).toBe(1);
    const answer = s.json()["server"] as Record<string, unknown>;
    expect(answer["refused"], s.all).toBe(true);
    expect(answer["reachable"], s.all).toBe(true);

    const human = await cli("status", "--dir", a);
    expect(human.stdout, human.all).toMatch(/refused this device/);
    expect(human.stdout, human.all).not.toMatch(/cannot reach the server/);
  }, 300_000);
});

/**
 * PLAN.md section 4.9 and M2 task 11: a path the server refuses reaches the
 * person, in `trew status` as well as in the sync that met it.
 *
 * Each file is made directly on disk, the way such names arrive in a real
 * vault: from an editor, another sync tool or a shell, never through this
 * client. Each is a name Basalt allowed and Trew's server refuses (hazard 9 in
 * plan/strip-ledger.md), and the refusal carries the server's reason, whose
 * code comes first (plan/protocol.md, "Paths").
 */
describe("a path the server will not hold (PLAN.md section 4.9)", () => {
  /** BEL, a control character a filesystem is happy to put in a name. */
  const BEL = String.fromCharCode(7);
  /** How `status` shows it: spelled out, so the terminal is not handed it. */
  const SPELLED_BEL = String.fromCharCode(92) + "u{7}";

  /** What `trew status --json` says the last sync left waiting on a person. */
  type Attention = { at: number; count: number; paths: { path: string; why: string }[] };

  it("names a file with a control character in its name, with the server's reason", async () => {
    await fresh();
    const a = await firstDevice();
    const bad = `bell${BEL}.md`;
    await writeFile(join(a, bad), "a note whose name the server refuses\n");
    await write(a, "fine.md", "a note that syncs\n");

    const synced = await cli("sync", "--dir", a, "--json");
    expect(synced.code, "a sync that left a path refused exited 0").toBe(1);
    const needs = synced.json()["needsAttention"] as { path: string; why: string }[];
    expect(needs.find((n) => n.path === bad)?.why, synced.all).toMatch(/^control: /);

    // The status, which runs no pass, says it too, with the reason and the
    // exit code the sync gave.
    const status = await cli("status", "--dir", a, "--json");
    expect(status.code, "status called a vault with a refused path clean").toBe(1);
    expect(status.json()["ok"]).toBe(false);
    const attention = status.json()["attention"] as Attention;
    expect(attention.count).toBe(1);
    expect(attention.paths).toHaveLength(1);
    expect(attention.paths[0]!.path).toBe(bad);
    expect(attention.paths[0]!.why).toMatch(/^control: the path contains a control character/);
    expect(attention.at).toBeGreaterThan(0);

    const human = await cli("status", "--dir", a);
    expect(human.code).toBe(1);
    expect(human.stdout).toMatch(/1 path needs a person/);
    expect(human.stdout).toContain(`bell${SPELLED_BEL}.md: control: `);
    expect(human.stdout, "status handed the raw control character to the terminal").not.toContain(
      BEL,
    );

    // The note is untouched here, and the rest of the vault went up.
    expect(await read(a, bad)).toBe("a note whose name the server refuses\n");
    const b = await vaultDir("b");
    expect((await cli("pair", await inviteFrom(a), "--dir", b)).code).toBe(0);
    expect((await cli("sync", "--dir", b)).code).toBe(0);
    expect(await read(b, "fine.md")).toBe("a note that syncs\n");

    // Renamed to something the server takes, it syncs, and the next status
    // says nothing needs a person: the record follows the vault.
    const { rename } = await import("node:fs/promises");
    await rename(join(a, bad), join(a, "bell.md"));
    expect((await cli("sync", "--dir", a)).code).toBe(0);
    const clean = await cli("status", "--dir", a, "--json");
    expect(clean.code, clean.all).toBe(0);
    expect(clean.json()["attention"]).toMatchObject({ count: 0, paths: [] });
    expect((await cli("sync", "--dir", b)).code).toBe(0);
    expect(await read(b, "bell.md")).toBe("a note whose name the server refuses\n");
  }, 120_000);

  /**
   * The two together, the path over 1,024 bytes being the one Basalt's 4,096
   * made most likely. Four folders of 250 bytes and a note: 1,042 bytes in
   * all, every name inside the 255 a name may have, so the refusal is
   * `toolong` and not `segmenttoolong`, and only the note is refused.
   *
   * macOS holds no path over 1,024 bytes (PATH_MAX, the vault's own folder
   * included), so the file cannot be made there and the server's refusal
   * cannot be reached. The test says so and skips rather than passing over
   * nothing; Linux, where CI runs it, allows 4,096.
   */
  it("names a path over 1,024 bytes beside it, both with their reasons", async (ctx) => {
    const folders = [1, 2, 3, 4].map((i) => `folder${i}-`.padEnd(250, "x"));
    const long = [...folders, "a note past the limit, deep down.md"].join("/");
    expect(new TextEncoder().encode(long).length).toBe(1_039);
    const a = await vaultDir("a");
    try {
      await mkdir(join(a, ...folders), { recursive: true });
      await writeFile(join(a, long), "a note too deep for the server\n");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENAMETOOLONG") {
        ctx.skip(
          `${process.platform} refuses a path of ${join(a, long).length} bytes, so a vault path ` +
            `over 1,024 bytes cannot exist here and the server's refusal cannot be reached`,
        );
      }
      throw err;
    }
    const bad = `bell${BEL}.md`;
    await writeFile(join(a, bad), "a note whose name the server refuses\n");

    await fresh();
    const paired = await cli("pair", await server.firstInvite(), "--dir", a, "--device", "a");
    expect(paired.code, paired.all).toBe(0);
    const synced = await cli("sync", "--dir", a);
    expect(synced.code, synced.all).toBe(1);

    const status = await cli("status", "--dir", a, "--json");
    expect(status.code, "status called a vault with two refused paths clean").toBe(1);
    const attention = status.json()["attention"] as Attention;
    expect(attention.count, JSON.stringify(attention)).toBe(2);
    const why = new Map(attention.paths.map((p) => [p.path, p.why]));
    expect(why.get(long), JSON.stringify(attention)).toMatch(
      /^toolong: the path is 1039 bytes of UTF-8, and a path is at most 1024/,
    );
    expect(why.get(bad), JSON.stringify(attention)).toMatch(/^control: /);

    const human = await cli("status", "--dir", a);
    expect(human.code).toBe(1);
    expect(human.stdout).toMatch(/2 paths need a person/);
    expect(human.stdout).toContain(`${long}: toolong: `);
    expect(human.stdout).toContain(`bell${SPELLED_BEL}.md: control: `);
    // And both notes are still here, which is the property that matters.
    expect(await read(a, long)).toBe("a note too deep for the server\n");
    expect(await read(a, bad)).toBe("a note whose name the server refuses\n");
  }, 120_000);

  /**
   * Rule 2 for the record itself. A record that is there and cannot be read
   * is not a vault with nothing to attend to, and saying "clean" over it is
   * the fallback to empty that rule is about. The next sync writes it again.
   */
  it("says so when what the last sync found cannot be read", async () => {
    await fresh();
    const a = await firstDevice();
    await write(a, "note.md", "x\n");
    expect((await cli("sync", "--dir", a)).code).toBe(0);
    expect((await cli("status", "--dir", a)).code).toBe(0);

    await writeFile(join(a, ".trew", "attention.json"), '{"at": 1, "count": ');
    const torn = await cli("status", "--dir", a, "--json");
    expect(torn.code, torn.all).toBe(1);
    expect(torn.json()["ok"]).toBe(false);
    expect(String(torn.json()["attentionUnknown"])).toMatch(/not valid JSON/);
    const human = await cli("status", "--dir", a);
    expect(human.stdout).toMatch(/could not be read/);

    expect((await cli("sync", "--dir", a)).code).toBe(0);
    expect((await cli("status", "--dir", a)).code).toBe(0);
  }, 120_000);
});

describe("renaming this device", () => {
  /**
   * Protocol 5. The name was chosen once at pairing and then fixed, so a typo
   * or a laptop that became something else meant unlinking and pairing again,
   * which makes a new row and detaches the old one's history of who wrote what.
   */
  it("changes the device list and this device's own record", async () => {
    await fresh();
    const { a } = await twoDevices();
    const before = await cli("devices", "--dir", a, "--json");
    const mine = before.json()["thisDevice"] as string;

    const done = await cli("rename", "the-good-laptop", "--dir", a, "--json");
    expect(done.code, done.all).toBe(0);
    expect(done.json()["name"], done.all).toBe("the-good-laptop");
    expect(done.json()["saved"], done.all).toBe(true);

    // The list is the authority, so it is what is checked, and the row is the
    // same row: a rename is not a re-pairing.
    const after = await cli("devices", "--dir", a, "--json");
    const rows = after.json()["devices"] as Record<string, unknown>[];
    const row = rows.find((d) => d["id"] === mine);
    expect(row?.["name"], after.all).toBe("the-good-laptop");
    expect(after.json()["thisDevice"], "the rename made a new row").toBe(mine);
  }, 60_000);

  it("is what conflict copies made afterwards are named by", async () => {
    // The half a person would otherwise discover from a filename. The engine
    // is handed the name when it is built, so a config saved under a running
    // loop would rename the list and nothing else.
    await fresh();
    const { a, b } = await twoDevices();
    await write(a, "note.md", "the original\n");
    expect((await cli("sync", "--dir", a)).code).toBe(0);
    expect((await cli("sync", "--dir", b)).code).toBe(0);

    expect((await cli("rename", "renamed-one", "--dir", b, "--json")).code).toBe(0);

    // Both sides edit it, and only a's edit reaches the server, so b has to
    // keep both.
    await write(a, "note.md", "changed on a\n");
    await write(b, "note.md", "changed on b\n");
    expect((await cli("sync", "--dir", a)).code).toBe(0);
    expect((await cli("sync", "--dir", b, "--no-merge")).code).toBe(0);

    const copies = (await readdir(b)).filter((n) => n.includes("Conflicted copy"));
    expect(copies.length, `copies: ${copies.join(", ")}`).toBeGreaterThan(0);
    expect(copies.join(" "), "a conflict copy still carries the old name").toContain("renamed-one");
  }, 120_000);

  it("refuses a name the server would refuse, before asking it", async () => {
    await fresh();
    const { a } = await twoDevices();
    const long = await cli("rename", "x".repeat(200), "--dir", a);
    expect(long.code, long.all).not.toBe(0);
    expect(long.all).toMatch(/bytes|limit/i);

    // And an empty one is not a way to clear the label.
    const empty = await cli("rename", "", "--dir", a);
    expect(empty.code, empty.all).not.toBe(0);
    expect(empty.all).toMatch(/needs a name|cannot be empty/i);
  }, 60_000);

  it("uses the name as typed, without a random tail", async () => {
    // `deviceNameFor` appends four hex characters to a *derived* name, so that
    // two laptops with one hostname differ. A name somebody typed is theirs:
    // without `deviceGiven` this command would have quietly produced
    // `laptop-3f9c`.
    await fresh();
    const { a } = await twoDevices();
    const done = await cli("rename", "laptop", "--dir", a, "--json");
    expect(done.json()["name"], done.all).toBe("laptop");
  }, 60_000);
});

describe("unlinking", () => {
  it("names the row it leaves behind, and what removes it", async () => {
    // Unlinking is local on purpose: it has to work when the server does not.
    // The cost is a row nothing here can remove afterwards, because the
    // credential for it is what was just forgotten.
    await fresh();
    const { a, b } = await twoDevices();
    const listed = await cli("devices", "--dir", b, "--json");
    const mine = listed.json()["thisDevice"] as string;

    const gone = await cli("unlink", "--dir", b);
    expect(gone.code, gone.all).toBe(0);
    expect(gone.stdout).toContain(mine);
    expect(gone.stdout).toMatch(new RegExp(`trew revoke ${mine}`));

    // And it is true: the row is still there, and that command removes it.
    const still = await cli("devices", "--dir", a, "--json");
    expect((still.json()["devices"] as Record<string, unknown>[]).map((d) => d["id"])).toContain(
      mine,
    );
    expect((await cli("revoke", mine, "--dir", a)).code).toBe(0);
  }, 60_000);

  it("forgets the pairing and keeps every note", async () => {
    await fresh();
    const { a, b } = await twoDevices();
    await write(a, "keep.md", "still here\n");
    await cli("sync", "--dir", a);
    await cli("sync", "--dir", b);

    const gone = await cli("unlink", "--dir", b, "--json");
    expect(gone.code).toBe(0);
    expect(await read(b, "keep.md")).toBe("still here\n");
    await expect(read(b, ".trew/config.json")).rejects.toThrow();

    // And the server still has it, because unlinking is a local decision.
    const c = await vaultDir("c");
    await cli("pair", await inviteFrom(a), "--dir", c, "--device", "c");
    await cli("sync", "--dir", c);
    expect(await read(c, "keep.md")).toBe("still here\n");
  }, 300_000);
});

describe("saying no clearly", () => {
  it("refuses to sync a vault nobody paired", async () => {
    const dir = await vaultDir("lonely");
    const r = await cli("sync", "--dir", dir);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/not paired/);
  });

  it("refuses a config it cannot trust rather than starting over", async () => {
    // Rule 2. A config read as absent because it could not be parsed would
    // look like an unpaired vault, and the next pair would replace a
    // credential that may be the only copy of a live row's token.
    const dir = await vaultDir("broken");
    await mkdir(join(dir, ".trew"), { recursive: true });
    await writeFile(join(dir, ".trew", "config.json"), "{ not json");
    const r = await cli("status", "--dir", dir);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/not valid JSON/);
  });

  /**
   * cli.test.ts:771 in the ledger (SPLIT). A token of the wrong size is one
   * the server refuses at every hello, so a config holding one reads as
   * paired and fails for ever. It is refused where it is read, by name.
   */
  it("refuses a config whose device token is the wrong size", async () => {
    const dir = await vaultDir("shorttoken");
    await mkdir(join(dir, ".trew"), { recursive: true });
    await writeFile(
      join(dir, ".trew", "config.json"),
      JSON.stringify({
        url: "ws://x",
        vaultId: "default",
        device: "d",
        deviceId: generateDeviceId(),
        deviceToken: "AAAA",
      }),
    );
    const r = await cli("status", "--dir", dir);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/3 byte deviceToken, and a device token is 32 bytes/);
    // And not a pairing to be finished or replaced: nothing was rewritten.
    expect(JSON.parse(await read(dir, ".trew/config.json"))["deviceToken"]).toBe("AAAA");
  });

  /**
   * A command missing the one thing it needs says what that is and where it
   * comes from. `pair` with nothing to pair from and nothing pending has no
   * pairing to finish, so it names the invite and the file the first one is
   * in, and writes nothing.
   */
  it("refuses to pair without an invite, and says where one comes from", async () => {
    const dir = await vaultDir("noinvite");
    const r = await cli("pair", "--dir", dir);
    expect(r.code).toBe(1);
    expect(r.all).toMatch(/pair needs an invite/);
    expect(r.all).toMatch(/first-invite/);
    await expect(read(dir, ".trew/config.json")).rejects.toThrow();
  });

  it("prints usage for no command and for a wrong one", async () => {
    const none = await cli();
    expect(none.code).toBe(2);
    expect(none.stdout).toMatch(/trew sync/);

    const wrong = await cli("frobnicate");
    expect(wrong.code).toBe(2);
    expect(wrong.all).toMatch(/no such command: frobnicate/);
  });
});

describe("arguments", () => {
  it("refuses an option that swallowed the next option", () => {
    // --dir --json would otherwise point the vault at a directory called
    // "--json", create it, and sync the wrong thing.
    expect(() => parseArgs(["sync", "--dir", "--json"])).toThrow(/--dir needs a value/);
    expect(() => parseArgs(["sync", "--dir"])).toThrow(/--dir needs a value/);
  });

  it("refuses an option it does not know", () => {
    expect(() => parseArgs(["sync", "--brute"])).toThrow(/no such option: --brute/);
  });

  it("refuses a timeout that is not a number", () => {
    expect(() => parseArgs(["sync", "--timeout", "soon"])).toThrow(/milliseconds/);
    expect(() => parseArgs(["sync", "--timeout", "0"])).toThrow(/milliseconds/);
  });

  /**
   * N4. The list is matched against one part of a path at a time, so a value
   * with a slash in it can never match anything. Accepted in silence, it read
   * as a folder kept out of this device and kept nothing out.
   */
  it("refuses an ignore that could never match a path segment (N4)", () => {
    expect(() => parseArgs(["sync", "--ignore", "a/b"])).toThrow(/one folder or file name/);
    expect(() => parseArgs(["sync", "--ignore", ""])).toThrow(/one folder or file name/);
    expect(() => parseArgs(["sync", "--ignore", "."])).toThrow(/one folder or file name/);
    expect(() => parseArgs(["sync", "--ignore", ".."])).toThrow(/one folder or file name/);
    expect(parseArgs(["sync", "--ignore", "Drafts"]).ignore).toEqual(["Drafts"]);
    expect(parseArgs(["sync", "--ignore", "..."]).ignore).toEqual(["..."]);
  });
});

describe("server addresses", () => {
  it("accepts what a person is likely to type", () => {
    expect(normaliseUrl("ws://host:8384")).toBe("ws://host:8384");
    expect(normaliseUrl("wss://host")).toBe("wss://host");
    expect(normaliseUrl("http://host:8384")).toBe("ws://host:8384");
    expect(normaliseUrl("https://host/")).toBe("wss://host");
    // A bare host gets TLS, because TLS is terminated in front of the server
    // and the plain case is the one worth being explicit about.
    expect(normaliseUrl("laptop.tail1234.ts.net")).toBe("wss://laptop.tail1234.ts.net");
    expect(normaliseUrl("  host:8384  ")).toBe("wss://host:8384");
  });

  it("refuses one it would have to guess at", () => {
    expect(() => normaliseUrl("ftp://host")).toThrow(/ws:\/\/ or wss:\/\//);
    expect(() => normaliseUrl("   ")).toThrow(/not a server address/);
  });
});

describe("what a paired device holds", () => {
  /**
   * cli.test.ts:866 in the ledger (SPLIT). After pairing, the config holds
   * exactly the DeviceConfig keys and nothing else: no invite, which is spent,
   * and nothing shared with another device. What is left is a credential for
   * one row, and the vault syncs on it.
   */
  it("keeps exactly its own credential after pairing, and syncs on it", async () => {
    await fresh();
    const a = await firstDevice();
    await write(a, "note.md", "paired\n");
    expect((await cli("sync", "--dir", a, "--json")).code).toBe(0);

    const after = JSON.parse(await read(a, ".trew/config.json")) as Record<string, string>;
    expect(Object.keys(after).sort()).toEqual(["device", "deviceId", "deviceToken", "url", "vaultId"]);
    // The token is the 32 random bytes the server insists on, and nothing else.
    expect(base64urlDecode(after["deviceToken"]!)).toHaveLength(32);

    // A read-only device records that, and still nothing more.
    const b = await vaultDir("b");
    expect((await cli("pair", await inviteFrom(a), "--dir", b, "--read-only")).code).toBe(0);
    const mirror = JSON.parse(await read(b, ".trew/config.json")) as Record<string, string>;
    expect(Object.keys(mirror).sort()).toEqual([
      "device",
      "deviceId",
      "deviceToken",
      "readOnly",
      "url",
      "vaultId",
    ]);

    // And the vault still syncs, on that credential alone.
    await write(a, "again.md", "still working\n");
    expect((await cli("sync", "--dir", a, "--json")).json()["uploaded"]).toBe(1);
  }, 300_000);
});

describe("what counts as a successful run", () => {
  /**
   * A sync that ends with files still failing has not finished. It reported
   * zero once, because the settle loop stops when a pass produces no work and
   * a pass where everything failed produces none: the connection had died
   * half way through a large sync and the client said it was done.
   */
  it("exits non-zero when files are still failing", async () => {
    await fresh();
    const dir = await firstDevice();
    await write(dir, "fine.md", "this one is ok\n");
    await write(dir, "locked.md", "this one cannot be read\n");
    await cli("sync", "--dir", dir);

    // A file that cannot be read is the ordinary version of this: a
    // permission, a file open exclusively by something else, a disk that
    // answered once and not twice.
    const { chmod } = await import("node:fs/promises");
    await write(dir, "locked.md", "changed, and now unreadable\n");
    await chmod(join(dir, "locked.md"), 0o000);
    try {
      const r = await cli("sync", "--dir", dir, "--json");
      expect(r.json()["retrying"], `report was ${r.stdout}`).toBe(1);
      expect(r.code, "a sync that could not read a file reported success").toBe(1);
    } finally {
      await chmod(join(dir, "locked.md"), 0o644);
    }
  }, 300_000);

  /**
   * C-D10 in the 0.3.0 review. `sync` returns `exitCodeFor` and `restore`
   * returned 0 whatever the sync after it found. The note is on this device
   * either way; whether the vault is in the state the command claims is the
   * other half, and a cron job reading the exit code was told yes.
   */
  it("exits non-zero from a restore whose sync could not finish", async () => {
    await fresh();
    const dir = await firstDevice();
    await write(dir, "note.md", "the first version\n");
    expect((await cli("sync", "--dir", dir)).code).toBe(0);
    await write(dir, "note.md", "the second version\n");
    expect((await cli("sync", "--dir", dir)).code).toBe(0);

    const { chmod } = await import("node:fs/promises");
    await write(dir, "locked.md", "cannot be read\n");
    await chmod(join(dir, "locked.md"), 0o000);
    try {
      const r = await cli("restore", "note.md", "--dir", dir, "--json");
      // The restore itself worked, and says so -- in `restored`, which is its
      // own field now (RR8).
      //
      // `ok` used to carry that meaning and sat beside an exit code answering
      // a different question, so this command returned `ok: true` and exit 1
      // and automation's answer depended on which it read. `ok` is the run,
      // `restored` is the file, and both are here rather than one standing in
      // for the other.
      expect(r.json()["restored"], r.all).toBe(true);
      expect(r.json()["ok"], "ok disagrees with the exit code").toBe(false);
      expect((r.json()["outcome"] as Record<string, unknown>)["kind"]).toBe("retrying");
      expect((r.json()["sync"] as Record<string, number>)["retrying"]).toBe(1);
      expect(r.code, "a restore over a vault that cannot sync reported success").toBe(1);
    } finally {
      await chmod(join(dir, "locked.md"), 0o644);
    }
  }, 300_000);

  it("still exits zero when there is simply nothing to do", async () => {
    await fresh();
    const dir = await firstDevice();
    await write(dir, "note.md", "x\n");
    await cli("sync", "--dir", dir);
    const again = await cli("sync", "--dir", dir);
    expect(again.code).toBe(0);
  }, 300_000);
});

/**
 * Adding a device: an invite, from a device that has the vault or from the
 * server, and nothing else.
 *
 * An invite is a single-use token with the server's address and the vault's
 * name around it. Redeeming it registers the new device's own row, under an id
 * and a token the new device made, and the new device holds that and nothing
 * shared with anybody.
 */
describe("adding a device", () => {
  /**
   * cli.test.ts:1160 in the ledger (SPLIT). Issuing, pairing, the config's
   * fields, sync and the listing stay; what an invite carried besides its
   * token is gone, and so is the check for it.
   */
  it("adds a device with an invite, and each device holds only its own credential", async () => {
    await fresh();
    const a = await firstDevice();
    await write(a, "note.md", "from a\n");
    expect((await cli("sync", "--dir", a)).code).toBe(0);

    const before = Date.now();
    const issued = await cli("invite", "--dir", a, "--json");
    expect(issued.code, issued.all).toBe(0);
    const invite = issued.json()["invite"] as string;
    expect(invite).toMatch(/^trew1i_/);
    // An hour by default, and never longer.
    const expiresAt = issued.json()["expiresAt"] as number;
    expect(expiresAt).toBeGreaterThan(before);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 3_600_000 + 5_000);
    expect(parseInvite(invite).url).toBe(server.wsUrl);

    const b = await vaultDir("b");
    const paired = await cli("pair", invite, "--dir", b, "--device", "b", "--json");
    expect(paired.code, paired.all).toBe(0);
    expect(paired.json()["deviceId"]).toMatch(/^[A-Za-z0-9_-]+$/);

    // What the new device holds: its own row id and its own token, and
    // nothing of the device that invited it.
    const configA = JSON.parse(await read(a, ".trew/config.json")) as Record<string, string>;
    const config = JSON.parse(await read(b, ".trew/config.json")) as Record<string, string>;
    expect(config["deviceId"]).toBe(paired.json()["deviceId"]);
    expect(base64urlDecode(config["deviceToken"]!)).toHaveLength(32);
    expect(config["deviceToken"], "two devices share a credential").not.toBe(
      configA["deviceToken"],
    );
    expect(config["invite"], "a finished pairing kept the invite").toBeUndefined();

    // And it is a device: it syncs, and it appears in the list as its own row.
    expect((await cli("sync", "--dir", b)).code).toBe(0);
    expect(await read(b, "note.md")).toBe("from a\n");
    const listed = await cli("devices", "--dir", a, "--json");
    const devices = listed.json()["devices"] as Record<string, unknown>[];
    expect(devices.map((d) => d["name"]).sort()).toEqual(["a", "b"]);
  }, 120_000);

  it("spends an invite once, and says so the second time", async () => {
    await fresh();
    const a = await firstDevice();
    const invite = await inviteFrom(a);

    const b = await vaultDir("b");
    expect((await cli("pair", invite, "--dir", b, "--device", "b")).code).toBe(0);

    const c = await vaultDir("c");
    const again = await cli("pair", invite, "--dir", c, "--device", "c");
    expect(again.code).toBe(1);
    expect(again.all).toMatch(/not authorised/);
    // Nothing kept, so the next attempt with a fresh invite is the ordinary
    // path rather than an unlink first.
    await expect(stat(join(c, ".trew", "config.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    // And the vault gained one device, not two.
    const devices = (await cli("devices", "--dir", a, "--json")).json()["devices"] as unknown[];
    expect(devices).toHaveLength(2);
  }, 120_000);

  it("refuses a damaged invite before it reaches the server", async () => {
    await fresh();
    const a = await firstDevice();
    const invite = await inviteFrom(a);
    // One character changed in the middle, which the checksum is there for.
    const at = Math.floor(invite.length / 2);
    const damaged = invite.slice(0, at) + (invite[at] === "A" ? "B" : "A") + invite.slice(at + 1);
    const b = await vaultDir("b");
    const given = await cli("pair", damaged, "--dir", b);
    expect(given.code).toBe(1);
    expect(given.all).toMatch(/this invite is damaged/);
    await expect(stat(join(b, ".trew", "config.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    // Before it reached the server, which the undamaged one shows: it was not
    // spent.
    expect((await cli("pair", invite, "--dir", b)).code).toBe(0);
  }, 60_000);

  /**
   * cli.test.ts:1265 in the ledger (SPLIT), and hazard 2: the pairing is
   * saved before anything is sent, and an unreachable server removes it
   * again, so a dead server never ends in "Paired" and never leaves anything
   * saved. The invite was not spent either, which the server coming back
   * shows.
   */
  it("reaches the server before it says paired, and saves nothing it could not reach", async () => {
    await fresh();
    const a = await firstDevice();
    const invite = await inviteFrom(a);
    const b = await vaultDir("b");
    const port = server.port;
    await server.stop();
    const paired = await cli("pair", invite, "--dir", b, "--device", "b", "--timeout", "3000");
    expect(paired.code).toBe(1);
    expect(paired.all).not.toMatch(/Paired/);
    expect(paired.all).toMatch(/Nothing was registered and nothing is saved here/);
    await expect(stat(join(b, ".trew", "config.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await server.start(port);
    const later = await cli("pair", invite, "--dir", b, "--device", "b");
    expect(later.code, later.all).toBe(0);
    expect(later.all).toMatch(/Paired/);
  }, 120_000);

  /**
   * The reply to a redemption lost after the server committed it
   * (plan/protocol.md, "Invite redemption"; hazard 3).
   *
   * The pending pairing is kept, because the credential in it may be the only
   * copy of a live row's token, and every command that would connect with it
   * says the pairing has not finished instead of connecting as nobody. A
   * different invite is refused, naming the pending pairing and `trew
   * unlink`. `trew pair` with the same invite finishes it under the same id,
   * which the server answers `redeemed` again for, and the vault has one row
   * for this device, not two.
   */
  it("keeps a pairing whose reply was lost, and finishes it under the same ids", async () => {
    await fresh();
    const a = await firstDevice();
    const relay = new LossyRelay(server.port);
    await relay.start();
    try {
      const printed = await server.cli("invite", "-url", relay.url);
      const invite = /trew1i_[A-Za-z0-9_-]+/.exec(printed)![0];
      const b = await vaultDir("b");

      const lost = await cli("pair", invite, "--dir", b, "--device", "b");
      expect(lost.code, lost.all).toBe(1);
      expect(lost.all).not.toMatch(/Paired/);
      expect(lost.all).toMatch(/not known/);
      expect(lost.all).toMatch(/run trew pair here again/);
      const pending = await loadConfig(b);
      expect(pending && isPendingPairing(pending), "the pending pairing was not kept").toBe(true);
      const id = pending!.deviceId!;

      // The server did register it: the row is there, and nothing has ever
      // connected under it.
      const rows = (await cli("devices", "--dir", a, "--json")).json()["devices"] as {
        id: string;
        lastSeen: number;
      }[];
      expect(rows.find((d) => d.id === id)?.lastSeen, "the redemption never committed").toBe(0);

      // Nothing connects with it until it is finished.
      const status = await cli("status", "--dir", b, "--json");
      expect(status.code).toBe(1);
      expect(status.json()["server"]).toMatchObject({ reachable: false, refused: false });
      const sync = await cli("sync", "--dir", b);
      expect(sync.code).toBe(1);
      expect(sync.all).toMatch(/has not finished/);

      // A different invite is somebody starting over, which could throw
      // away the only copy of that row's token, so it is theirs to decide.
      const other = await cli("pair", await server.invite(), "--dir", b, "--device", "b");
      expect(other.code).toBe(1);
      expect(other.all).toMatch(/has not finished/);
      expect(other.all).toMatch(/trew unlink/);
      expect((await loadConfig(b))?.deviceId, "the refusal replaced the pending pairing").toBe(id);

      // The same invite again, through a relay that delivers this time.
      relay.losing = false;
      const done = await cli("pair", invite, "--dir", b, "--json");
      expect(done.code, done.all).toBe(0);
      expect(done.json()["deviceId"]).toBe(id);
      const config = await loadConfig(b);
      expect(config && isPendingPairing(config), "the finished config kept the invite").toBe(false);

      // One row for this device, now seen, and the device works.
      const after = (await cli("devices", "--dir", a, "--json")).json()["devices"] as {
        id: string;
        lastSeen: number;
      }[];
      expect(after.filter((d) => d.id === id)).toHaveLength(1);
      expect(after).toHaveLength(2);
      await write(a, "note.md", "for the late one\n");
      expect((await cli("sync", "--dir", a)).code).toBe(0);
      expect((await cli("sync", "--dir", b)).code).toBe(0);
      expect(await read(b, "note.md")).toBe("for the late one\n");
    } finally {
      await relay.stop();
    }
  }, 120_000);

  /**
   * The same lost reply, finished with no invite at all: the pending pairing
   * is the whole of what is needed, so a person who has lost the string, or
   * whose invite has since expired, is not stuck.
   */
  it("finishes a pending pairing with no invite given", async () => {
    await fresh();
    await firstDevice();
    const relay = new LossyRelay(server.port);
    await relay.start();
    try {
      const printed = await server.cli("invite", "-url", relay.url);
      const invite = /trew1i_[A-Za-z0-9_-]+/.exec(printed)![0];
      const b = await vaultDir("b");
      expect((await cli("pair", invite, "--dir", b, "--device", "b")).code).toBe(1);
      const id = (await loadConfig(b))!.deviceId;

      relay.losing = false;
      const done = await cli("pair", "--dir", b);
      expect(done.code, done.all).toBe(0);
      expect(done.all).toMatch(/Finishing the pairing already started here/);
      expect((await loadConfig(b))!.deviceId).toBe(id);
      expect((await cli("sync", "--dir", b)).code).toBe(0);
    } finally {
      await relay.stop();
    }
  }, 120_000);
});

/**
 * The device list, and revoking one.
 *
 * The point of per-device credentials, and the only place the honesty
 * requirement can be checked: revoking stops a device connecting and does not
 * un-read what it already read.
 */
describe("the device list", () => {
  it("lists every device with its id, name and last seen", async () => {
    await fresh();
    const { a, b } = await twoDevices();
    expect((await cli("sync", "--dir", a)).code).toBe(0);
    expect((await cli("sync", "--dir", b)).code).toBe(0);

    const listed = await cli("devices", "--dir", a, "--json");
    expect(listed.code, listed.all).toBe(0);
    const devices = listed.json()["devices"] as Record<string, unknown>[];
    expect(devices).toHaveLength(2);
    expect(devices.map((d) => d["name"]).sort()).toEqual(["a", "b"]);
    for (const d of devices) {
      expect(d["id"], "a device with no id").toMatch(/^[A-Za-z0-9_-]+$/);
      expect(d["createdAt"] as number).toBeGreaterThan(0);
      // Both have connected, so both have been seen. Zero would mean the
      // server never stamped one, which is a device that cannot be told from
      // one that has never been used.
      expect(d["lastSeen"] as number, `${String(d["name"])} was never seen`).toBeGreaterThan(0);
    }
    expect(listed.json()["thisDevice"]).toBe(devices.find((d) => d["name"] === "a")!["id"]);
  }, 60_000);

  /**
   * cli.test.ts:1329 in the ledger (SPLIT). "Does not un-read" stays, and now
   * says what is left behind: the notes, in plaintext. What it said about a
   * key the device keeps and a rotation that would help has gone with them.
   */
  it("says, in the listing, that revoking does not un-read anything", async () => {
    await fresh();
    const { a } = await twoDevices();
    const listed = await cli("devices", "--dir", a);
    expect(listed.stdout).toMatch(/does not un-read/);
    expect(listed.stdout).toMatch(/still on its disk, in plaintext/);
    expect(listed.stdout).not.toMatch(/rotate|recovery key|decrypt|encrypted/i);
  }, 60_000);

  it("stops a revoked device connecting, and says why in words to act on", async () => {
    await fresh();
    const { a, b } = await twoDevices();
    await write(a, "note.md", "one\n");
    expect((await cli("sync", "--dir", a)).code).toBe(0);
    expect((await cli("sync", "--dir", b)).code).toBe(0);

    const list = await cli("devices", "--dir", a, "--json");
    const bId = (list.json()["devices"] as Record<string, unknown>[]).find(
      (d) => d["name"] === "b",
    )!["id"] as string;

    const revoked = await cli("revoke", bId, "--dir", a);
    expect(revoked.code, revoked.all).toBe(0);
    expect(revoked.stdout).toMatch(/cannot connect again/);
    expect(revoked.stdout).toMatch(/does not un-read/);
    expect(revoked.stdout).not.toMatch(/rotate|recovery key|decrypt|encrypted/i);

    const refused = await cli("sync", "--dir", b);
    expect(refused.code).toBe(1);
    expect(refused.all).toMatch(/not authorised/);
    // And what it had synced is still there, which is what "does not un-read"
    // means, said by the disk rather than by the sentence.
    expect(await read(b, "note.md")).toBe("one\n");

    // And the other device is untouched.
    await write(a, "after.md", "two\n");
    expect((await cli("sync", "--dir", a)).code, "revoking one disturbed another").toBe(0);
  }, 60_000);

  /**
   * Base64url's alphabet includes `-`, so an id can begin with one and be read
   * as an option. Ids made here no longer do, and `--` says "the next word is
   * a word" for the ones that arrive from anywhere else.
   */
  it("takes a device id that looks like an option, after --", async () => {
    await fresh();
    const { a } = await twoDevices();
    // `--` means every word after it is a word, options included, so the
    // options come first. That is what `--` means everywhere else too.
    const refused = await cli("revoke", "--dir", a, "--", "-not-a-real-id");
    expect(refused.code).toBe(1);
    expect(refused.all, refused.all).toMatch(/no device with id -not-a-real-id/);
    // And every id this client makes is safe without it.
    const listed = await cli("devices", "--dir", a, "--json");
    for (const d of listed.json()["devices"] as Record<string, unknown>[]) {
      expect(String(d["id"]).startsWith("-"), `${String(d["id"])} reads as an option`).toBe(false);
    }
  }, 60_000);

  it("refuses an id the vault does not have, and says the list is stale", async () => {
    await fresh();
    const { a } = await twoDevices();
    const missing = await cli("revoke", "no-such-device", "--dir", a);
    expect(missing.code).toBe(1);
    expect(missing.all).toMatch(/no device with id no-such-device/);
    expect(missing.all).toMatch(/trew devices again/);
  }, 60_000);

  /**
   * cli.test.ts:1408 in the ledger, inverted (hazard 4, decided): a device
   * may revoke the last device, itself included, because nothing a device
   * holds is needed to get back in. The way back is `trew invite` on the
   * server, and this walks it to the end rather than trusting the sentence
   * that names it (rule 11): the notes are still on the server afterwards.
   */
  it("revokes the last device too, and the way back it names works", async () => {
    await fresh();
    const a = await firstDevice();
    await write(a, "kept.md", "written before the vault had no devices\n");
    expect((await cli("sync", "--dir", a)).code).toBe(0);
    const list = await cli("devices", "--dir", a, "--json");
    const only = (list.json()["devices"] as Record<string, unknown>[])[0]!["id"] as string;

    const done = await cli("revoke", only, "--dir", a);
    expect(done.code, done.all).toBe(0);
    expect(done.stdout).toMatch(/That was this device/);
    expect(done.stdout).toMatch(/trew invite on the server/);
    expect((await cli("sync", "--dir", a)).all).toMatch(/not authorised/);
    expect(JSON.parse(await server.cli("devices", "-json"))["devices"] ?? []).toEqual([]);

    // The way back, in the order the words give it.
    expect((await cli("unlink", "--dir", a)).code).toBe(0);
    const back = await cli("pair", await server.invite(), "--dir", a, "--device", "again");
    expect(back.code, back.all).toBe(0);
    expect((await cli("sync", "--dir", a)).code).toBe(0);
    const fresh_ = await vaultDir("fresh");
    expect((await cli("pair", await inviteFrom(a), "--dir", fresh_)).code).toBe(0);
    expect((await cli("sync", "--dir", fresh_)).code).toBe(0);
    expect(await read(fresh_, "kept.md")).toBe("written before the vault had no devices\n");
  }, 90_000);

  /**
   * An invite that has not been redeemed is visible beside the rows, and can
   * be cancelled.
   *
   * It was the one authority on a vault that nothing could see: a string
   * issued on a stolen laptop stayed invisible until somebody redeemed it, for
   * up to an hour. What the list must never carry is anything that redeems,
   * and with a bearer token the only way to show that is to try every field
   * (cli.test.ts:1464 in the ledger; hazard 1). A whole-string check would
   * pass while the token itself leaked.
   */
  it("shows outstanding invites beside the devices, none of whose fields redeems", async () => {
    await fresh();
    const { a } = await twoDevices();

    const empty = await cli("devices", "--dir", a);
    expect(empty.stdout).toMatch(/No outstanding invites/);

    const issued = await cli("invite", "--dir", a, "--json");
    expect(issued.code, issued.all).toBe(0);
    const string = issued.json()["invite"] as string;
    const parsed = parseInvite(string);
    const token = base64urlEncode(parsed.token);

    const listed = await cli("devices", "--dir", a, "--json");
    const invites = listed.json()["invites"] as Record<string, unknown>[];
    expect(invites).toHaveLength(1);
    const row = invites[0]!;
    expect(Object.keys(row).sort()).toEqual(["expiresAt", "id", "label"]);
    expect(row["id"]).toBe(issued.json()["id"]);
    expect(row["expiresAt"]).toBe(issued.json()["expiresAt"]);

    // No field is the token, holds it, or is it in another spelling.
    const hex = Buffer.from(parsed.token).toString("hex");
    for (const [field, value] of Object.entries(row)) {
      const text = JSON.stringify(value);
      expect(text, `${field} carries the token`).not.toContain(token);
      expect(text.toLowerCase(), `${field} carries the token in hex`).not.toContain(hex);
      expect(text, `${field} carries the invite`).not.toContain(string);
    }
    expect(listed.stdout).not.toContain(token);
    const shown = await cli("devices", "--dir", a);
    expect(shown.stdout).not.toContain(token);
    expect(shown.stdout).not.toContain(string);
    expect(shown.stdout).toMatch(/1 outstanding invite/);
    expect(shown.stdout).toMatch(/trew uninvite ID/);

    // And none of them redeems: each one, offered as the invite, is refused.
    for (const [field, value] of Object.entries(row)) {
      const offered = typeof value === "string" ? value : JSON.stringify(value);
      const answer = await redeemWith(parsed.url, parsed.vault, offered);
      expect(answer, `the listed ${field} redeemed an invite`).toBeInstanceOf(ProtocolError);
      expect((answer as ProtocolError).code, `${field}`).toBe("auth");
    }
    // A refused redemption never spends the invite: it is still outstanding.
    const still = (await cli("devices", "--dir", a, "--json")).json()["invites"] as unknown[];
    expect(still).toHaveLength(1);

    // Cancelled, and the string stops working, which is the point of seeing
    // it in the first place.
    const id = row["id"] as string;
    const cancelled = await cli("uninvite", id, "--dir", a);
    expect(cancelled.code, cancelled.all).toBe(0);
    expect(cancelled.stdout).toMatch(/no longer adds a device/);

    const c = await vaultDir("c");
    const refused = await cli("pair", string, "--dir", c, "--device", "c");
    expect(refused.code).toBe(1);
    expect(refused.all).toMatch(/not authorised/);
    expect((await cli("devices", "--dir", a, "--json")).json()["invites"]).toHaveLength(0);
    expect((await cli("devices", "--dir", a, "--json")).json()["devices"]).toHaveLength(2);

    // And cancelling it twice says there is nothing to cancel, in one answer
    // that an unknown identifier also gets: telling them apart would tell
    // somebody guessing that they had found a real one.
    const again = await cli("uninvite", id, "--dir", a);
    expect(again.code).toBe(1);
    expect(again.all).toMatch(/no outstanding invite/);
    expect(again.all).toMatch(/trew devices/);
  }, 60_000);

  /**
   * A label and an invite that never expires, as `trew invite -label L -ttl 0`
   * on the server makes, are shown as they are: the name somebody gave it, and
   * "never" rather than a date, because an invite with no end is the one most
   * worth seeing.
   */
  it("shows an invite's label, and one that never expires as never", async () => {
    await fresh();
    const { a } = await twoDevices();
    await server.invite({ label: "for the tablet", ttl: "0" });
    const listed = await cli("devices", "--dir", a, "--json");
    const row = (listed.json()["invites"] as Record<string, unknown>[])[0]!;
    expect(row["label"]).toBe("for the tablet");
    expect(row["expiresAt"]).toBeNull();
    const shown = await cli("devices", "--dir", a);
    expect(shown.stdout).toMatch(/invite "for the tablet", never expires/);
  }, 60_000);

  /**
   * A row nothing has ever connected under is flagged, because it is the one
   * that can be reclaimed.
   *
   * A pairing saves its credential before it sends anything, so an interrupted
   * one leaves a pending pairing on the device that `trew pair` finishes. A row
   * nothing ever connects under is what is left when that never happens: the
   * device was unlinked or wiped while the pairing was pending. The list has to
   * say which rows those are, or advice to revoke one is advice nobody can
   * follow.
   */
  it("flags a row nothing has ever connected under", async () => {
    await fresh();
    const { a } = await twoDevices();

    // A redemption the server answered, and then nothing ever connects under
    // the row it made.
    await redeemAndVanish(await inviteFrom(a), "the-one-that-vanished");

    const listed = await cli("devices", "--dir", a);
    expect(listed.code, listed.all).toBe(0);
    expect(listed.stdout).toMatch(/never connected/);
    expect(listed.stdout).toMatch(/1 of them has never connected/);
    expect(listed.stdout).toMatch(/interrupted and never finished/);

    // The two working devices are not flagged, which is the half that makes
    // the flag worth reading.
    const rows = (await cli("devices", "--dir", a, "--json")).json()["devices"] as Record<
      string,
      unknown
    >[];
    expect(rows.filter((d) => d["lastSeen"] === 0)).toHaveLength(1);
    expect(rows.filter((d) => d["lastSeen"] !== 0)).toHaveLength(2);
  }, 60_000);

  /**
   * cli.test.ts:1570 in the ledger (SPLIT): listing and revoking with no
   * device to ask moved to the server's control socket (M1 task 9). What this
   * side still owes is that the answer reaches the devices: a row revoked on
   * the server is refused at its next sync, and the other device is untouched,
   * which is the guarantee a revocation makes whoever asked for it.
   */
  it("is administered on the server when no device is there to ask", async () => {
    await fresh();
    const { a, b } = await twoDevices();
    const mine = (await cli("devices", "--dir", b, "--json")).json()["thisDevice"] as string;

    const listed = JSON.parse(await server.cli("devices", "-json")) as {
      devices: { id: string; name: string }[];
    };
    expect(listed.devices.map((d) => d.name).sort()).toEqual(["a", "b"]);

    // The binary directly, because its flags have to come before the id and
    // `server.cli` puts `-data` last.
    const onServer = promisify(execFile);
    await onServer(await serverBinary(), ["revoke", "-data", server.dataDir, mine]);
    expect((await cli("sync", "--dir", b)).all).toMatch(/not authorised/);
    expect((await cli("sync", "--dir", a)).code).toBe(0);
  }, 60_000);
});

/**
 * R2. A folder one device syncs and another is told to ignore is an ordinary
 * arrangement: the laptop keeps `Drafts`, the server-side client does not
 * want it. The refusal used to be filed as a permanent skip, and a skip
 * exits 1, so from the first pass onwards every sync of that vault failed
 * for ever. The path is still refused, still counted and still printed; what
 * changed is that obeying the configuration is not a failure.
 */
describe("a folder this device ignores and another device syncs (R2)", () => {
  it("counts it as ignored, keeps it out of the exit code, and stays that way", async () => {
    await fresh();
    const { a, b } = await twoDevices();
    await write(a, "Drafts/plan.md", "not for the other one\n");
    await write(a, "keep.md", "for everybody\n");
    expect((await cli("sync", "--dir", a)).code).toBe(0);

    for (const pass of [1, 2, 3]) {
      const r = await cli("sync", "--dir", b, "--ignore", "Drafts", "--json");
      expect(r.code, `pass ${pass}: ${r.all}`).toBe(0);
      const report = r.json();
      expect(report["ignored"], `pass ${pass}`).toBeGreaterThan(0);
      expect(report["skipped"], `pass ${pass}`).toBe(0);
      expect(report["retrying"], `pass ${pass}`).toBe(0);
    }

    // Refused, not written: the ignore list still means what it says.
    await expect(stat(join(b, "Drafts", "plan.md"))).rejects.toThrow(/ENOENT/);
    // And the rest of the vault syncs, which is the other half of it.
    expect(await read(b, "keep.md")).toBe("for everybody\n");

    // Printed rather than swallowed. A count that disappears is how somebody
    // loses track of a folder they stopped syncing years ago.
    const human = await cli("sync", "--dir", b, "--ignore", "Drafts");
    expect(human.code, human.all).toBe(0);
    expect(human.stdout).toMatch(/ignored here, and synced by another device/);
  }, 300_000);

  /**
   * N4. An ignored path was left on the inbound work list for ever, so
   * `trew status` said "N files with work outstanding" about a folder
   * whose owner had decided it would never arrive. Rule 7: the ignored
   * counter is where that belongs, and nothing is outstanding.
   */
  it("does not leave an ignored path on the work list (N4)", async () => {
    await fresh();
    const { a, b } = await twoDevices();
    await write(a, "Drafts/plan.md", "not for the other one\n");
    await write(a, "keep.md", "for everybody\n");
    expect((await cli("sync", "--dir", a)).code).toBe(0);
    expect((await cli("sync", "--dir", b, "--ignore", "Drafts", "--json")).code).toBe(0);

    const s = await cli("status", "--dir", b, "--ignore", "Drafts", "--json");
    expect(s.code, s.all).toBe(0);
    expect(s.json()["pending"], s.all).toBe(0);
    const human = await cli("status", "--dir", b, "--ignore", "Drafts");
    expect(human.stdout, human.all).not.toMatch(/work outstanding/);
  }, 300_000);

  it("still fails for a path that cannot work here, ignore list or not (R2)", async () => {
    await fresh();
    const { a, b } = await twoDevices();
    // `notes` is a folder on a and a file on b: nobody can apply that, and it
    // is nothing the person configured.
    await write(a, "notes/inside.md", "in the folder\n");
    expect((await cli("sync", "--dir", a)).code).toBe(0);
    await writeFile(join(b, "notes"), "a file\n");

    const r = await cli("sync", "--dir", b, "--ignore", "Drafts", "--json");
    expect(r.code, r.all).toBe(1);
    expect(r.json()["ignored"]).toBe(0);
  }, 300_000);
});

/**
 * I11, I14, I15, I24: the smaller CLI contracts.
 */
describe("what the CLI says about itself and the vault", () => {
  it("prints both cursors on their own lines, and the ignore list (I11, I14)", async () => {
    await fresh();
    const { a } = await twoDevices();
    await write(a, "note.md", "x\n");
    await cli("sync", "--dir", a);
    const r = await cli("status", "--dir", a, "--ignore", "Drafts", "--ignore", "scratch");
    expect(r.code, r.all).toBe(0);
    expect(r.out).toContainEqual(expect.stringMatching(/^local cursor\s+1$/));
    expect(r.out).toContainEqual(expect.stringMatching(/^server cursor\s+1$/));
    expect(r.out).toContainEqual(
      expect.stringMatching(/^ignore\s+Drafts, scratch \(this device only\)$/),
    );
    const plain = await cli("status", "--dir", a, "--json");
    expect(plain.json()["ignore"]).toEqual([]);
    const bare = await cli("status", "--dir", a);
    expect(bare.out).toContainEqual(expect.stringMatching(/^ignore\s+nothing beyond the dot rule/));
  });

  it("gives a default device name a tail, so two laptops with one hostname differ (I15)", async () => {
    await fresh();
    const a = await vaultDir("a");
    const first = await cli("pair", await server.firstInvite(), "--dir", a, "--json");
    expect(first.code, first.all).toBe(0);
    const b = await vaultDir("b");
    const paired = await cli("pair", await inviteFrom(a), "--dir", b, "--json");
    expect(paired.code, paired.all).toBe(0);
    const nameA = first.json()["device"] as string;
    const nameB = paired.json()["device"] as string;
    const { hostname } = await import("node:os");
    const host = hostname().split(".")[0] || "device";
    // A *prefix* of the hostname, not the whole of it. This asserted the whole
    // of it, and on a runner whose hostname is sixty-one characters the name
    // that produced was sixty-six bytes and the server refused it, which is
    // what the clipping fixed and what this then contradicted. The point of
    // the name is that it says which machine and that two machines with one
    // hostname differ, and a prefix does both.
    expect(host.startsWith(nameA.slice(0, nameA.length - 5))).toBe(true);
    expect(nameA).toMatch(/-[0-9a-f]{4}$/);
    expect(nameB).toMatch(/-[0-9a-f]{4}$/);
    for (const name of [nameA, nameB]) {
      expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(MAX_NAME_BYTES);
    }
    expect(nameA).not.toBe(nameB);
    // A name that was typed is used as typed.
    const c = await vaultDir("c");
    const typed = await cli(
      "pair",
      await inviteFrom(a),
      "--dir",
      c,
      "--device",
      "exactly",
      "--json",
    );
    expect(typed.json()["device"]).toBe("exactly");
  });

  it("prints its version (I24)", async () => {
    const r = await cli("--version");
    expect(r.code).toBe(0);
    expect(r.out).toEqual(["development"]);
    const j = await cli("--version", "--json");
    expect(j.json()["version"]).toBe("development");
  });

  it("exits non-zero for a report with only blocked paths", async () => {
    const { exitCodeFor } = await import("./cli.ts");
    const clean = {
      uploaded: 0,
      downloaded: 0,
      merged: 0,
      conflicted: 0,
      deletedLocally: 0,
      deletedRemotely: 0,
      restored: 0,
      foldersCreated: 0,
      unchanged: 3,
      waiting: 0,
      retrying: 0,
      skipped: 0,
      skippedPaths: [],
      retryingPaths: [],
      heldBack: 0,
      heldBackPaths: [],
      ignored: 0,
      blocked: 0,
      inTheWay: [],
      needsAttention: [],
      chunksSent: 0,
      bytesSent: 0,
      reusedChunks: 0,
    };
    expect(exitCodeFor(clean)).toBe(0);
    expect(exitCodeFor({ ...clean, uploaded: 2, waiting: 1 })).toBe(0);
    expect(exitCodeFor({ ...clean, blocked: 1, inTheWay: [{ path: "a/b", blockedBy: "a" }] })).toBe(
      1,
    );
    expect(exitCodeFor({ ...clean, skipped: 1 })).toBe(1);
    expect(exitCodeFor({ ...clean, retrying: 1 })).toBe(1);
    // A path this device is set to ignore is the configuration working, and
    // a run is not a failure for having obeyed it (R2).
    expect(exitCodeFor({ ...clean, ignored: 4 })).toBe(0);
  });

  it("exits non-zero when a path is blocked by a name that is a file here and a folder elsewhere", async () => {
    await fresh();
    const { a, b } = await twoDevices();
    // A folder called `notes` on a, a file called `notes` on b.
    await write(a, "notes/inside.md", "in the folder\n");
    expect((await cli("sync", "--dir", a)).code).toBe(0);
    await writeFile(join(b, "notes"), "a file\n");
    const r = await cli("sync", "--dir", b, "--json");
    const report = r.json();
    expect((report["blocked"] as number) + (report["skipped"] as number), r.all).toBeGreaterThan(0);
    expect(r.code, "a sync that left a path unwritten exited zero").toBe(1);
  });
});

/**
 * review finding I10, where `trew rebase` used to answer it. A restore through
 * `trew backup` starts a new epoch now, which the engine rejoins by itself; what
 * is left is a data directory copied back behind the server's back, which keeps
 * the old epoch and so still looks, from a device that applied what it lost,
 * like a server behind its own clients.
 *
 * The refusal is right, and the way past it is the one the advice names:
 * unlink and pair again with a new invite, which forgets what this device
 * believed was synced and sends what only it holds as new versions. Walked to
 * the end (rule 11), because advice nobody has followed is a rumour.
 */
describe("a server that lost history behind its own back (I10)", () => {
  it("refuses, names the way back, and the way back keeps what only this device held", async () => {
    await fresh();
    const { a, b } = await twoDevices();
    await write(a, "first.md", "first\n");
    expect((await cli("sync", "--dir", a)).code).toBe(0);

    // The operator's copy is taken here, before the second note.
    const backup = await vaultDir("backup");
    const { cp } = await import("node:fs/promises");
    await server.whileStopped(async () => {
      await cp(server.dataDir, backup, { recursive: true });
    });
    await write(a, "second.md", "second\n");
    expect((await cli("sync", "--dir", a)).code).toBe(0);

    // The copy goes back, so the server has forgotten second.md and has not
    // been told: same store, same epoch, older history.
    await server.whileStopped(async () => {
      await rm(server.dataDir, { recursive: true, force: true });
      await cp(backup, server.dataDir, { recursive: true });
    });
    const refused = await cli("sync", "--dir", a);
    expect(refused.code).toBe(1);
    expect(refused.all).toMatch(/cursor|ahead|behind/);
    // The refusal is the server's, and the server has never heard of the
    // client's way out. It used to stop at the diagnosis. Error strings are UI.
    expect(refused.all, "the refusal named no way back").toMatch(
      /unlink this device and pair it again with a new invite/,
    );
    // And nothing was touched by refusing.
    expect(await read(a, "second.md")).toBe("second\n");

    // The way back, as the words give it.
    expect((await cli("unlink", "--dir", a)).code).toBe(0);
    const again = await cli("pair", await server.invite(), "--dir", a, "--device", "a-again");
    expect(again.code, again.all).toBe(0);
    const rejoined = await cli("sync", "--dir", a, "--json");
    expect(rejoined.code, rejoined.all).toBe(0);
    expect(rejoined.json()["uploaded"], "what only this device held was not sent").toBe(1);

    // Both notes are on the server again, byte for byte, as another device
    // that syncs now shows.
    expect((await cli("sync", "--dir", b)).code).toBe(0);
    expect(await read(b, "first.md")).toBe("first\n");
    expect(await read(b, "second.md")).toBe("second\n");
    // And a is an ordinary device again.
    expect((await cli("sync", "--dir", a)).code).toBe(0);
  }, 120_000);
});

/**
 * C-D2 in the 0.3.0 review. `NodeVault` has a case probe: it writes a name into
 * the state folder and looks for it under the other spelling, so `canonical`
 * answers for this disk rather than for the worst one. Nothing in the CLI ever
 * called it. Until it runs the answer is "yes, this disk folds case", which is
 * the safe default and the wrong answer on Linux: two notes that differ only in
 * case are then one file to the alias check, both are refused, and every sync
 * exits 1 over a pair the disk is perfectly happy with.
 */
describe("what the disk says about case (C-D2)", () => {
  it("is asked, and is what the vault then goes by", async () => {
    await fresh();
    const { a } = await twoDevices();

    // What this disk actually does, found the way the vault has to find it.
    await writeFile(join(a, "probe-case.md"), "x");
    const folds = await stat(join(a, "PROBE-CASE.md")).then(
      () => true,
      () => false,
    );
    await rm(join(a, "probe-case.md"));

    const probed: string[] = [];
    let asked = 0;
    const real = NodeVault.prototype.probeCase;
    NodeVault.prototype.probeCase = function (this: NodeVault): Promise<void> {
      probed.push("asked");
      return real.call(this);
    };
    let vault: NodeVault;
    try {
      await write(a, "note.md", "one\n");
      // Two files on a case-sensitive disk, one file on a folding one. Either
      // way the sync has to agree with the disk about which it is.
      if (!folds) await write(a, "NOTE.md", "two\n");
      const synced = await cli("sync", "--dir", a);
      expect(synced.code, synced.all).toBe(0);
      expect(synced.all).not.toMatch(/in the way|blocked/i);
      // Counted before this test asks for itself, or the spy would be
      // satisfied by the line below it.
      asked = probed.length;
      vault = new NodeVault(a, {});
      await vault.probeCase();
    } finally {
      NodeVault.prototype.probeCase = real;
    }

    expect(
      asked,
      "nothing asked the disk, so canonical folds case whatever the disk does",
    ).toBeGreaterThan(0);
    // And the probe agrees with the disk it just probed.
    expect(vault.canonical("NOTE.md")).toBe(folds ? "note.md" : "NOTE.md");
  }, 240_000);
});

/**
 * C-D15 in the 0.3.0 review. `parseArgs` collects everything that is not an
 * option into `rest`, and the commands that take no positional never looked.
 * `trew sync ~/notes` synced the current directory and reported that it had
 * synced, which is a wrong vault reported as a right one.
 */
describe("an argument the command does not take", () => {
  it("is refused, rather than ignored", async () => {
    const dir = await vaultDir("a");
    const r = await cli("sync", "/somewhere/else", "--dir", dir);
    expect(r.code).toBe(2);
    expect(r.all).toMatch(/takes no arguments/);
    // And says how the vault is actually chosen, because that is the mistake.
    expect(r.all).toMatch(/--dir/);
  });

  it("is refused past the one a command does take", async () => {
    const dir = await vaultDir("a");
    const r = await cli("restore", "note.md", "also-note.md", "--dir", dir);
    expect(r.code).toBe(2);
    expect(r.all).toMatch(/takes one argument/);
  });

  it("leaves the commands that take one alone", async () => {
    // Not paired, so this gets as far as the argument check and no further:
    // what matters is which complaint comes back.
    const dir = await vaultDir("a");
    const r = await cli("history", "note.md", "--dir", dir);
    expect(r.all).toMatch(/not paired/);
  });
});

/**
 * What the CLI actually prints when something needs a person, which nothing
 * asserted.
 *
 * Two things are being pinned here and they arrived together. The first is the
 * shape: one "need attention" list with a reason against each name, where
 * there used to be three counters and two lists under them. The second is the
 * content of the reason for the one refusal that had no test at all, two
 * spellings that normalize to one name, whose sentence has to spell both names
 * out because they are identical on a terminal. The whole reason `spellOut`
 * exists is that "rename one of them" printed the same string twice and nobody
 * could act on it.
 *
 * The two blocked kinds still ask for different things and still say so, which
 * is what the one list must not lose: two spellings of one name are both on
 * this device so the rename is here, while a file here and a folder elsewhere
 * waits on whichever device meant the other thing. Rule 7 asked for one list,
 * not for one sentence.
 *
 * A unit test on the renderer rather than a real sync, for the reason
 * `vault-spelling.test.ts` gives about the mechanism underneath it: a disk that
 * keeps NFC and NFD apart cannot be mounted on the machine this is written on,
 * so an end-to-end version would self-skip locally and a green run that is not
 * evidence is worse than no run (R9). The engine's side, including that it
 * builds these sentences at all, is covered over a real server in
 * `core/engine.test.ts`; this is the half that turns a report into lines, and
 * it is exported for the same reason `exitCodeFor` is.
 */
describe("what needs attention looks like on the way out", () => {
  const clean: SyncReport = {
    uploaded: 0,
    downloaded: 0,
    merged: 0,
    conflicted: 0,
    deletedLocally: 0,
    deletedRemotely: 0,
    restored: 0,
    foldersCreated: 0,
    unchanged: 3,
    waiting: 0,
    retrying: 0,
    skipped: 0,
    skippedPaths: [],
    retryingPaths: [],
    heldBack: 0,
    heldBackPaths: [],
    ignored: 0,
    blocked: 0,
    inTheWay: [],
    needsAttention: [],
    chunksSent: 0,
    bytesSent: 0,
    reusedChunks: 0,
  };

  /** What `renderReport` writes, given a report. */
  const printed = (r: SyncReport, json = false): string => {
    const out: string[] = [];
    const err: string[] = [];
    const io: Console = { out: (l) => out.push(l), err: (l) => err.push(l) };
    renderReport(r, { json } as Parameters<typeof renderReport>[1], io, 7);
    return out.join("\n") + "\n" + err.join("\n");
  };

  /** The sentences the engine builds, as it builds them. */
  const CLASH =
    '"cafe\\u{301}.md" and "caf\\u{e9}.md" are one name here, and only one of them can sync. ' +
    "Rename one of them here; nothing syncs under that name until you do.";
  const FOLDER =
    '"notes" is a file here and a folder on another device. ' +
    "Rename one of them, on whichever device meant the other thing.";

  it("spells both names out, and says the rename is here", () => {
    const text = printed({
      ...clean,
      blocked: 1,
      inTheWay: [{ path: "café.md", blockedBy: "café.md", why: CLASH }],
      needsAttention: [{ path: "café.md", why: CLASH }],
    });
    expect(text).toMatch(/1 {2}need attention/);
    // The two names are distinguishable on a terminal, which is the property.
    expect(text).toContain("cafe\\u{301}.md");
    expect(text).toContain("caf\\u{e9}.md");
    expect(text).toMatch(/Rename one of them here/);
    // And not the other refusal's advice, which would send somebody to the
    // wrong device.
    expect(text).not.toMatch(/whichever device meant the other thing/);
  });

  it("says the other thing for a file here and a folder elsewhere", () => {
    const text = printed({
      ...clean,
      blocked: 1,
      inTheWay: [{ path: "notes/a.md", blockedBy: "notes" }],
      needsAttention: [{ path: "notes/a.md", why: FOLDER }],
    });
    expect(text).toMatch(/notes\/a\.md: "notes" is a file here and a folder on another device\./);
    expect(text).toMatch(/whichever device meant the other thing/);
    expect(text).not.toMatch(/Rename one of them here/);
  });

  it("keeps the two reasons apart in one list", () => {
    // One list, and still two answers. Collapsing the sentences as well as the
    // counters would tell somebody to do the wrong thing to half of it.
    const text = printed({
      ...clean,
      blocked: 2,
      inTheWay: [
        { path: "notes/a.md", blockedBy: "notes" },
        { path: "café.md", blockedBy: "café.md", why: CLASH },
      ],
      needsAttention: [
        { path: "notes/a.md", why: FOLDER },
        { path: "café.md", why: CLASH },
      ],
    });
    expect(text).toMatch(/2 {2}need attention/);
    expect(text).toMatch(/Rename one of them here/);
    expect(text).toMatch(/whichever device meant the other thing/);
  });

  it("puts every path sharing one reason on one line", () => {
    // One file where a folder belongs blocks a subtree, and four hundred
    // copies of one sentence is a wall rather than a message.
    const text = printed({
      ...clean,
      blocked: 3,
      needsAttention: [
        { path: "notes/b.md", why: FOLDER },
        { path: "notes/a.md", why: FOLDER },
        { path: "notes/c.md", why: FOLDER },
      ],
    });
    expect(text).toContain("notes/a.md, notes/b.md, notes/c.md: ");
    expect(text.match(/is a file here and a folder/g)).toHaveLength(1);
  });

  it("says how many are not shown, because the list is bounded and the count is not", () => {
    const text = printed({
      ...clean,
      blocked: 40,
      needsAttention: [{ path: "notes/a.md", why: FOLDER }],
    });
    expect(text).toMatch(/40 {2}need attention/);
    expect(text).toMatch(/and 39 more\./);
  });

  it("keeps ignored out of it, and still prints it", () => {
    // R2. A path this device is set to ignore is the configuration working, so
    // it is not something to attend to and not in the exit code, and it still
    // has to be visible or somebody loses track of a folder they stopped
    // syncing years ago.
    const text = printed({ ...clean, ignored: 4 });
    expect(text).toMatch(/4 {2}ignored here, and synced by another device/);
    expect(text).not.toMatch(/need attention/);
    expect(exitCodeFor({ ...clean, ignored: 4 })).toBe(0);
  });

  it("says nothing about names when nothing needs a person", () => {
    const text = printed({ ...clean, uploaded: 2 });
    expect(text).not.toMatch(/need attention|Rename/i);
  });

  it("puts the whole report in --json, the reasons included", () => {
    const text = printed(
      { ...clean, blocked: 1, needsAttention: [{ path: "café.md", why: CLASH }] },
      true,
    );
    const parsed = JSON.parse(text.trim()) as { needsAttention: { why: string }[] };
    expect(parsed.needsAttention[0]!.why).toBe(CLASH);
  });
});

/**
 * The usage text and the dispatch, checked against each other.
 *
 * Two lists of the same commands, written by hand, one of which is the only
 * thing most people ever read. A command in the switch and not in the usage is
 * one nobody can find; a command in the usage and not in the switch prints
 * "no such command" at somebody who typed exactly what they were told to. This
 * caught neither when it was written, which is the point of adding it before
 * one of them happens.
 */
describe("the commands", () => {
  it("are the same in the usage text and in the dispatch", async () => {
    const source = await readFile(fileURLToPath(new URL("./cli.ts", import.meta.url)), "utf8");

    // The dispatch, between `switch (args.command) {` and its `default:`.
    const from = source.indexOf("switch (args.command) {");
    const to = source.indexOf("default:", from);
    expect(from, "the dispatch switch has moved, so this is checking nothing").toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const dispatched = new Set(
      [...source.slice(from, to).matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]!),
    );

    // The usage, from the lines that begin `  trew <word>`, minus the
    // options that are listed among them because that is where somebody looks
    // for them.
    const documented = new Set(
      [...USAGE.matchAll(/^ {2}trew (--?[a-z-]+|[a-z][a-z-]*)/gm)]
        .map((m) => m[1]!)
        .filter((word) => !word.startsWith("-")),
    );

    expect([...documented].sort()).toEqual([...dispatched].sort());
    // And there really are some, so an empty pair of sets cannot pass.
    expect(dispatched.size).toBeGreaterThan(10);
  });

  /**
   * The commands and options of the design that had a vault key are gone,
   * and gone loudly: a script still calling one is told so, rather than
   * having a flag it relied on ignored.
   */
  it("refuses the commands and options that went with the vault key", async () => {
    for (const command of ["init", "rotate", "rebase", "recovery-key"]) {
      const r = await cli(command);
      expect(r.code, command).toBe(2);
      expect(r.all, command).toMatch(new RegExp(`no such command: ${command}`));
      expect(USAGE, command).not.toMatch(new RegExp(`trew ${command}\\b`));
    }
    for (const flag of [
      "--recovery-key",
      "--allow-last",
      "--backup-taken",
      "--server",
      "--token",
      "--vault-id",
    ]) {
      expect(() => parseArgs(["sync", flag]), flag).toThrow(new RegExp(`no such option: ${flag}`));
    }
    expect(USAGE).not.toMatch(/recovery key|rotat|data key|seal|HOST:PORT#TOKEN|start a new vault/i);
    // And it says where the first device's invite is.
    expect(USAGE).toMatch(/<data>\/first-invite/);
  });
});

/**
 * The default device name, on a machine with a long hostname.
 *
 * Found by CI rather than here: a runner whose hostname is sixty-one
 * characters produced a sixty-six byte default, the server refuses anything
 * over sixty-four, and every pairing test on that runner failed with
 * "the device name is 66 bytes". Nobody had chosen that name -- it is the
 * hostname plus a random tail -- so `trew init` failed on a machine whose
 * only unusual property was what it is called.
 *
 * The split is between a name somebody typed and one this program derived. A
 * typed name is theirs and a long one is refused, because it goes beside their
 * notes in a conflict copy and handing back a different one is worse than
 * saying no. A derived one is nobody's, so it is cut to fit.
 */
describe("the device name it makes up", () => {
  const bytes = (s: string) => new TextEncoder().encode(s).length;

  it("fits the server's limit however long the hostname is", () => {
    for (const hostname of ["a".repeat(200), "a".repeat(64), "a".repeat(59), "short"]) {
      const args = parseArgs(["pair", "--dir", "/tmp/x"]);
      const made = deviceNameFor({ ...args, device: hostname, deviceGiven: false });
      expect(
        bytes(made),
        `a ${hostname.length}-character hostname made a ${bytes(made)}-byte name`,
      ).toBeLessThanOrEqual(MAX_NAME_BYTES);
      // And it is still a name, with the tail that tells two identical
      // laptops apart.
      expect(made).toMatch(/-[0-9a-f]{4}$/);
    }
  });

  it("never cuts a character in half", () => {
    // Bytes rather than characters is what the server counts, and a name cut
    // at a byte offset can end in half a codepoint, which is a name no two
    // devices would spell the same way.
    const made = deviceNameFor({
      ...parseArgs(["pair", "--dir", "/tmp/x"]),
      device: "é".repeat(100),
      deviceGiven: false,
    });
    expect(bytes(made)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(made).not.toContain("\uFFFD");
    expect([...made].every((c) => c === "é" || /[-0-9a-f]/.test(c))).toBe(true);
  });

  it("still refuses a long name somebody typed, rather than shortening it", () => {
    const typed = "a".repeat(200);
    const made = deviceNameFor({
      ...parseArgs(["pair", "--dir", "/tmp/x"]),
      device: typed,
      deviceGiven: true,
    });
    expect(made, "a name the person chose was quietly changed").toBe(typed);
    expect(() => checkName("device", made)).toThrow(/at most 64/);
  });
});
