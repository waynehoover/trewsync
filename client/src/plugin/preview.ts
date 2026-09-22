import { Modal, Setting, type App } from "obsidian";
import { previewCounts, type SyncPreview, type PreviewAction } from "../core/preview.ts";
const LABELS: Record<PreviewAction, string> = {
  upload: "Upload",
  download: "Download",
  merge: "Merge, or keep both if edits overlap",
  copy: "Keep both versions",
  "delete-local": "Delete on this device",
  "delete-server": "Upload deletion",
  unchanged: "Already matches",
  blocked: "Needs attention",
  "held-back": "Local change kept on this device",
};
export class SyncPreviewModal extends Modal {
  private answer: ((proceed: boolean) => void) | undefined;
  isClosed = true;
  constructor(
    app: App,
    private preview?: SyncPreview,
    private readonly heading = "Preview sync",
  ) {
    super(app);
  }
  confirm(): Promise<boolean> {
    return new Promise((resolve) => {
      this.answer = resolve;
      this.open();
    });
  }
  override onOpen(): void {
    this.isClosed = false;
    this.setTitle(this.heading);
    this.modalEl.addClass("mod-telimus-preview");
    this.contentEl.empty();
    if (!this.preview) {
      this.contentEl
        .createEl("p", { text: "Preparing sync preview…" })
        .setAttribute("role", "status");
      return;
    }
    const counts = previewCounts(this.preview);
    this.contentEl.createEl("p", {
      text: "Based on the files here and the server history just read. Changes made while this is open will be checked again during sync.",
    });
    for (const [key, count] of Object.entries(counts)) {
      if (count)
        new Setting(this.contentEl)
          .setName(LABELS[key as PreviewAction])
          .setDesc(`${count.toLocaleString()} ${count === 1 ? "file" : "files"}`);
    }
    // Only when there is something behind it.
    //
    // This used to be drawn whatever the preview said, and its contents are
    // the files that are *not* already matching. Pairing a device to a vault
    // it already holds a copy of therefore offered a "File details" chevron
    // that opened onto an empty box: the one moment somebody most wants to
    // know what is about to happen to their notes, answered with nothing at
    // all. Reported from a phone doing exactly that.
    const changes = this.preview.files.filter((file) => file.action !== "unchanged");
    if (changes.length === 0) {
      this.contentEl.createEl("p", {
        cls: "telimus-advice",
        text:
          this.preview.files.length === 0
            ? "There is nothing here and nothing on the server yet."
            : "Nothing to do: every file here already matches the server.",
      });
    } else {
      const details = this.contentEl.createEl("details");
      details.createEl("summary", {
        text: `File details (${changes.length.toLocaleString()})`,
      });
      const list = details.createDiv("telimus-activity-list");
      for (const file of changes.slice(0, 200))
        new Setting(list).setName(file.path).setDesc(LABELS[file.action]);
      if (changes.length > 200)
        list.createEl("p", { text: `Showing 200 of ${changes.length.toLocaleString()} changes.` });
    }
    if (this.answer)
      new Setting(this.contentEl)
        .addButton((button) => button.setButtonText("Pause sync").onClick(() => this.close()))
        .addButton((button) =>
          button
            .setButtonText("Continue sync")
            .setCta()
            .onClick(() => {
              this.answer?.(true);
              this.answer = undefined;
              this.close();
            }),
        );
  }
  override onClose(): void {
    this.isClosed = true;
    this.answer?.(false);
    this.answer = undefined;
    this.contentEl.empty();
  }

  showPreview(preview: SyncPreview): void {
    if (this.isClosed) return;
    this.preview = preview;
    this.onOpen();
  }

  showError(message: string): void {
    if (this.isClosed) return;
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: message }).setAttribute("role", "alert");
  }
}
