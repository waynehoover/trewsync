import { diff_match_patch } from "diff-match-patch";
import { Modal, Notice, type App } from "obsidian";

import { looksLikeText } from "../core/chunk.ts";
import type { Version } from "../core/client.ts";

/** Where a restore landed, and whether it went any further. */
export interface Restored {
  readonly path: string;
  /** The upload afterwards succeeded. When false, `why` says what stopped it. */
  readonly sent: boolean;
  readonly why?: string;
  /**
   * Whether a later pass will send it. Absent means yes, which is every
   * ordinary failure. False is for a vault unlinked under the restore: the
   * note is on this device and there is no next pass to promise it to.
   */
  readonly willRetry?: boolean;
}

export function describeRestore(version: Version, done: Restored): string {
  const where =
    done.path === version.path
      ? `Restored ${done.path}.`
      : `Restored to ${done.path}, because something is already at ${version.path}.`;
  if (done.sent)
    return `${where} Uploaded to server. Other devices will receive it when they sync.`;
  return done.willRetry === false
    ? `${where} It is on this device and nowhere else: ${done.why}`
    : `${where} It is on this device and will be sent when the next sync succeeds: ${done.why}`;
}

/** What the modal needs from the plugin, so this file needs no plugin type. */
export interface HistorySource {
  /** Versions of one path, newest first. `before` pages backwards by uid. */
  history(path: string, opts: { before?: number; limit?: number }): Promise<Version[]>;
  /** The text of one version, without writing anything. */
  contentAt(version: Version): Promise<string>;
  /**
   * Writes a version back, never over the top of something already there.
   *
   * The outcome, not a sentence about it: where it landed and whether the
   * upload afterwards succeeded are two facts, and a string that has already
   * been through `describeRestore` cannot be asked either question.
   */
  restoreVersion(version: Version): Promise<Restored>;
  /** What is on disk now, for the diff. Undefined when the note is gone. */
  currentText(path: string, maxBytes?: number): Promise<string | undefined>;
}

/** How many versions a page holds. Sync pages too, and for the same reason. */
export const PAGE = 20;
export const PREVIEW_BYTES = 128 * 1024;
const PREVIEW_LINES = 2000;

export function previewReason(version: Version): string | undefined {
  if (version.deleted)
    return "This version records a deletion. Choose an earlier version to restore.";
  if (version.folder) return "This version is a folder.";
  // The engine's own list, not a second one. These had drifted apart: `.bib`
  // and `.tex` merged as text and previewed as attachments, and `.base` was an
  // attachment on both sides (R083-12). A file this device will diff and merge
  // as text is a file this modal can show.
  if (!looksLikeText(version.path))
    return "Attachment preview unavailable. Restore a copy to open the complete file.";
  if (version.size > PREVIEW_BYTES)
    return "This version is too large to preview. Restore a copy to open the complete file.";
  return undefined;
}

function boundedPreview(text: string): string {
  const lines = text.slice(0, PREVIEW_BYTES).split("\n");
  const clipped = text.length > PREVIEW_BYTES || lines.length > PREVIEW_LINES;
  return (
    lines.slice(0, PREVIEW_LINES).join("\n") +
    (clipped ? "\n… Preview shortened. Restore a copy for the complete version." : "")
  );
}

export class HistoryModal extends Modal {
  private closed = false;
  private reading = false;
  private restoring = false;
  /** Keep only the selected version, including an in-flight download. */
  private preview: { uid: number; text: Promise<string> } | undefined;
  private versions: Version[] = [];
  /**
   * The name currently being paged, which is the note's own until paging walks
   * back through a rename into an earlier one.
   */
  private pagingName = "";
  private chosen: Version | undefined;
  private text = "";
  private showDiff = false;
  private exhausted = false;
  /** Why the last page did not arrive, while that is the case. */
  private failed: string | undefined;
  /**
   * Which selection the pane is loading for.
   *
   * Reading a version is a round trip, and somebody pressing the down arrow
   * twice starts two. The one that finishes last used to win the pane, so
   * with A slow and B fast the list said B, the Restore button restored B,
   * and the text on screen was A. Every load takes a number and only the
   * newest number may draw.
   */
  private loading = 0;
  /** The page load in flight, so a second press of Load more joins it rather than asking again. */
  private paging: Promise<void> | undefined;
  private listEl!: HTMLElement;
  private paneEl!: HTMLElement;
  private versionsEl!: HTMLElement;
  private moreEl!: HTMLButtonElement;

  constructor(
    app: App,
    private readonly source: HistorySource,
    private readonly path: string,
  ) {
    super(app);
    this.pagingName = path;
  }

