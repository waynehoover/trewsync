import { afterEach, expect, it } from "vitest";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "../core/client.ts";
import { TestServer } from "../core/test-server.ts";
import { device, fingerprint, settle, tidy } from "./harness.ts";

let server: TestServer;
const open: Client[] = [];
const dirs: string[] = [];
afterEach(async () => tidy(open, dirs, server));

it.each(["deleted", "moved"] as const)(
  "a local rename preserves its content when the destination was %s",
  async (destination) => {
    server = new TestServer();
    await server.start();
    const a = await device(server, "writer", dirs, open);
    await writeFile(join(a.dir, "a.md"), "ALPHA ORIGINAL MUST SURVIVE\n");
    await writeFile(join(a.dir, "b.md"), "BRAVO ORIGINAL MUST SURVIVE\n");
    await settle([a]);
    const b = await device(server, "reader", dirs, open);
    await settle([b]);

    if (destination === "deleted") {
      await rm(join(a.dir, "b.md"));
      await settle([a, b]);
    } else {
      await rename(join(a.dir, "b.md"), join(a.dir, "c.md"));
      await a.c.noteRename("b.md", "c.md");
    }
    await rename(join(a.dir, "a.md"), join(a.dir, "b.md"));
    await a.c.noteRename("a.md", "b.md");
    await settle([a, b]);
    const fresh = await device(server, "fresh", dirs, open);
    await settle([fresh]);

    for (const d of [a, b, fresh]) {
      const contents = await Promise.all(
        [...(await fingerprint(d.dir)).keys()].map((path) => readFile(join(d.dir, path), "utf8")),
      );
      expect(contents.join("\n"), "the moved content must remain discoverable").toContain(
        "ALPHA ORIGINAL MUST SURVIVE",
      );
      expect(await readFile(join(d.dir, "b.md"), "utf8")).toBe("ALPHA ORIGINAL MUST SURVIVE\n");
      if (destination === "moved")
        expect(await readFile(join(d.dir, "c.md"), "utf8")).toBe("BRAVO ORIGINAL MUST SURVIVE\n");
    }
  },
);

it("swapping two names before sync preserves the chosen names on every client", async () => {
  server = new TestServer();
  await server.start();
  const a = await device(server, "writer", dirs, open);
  await writeFile(join(a.dir, "a.md"), "ALPHA\n");
  await writeFile(join(a.dir, "b.md"), "BRAVO\n");
  await settle([a]);
  const b = await device(server, "reader", dirs, open);
  await settle([b]);
  for (const [from, to] of [
    ["a.md", "temporary.md"],
    ["b.md", "a.md"],
    ["temporary.md", "b.md"],
  ] as const) {
    await rename(join(a.dir, from), join(a.dir, to));
    await a.c.noteRename(from, to);
  }
  await settle([a, b]);
  const fresh = await device(server, "fresh", dirs, open);
  await settle([fresh]);
  for (const d of [a, b, fresh]) {
    expect([...(await fingerprint(d.dir)).keys()].sort()).toEqual(["a.md", "b.md"]);
    expect(await readFile(join(d.dir, "a.md"), "utf8")).toBe("BRAVO\n");
    expect(await readFile(join(d.dir, "b.md"), "utf8")).toBe("ALPHA\n");
  }
});

it("a peer edit to the occupied destination survives a compound local move", async () => {
  server = new TestServer();
  await server.start();
  const a = await device(server, "writer", dirs, open);
  await writeFile(join(a.dir, "a.md"), "ALPHA\n");
  await writeFile(join(a.dir, "b.md"), "BRAVO\n");
  await settle([a]);
  const b = await device(server, "peer", dirs, open);
  await settle([b]);
  await rename(join(a.dir, "b.md"), join(a.dir, "c.md"));
  await a.c.noteRename("b.md", "c.md");
  await rename(join(a.dir, "a.md"), join(a.dir, "b.md"));
  await a.c.noteRename("a.md", "b.md");
  await writeFile(join(b.dir, "b.md"), "BRAVO PEER EDIT\n");
  await settle([b]);
  await settle([a, b]);
  const fresh = await device(server, "fresh", dirs, open);
  await settle([fresh]);
  for (const d of [a, b, fresh]) {
    const contents = await Promise.all(
      [...(await fingerprint(d.dir)).keys()].map((path) => readFile(join(d.dir, path), "utf8")),
    );
    expect(contents.join("\n")).toContain("ALPHA\n");
    expect(contents.join("\n")).toContain("BRAVO PEER EDIT\n");
    expect(await readFile(join(d.dir, "c.md"), "utf8")).toBe("BRAVO\n");
  }
});
