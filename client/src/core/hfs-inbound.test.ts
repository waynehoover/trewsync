/**
 * A name an HFS+ disk reads as dot-prefixed, arriving from a peer.
 *
 * HFS+ leaves some invisible code points out when it compares names, so on a
 * Mac with an HFS+ disk `<U+200C>.obsidian` is `.obsidian`, and a peer could
 * write a plugin into this device's settings as an ordinary note, past the
 * dot rule and the Apply dialog. Every device refuses such a name on the way
 * in, as a stranded path with its reason, and never as a deletion. A note
 * already on this device under such a name is the device's own, and keeps
 * syncing as before: the rule never costs a note.
 *
 * The rule itself is checked against the `hfs` section of
 * `protocol-fixtures.json`, which `internal/paths` checks in Go.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { chunkName } from "./digest.ts";
import { HIDDEN_ON_HFS } from "./engine.ts";
import { hiddenOnHFS } from "./path-policy.ts";
import {
  CommittingServer,
  FakeSocket,
  engineOnFakeSocket,
  settle,
} from "../../test/core/fake-socket.ts";
import type { WireEntry } from "./transport.ts";

const fixtures = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "..", "protocol-fixtures.json"), "utf8"),
) as { hfs: { cases: { name: string; path: string; hidden: boolean }[] } };

const enc = new TextEncoder();
const bodies = new Map<string, Uint8Array>();

async function entry(uid: number, path: string, text: string): Promise<WireEntry> {
  const raw = enc.encode(text);
  const name = await chunkName(raw);
  bodies.set(name, raw);
  return {
    uid,
    path,
    size: raw.length,
    ctime: 1000,
    mtime: 1000 + uid,
    folder: false,
    deleted: false,
    chunks: [name],
    device: "mac",
  };
}

function serving(socket: FakeSocket, asked: string[]): void {
  socket.autoReply = (frame, s) => {
    if (frame["op"] === "fetch") {
      const names = frame["chunks"] as string[];
      asked.push(...names);
      s.bodies(...names.map((n) => bodies.get(n)!));
    } else if (frame["op"] === "ping") s.raw({ res: "pong" });
  };
}

async function accepted(engine: { status(): { pending: number } }, n: number): Promise<void> {
  for (let i = 0; i < 400 && engine.status().pending < n; i++) await settle();
}

/** Every put frame this socket sent, with whether it was a deletion. */
function puts(socket: FakeSocket): { path: string; deleted: boolean }[] {
  const out: { path: string; deleted: boolean }[] = [];
  const one = (e: Record<string, unknown>) => {
    const meta = (e["meta"] ?? {}) as Record<string, unknown>;
    out.push({ path: e["path"] as string, deleted: meta["deleted"] === true });
  };
  for (const frame of socket.sentText) {
    if (frame["op"] === "put") one(frame);
    if (frame["op"] === "putmany")
      for (const e of frame["entries"] as Record<string, unknown>[]) one(e);
  }
  return out;
}

const EVIL = "\u200c.obsidian/plugins/evil/main.js";
const KEPT = "\ufeff.notes/kept.md";

describe("a name HFS+ reads as dot-prefixed", () => {
  it("is the reference's verdict for every case", () => {
    expect(fixtures.hfs.cases.length).toBeGreaterThan(9);
    for (const c of fixtures.hfs.cases) expect(hiddenOnHFS(c.path), c.name).toBe(c.hidden);
  });

  it("is stranded on the way in, with its reason, and nothing goes back", async () => {
    const rig = await engineOnFakeSocket();
    const asked: string[] = [];
    serving(rig.socket, asked);
    const entries = [
      await entry(1, EVIL, "code"),
      await entry(2, "\u200c.obsidian/community-plugins.json", '["evil"]'),
      await entry(3, "\u{1f468}\u200d\u{1f469} family.md", "an ordinary note"),
    ];
    rig.socket.raw({ op: "batch", from: 1, to: entries.length, entries });
    await accepted(rig.engine, entries.length);
    const report = await rig.engine.sync({ coalesceWrites: false });

    expect(rig.vault.paths()).toEqual(["\u{1f468}\u200d\u{1f469} family.md"]);
    expect(report.skipped).toBe(2);
    expect(report.retrying).toBe(0);
    expect(report.needsAttention).toContainEqual({ path: EVIL, why: HIDDEN_ON_HFS });
    expect(asked).toEqual([entries[2]!.chunks[0]]);
    expect(puts(rig.socket)).toEqual([]);
  });

  it("keeps a note already on this device under such a name, and syncs it as before", async () => {
    // The note was made here and is on the server, as it would be before the
    // rule: the same bytes on both sides.
    const rig = await engineOnFakeSocket();
    const server = new CommittingServer(rig.socket);
    await rig.vault.write(KEPT, enc.encode("mine\n"), { mtime: 1000, ctime: 1000 });
    const first = await server.version(1, KEPT, "mine\n");
    rig.socket.raw({ op: "batch", from: 1, to: 1, entries: [first] });
    await accepted(rig.engine, 1);
    const report = await rig.engine.sync({ coalesceWrites: false });
    expect(report.needsAttention).toEqual([]);
    expect(rig.vault.text(KEPT)).toBe("mine\n");

    // A peer's edit of it lands, and nothing this device sent deleted it.
    const edit = await server.version(2, KEPT, "mine, edited on the Mac\n", { mtime: 2000 });
    rig.socket.raw({ op: "batch", from: 2, to: 2, entries: [edit] });
    await accepted(rig.engine, 1);
    const again = await rig.engine.sync({ coalesceWrites: false });
    expect(again.needsAttention).toEqual([]);
    expect(again.skipped).toBe(0);
    expect(rig.vault.text(KEPT)).toBe("mine, edited on the Mac\n");
    expect(server.committed.filter((c) => c.deleted)).toEqual([]);
  });
});
