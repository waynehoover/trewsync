import { Modal, Notice, Setting, type App } from "obsidian";
import { diffLines, when } from "./history.ts";
import type { ConflictPair, ConflictReview, ConflictChoice } from "../core/conflicts.ts";

const DIFF_PREVIEW_CHARS = 128 * 1024;

export interface ConflictSource {
  pairs(): ConflictPair[];
  review(pair: ConflictPair): Promise<ConflictReview>;
  resolve(review: ConflictReview, choice: ConflictChoice, edited?: string): Promise<void>;
  open(path: string): void;
}

export class ConflictsModal extends Modal {
  private generation = 0;
  private busy = false;
  private readonly drafts = new Map<string, string>();
  constructor(
    app: App,
    private readonly source: ConflictSource,
  ) {
    super(app);
  }
  override onOpen(): void {
    this.setTitle("Review conflicts");
    this.modalEl.addClass("mod-telimus-conflicts");
    this.list();
  }
  override onClose(): void {
    this.generation++;
    this.contentEl.empty();
  }

  private list(): void {
    this.generation++;
    this.contentEl.empty();
    const pairs = this.source.pairs();
    if (!pairs.length) this.contentEl.createEl("p", { text: "No conflict copies to review." });
    for (const pair of pairs) {
      new Setting(this.contentEl)
        .setName(pair.original)
        .setDesc(pair.copy)
        .addButton((button) =>
          button.setButtonText("Compare").onClick(() => void this.choose(pair)),
        );
    }
  }

  private async choose(pair: ConflictPair, draft?: string): Promise<void> {
    if (draft !== undefined) this.drafts.set(pair.copy, draft);
    draft ??= this.drafts.get(pair.copy);
    const generation = ++this.generation;
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: "Reading both versions…" });
    try {
      const review = await this.source.review(pair);
      if (generation !== this.generation) return;
      this.contentEl.empty();
      new Setting(this.contentEl)
        .setName(review.original)
        .addButton((button) =>
          button.setButtonText("Refresh").onClick(() => void this.choose(pair, edited)),
        )
        .addButton((button) => button.setButtonText("Back").onClick(() => this.list()));
      for (const [name, file] of [
        ["Original", review.current],
        ["Preserved copy", review.preserved],
      ] as const) {
        new Setting(this.contentEl)
          .setName(name)
          .setDesc(
            file
              ? `${file.path} · ${when(file.stat.mtime)} · ${file.stat.size.toLocaleString()} bytes`
              : "No longer present",
          )
          .addButton((button) =>
            button
              .setButtonText("Open")
              .setDisabled(!file)
              .onClick(() => {
                if (file) {
                  this.close();
                  this.source.open(file.path);
                }
              }),
          );
      }
      let edited: string | undefined = draft;
      let editControls: HTMLElement | undefined;
      let editor: HTMLTextAreaElement | undefined;
      const text = review.current?.text !== undefined && review.preserved.text !== undefined;
      if (text) {
        const comparison = diffLines(review.current!.text!, review.preserved.text!);
        if (comparison.length > DIFF_PREVIEW_CHARS)
          this.contentEl.createEl("p", {
            cls: "setting-item-description",
            text: "Comparison shortened. Open both files to review all changes before choosing a version.",
          });
        this.contentEl.createEl("pre", {
          cls: "telimus-conflict-preview",
          text: comparison.slice(0, DIFF_PREVIEW_CHARS),
        });
        const edit = this.contentEl.createEl("details");
        editControls = edit;
        edit.createEl("summary", { text: "Edit a combined version" });
        const field = edit.createEl("textarea", { cls: "telimus-conflict-editor" });
        editor = field;
        field.value = draft ?? review.current!.text!;
        if (draft !== undefined) edit.open = true;
        field.setAttribute("aria-label", "Combined note text");
        field.addEventListener("input", () => {
          edited = field.value;
          this.drafts.set(pair.copy, edited);
        });
      } else
        this.contentEl.createEl("p", {
          text: "Open the files to compare attachments or large notes.",
        });
      this.contentEl.createEl("p", {
        cls: "setting-item-description",
        text: "Choosing a version removes the extra copy and syncs your choice to other devices.",
      });
      const actions = new Setting(this.contentEl);
      actions.settingEl.addClass("telimus-conflict-actions");
      const apply = async (choice: ConflictChoice) => {
        if (this.busy) return;
        this.busy = true;
        // Freeze the draft as well as the actions: resolve receives this text now,
        // so edits accepted while it waits would be discarded after success.
        const controls: (HTMLButtonElement | HTMLTextAreaElement)[] = Array.from(
          this.contentEl.querySelectorAll<HTMLButtonElement>("button"),
        );
        if (editor) controls.push(editor);
        const disabled = controls.map((control) => control.disabled);
        for (const control of controls) control.disabled = true;
        try {
          await this.source.resolve(review, choice, edited);
          this.drafts.delete(pair.copy);
          if (generation === this.generation) this.list();
        } catch (error) {
          new Notice((error as Error).message, 10000);
          // Keep the editor and its draft on failure. Refresh updates the comparison
          // while carrying that draft forward.
          if (generation === this.generation) {
            controls.forEach((control, index) => {
              control.disabled = disabled[index]!;
            });
          }
        } finally {
          this.busy = false;
        }
      };
      actions
        .addButton((button) =>
          button
            .setButtonText("Keep original")
            .setDisabled(!review.current)
            .onClick(() => void apply("original")),
        )
        .addButton((button) => button.setButtonText("Keep copy").onClick(() => void apply("copy")));
      if (editControls)
        new Setting(editControls).addButton((button) =>
          button.setButtonText("Save combined version").onClick(() => {
            if (edited === undefined) {
              new Notice("Edit the combined version first.");
              return;
            }
            void apply("edited");
          }),
        );
      actions.addButton((button) =>
        button.setButtonText("Decide later").onClick(() => this.close()),
      );
    } catch (error) {
      if (generation !== this.generation) return;
      new Notice((error as Error).message, 10000);
      this.list();
    }
  }
}
