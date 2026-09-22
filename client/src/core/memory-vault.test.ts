/**
 * The in-memory vault answers what the two real adapters answer.
 *
 * It is not a mock: engine tests converge two clients against a real server
 * with only the disk faked, so every destructive path they exercise is this
 * class's version of it. A fake that is wrong in the safe direction lets a
 * defect through, and one wrong in the unsafe direction teaches the engine to
 * guard something that was never true. This class managed both at once, and
 * neither was visible from any engine test, which is why they get a file that
 * looks at the fake itself rather than through it.
 *
 * The behaviour asserted here is read off `cli/vault.ts` and
 * `plugin/vault.ts`, which is where the answers come from.
 */

import { describe, expect, it } from "vitest";

import { plainDigest } from "./crypto.ts";
import { MemoryVault } from "./vault.ts";

const enc = new TextEncoder();
const times = { mtime: 2000, ctime: 1000 };
const expecting = async (text: string) => ({
  contentId: await plainDigest(enc.encode(text)),
  idOf: plainDigest,
});

describe("a write whose destination is taken while it is in flight", () => {
  /**
   * Both real adapters publish with an exclusive create whether or not they
   * displaced anything: the headless client links, the plugin renames, and
   * both refuse an occupied name. So a save that takes a free path first keeps
   * it, and the caller is told the incoming version has nowhere to go.
   */
  it("keeps the competitor's file and says the write did not land", async () => {
    const vault = new MemoryVault();
    vault.nameTakenOnce = enc.encode("typed while the name was free\n");

    const out = await vault.replace(
      "fresh.md",
      undefined,
      enc.encode("the server's version\n"),
      times,
      "fresh (kept).md",
    );

    expect(out.landed, "a write that lost the name was reported as landed").toBe(false);
    expect(vault.text("fresh.md"), "the fake wrote over a competitor and called it a success").toBe(
      "typed while the name was free\n",
    );
  });

  /** And the seam is consumed there, rather than staying armed for the next call. */
  it("does not fire on an unrelated write afterwards", async () => {
    const vault = new MemoryVault();
    vault.nameTakenOnce = enc.encode("typed while the name was free\n");
    await vault.replace("fresh.md", undefined, enc.encode("one\n"), times, "fresh (kept).md");

    const after = await vault.replace(
      "other.md",
      undefined,
      enc.encode("two\n"),
      times,
      "other (kept).md",
    );
    expect(after, "the seam stayed armed and fired on the wrong call").toEqual({ landed: true });
    expect(vault.text("other.md")).toBe("two\n");
  });
});

describe("a removal that is identified after it is taken", () => {
  /**
   * R22, which both real adapters have and this did not. The plugin moves the
   * note into a hidden folder and the headless client renames it beside
   * itself, and only then is it hashed; this identified the file and then
   * deleted it across an await, so a save in that window was destroyed here
   * and kept by both shipped clients.
   */
  it("keeps a save that lands while the removal is deciding", async () => {
    const vault = new MemoryVault();
    const was = "the version the pass decided about\n";
    await vault.write("doomed.md", enc.encode(was), times);

    // The editor, in the window between the file being taken off its name and
    // the removal being carried out.
    vault.midReplace = undefined;
    const expect0 = await expecting(was);
    let saved = false;
    const out = await vault.removeExpecting(
      "doomed.md",
      {
        contentId: expect0.contentId,
        idOf: async (bytes) => {
          if (!saved) {
            saved = true;
            await vault.write("doomed.md", enc.encode("typed during the removal\n"), times);
          }
          return plainDigest(bytes);
        },
      },
      "doomed (kept).md",
    );

    expect(out.landed).toBe(true);
    expect(
      vault.text("doomed.md"),
      "the save made while the removal was deciding was deleted",
    ).toBe("typed during the removal\n");
  });

  /** The ordinary case is unchanged: an agreed deletion is a deletion. */
  it("removes the version the pass decided about", async () => {
    const vault = new MemoryVault();
    const was = "here for now\n";
    await vault.write("doomed.md", enc.encode(was), times);

    const out = await vault.removeExpecting("doomed.md", await expecting(was), "doomed (kept).md");

    expect(out).toEqual({ landed: true });
    expect(vault.text("doomed.md")).toBeUndefined();
    expect(vault.text("doomed (kept).md")).toBeUndefined();
  });

  /** And one it did not decide about is kept, under the name it was given. */
  it("keeps a version it cannot account for", async () => {
    const vault = new MemoryVault();
    await vault.write("doomed.md", enc.encode("an unsent edit\n"), times);

    const out = await vault.removeExpecting(
      "doomed.md",
      await expecting("something else entirely"),
      "doomed (kept).md",
    );

    expect(out.keptAt).toBe("doomed (kept).md");
    expect(vault.text("doomed (kept).md")).toBe("an unsent edit\n");
    expect(vault.text("doomed.md")).toBeUndefined();
  });
});
