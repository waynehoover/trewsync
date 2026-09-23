/**
 * Folder operations on three devices, at random, with notes being written
 * inside the folders and devices going offline (docs/design.md, "Folders").
 *
 * Folder deletions travel, and a device receiving one removes the folder only
 * if nothing is left in it. The ways that could lose a note are all about
 * timing: a note written offline into a folder another device deleted, an
 * edit racing a rename, a deletion arriving before the files it follows. So
 * this does not script an ordering. It makes folders, renames them, empties
 * and deletes them, writes and edits notes in them, and takes devices away
 * and brings them back, from a fixed seed, and then asks two things of the
 * result.
 *
 * No note is lost to a folder operation. Every line a device wrote is on
 * every device at the end, in some note or conflict copy, unless a person
 * deleted a file holding it while it was on that person's screen: a folder
 * deleted with its notes on the device that deleted it. A folder deletion
 * arriving from elsewhere deletes nothing, so a line written anywhere that
 * device could not see must survive.
 *
 * No empty folder survives a deletion that nothing kept. After the random
 * phase one device deletes every empty folder it has, as somebody tidying up
 * does, and at the end every device holds the same folders and no empty one,
 * except a folder a file nobody syncs is in, on some device, which keeps it.
 */

import { afterEach, expect, it } from "vitest";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Client } from "../core/client.ts";
import { TestServer } from "../core/test-server.ts";
import { device, reopen, settle, tidy, type Device } from "./harness.ts";

let server: TestServer;
const open: Client[] = [];
const dirs: string[] = [];
afterEach(async () => tidy(open, dirs, server));

/** The folder names this draws from: few, so devices keep meeting in the same ones. */
const NAMES = ["Projects", "Archive", "Inbox", "Old", "New", "Journal"];

/** A small deterministic generator, so a failure is a seed to rerun. */
function generator(seed: number): (n: number) => number {
  let state = seed >>> 0 || 1;
  return (n) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % n;
  };
}

