import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeVault } from "./vault.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), readdir: vi.fn(actual.readdir) };
});

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "telimus-snapshot-")));
});
afterEach(async () => {
  vi.mocked(open).mockRestore();
  vi.mocked(readdir).mockRestore();
  await chmod(root, 0o700);
  await rm(root, { recursive: true, force: true });
});
const enc = new TextEncoder();
const normalForm = (name: string): string => name.normalize("NFC").replaceAll("~", "");

async function note(
  path = "note.md",
  content: string | Uint8Array = "private note\n",
): Promise<void> {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), content);
}

async function inventory(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const name of (await readdir(root, { recursive: true })).sort()) {
    const info = await lstat(join(root, name));
    if (info.isFile()) files[name] = (await readFile(join(root, name))).toString("hex");
  }
  return files;
}

describe("a model-addressable snapshot", () => {
  it.each([
    ["ſ", "s"],
    ["s", "ſ"],
    ["ς", "Σ"],
    ["Σ", "ς"],
    ["ﬀ", "ff"],
    ["ff", "ﬀ"],
    ["ẞ", "ß"],
    ["ß", "ss"],
  ])("does not create an absent excluded %s through %s", async (configured, requested) => {
    const vault = new NodeVault(root, { configDir: configured });
    const operation = async (): Promise<void> => {
      const checked = await vault.checkPath(`${requested}/new.md`, { allowMissing: true });
      await vault.create(checked.path, enc.encode("must not enter excluded state"), {
        mtime: 1,
        ctime: 1,
      });
    };
    await expect(operation()).rejects.toThrow(/excluded/);
    expect(await readdir(root)).toEqual([]);
  });

  it.each([
    ["Σ", "ς"],
    ["s", "ſ"],
    ["ff", "ﬀ"],
    ["ss", "ß"],
  ])("refuses the filesystem's excluded alias %s / %s", async (configured, requested) => {
    await note(`${configured}/note.md`, "excluded credential");
    const vault = new NodeVault(root, { configDir: configured });
    const before = await inventory();
    await expect(vault.readSnapshot(`${requested}/note.md`, 1024)).rejects.toThrow(
      /excluded|alias|ENOENT/,
    );
    expect(await inventory()).toEqual(before);
  });

  it.each([
    ["Private", "private"],
    ["ς", "Σ"],
    ["ſ", "s"],
    ["ﬀ", "ff"],
    ["ß", "ss"],
  ])("conservatively excludes %s physically filed as %s", async (configured, actual) => {
    await note(`${actual}/note.md`, "excluded on a folding filesystem");
    const vault = new NodeVault(root, { configDir: configured });
    await vault.probeCase();
    const before = await inventory();
    await expect(vault.readSnapshot(`${actual}/note.md`, 1024)).rejects.toThrow(/excluded/);
    await expect(vault.checkPath(`${actual}/new.md`, { allowMissing: true })).rejects.toThrow(
      /excluded/,
    );
    expect(await inventory()).toEqual(before);
  });

  it("retains every byte, including BOM and CRLF, and hashes the complete source", async () => {
    const bytes = enc.encode("\ufeff---\r\ntitle: Day\r\n---\r\n\r\n- [ ] café\r\n");
    await note("cafe\u0301.md", bytes);
    const before = await inventory();
    const snapshot = await new NodeVault(root).readSnapshot("café.md", bytes.length);
    expect(snapshot.path).toBe("café.md");
    expect(snapshot.bytes).toEqual(bytes);
    expect(snapshot.size).toBe(bytes.length);
    expect(snapshot.base).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(snapshot.mtime).toBeGreaterThan(0);
    expect(snapshot.ctime).toBeGreaterThan(0);
    expect(await inventory()).toEqual(before);
  });

  it.each(["alias/secret.md", "secret.md"])("refuses an in-vault link at %s", async (path) => {
    await note(".telimus/secret.md", "a device credential");
    await symlink(join(root, ".telimus"), join(root, "alias"));
    await symlink(join(root, ".telimus/secret.md"), join(root, "secret.md"));
    const before = await inventory();
    await expect(new NodeVault(root).readSnapshot(path, 1024)).rejects.toThrow(/link/);
    expect(await inventory()).toEqual(before);
  });

  it("refuses an ancestor changed to a link after a previous ordinary read", async () => {
    await note("folder/note.md", "public");
    await note(".telimus/note.md", "credential");
    const vault = new NodeVault(root);
    await vault.read("folder/note.md");
    await rename(join(root, "folder"), join(root, "parked"));
    await symlink(join(root, ".telimus"), join(root, "folder"));
    const before = await inventory();
    await expect(vault.readSnapshot("folder/note.md", 1024)).rejects.toThrow(/link/);
    expect(await inventory()).toEqual(before);
  });

  it.each(["Settings/note.md", "settings/note.md", "deep/SETTINGS/note.md"])(
    "refuses custom excluded-name aliases at %s",
    async (path) => {
      await note(path);
      const before = await inventory();
      const vault = new NodeVault(root, { configDir: "Settings" });
      await expect(vault.readSnapshot(path, 1024)).rejects.toThrow(/excluded|ignore/);
      expect(await inventory()).toEqual(before);
    },
  );

  it.each([
    "",
    "/note.md",
    "C:/note.md",
    "\\\\server\\note.md",
    "folder/../note.md",
    "./note.md",
    "folder//note.md",
    "note.md/",
    "note.md\0",
  ])("does not turn an invalid path %j into another request", async (path) => {
    await note();
    const before = await inventory();
    await expect(new NodeVault(root).readSnapshot(path, 1024)).rejects.toThrow(/path/);
    expect(await inventory()).toEqual(before);
  });

  it("detects a new normalization collision after caching an ordinary read", async () => {
    await note("cafe.md", "first");
    const vault = new NodeVault(root, { normalForm });
    await vault.read("cafe.md");
    await note("cafe~.md", "second");
    const before = await inventory();
    await expect(vault.readSnapshot("cafe.md", 1024)).rejects.toThrow(/ambiguous/);
    expect(await inventory()).toEqual(before);
  });

  it("rejects ambiguous ancestor spellings without normalizing the directory", async () => {
    await note("folder/note.md", "first");
    await note("folder~/note.md", "second");
    const before = await inventory();
    await expect(
      new NodeVault(root, { normalForm }).readSnapshot("folder/note.md", 1024),
    ).rejects.toThrow(/ambiguous/);
    expect(await inventory()).toEqual(before);
  });

  it("uses the newly observed disk spelling instead of a previous cache entry", async () => {
    await note("cafe~.md", "first");
    const vault = new NodeVault(root, { normalForm });
    await vault.read("cafe.md");
    await rename(join(root, "cafe~.md"), join(root, "ca~fe.md"));
    expect((await vault.readSnapshot("cafe.md", 1024)).bytes).toEqual(enc.encode("first"));
    expect(await readdir(root)).toEqual(["ca~fe.md"]);
  });

  it("allows a root alias without allowing child links", async () => {
    await note("real/note.md");
    await symlink(join(root, "real"), join(root, "alias"));
    expect((await new NodeVault(join(root, "alias")).readSnapshot("note.md", 1024)).bytes).toEqual(
      enc.encode("private note\n"),
    );
  });

  it("keeps an unreadable file distinct from an absent local file", async () => {
    await note();
    const vault = new NodeVault(root);
    await expect(vault.readSnapshot("missing.md", 1024)).rejects.toMatchObject({ code: "ENOENT" });
    await chmod(join(root, "note.md"), 0);
    try {
      await expect(vault.readSnapshot("note.md", 1024)).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await chmod(join(root, "note.md"), 0o600);
    }
    expect(await readFile(join(root, "note.md"), "utf8")).toBe("private note\n");
  });

  it("refuses directories and FIFOs before opening them", async () => {
    await mkdir(join(root, "directory.md"));
    await promisify(execFile)("mkfifo", [join(root, "pipe.md")]);
    const called = vi.mocked(open);
    await expect(new NodeVault(root).readSnapshot("directory.md", 1024)).rejects.toThrow(/regular/);
    await expect(new NodeVault(root).readSnapshot("pipe.md", 1024)).rejects.toThrow(/regular/);
    expect(called).not.toHaveBeenCalled();
  });

  it("refuses a large source without asking readFile to allocate its body", async () => {
    await note("note.md", "x".repeat(4096));
    const before = await inventory();
    await expect(new NodeVault(root).readSnapshot("note.md", 32)).rejects.toThrow(/large/);
    expect(await inventory()).toEqual(before);
  });

  it("never reads more than the cap plus one byte when a file grows", async () => {
    await note("note.md", "tiny");
    const realOpen = vi.mocked(open).getMockImplementation()!;
    let total = 0;
    let grew = false;
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (String(args[0]).endsWith("note.md")) {
        const read = handle.read.bind(handle);
        handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
          if (!grew) {
            grew = true;
            await appendFile(join(root, "note.md"), "x".repeat(4096));
          }
          const result = await read(...readArgs);
          total += result.bytesRead;
          return result;
        }) as typeof handle.read;
      }
      return handle;
    });
    await expect(new NodeVault(root).readSnapshot("note.md", 32)).rejects.toThrow(/large|changed/);
    expect(grew).toBe(true);
    expect(total).toBeLessThanOrEqual(33);
    expect((await readFile(join(root, "note.md"))).length).toBe(4100);
  });

  it("does not return bytes from a name swapped between checking and opening", async () => {
    await note("folder/note.md", "public");
    await note(".telimus/note.md", "credential");
    const realOpen = vi.mocked(open).getMockImplementation()!;
    let swapped = false;
    vi.mocked(open).mockImplementation(async (...args) => {
      if (!swapped && String(args[0]).endsWith("folder/note.md")) {
        swapped = true;
        await rename(join(root, "folder"), join(root, "saved"));
        await symlink(join(root, ".telimus"), join(root, "folder"));
      }
      return realOpen(...args);
    });
    await expect(new NodeVault(root).readSnapshot("folder/note.md", 1024)).rejects.toThrow(
      /changed|link/,
    );
    expect(swapped).toBe(true);
    expect(await readFile(join(root, "saved/note.md"), "utf8")).toBe("public");
  });

  it("detects an equal-size edit during the read even when its mtime is restored", async () => {
    await note("note.md", "before");
    const stamp = await lstat(join(root, "note.md"));
    const realOpen = vi.mocked(open).getMockImplementation()!;
    let edited = false;
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (String(args[0]).endsWith("note.md")) {
        const read = handle.read.bind(handle);
        handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
          const result = await read(...readArgs);
          if (!edited) {
            edited = true;
            await writeFile(join(root, "note.md"), "edited");
            await utimes(join(root, "note.md"), stamp.atime, stamp.mtime);
          }
          return result;
        }) as typeof handle.read;
      }
      return handle;
    });
    await expect(new NodeVault(root).readSnapshot("note.md", 1024)).rejects.toThrow(/changed/);
    expect(edited).toBe(true);
    expect(await readFile(join(root, "note.md"), "utf8")).toBe("edited");
  });

  it("does not block on a FIFO that takes the name just before open", async () => {
    await note();
    const realOpen = vi.mocked(open).getMockImplementation()!;
    let swapped = false;
    vi.mocked(open).mockImplementation(async (...args) => {
      if (!swapped && String(args[0]).endsWith("note.md")) {
        swapped = true;
        await rename(join(root, "note.md"), join(root, "saved.md"));
        await promisify(execFile)("mkfifo", [join(root, "note.md")]);
      }
      if (String(args[0]).endsWith("note.md") && !(Number(args[1]) & constants.O_NONBLOCK)) {
        throw new Error("opening this FIFO would block the process");
      }
      return realOpen(...args);
    });
    await expect(new NodeVault(root).readSnapshot("note.md", 1024)).rejects.toThrow(/changed/);
    expect(swapped).toBe(true);
    expect(await readFile(join(root, "saved.md"), "utf8")).toBe("private note\n");
  }, 2000);

  it("refreshes the writer's spelling before exclusive creation", async () => {
    await note("ca~fe.md", "original");
    const vault = new NodeVault(root, { normalForm });
    await vault.read("cafe.md");
    await rename(join(root, "ca~fe.md"), join(root, "cafe~.md"));
    expect(await vault.checkPath("cafe.md", { allowMissing: true })).toEqual({
      path: "cafe.md",
      exists: true,
    });
    expect(await vault.create("cafe.md", enc.encode("replacement"), { mtime: 1, ctime: 1 })).toBe(
      false,
    );
    expect(await readFile(join(root, "cafe~.md"), "utf8")).toBe("original");
    expect((await readdir(root)).filter((name) => !name.startsWith("."))).toEqual(["cafe~.md"]);
  });

  it("checks missing destinations and their ancestors without creating directories", async () => {
    await note(".telimus/token.md", "secret");
    await symlink(join(root, ".telimus"), join(root, "alias"));
    const vault = new NodeVault(root);
    const before = await inventory();
    await expect(vault.checkPath("alias/new/note.md", { allowMissing: true })).rejects.toThrow(
      /link/,
    );
    await expect(vault.checkPath(".telimus/new/note.md", { allowMissing: true })).rejects.toThrow(
      /excluded/,
    );
    expect(await vault.checkPath("new/folder/note.md", { allowMissing: true })).toEqual({
      path: "new/folder/note.md",
      exists: false,
    });
    expect(await inventory()).toEqual(before);
    expect(await readdir(root)).not.toContain("new");
  });

  it.each([1, 2])("refuses a link introduced during destination walk %i", async (walk) => {
    await mkdir(join(root, "folder"));
    await mkdir(join(root, ".telimus"));
    const realReadDir = vi.mocked(readdir).getMockImplementation()!;
    let swapped = false;
    let walks = 0;
    vi.mocked(readdir).mockImplementation(async (...args) => {
      if (String(args[0]) === join(root, "folder")) walks++;
      if (!swapped && String(args[0]) === join(root, "folder") && walks === walk) {
        swapped = true;
        await rename(join(root, "folder"), join(root, "saved"));
        await symlink(join(root, ".telimus"), join(root, "folder"));
      }
      return realReadDir(...args);
    });
    const vault = new NodeVault(root);
    const operation = async (): Promise<void> => {
      const checked = await vault.checkPath("folder/new.md", { allowMissing: true });
      await vault.create(checked.path, enc.encode("must not reach excluded state"), {
        mtime: 1,
        ctime: 1,
      });
    };
    await expect(operation()).rejects.toThrow(/link|changed/);
    expect(swapped).toBe(true);
    await expect(readFile(join(root, ".telimus/new.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