  override onOpen(): void {
    this.closed = false;
    this.setTitle(`History of ${this.path}`);
    this.modalEl.addClass("mod-trew-history", "mod-sidebar-layout");
    const sidebar = this.contentEl.createDiv("modal-sidebar mod-history");
    // setTitle above is invisible under mod-sidebar-layout, which collapses
    // the modal header, so the path goes here instead. Without it the modal
    // never says which note you are looking at the history of.
    sidebar.createDiv({ cls: "trew-history-heading", text: this.path });
    this.listEl = sidebar.createDiv("modal-sidebar-inner");
    this.versionsEl = this.listEl.createDiv("modal-sidebar-list");
    this.moreEl = this.listEl.createEl("button", { cls: "trew-history-button" });
    this.moreEl.setAttribute("type", "button");
    this.moreEl.addEventListener("click", () => void this.load());
    this.paneEl = this.contentEl.createDiv("trew-history-content-container");
    void this.load();
  }

  override onClose(): void {
    this.closed = true;
    this.loading++;
    this.preview = undefined;
    this.text = "";
    this.chosen = undefined;
    this.versions = [];
    this.contentEl.empty();
  }

  /** Fetches a page and redraws. `before` continues from the oldest held. */
  private load(): Promise<void> {
    if (this.closed) return Promise.resolve();
    // One page at a time. Two presses of Load more used to send two requests
    // for the same `before`, and the second page arrived twice.
    if (this.paging) return this.paging;
    this.paging = this.loadPage().finally(() => {
      this.paging = undefined;
      if (!this.closed) this.renderList();
    });
    this.renderList();
    return this.paging;
  }

  private async loadPage(): Promise<void> {
    const before = this.versions.length ? this.versions[this.versions.length - 1]!.uid : undefined;
    try {
      const page = await this.source.history(this.pagingName, {
        limit: PAGE,
        ...(before !== undefined ? { before } : {}),
      });
      if (this.closed) return;
      // Short of a full page means the server has no more *under this name*.
      // Asking again would be a round trip that can only return nothing.
      if (page.length < PAGE) this.exhausted = true;
      const moveFocus = this.moreEl.ownerDocument.activeElement === this.moreEl;
      this.versions.push(...page);
      // A rename does not end a note's history (Codex-06). History matches one
      // exact sealed path, so a note renamed today used to have a history that
      // started today, however many months of it the server was still holding
      // under the old name. The rename is signed with the entry that carries
      // it, so the older name is authenticated, and paging continues under it
      // bounded by that version's own uid: a name reused for something else
      // later cannot be pulled in, because everything older is what is asked
      // for and everything newer is refused.
      const oldest = this.versions.at(-1);
      if (this.exhausted && oldest?.previousPath !== undefined) {
        this.pagingName = oldest.previousPath;
        this.exhausted = false;
      }
      this.renderList();
      if (moveFocus) {
        const target = page[0] ?? this.versions.at(-1);
        if (target)
          this.listEl.querySelector<HTMLElement>(`[data-version="${target.uid}"]`)?.focus();
      }
    } catch (err) {
      if (this.closed) return;
      // Not exhausted: the server was not asked, it was unreachable. Setting
      // it here took the Load more button away, so an offline moment while
      // the modal opened left a window whose only recovery was closing it
      // and opening it again.
      new Notice(`Trew: ${(err as Error).message}`, 10_000);
      this.failed = (err as Error).message;
      this.render();
      return;
    }
    this.failed = undefined;
    // Open on the newest version rather than on an empty pane. This used to
    // ask instead, on the grounds that it should not guess which version
    // somebody meant; but the pane is two thirds of the modal, "select a
    // version" is not an answer to anything, and the newest is what Sync
    // shows and what someone opening history is nearly always after.
    // Showing a version only displays it. Restoring is still a button.
    //
    // Only when nothing is chosen yet, so paging further back does not drag
    // the selection off whatever the reader is reading.
    if (!this.chosen && this.versions.length > 0) {
      void this.choose(this.versions[0]!);
      return;
    }
    this.render();
  }

  private render(): void {
    this.renderList();
    this.renderPane();
  }