/** Every visible folder and file under a vault: nothing the client keeps, nothing dot-prefixed. */
async function walk(dir: string): Promise<{ folders: string[]; files: string[] }> {
  const folders: string[] = [];
  const files: string[] = [];
  const go = async (under: string): Promise<void> => {
    for (const e of await readdir(join(dir, under), { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const path = under ? `${under}/${e.name}` : e.name;
      if (e.isDirectory()) {
        folders.push(path);
        await go(path);
      } else if (e.isFile()) files.push(path);
    }
  };
  await go("");
  return { folders: folders.sort(), files: files.sort() };
}

/** Every file under a folder on the disk, dot-prefixed ones included. */
async function everythingIn(dir: string, folder: string): Promise<string[]> {
  const out: string[] = [];
  const go = async (under: string): Promise<void> => {
    for (const e of await readdir(join(dir, under), { withFileTypes: true })) {
      const path = `${under}/${e.name}`;
      if (e.isDirectory()) await go(path);
      else out.push(path);
    }
  };
  await go(folder);
  return out;
}

const MARK = /line-[a-z]+-\d+-\d+/g;

interface Slot {
  readonly name: string;
  readonly dir: string;
  device: Device | undefined;
}

async function scenario(seed: number): Promise<void> {
  const pick = generator(seed);
  server = new TestServer();
  await server.start();
  const slots: Slot[] = [];
  for (const name of ["mac", "phone", "linux"]) {
    const d = await device(server, name, dirs, open);
    slots.push({ name, dir: d.dir, device: d });
  }

  /** Every line written, and the ones a person deleted while holding them. */
  const written = new Set<string>();
  const deliberatelyDeleted = new Set<string>();
  let counter = 0;
  const line = (who: string) => {
    const mark = `line-${who}-${seed}-${++counter}`;
    written.add(mark);
    return `${mark}\n`;
  };

  const online = () => slots.filter((s) => s.device !== undefined).map((s) => s.device!);

  async function act(slot: Slot): Promise<void> {
    const { folders, files } = await walk(slot.dir);
    const choice = pick(100);
    if (choice < 30) {
      // A note, in a folder this device has or in a new one.
      const folder =
        folders.length > 0 && pick(3) > 0
          ? folders[pick(folders.length)]!
          : NAMES[pick(NAMES.length)]! + (pick(3) === 0 ? `/${NAMES[pick(NAMES.length)]}` : "");
      const path = `${folder}/note-${slot.name}-${counter}.md`;
      await mkdir(join(slot.dir, folder), { recursive: true });
      await writeFile(join(slot.dir, path), line(slot.name));
    } else if (choice < 50 && files.length > 0) {
      await appendFile(join(slot.dir, files[pick(files.length)]!), line(slot.name));
    } else if (choice < 58) {
      await mkdir(join(slot.dir, NAMES[pick(NAMES.length)]!, NAMES[pick(NAMES.length)]!), {
        recursive: true,
      });
    } else if (choice < 72 && folders.length > 0) {
      // A folder renamed, with everything in it, the way a file manager does.
      const from = folders[pick(folders.length)]!;
      const to = `${dirname(from) === "." ? "" : `${dirname(from)}/`}${NAMES[pick(NAMES.length)]}`;
      if (to === from || to.startsWith(`${from}/`) || folders.includes(to) || files.includes(to))
        return;
      await rename(join(slot.dir, from), join(slot.dir, to));
      // Reported sometimes, as Obsidian would; found by the scan otherwise.
      if (slot.device !== undefined && pick(2) === 0) await slot.device.c.noteRename(from, to);
    } else if (choice < 86 && folders.length > 0) {
      // An empty folder deleted, if this device has one.
      const empty = [];
      for (const f of folders) {
        if ((await readdir(join(slot.dir, f))).length === 0) empty.push(f);
      }
      if (empty.length > 0) await rmdir(join(slot.dir, empty[pick(empty.length)]!));
    } else if (choice < 95 && folders.length > 0) {
      // A folder deleted with its notes: the person saw every line in it.
      const doomed = folders[pick(folders.length)]!;
      for (const file of await everythingIn(slot.dir, doomed)) {
        const text = await readFile(join(slot.dir, file), "utf8");
        for (const mark of text.match(MARK) ?? []) deliberatelyDeleted.add(mark);
      }
      await rm(join(slot.dir, doomed), { recursive: true });
    } else if (folders.length > 0 && slot.name === "linux") {
      // A file nobody syncs, which keeps its folder wherever it is.
      const folder = folders[pick(folders.length)]!;
      await writeFile(join(slot.dir, folder, ".keep"), "never synced\n");
    }
  }

  for (let round = 0; round < 10; round++) {
    for (const slot of slots) {
      // Away for a while, and back.
      if (slot.device !== undefined && pick(5) === 0) {
        await slot.device.c.close();
        slot.device = undefined;
      } else if (slot.device === undefined && pick(2) === 0) {
        slot.device = await reopen(server, slot.name, slot.dir, open);
      }
      for (let n = 1 + pick(3); n > 0; n--) await act(slot);
    }
    await settle(online(), 2);
  }
  for (const slot of slots) {
    slot.device ??= await reopen(server, slot.name, slot.dir, open);
  }
  await settle(online(), 8);

  const lost = async (): Promise<string[]> => {
    const out: string[] = [];
    for (const slot of slots) {
      const { files } = await walk(slot.dir);
      const here = new Set<string>();
      for (const f of files) {
        for (const mark of (await readFile(join(slot.dir, f), "utf8")).match(MARK) ?? []) {
          here.add(mark);
        }
      }
      for (const mark of written) {
        if (!deliberatelyDeleted.has(mark) && !here.has(mark)) out.push(`${slot.name}: ${mark}`);
      }
    }
    return out;
  };
  expect(await lost(), `seed ${seed}: lines lost to a folder operation`).toEqual([]);
  const first = await walk(slots[0]!.dir);
  for (const slot of slots.slice(1)) {
    expect(
      await walk(slot.dir),
      `seed ${seed}: ${slot.name} differs from ${slots[0]!.name}`,
    ).toEqual(first);
  }

  // Tidying up: one device deletes every empty folder it has, deepest first.
  const tidier = slots[0]!;
  for (const folder of [...(await walk(tidier.dir)).folders].reverse()) {
    if ((await readdir(join(tidier.dir, folder))).length === 0) {
      await rmdir(join(tidier.dir, folder));
    }
  }
  await settle(online(), 8);

  expect(await lost(), `seed ${seed}: lines lost while tidying`).toEqual([]);
  // Where a file nobody syncs is now, on any device: renamed along with its
  // folder, or gone with it, since it was written.
  const keepers: string[] = [];
  for (const slot of slots) {
    for (const folder of (await walk(slot.dir)).folders) {
      if ((await readdir(join(slot.dir, folder))).some((name) => name.startsWith("."))) {
        keepers.push(folder);
      }
    }
  }
  const after = await walk(tidier.dir);
  for (const slot of slots) {
    const { folders, files } = await walk(slot.dir);
    expect({ folders, files }, `seed ${seed}: ${slot.name} differs after tidying`).toEqual(after);
    for (const folder of folders) {
      const holds = files.some((f) => f.startsWith(`${folder}/`));
      const kept = keepers.some((k) => k === folder || k.startsWith(`${folder}/`));
      expect(
        holds || kept,
        `seed ${seed}: ${slot.name} kept the empty folder ${folder}, which nothing keeps`,
      ).toBe(true);
    }
  }
}

it.each([1, 2, 3])(
  "no note is lost to a folder operation, and no emptied folder outlives its deletion, seed %i",
  async (seed) => {
    await scenario(seed);
  },
);
