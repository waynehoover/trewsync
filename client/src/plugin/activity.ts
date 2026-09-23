import { when } from "./history.ts";
import { Modal, Notice, Setting, type App, type DataAdapter } from "obsidian";
import type { Activity, ActivityAction } from "../core/activity.ts";

const LIMIT = 300;
const ACTIONS: Record<ActivityAction, string> = {
  uploaded: "Uploaded to server",
  downloaded: "Downloaded",
  merged: "Merged edits",
  "deleted-local": "Deleted on this device",
  "deleted-server": "Deletion uploaded",
  conflict: "Kept both versions",
  error: "Sync failed",
  resolved: "Conflict resolved",
};

export class ActivityLog {
  events: Activity[] = [];
  problem: string | undefined;
  private readonly listeners = new Set<() => void>();
  watch(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(): void {
    for (const listener of this.listeners) listener();
  }
  private dirty = false;
  private writing: Promise<void> = Promise.resolve();
  constructor(
    private readonly adapter: Pick<DataAdapter, "read" | "write" | "exists" | "stat">,
    private readonly path: string,
  ) {}

  async load(): Promise<void> {
    try {
      if (!(await this.adapter.exists(this.path))) return;
      const stat = await this.adapter.stat(this.path);
      if (!stat || stat.size > 3 * 1024 * 1024) throw new Error("Invalid activity log size");
      const data: unknown = JSON.parse(await this.adapter.read(this.path));
      if (!Array.isArray(data) || data.length > LIMIT) throw new Error("Invalid activity log");
      this.events = (data as unknown[]).map((raw): Activity => {
        if (!raw || typeof raw !== "object") throw new Error("Invalid activity entry");
        const event = raw as Record<string, unknown>;
        const { at, action, path, copy } = event;
        if (
          typeof at !== "number" ||
          !Number.isFinite(at) ||
          typeof action !== "string" ||
          !Object.hasOwn(ACTIONS, action) ||
          [path, copy].some((p) => p !== undefined && (typeof p !== "string" || p.length > 4096))
        )
          throw new Error("Invalid activity entry");
        // Only the allowlisted fields can reach display or export, even from a modified file.
        return {
          at,
          action: action as ActivityAction,
          ...(typeof path === "string" && path ? { path } : {}),
          ...(typeof copy === "string" && copy ? { copy } : {}),
        };
      });
    } catch {
      this.problem =
        "The saved activity log could not be read. Sync can continue. Clear the log to start a new one.";
    }
  }

  add(event: Activity): void {
    const last = this.events.at(-1);
    if (
      last &&
      last.action === event.action &&
      last.path === event.path &&
      last.copy === event.copy &&
      event.at - last.at < 1000
    )
      return;
    this.events.push(event);
    this.events = this.events.slice(-LIMIT);
    this.dirty = true;
    this.changed();
  }

  flush(): Promise<void> {
    this.writing = this.writing.then(async () => {
      if (!this.dirty || this.problem) return;
      this.dirty = false;
      try {
        await this.adapter.write(this.path, JSON.stringify(this.events));
      } catch {
        this.dirty = true;
        this.problem = "Recent activity could not be saved. Clear the log to retry.";
        this.changed();
      }
    });
    return this.writing;
  }

  async clear(): Promise<void> {
    await this.writing;
    this.events = [];
    this.problem = undefined;
    this.dirty = true;
    this.changed();
    await this.flush();
  }

  diagnostics(): string {
    // Filenames are deliberately omitted; never export raw errors, URLs or credentials.
    return JSON.stringify(
      this.events.map(({ at, action }) => ({ at, action })),
      null,
      2,
    );
  }
}

export class ActivityModal extends Modal {
  private stop: (() => void) | undefined;
  constructor(
    app: App,
    private readonly log: ActivityLog,
    private readonly openPath: (path: string) => void,
    private readonly watchUnload?: (close: () => void) => () => void,
  ) {
    super(app);
  }
  override onOpen(): void {
    this.setTitle("Sync activity");
    this.modalEl.addClass("mod-trew-activity");
    const problem = this.contentEl.createEl("p");
    let query = "";
    let filter = "all";
    const controls = new Setting(this.contentEl).setName("Recent activity");
    controls.settingEl.addClass("trew-activity-filter");
    controls.addSearch((input) => {
      input.inputEl.setAttribute("aria-label", "Find activity by filename");
      input.setPlaceholder("Find a file…").onChange((value) => {
        query = value.toLocaleLowerCase();
        draw();
      });
    });
    controls.addDropdown((dropdown) => {
      dropdown.selectEl.setAttribute("aria-label", "Activity type");
      dropdown
        .addOptions({ all: "All", error: "Errors", conflict: "Conflicts" })
        .onChange((value) => {
          filter = value;
          draw();
        });
    });
    const list = this.contentEl.createDiv("trew-activity-list");
    const rows = new Map<Activity, Setting>();
    const empty = list.createEl("p", { text: "No matching activity." });
    const draw = () => {
      problem.setText(this.log.problem ?? "");
      problem.toggle(this.log.problem !== undefined);
      const events = this.log.events
        .filter(
          (event) =>
            (filter === "all" || event.action === filter) &&
            `${event.path ?? ""} ${event.copy ?? ""}`.toLocaleLowerCase().includes(query),
        )
        .slice()
        .reverse();
      empty.toggle(events.length === 0);
      const visible = new Set(events);
      for (const [event, row] of rows) {
        if (!visible.has(event)) {
          row.settingEl.remove();
          rows.delete(event);
        }
      }
      let previous: HTMLElement = empty;
      for (const event of events) {
        let row = rows.get(event);
        if (!row) {
          row = new Setting(list)
            .setName(event.path ?? "Sync")
            .setDesc(`${when(event.at)} · ${ACTIONS[event.action]}`);
          if (event.path)
            row.addExtraButton((button) =>
              button
                .setIcon("file-text")
                .setTooltip("Open file")
                .onClick(() => {
                  this.close();
                  this.openPath(event.path!);
                }),
            );
          rows.set(event, row);
        }
        if (previous.nextElementSibling !== row.settingEl)
          list.insertBefore(row.settingEl, previous.nextElementSibling);
        previous = row.settingEl;
      }
    };
    draw();
    let closed = false;
    let queued = false;
    let frame: number | undefined;
    let dirty = false;
    const doc =
      typeof this.contentEl.ownerDocument?.addEventListener === "function"
        ? this.contentEl.ownerDocument
        : globalThis.document;
    const view = doc?.defaultView ?? globalThis;
    const schedule = () => {
      dirty = true;
      if (closed || queued || doc?.visibilityState === "hidden") return;
      queued = true;
      const paint = () => {
        queued = false;
        frame = undefined;
        if (closed || doc?.visibilityState === "hidden" || !dirty) return;
        dirty = false;
        draw();
      };
      if (typeof view.requestAnimationFrame === "function")
        frame = view.requestAnimationFrame(paint);
      else queueMicrotask(paint);
    };
    const unwatch = this.log.watch(schedule);
    doc?.addEventListener("visibilitychange", schedule);
    const unwatchUnload = this.watchUnload?.(() => this.close());
    this.stop = () => {
      closed = true;
      unwatch();
      unwatchUnload?.();
      doc?.removeEventListener("visibilitychange", schedule);
      if (frame !== undefined) view.cancelAnimationFrame(frame);
      rows.clear();
    };
    new Setting(this.contentEl)
      .setName("Troubleshooting")
      .setDesc("The last 300 events stay on this device. Copied diagnostics omit filenames.")
      .addButton((button) =>
        button.setButtonText("Copy diagnostics").onClick(async () => {
          try {
            await navigator.clipboard.writeText(this.log.diagnostics());
            new Notice("Copied diagnostics without filenames.");
          } catch {
            new Notice("The clipboard is unavailable on this device.");
          }
        }),
      )
      .addButton((button) =>
        button.setButtonText("Clear log").onClick(async () => {
          await this.log.clear();
        }),
      );
  }
  override onClose(): void {
    this.stop?.();
    this.stop = undefined;
    this.contentEl.empty();
  }
}