  private renderList(): void {
    const focused = this.listEl.ownerDocument?.activeElement?.getAttribute("data-version");
    this.versionsEl.empty();
    this.moreEl.setText(
      this.paging ? "Loading…" : this.failed === undefined ? "Load more" : "Try again",
    );
    // Keep keyboard focus during a request. load() already joins repeated presses.
    this.moreEl.setAttribute("aria-disabled", String(this.paging !== undefined));
    this.moreEl.toggle(!this.exhausted && (this.versions.length > 0 || this.failed !== undefined));
    if (this.paging && this.versions.length === 0) {
      this.versionsEl.createEl("p", { cls: "trew-history-empty", text: "Loading history…" });
      return;
    }
    if (this.versions.length === 0 && this.failed !== undefined) {
      // "The server holds no history for this note" over an ask that never
      // reached the server is rule 7's mistake in miniature: it describes the
      // question rather than the vault. This says what happened, and the
      // button under it asks again.
      this.versionsEl.createEl("p", {
        cls: "trew-history-empty",
        text: `The history could not be read: ${this.failed}`,
      });
    } else if (this.versions.length === 0) {
      this.versionsEl.createEl("p", {
        cls: "trew-history-empty",
        text: "The server holds no history for this note.",
      });
      return;
    }

    const list = this.versionsEl;
    this.versions.forEach((version, i) => {
      const item = list.createEl("button", {
        cls:
          "modal-sidebar-list-item tappable" +
          (this.chosen?.uid === version.uid ? " is-active" : ""),
      });
      item.setAttribute("type", "button");
      item.setAttribute("data-version", String(version.uid));
      item.setAttribute("aria-pressed", String(this.chosen?.uid === version.uid));
      if (focused === String(version.uid)) item.focus();
      item.createSpan({ cls: "modal-sidebar-list-item-header", text: when(version.mtime) });
      item.createSpan({
        cls: "modal-sidebar-list-item-details",
        text: describe(version, i === 0),
      });
      // Under the name it had then, when that is not the name it has now. A
      // version restored from here goes back to its own name, so saying which
      // one is not decoration.
      if (version.path !== this.path) {
        item.createSpan({
          cls: "modal-sidebar-list-item-details",
          text: `as ${version.path}`,
        });
      }
      item.addEventListener("click", () => void this.choose(version));
      item.addEventListener("keydown", (event) => {
        const next =
          event.key === "ArrowDown"
            ? i + 1
            : event.key === "ArrowUp"
              ? i - 1
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? this.versions.length - 1
                  : undefined;
        if (next === undefined) return;
        event.preventDefault();
        const target = this.versions[Math.max(0, Math.min(next, this.versions.length - 1))]!;
        void this.choose(target);
        this.listEl.querySelector<HTMLElement>(`[data-version="${target.uid}"]`)?.focus();
      });
    });
  }

  private renderPane(): void {
    this.paneEl.empty();
    const version = this.chosen;
    if (!version) {
      this.paneEl.addClass("mod-empty");
      this.paneEl.createEl("p", {
        cls: "trew-history-content-empty",
        text: "Select a version to see it.",
      });
      return;
    }
    this.paneEl.removeClass("mod-empty");

    const bar = this.paneEl.createDiv("modal-setting-titlebar");
    bar.createDiv({ cls: "modal-setting-title", text: when(version.mtime) });
    const actions = bar.createDiv("modal-setting-titlebar-actions");

    const toggle = actions.createEl("button", {
      text: this.showDiff ? "Show text" : "Show changes",
    });
    toggle.addEventListener("click", () => {
      this.showDiff = !this.showDiff;
      void this.choose(version);
    });
    toggle.disabled = this.restoring || previewReason(version) !== undefined;

    const restore = actions.createEl("button", {
      cls: "mod-cta",
      text: this.restoring ? "Restoring…" : "Restore",
    });
    restore.disabled = this.reading || this.restoring || version.deleted || version.folder;
    restore.addEventListener("click", () => void this.restore(version));

    if (previewReason(version) !== undefined) {
      this.paneEl.createEl("p", { cls: "trew-history-content-empty", text: this.text });
      return;
    }
    const pre = this.paneEl.createEl("pre", {
      cls: this.showDiff ? "trew-history-diff" : "trew-history-text",
    });
    if (!this.showDiff) {
      pre.setText(this.text);
      return;
    }
    // A line at a time, so the added and removed rules in styles.css have
    // something to colour. They used to have nothing: the diff went in as
    // one run of text, so both rules matched no element and every diff came
    // out the single colour the stylesheet says is unreadable.
    for (const line of this.text.split("\n")) {
      const cls = line.startsWith("+") ? "trew-added" : line.startsWith("-") ? "trew-removed" : "";
      // Never an empty class: addClass throws on one, and createSpan
      // takes the same path.
      pre.createSpan(cls === "" ? { text: `${line}\n` } : { cls, text: `${line}\n` });
    }
  }

