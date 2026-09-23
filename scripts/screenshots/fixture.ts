import { ActivityLog, ActivityModal } from "../../client/src/plugin/activity";
import { ConflictsModal } from "../../client/src/plugin/conflicts";
import { SyncPreviewModal } from "../../client/src/plugin/preview";
import { PROTO } from "../../client/src/core/transport";
// Desktop-only sample provider for scripts/screenshots.mjs; never shipped.
import { Plugin, PluginSettingTab } from "obsidian";
import { TrewPanel, TrewModal, RecoverModal, paintStatus } from "../../client/src/plugin/main";
import { HistoryModal } from "../../client/src/plugin/history";
import { formatInvite } from "../../client/src/core/pairing";
import { MergeConfirmationRequired } from "../../client/src/plugin/first-sync";

const electron = require("electron");
const fs = require("fs");
const now = new Date();
now.setHours(10, 30, 0, 0);
const at = +now;
const invite = formatInvite({
  url: "wss://sync.example.com",
  vaultId: "default",
  id: new Uint8Array(16).fill(17),
  key: new Uint8Array(32).fill(34),
});
const texts = [
  "# Weekend plans\n\n## Saturday\n- Coffee at the market\n- Walk along the coast\n\n## Sunday\n- Lunch with friends\n- Read a few chapters\n",
  "# Weekend plans\n\n## Saturday\n- Coffee at the market\n- Visit the museum\n\n## Sunday\n- Lunch with friends\n",
  "# Weekend plans\n\n## Saturday\n- Coffee at the market\n\n## Sunday\n- Lunch with friends\n",
];
const versions = texts.map((text, i) => ({
  uid: 30 - i,
  path: "Weekend plans.md",
  size: new TextEncoder().encode(text).length,
  ctime: at - 86400000,
  mtime: at - i * 3600000,
  folder: false,
  deleted: false,
  device: i === 1 ? "Phone" : "MacBook",
  chunks: 1,
  contentId: "sample-" + i,
}));
const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

class PreviewTab extends PluginSettingTab {
  display() {
    this.panel?.teardown();
    this.panel = new TrewPanel(this.plugin.model, this.containerEl, () => {});
    this.panel.render();
  }
  hide() {
    this.panel?.teardown();
  }
}

export default class Screenshots extends Plugin {
  onload() {
    this.window = this.findWindow(this.app.workspace.containerEl.ownerDocument);
    this.originalBounds = this.window.getBounds();
    this.originalMinimum = this.window.getMinimumSize();
    this.platformClasses = new Map();
    this.clipboardBefore = electron.clipboard.readText();
    this.hiddenNotices = new Map();
    this.themes = new Map();
    // A neutral preview backdrop keeps the test vault's sidebar and notes out
    // of the modal's transparent corners. It never covers the plugin itself.
    this.backdrop = this.app.workspace.containerEl.ownerDocument.body.createDiv();
    Object.assign(this.backdrop.style, {
      position: "fixed",
      inset: "0",
      background: "var(--background-primary)",
      zIndex: "49",
      pointerEvents: "none",
    });
    this.status = this.addStatusBarItem();
    this.status.addClass("plugin-trew-sync");
    this.model = this.makeModel();
    this.tab = new PreviewTab(this.app, this);
    this.addSettingTab(this.tab);
  }

  findWindow(doc) {
    const window = electron.remote.BrowserWindow.getAllWindows().find(
      (w) => w.getTitle() === doc.title,
    );
    if (!window) throw new Error("No window for " + doc.title);
    return window;
  }

  applyTheme(doc, theme) {
    if (!this.themes.has(doc)) this.themes.set(doc, doc.body.classList.contains("theme-dark"));
    // Use Obsidian's native theme classes without saving an appearance setting.
    // Rapid persisted changes can race config-file reloads during a capture run.
    doc.body.classList.toggle("theme-dark", theme === "dark");
    doc.body.classList.toggle("theme-light", theme === "light");
  }

