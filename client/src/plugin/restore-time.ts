/**
 * Putting a folder, or every note in the vault, back as it was at a time
 * (protocol 5; plan/protocol.md, "Restore").
 *
 * Preview first, always: nothing changes until the preview has been shown,
 * and what is applied is exactly that preview, by the uid and head it
 * answered with. The server refuses the apply as `stale` if anything was
 * saved in between, and the modal says to preview again. Once applied, Undo
 * reverses the whole restore as one operation.
 */

import { Modal, Notice, Setting, type App } from "obsidian";

import type { RestoreAsk, RestoreResult } from "../core/transport.ts";
import { ProtocolError } from "../core/transport.ts";

/** How many of a preview's changes are listed; the counts are always whole. */
const LISTED = 50;

/** What the modal asks of the plugin. */
export interface RestoreTimeActions {
  restore(ask: RestoreAsk): Promise<RestoreResult>;
  undo(opId: string): Promise<unknown>;
}

/** `YYYY-MM-DDTHH:mm` in local time, which a `datetime-local` input holds. */
export function localInputValue(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}` +
    `T${two(d.getHours())}:${two(d.getMinutes())}`
  );
}

/** A `datetime-local` value as milliseconds, read in local time, or undefined. */
export function fromLocalInput(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

/** What a step does, for a person. */
function describeStep(action: string): string {
  switch (action) {
    case "restore":
      return "put back";
    case "remove":
      return "removed, made since";
    case "remove_folder":
      return "folder removed, made since";
    case "keep_folder":
      return "folder kept";
    default:
      return action;
  }
}

/** What a preview will do, in one sentence. */
export function summarise(p: RestoreResult): string {
  const parts: string[] = [];
  if (p.restore > 0) parts.push(`${p.restore} ${p.restore === 1 ? "file" : "files"} put back`);
  if (p.remove > 0) parts.push(`${p.remove} made since removed`);
  if (p.removeFolder > 0)
    parts.push(
      `${p.removeFolder} ${p.removeFolder === 1 ? "folder" : "folders"} made since removed`,
    );
  return parts.length === 0
    ? "Nothing to change: it already holds what it held then."
    : `${parts.join(", ")}.`;
}

export class RestoreTimeModal extends Modal {
  private folder: string;
  private at: number;
  private preview: RestoreResult | undefined;
  private busy = false;
  /** Moved on by every change of folder or time, so a late preview of the old ones is dropped. */
  private asked = 0;
  private body!: HTMLElement;

  constructor(
    app: App,
    folder: string,
    private readonly actions: RestoreTimeActions,
    now = Date.now(),
  ) {
    super(app);
    this.folder = folder;
    this.at = now - 24 * 60 * 60 * 1000;
  }

  override onOpen(): void {
    this.setTitle("Restore to an earlier time");
    new Setting(this.contentEl)
      .setName("Folder")
      .setDesc("Empty for every note in the vault. Settings are never changed.")
      .addText((t) =>
        t
          .setPlaceholder("The whole vault")
          .setValue(this.folder)
          .onChange((v) => {
            this.folder = v.trim().replace(/^\/+|\/+$/g, "");
            this.forget();
          }),
      );
    new Setting(this.contentEl)
      .setName("Time")
      .setDesc(`In this device's time zone, ${Intl.DateTimeFormat().resolvedOptions().timeZone}.`)
      .addText((t) => {
        t.inputEl.type = "datetime-local";
        t.setValue(localInputValue(this.at)).onChange((v) => {
          const ms = fromLocalInput(v);
          if (ms !== undefined) this.at = ms;
          this.forget();
        });
      });
    this.body = this.contentEl.createDiv();
    this.draw();
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  /** A changed folder or time makes the shown preview another question's. */
  private forget(): void {
    this.asked++;
    if (this.preview === undefined || this.preview.opId !== undefined) return;
    this.preview = undefined;
    this.draw();
  }

  private draw(message?: string): void {
    this.body.empty();
    if (message) this.body.createEl("p", { text: message, cls: "trew-restore-message" });
    const p = this.preview;
    if (p === undefined) {
      new Setting(this.body).addButton((b) =>
        b
          .setButtonText("Preview")
          .setCta()
          .setDisabled(this.busy)
          .onClick(() => void this.runPreview()),
      );
      return;
    }
    const scope = p.folder === "" ? "Every note in the vault" : p.folder;
    this.body.createEl("p", {
      text: `${scope}, as the server had it at ${new Date(p.at).toLocaleString()}.`,
    });
    this.body.createEl("p", { text: summarise(p) });
    const kept = [...p.keptMovedIn, ...p.keptMovedOut];
    if (kept.length > 0) {
      this.body.createEl("p", {
        text:
          `Left where they are: ${kept.length} moved into or out of the folder since, ` +
          `which a restore of the folder does not change.`,
      });
    }
    const list = this.body.createEl("ul", { cls: "trew-restore-list" });
    const shown = p.steps.filter((s) => s.action !== "keep_folder").slice(0, LISTED);
    for (const step of shown) {
      list.createEl("li", { text: `${step.path}: ${describeStep(step.action)}` });
    }
    const hidden = p.restore + p.remove + p.removeFolder - shown.length;
    if (hidden > 0) this.body.createEl("p", { text: `And ${hidden} more.` });
    if (p.opId !== undefined) {
      const opId = p.opId;
      new Setting(this.body)
        .setName("Restored")
        .setDesc("Every device receives it as it syncs. Undo puts back everything it replaced.")
        .addButton((b) =>
          b
            .setButtonText("Undo")
            .setDisabled(this.busy)
            .onClick(() => void this.runUndo(opId)),
        );
      return;
    }
    if (p.restore + p.remove + p.removeFolder === 0) return;
    new Setting(this.body).addButton((b) =>
      b
        .setButtonText("Restore")
        .setWarning()
        .setDisabled(this.busy)
        .onClick(() => void this.runApply(p)),
    );
  }

  private async step(work: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.draw("Working…");
    try {
      await work();
      this.busy = false;
      this.draw();
    } catch (err) {
      this.busy = false;
      const e = err as Error;
      if (err instanceof ProtocolError && err.code === "stale") {
        this.preview = undefined;
        this.draw("Something in the vault changed since the preview. Preview again.");
        return;
      }
      this.draw(e.message);
    }
  }

  private runPreview(): Promise<void> {
    const asked = this.asked;
    return this.step(async () => {
      const preview = await this.actions.restore({
        at: this.at,
        ...(this.folder !== "" ? { folder: this.folder } : {}),
      });
      // The folder or the time changed while it was asked: it answers a
      // question nobody is asking now.
      if (asked === this.asked) this.preview = preview;
    });
  }

  private runApply(p: RestoreResult): Promise<void> {
    return this.step(async () => {
      this.preview = await this.actions.restore({
        uid: p.toUid,
        head: p.head,
        ...(p.folder !== "" ? { folder: p.folder } : {}),
      });
      new Notice(`TrewSync: restored. ${summarise(this.preview)}`);
    });
  }

  private runUndo(opId: string): Promise<void> {
    return this.step(async () => {
      await this.actions.undo(opId);
      this.preview = undefined;
      new Notice("TrewSync: the restore is undone.");
    });
  }
}