  private async choose(version: Version): Promise<void> {
    if (this.closed || this.restoring) return;
    const mine = ++this.loading;
    this.chosen = version;
    this.reading = true;
    this.text = "Loading…";
    this.render();
    let text: string;
    try {
      const reason = previewReason(version);
      if (reason) {
        this.preview = undefined;
        this.text = reason;
        this.reading = false;
        this.renderPane();
        return;
      }
      if (this.preview?.uid !== version.uid) {
        const preview = { uid: version.uid, text: this.source.contentAt(version) };
        this.preview = preview;
        void preview.text.catch(() => {
          if (this.preview === preview) this.preview = undefined;
        });
      }
      const older = await this.preview.text;
      if (mine !== this.loading) return;
      if (this.showDiff) {
        const now = (await this.source.currentText(this.path, PREVIEW_BYTES)) ?? "";
        if (mine !== this.loading) return;
        text =
          older.length > PREVIEW_BYTES || now.length > PREVIEW_BYTES
            ? "These notes are too large to compare here. Restore a copy to compare the complete files."
            : diffLines(older, now);
      } else {
        text = older;
      }
    } catch (err) {
      text = `Could not read this version: ${(err as Error).message}`;
    }
    // A newer selection has been made while this one was loading. Its text
    // belongs to a version the list no longer says is chosen, and drawing it
    // would label one version's text with another's name.
    if (mine !== this.loading) return;
    this.reading = false;
    this.text = boundedPreview(text);
    // Only the pane, so a slow read does not rebuild the list under the
    // pointer of somebody about to click the next version.
    this.renderPane();
  }

  private async restore(version: Version): Promise<void> {
    if (this.closed || this.restoring || this.reading || version.deleted || version.folder) return;
    this.restoring = true;
    this.renderPane();
    try {
      const done = await this.source.restoreVersion(version);
      // Longer on screen when the note is here but not yet on the other
      // devices, because that half-outcome is the one worth reading. The
      // recovery list says it the same way.
      new Notice(describeRestore(version, done), done.sent ? undefined : 10_000);
      this.close();
    } catch (err) {
      new Notice(`Trew: ${(err as Error).message}`, 10_000);
    } finally {
      this.restoring = false;
      if (!this.closed) this.renderPane();
    }
  }
}

/**
 * A timestamp for a narrow column.
 *
 * The full locale string wrapped onto two ragged lines in the sidebar, which is
 * most of what a row is. A version from today wants the time; one from this year
 * wants the day; only an older one needs the year at all.
 */
export function when(ms: number): string {
  const at = new Date(ms);
  const now = new Date();
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  const sameDay =
    at.getDate() === now.getDate() &&
    at.getMonth() === now.getMonth() &&
    at.getFullYear() === now.getFullYear();
  if (sameDay) return time;

  const day = at.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  if (at.getFullYear() === now.getFullYear()) return `${day}, ${time}`;
  return `${day} ${at.getFullYear()}`;
}

/**
 * The second line of a row: what the version is, rather than what it contains.
 *
 * The newest one is called out because "restore the newest" and "restore an
 * older one" are different intentions, and a list where every row looks alike
 * makes the first indistinguishable from the second.
 */
function describe(version: Version, newest: boolean): string {
  if (version.deleted) return `Deleted on ${version.device}`;
  if (version.folder) return `Folder, ${version.device}`;
  const size = version.size < 1024 ? `${version.size} B` : `${Math.round(version.size / 1024)} KiB`;
  return `${size} · ${version.device}${newest ? " · newest" : ""}`;
}

/**
 * A line diff of an old version against what is on disk.
 *
 * Line-wise rather than character-wise, because this is for reading rather than
 * for merging: the merge in core/merge.ts is character-granular precisely
 * because a paragraph is one line, and that is the wrong granularity to look at.
 *
 * A real diff, from the library the merge already uses in its line mode. The
 * first version of this was a set difference of the two line lists, which is
 * not a diff: a paragraph that appeared twice and now appears once, or two
 * paragraphs that swapped places, came out as "No difference from the note on
 * disk", and a person deciding whether to restore was told the versions were
 * the same when they were not.
 */
export function diffLines(older: string, current: string): string {
  const dmp = new diff_match_patch();
  dmp.Diff_Timeout = 0.1;
  const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(older, current);
  const diffs = dmp.diff_main(chars1, chars2, false);
  dmp.diff_charsToLines_(diffs, lineArray);
  // Coalesces the runs the line encoding leaves behind, so an edited
  // paragraph reads as one removal and one addition rather than as a stutter
  // of single lines with unchanged ones wedged between them. Cosmetic, and
  // this is the one place in the project where cosmetic is the whole job:
  // somebody is reading it to decide whether to restore.
  dmp.diff_cleanupSemantic(diffs);

  const out: string[] = [];
  for (const [op, text] of diffs) {
    if (op === 0) continue;
    const mark = op === -1 ? "-" : "+";
    for (const line of splitLines(text)) out.push(`${mark} ${line}`);
  }
  return out.length ? out.join("\n") : "No difference from the note on disk.";
}

/** The lines of a run of text, without the empty tail a trailing newline leaves. */
function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}
