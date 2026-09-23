/** Native editor acceptance. Loaded only by scripts/open-note-smoke.mjs. */
import { MarkdownView, Plugin, type WorkspaceLeaf } from "obsidian";
import { writeFileSync } from "fs";
import { plainDigest } from "../../client/src/core/crypto.ts";
import { ObsidianVault } from "../../client/src/plugin/vault.ts";

declare const RESULT_PATH: string;
declare const NATIVE_WRITES: boolean;

function check(ok: unknown, why: string): asserts ok {
  if (!ok) throw new Error(why);
}

/** Observe real editor changes; the timer only bounds a failed observation. */
function rendered(leaf: WorkspaceLeaf, matches: () => boolean): Promise<void> {
  if (matches()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = () => {
      if (!matches()) return;
      observer.disconnect();
      clearTimeout(timer);
      resolve();
    };
    const observer = new MutationObserver(finish);
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error("The open editor did not receive the update"));
    }, 5000);
    observer.observe(leaf.view.containerEl, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    finish();
  });
}

export default class OpenNoteSmoke extends Plugin {
  override async onload(): Promise<void> {
    const result: Record<string, unknown> = {};
    const previousLeaf = this.app.workspace.activeLeaf;
    const leaves: WorkspaceLeaf[] = [];
    const path = `TrewSync editor check ${Date.now()}.md`;
    const kept = path.replace(".md", " (kept).md");
    const enc = new TextEncoder();
    const renames: string[] = [];
    const event = this.app.vault.on("rename", (file, from) => {
      if (from === path) renames.push(file.path);
    });
    try {
      const file = await this.app.vault.create(path, "# Editor check\n\nOriginal text.\n");
      for (let i = 0; i < 2; i++) {
        const leaf = this.app.workspace.getLeaf("tab");
        leaves.push(leaf);
        await leaf.openFile(file, { state: { mode: "source" } });
        check(leaf.view instanceof MarkdownView, "Expected a Markdown editor");
        leaf.view.editor.setCursor({ line: 1, ch: 0 });
      }
      const views = leaves.map((leaf) => leaf.view as MarkdownView);
      const vault = new ObsidianVault(this.app.vault, this.app.vault.configDir);
      const replace = async (before: string, next: string) => {
        const times = { mtime: Date.now(), ctime: file.stat.ctime };
        if (NATIVE_WRITES) {
          // Control: the public write API used by official Sync's merge path.
          await this.app.vault.modify(file, next, times);
          return { landed: true, keptAt: undefined };
        }
        return vault.replace(
          path,
          { contentId: await plainDigest(enc.encode(before)), idOf: plainDigest },
          enc.encode(next),
          times,
          kept,
        );
      };
      result.mode = NATIVE_WRITES ? "native Vault.modify control" : "TrewSync";
      const samples: number[] = [];
      for (let i = 0; i < 12; i++) {
        const before = await this.app.vault.read(file);
        const next = before + `Incoming paragraph ${i}.\n`;
        const started = performance.now();
        const written = await replace(before, next);
        check(written.landed && !written.keptAt, "An ordinary update created a conflict");
        for (const [j, view] of views.entries()) {
          check(view.file === file && file.path === path, "An open editor changed file identity");
          await rendered(leaves[j]!, () => view.editor.getValue() === next);
          check(
            view.editor.getCursor().line === 1 && view.editor.getCursor().ch === 0,
            "An incoming append moved the cursor",
          );
        }
        samples.push(Number((performance.now() - started).toFixed(2)));
      }
      check(renames.length === 0, "A normal update emitted a rename");
      result.splitViews = true;
      result.cursorPreserved = true;
      result.nativeUpdateMs = samples;

      // Type without waiting for autosave, then receive a disjoint remote edit.
      const before = await this.app.vault.read(file);
      const remote = before.replace("Original text.", "Text edited remotely.");
      const editor = views[0]!.editor;
      editor.replaceRange("Local unsaved paragraph.\n", { line: editor.lastLine(), ch: 0 });
      const written = await replace(before, remote);
      check(written.landed && !written.keptAt, "Unsaved typing caused a needless conflict");
      const both = () =>
        editor.getValue().includes("Local unsaved paragraph.") &&
        editor.getValue().includes("Text edited remotely.");
      await rendered(leaves[0]!, both);
      await views[0]!.save();
      const combined = await this.app.vault.read(file);
      check(combined === editor.getValue() && both(), "An edit was lost when the buffer saved");
      await rendered(leaves[1]!, () => views[1]!.editor.getValue() === combined);
      result.unsavedEditsPreserved = true;
      editor.undo();
      // Obsidian includes external replacements in its undo history. Record
      // that behavior in both modes, and verify that redo restores every edit.
      result.undoIncludesRemoteEdit = !editor.getValue().includes("Text edited remotely.");
      editor.redo();
      check(editor.getValue() === combined, "Undo/redo lost edited text");
      result.undoRedoPreserved = true;
      await views[0]!.save();
      check(!(await this.app.vault.adapter.exists(kept)), "A temporary conflict copy remained");
      result.ok = true;
    } catch (error) {
      result.ok = false;
      result.error = String(error);
    } finally {
      this.app.vault.offref(event);
      for (const leaf of leaves) {
        if (leaf.view instanceof MarkdownView) await leaf.view.save();
        leaf.detach();
      }
      for (const name of [path, kept]) {
        const file = this.app.vault.getAbstractFileByPath(name);
        if (file) await this.app.vault.trash(file, false);
      }
      if (previousLeaf) this.app.workspace.setActiveLeaf(previousLeaf);
      writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2));
    }
  }
}