  makeModel(paired = true) {
    const unavailable = () => {
      throw new Error("Screenshot sample only");
    };
    return {
      app: this.app,
      paired,
      deliveryReady: true,
      deviceName: "MacBook",
      currentState: paired
        ? { kind: "synced", summary: "up to date", at, refused: 0, waiting: 0 }
        : { kind: "unpaired" },
      pendingFirstPairing: () => undefined,
      cursors: () => ({ local: 124, server: 124 }),
      connection: () => ({
        url: "wss://sync.example.com",
        server: { proto: PROTO, version: __SCREENSHOT_SERVER_VERSION__ },
      }),
      watchState: (listener) => {
        listener();
        return () => {};
      },
      watchUnload: () => () => {},
      syncNow: unavailable,
      devices: async () => ({
        devices: [
          { id: "sample-macbook", name: "MacBook", createdAt: at - 86400000, lastSeen: at, online: true, applied: 124 },
          { id: "sample-phone", name: "Phone", createdAt: at - 7200000, lastSeen: at, online: true, applied: 124 },
        ],
        maxDevices: 0,
        invites: [],
        thisDevice: "sample-macbook",
      }),
      createInvite: async () => ({ invite, expiresAt: at + 600000 }),
      deletedNotes: async () => ({
        notes: [
          {
            ...versions[0],
            uid: 40,
            path: "Packing list.md",
            mtime: at - 1800000,
            deleted: true,
            restorable: 39,
          },
          {
            ...versions[1],
            uid: 38,
            path: "Book ideas.md",
            mtime: at - 3600000,
            deleted: true,
            restorable: 37,
          },
        ],
        more: false,
      }),
      changeServerAddress: unavailable,
      renameDevice: unavailable,
      rotate: unavailable,
      repair: unavailable,
      unlink: unavailable,
      recover: unavailable,
      pair: unavailable,
      pairFirst: unavailable,
    };
  }

  async scene(name, theme, device) {
    this.modal?.close();
    this.modal = undefined;
    if (name !== "settings" || this.lastScene !== "settings") this.app.setting.close();
    this.lastScene = name;
    await settle();
    this.applyTheme(this.app.workspace.containerEl.ownerDocument, theme);
    const body = this.app.workspace.containerEl.ownerDocument.body;
    for (const cls of ["is-mobile", "is-phone", "is-tablet", "is-desktop"]) {
      if (!this.platformClasses.has(cls)) this.platformClasses.set(cls, body.hasClass(cls));
      body.toggleClass(
        cls,
        device === "phone"
          ? cls === "is-mobile" || cls === "is-phone"
          : this.platformClasses.get(cls),
      );
    }
    this.model = this.makeModel(!["pairing", "join", "join-confirm", "setup"].includes(name));
    if (name === "join-confirm")
      this.model.pair = async () => {
        throw new MergeConfirmationRequired();
      };
    paintStatus(this.status, this.makeModel().currentState);
    this.backdrop.style.display = name === "status" ? "none" : "";
    this.window.setMinimumSize(320, 480);
    this.window.setContentSize(
      device === "phone" ? 412 : 1080,
      device === "phone" ? 915 : name === "changes" ? 700 : 1100,
    );
    this.window.show();
    this.window.focus();
    if (name === "status") {
      this.target = this.status;
      return;
    }
    if (name === "settings") {
      this.app.setting.open();
      this.app.setting.openTabById(this.manifest.id);
      await settle();
      this.target = this.tab.containerEl;
      return;
    }
    if (name === "changes") {
      this.modal = new HistoryModal(
        this.app,
        {
          history: async () => versions,
          contentAt: async (v) => texts[30 - v.uid],
          currentText: async () => texts[0],
          restoreVersion: async () => {
            throw new Error("Screenshot sample only");
          },
        },
        "Weekend plans.md",
      );
    } else if (name === "activity") {
      const log = new ActivityLog(this.app.vault.adapter, "unused-screenshot-log.json");
      log.events = [
        { at: at - 180000, action: "uploaded", path: "Weekend plans.md" },
        { at: at - 90000, action: "downloaded", path: "Ideas/Places to visit.md" },
        { at: at - 60000, action: "merged", path: "Shopping list.md" },
        { at: at - 30000, action: "conflict", path: "Weekend plans.md" },
      ];
      this.modal = new ActivityModal(this.app, log, () => {});
    } else if (name === "preview") {
      this.modal = new SyncPreviewModal(this.app, { cursor: 30, files: [
        { path: "Weekend plans.md", action: "copy" },
        { path: "Ideas/New idea.md", action: "upload" },
        { path: "Shopping list.md", action: "download" },
        { path: "Recipes/Pasta.md", action: "unchanged" },
      ] }, "Review your first sync");
    } else if (name === "conflicts") {
      const pair = { original: "Weekend plans.md", copy: "Weekend plans (Conflicted copy Phone 202609101015).md" };
      this.modal = new ConflictsModal(this.app, {
        pairs: () => [pair], open: () => {}, resolve: async () => {},
        review: async () => ({ ...pair,
          current: { path: pair.original, digest: "sample-a", text: texts[0], stat: { path: pair.original, mtime: at, ctime: at, size: 180, folder: false } },
          preserved: { path: pair.copy, digest: "sample-b", text: texts[1], stat: { path: pair.copy, mtime: at - 60000, ctime: at, size: 160, folder: false } },
        }),
      });
    } else if (name === "attachment-history") {
      this.modal = new HistoryModal(this.app, {
        history: async () => [{ ...versions[0], path: "Attachments/Coastal walk.pdf", size: 16 * 1024 * 1024 }],
        contentAt: async () => { throw new Error("Attachments must not be decoded for previews"); },
        currentText: async () => undefined,
        restoreVersion: async () => { throw new Error("Screenshot sample only"); },
      }, "Attachments/Coastal walk.pdf");
    } else if (
      ["deleted", "deleted-empty", "deleted-error", "deleted-older-empty"].includes(name)
    ) {
      if (name === "deleted-empty" || name === "deleted-older-empty")
        this.model.deletedNotes = async () => ({ notes: [], more: false });
      if (name === "deleted-error")
        this.model.deletedNotes = async () => {
          throw new Error("Connection lost. Check your connection and try again.");
        };
      this.modal = new RecoverModal(this.model);
      if (name === "deleted-older-empty") this.modal.before = 38;
    } else {
      if (name === "uploading" || name === "downloading") {
        this.model.deliveryReady = false;
        this.model.currentState = {
          kind: "syncing", since: at,
          transfer: name === "uploading"
            ? { direction: "upload", files: 1, path: "Attachments/Coastal walk.pdf", bytes: 2_400_000 }
            : { direction: "download", files: 3, bytes: 8_700_000 },
        };
      }
      if (name === "loading") {
        this.model.currentState = { kind: "loading", local: 960, server: 3826 };
        this.model.cursors = () => ({ local: 960, server: 3826 });
      }
      this.modal = new TrewModal(this.model);
    }
    if (name === "preview") void this.modal.confirm();
    else this.modal.open();
    this.target = this.modal.modalEl;
    await settle();
    const content = this.modal.contentEl;
    const press = (label) => {
      const button = [...content.querySelectorAll("button")].find((b) => b.textContent === label);
      if (!button) throw new Error("Missing " + label);
      button.click();
      return button;
    };
    if (name === "join" || name === "join-confirm") press("Paste an invite");
    if (name === "setup") press("Use a setup line");
    if (name === "join" || name === "join-confirm" || name === "setup") {
      const field = content.querySelector("input");
      field.value = name.startsWith("join") ? "Phone" : "MacBook";
      field.dispatchEvent(new field.ownerDocument.defaultView.Event("input", { bubbles: true }));
    }
    if (name === "join-confirm") {
      press("Pair");
      await settle();
    }
    if (name === "invite") {
      content.querySelector(".trew-add-device").open = true;
      press("Create invite");
      await settle();
      this.target = content.querySelector(".trew-add-device");
      this.target.scrollIntoView({ block: "center" });
    }
    if (name === "server") {
      content.querySelector(".trew-server").open = true;
      this.target = content.querySelector(".trew-server");
      this.target.scrollIntoView({ block: "center" });
    }
    if (name === "devices") {
      content.querySelector(".trew-manage").open = true;
      const button = press("Show devices");
      await settle();
      this.target = button.closest(".setting-item").nextElementSibling;
      this.target.scrollIntoView({ block: "center" });
    }
    if (name === "conflicts") {
      press("Compare");
      await settle();
    }
    if (name === "changes") {
      const rows = content.querySelectorAll(".modal-sidebar-list-item");
      rows[0].focus();
      rows[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      await settle();
      const selected = content.querySelectorAll(".modal-sidebar-list-item")[1];
      if (selected.getAttribute("aria-pressed") !== "true" || selected.ownerDocument.activeElement !== selected)
        throw new Error("History keyboard selection did not preserve focus");
      press("Show changes");
    }
  }

  capture(name, theme, path, device = "desktop") {
    this.pending = this.captureScene(name, theme, path, device);
    return this.pending;
  }

  async captureScene(name, theme, path, device) {
    try {
      await this.scene(name, theme, device);
      await settle();
      if (electron.clipboard.readText() === invite)
        electron.clipboard.writeText(this.clipboardBefore);
      const doc = this.target.ownerDocument;
      this.applyTheme(doc, theme);
      await settle();
      if (!doc.body.classList.contains(`theme-${theme}`)) throw new Error("Theme did not change");
      for (const notice of doc.querySelectorAll(".notice-container")) {
        if (!this.hiddenNotices.has(notice))
          this.hiddenNotices.set(notice, notice.style.visibility);
        notice.style.visibility = "hidden";
      }
      const rect = this.target.getBoundingClientRect();
      if (name === "settings") {
        const first = this.target.firstElementChild.getBoundingClientRect();
        const last = this.target.lastElementChild.getBoundingClientRect();
        rect.y = first.y;
        rect.height = last.bottom - first.y;
      }
      if (name === "devices") {
        const heading = this.target.previousElementSibling.getBoundingClientRect();
        rect.height += rect.y - heading.y;
        rect.y = heading.y;
      }
      if (!rect.width || !rect.height) throw new Error("Screenshot target is not visible");
      const window = this.findWindow(doc),
        bounds = window.getContentBounds();
      const padding = name === "status" ? 0 : 16;
      const crop = {
        x: Math.max(0, Math.floor(rect.x - padding)),
        y: Math.max(0, Math.floor(rect.y - padding)),
        width: Math.ceil(rect.width + padding * 2),
        height: Math.ceil(rect.height + padding * 2),
      };
      crop.width = Math.min(crop.width, bounds.width - crop.x);
      crop.height = Math.min(crop.height, bounds.height - crop.y);
      if (crop.width <= 0 || crop.height <= 0)
        throw new Error("Screenshot target is outside the window");
      const picture = await window.webContents.capturePage(crop);
      const png = picture.toPNG();
      if (picture.isEmpty() || png.length === 0)
        throw new Error("Obsidian returned an empty screenshot; keep the test window visible");
      if (device === "phone") this.checkPhoneLayout();
      // The runner treats this path's existence as completion. Expose it only
      // after layout checks and the entire PNG have finished successfully.
      fs.writeFileSync(path + ".tmp", png);
      fs.renameSync(path + ".tmp", path);
    } catch (err) {
      fs.writeFileSync(path + ".error", String(err.stack ?? err));
    }
  }

  checkPhoneLayout() {
    const host = this.modal?.contentEl ?? this.tab.containerEl;
    if (this.modal?.modalEl.hasClass("mod-trew-history")) {
      const sidebar = host.querySelector(".modal-sidebar").getBoundingClientRect();
      const pane = host.querySelector(".trew-history-content-container").getBoundingClientRect();
      const row = host.querySelector(".modal-sidebar-list-item")?.getBoundingClientRect();
      if (row && (sidebar.height < row.height || row.height < 44))
        throw new Error("Phone history clips the version controls");
      if (sidebar.bottom > pane.top + 1 || pane.height < 160)
        throw new Error(
          "Phone version list overlaps the note preview or leaves it too little space: " +
            JSON.stringify({ sidebar, pane, content: host.getBoundingClientRect() }),
        );
    }
    if (host.scrollWidth > host.clientWidth + 1)
      throw new Error("Phone dialog overflows horizontally");
    for (const row of host.querySelectorAll(".trew-activity-list .setting-item")) {
      const info = row.querySelector(".setting-item-info");
      if (info?.getBoundingClientRect().width < 80)
        throw new Error("Activity filename has no readable width");
      if (row.scrollWidth > row.clientWidth + 1)
        throw new Error("Activity row overflows horizontally");
    }
    if (!host.hasClass("trew-panel")) return;
    for (const row of host.querySelectorAll(".setting-item")) {
      if (!row.getBoundingClientRect().height) continue;
      const info = row.querySelector(".setting-item-info");
      const input = row.querySelector("input");
      const select = row.querySelector("select");
      if (select) {
        const bounds = select.getBoundingClientRect();
        if (
          bounds.height < 44 ||
          bounds.width < 200 ||
          bounds.right > host.getBoundingClientRect().right + 1
        )
          throw new Error("Phone first-sync choice is too small or clipped");
      }
      const buttons = [...row.querySelectorAll("button")];
      for (const button of buttons) {
        const b = button.getBoundingClientRect();
        if (b.height < 44)
          throw new Error("Phone button has a small tap target: " + button.textContent);
        if (!input && buttons.length === 1 && info?.textContent) {
          const label = info.getBoundingClientRect();
          if (b.left < label.right - 1 || b.top >= label.bottom)
            throw new Error(
              "Phone action stacks below its label: " +
                button.textContent +
                " " +
                JSON.stringify({
                  label,
                  button: b,
                  viewport: row.ownerDocument.defaultView.innerWidth,
                  direction: row.ownerDocument.defaultView.getComputedStyle(row).flexDirection,
                }),
            );
        }
      }
      if (input && buttons.length === 1) {
        const field = input.getBoundingClientRect(),
          button = buttons[0].getBoundingClientRect();
        if (field.width < 80 || Math.abs(field.top - button.top) > 2)
          throw new Error("Phone field and button do not share a usable row");
      }
    }
  }

  onunload() {
    this.modal?.close();
    this.app.setting.close();
    for (const [doc, dark] of this.themes) {
      doc.body.classList.toggle("theme-dark", dark);
      doc.body.classList.toggle("theme-light", !dark);
    }
    this.app.updateTheme();
    for (const [cls, present] of this.platformClasses)
      this.app.workspace.containerEl.ownerDocument.body.toggleClass(cls, present);
    this.window.setMinimumSize(...this.originalMinimum);
    this.window.setBounds(this.originalBounds);
    this.backdrop.remove();
    for (const [el, visibility] of this.hiddenNotices) el.style.visibility = visibility;
    if (electron.clipboard.readText() === invite)
      electron.clipboard.writeText(this.clipboardBefore);
  }
}
