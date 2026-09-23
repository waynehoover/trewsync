/**
 * The panel walk: run it, check it captured something real, write it down.
 *
 * `panel-shots.ts` explains at length why what CI can have is an outline and
 * not a picture. This is the gate around it, and the gate is deliberately
 * narrow. The artifact itself is not diffed against a golden copy, because the
 * point of it is to be looked at rather than to be another thing to keep in
 * step; what would be intolerable is the artifact quietly becoming empty, or
 * the walk stopping two states short, and nobody finding out until they went
 * looking for a picture that was not there. So: every state was reached, and
 * each one holds the words and the shape it exists to have.
 *
 * The ordering assertion is the one that earns its place twice over. `de4d519`
 * put the device rows above the row that offers them, and its own commit
 * message says a screenshot found it and a test could not. This checks it
 * against the same text a reviewer reads, so the artifact and the gate are
 * looking at the same thing.
 *
 * Writing the files from a test rather than from a script is not laziness. The
 * plugin cannot be imported outside vitest at all: `main.ts` imports `obsidian`,
 * the npm package has no runtime, and `vitest.config.ts` is the only place the
 * alias to `stub.ts` exists. A standalone runner would need a second copy of
 * that alias, and a second copy is a thing that drifts.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TestServer, cleanupBinary, serverBinary } from "../core/test-server.ts";
import { resetStub } from "./stub.ts";
import { asHtml, asText, walkPanelStates, type Shot } from "./panel-shots.ts";

/** Where the artifact lands. CI uploads this directory; `.gitignore` has it. */
const OUT = new URL("../../panel-shots/", import.meta.url).pathname;

let server: TestServer;
let shots: Shot[];
const unload: (() => void)[] = [];

/**
 * One walk for the whole file, rather than one per assertion.
 *
 * Every test below reads the same captures, and the artifact is written from
 * them, so walking again for each one would pair four devices nine more times
 * to produce nine copies of the same strings. It would also mean the file
 * uploaded came from a different walk than the one the assertions passed
 * against, which for an artifact whose whole job is to be believed is the
 * wrong way round.
 */
beforeAll(async () => {
  await serverBinary();
  resetStub();
  server = new TestServer();
  await server.start();
  const walked = await walkPanelStates(server);
  shots = walked.shots;
  for (const plugin of walked.loaded) unload.push(() => plugin.onunload());
}, 300_000);

afterAll(async () => {
  while (unload.length) unload.pop()!();
  if (server) await server.cleanup();
  await cleanupBinary();
});

/** Every state the walk is expected to reach, in the order it reaches them. */
const EXPECTED = [
  "unpaired",
  "config-unreadable",
  "pairing-finishing",
  "join-confirm",
  "paired",
  "stopped-offering-rejoin",
  "stopped-revoked",
  "devices-listed-last-device",
  "invite-created",
  "devices-listed",
  "devices-revoke-confirming",
  "recover-nothing-deleted",
  "history-newest-version",
  "history-diff",
  "status-bar-unpaired",
  "status-bar-pairing",
  "status-bar-pairing-waiting",
  "status-bar-connecting",
  "status-bar-loading",
  "status-bar-syncing-started",
  "status-bar-syncing",
  "status-bar-uploading",
  "status-bar-downloading",
  "status-bar-synced",
  "status-bar-synced-needing-attention",
  "status-bar-synced-with-a-version-waiting",
  "status-bar-failed",
  "status-bar-offline",
  "status-bar-offline-origin-refused",
  "status-bar-stopped",
];

describe("the panel walk", () => {
  const of = (name: string): string => {
    const shot = shots.find((s) => s.name === name);
    if (!shot) throw new Error(`the walk did not reach ${name}`);
    return shot.body;
  };

  /**
   * The same capture with its line breaks taken out.
   *
   * The outline wraps long strings to a readable width, so a sentence in the
   * panel is several lines here and a search for it finds nothing. Asserting
   * against the wrapped text would be asserting about the wrap column.
   */
  const prose = (name: string): string => of(name).replace(/\s+/g, " ");

  it("reaches every state it says it does, and captures something in each", async () => {
    expect(shots.map((s) => s.name)).toEqual(EXPECTED);
    for (const shot of shots) {
      // A capture that came back with the modal's own wrapper and nothing
      // inside it is the failure this whole file exists to notice: the
      // artifact would still be there, still open in a browser, and empty.
      expect(shot.body.split("\n").length, `${shot.name} captured almost nothing`).toBeGreaterThan(
        3,
      );
      expect(shot.why, `${shot.name} says nothing about what puts the panel there`).not.toBe("");
    }
  });

  it("gives a device with nothing one field, and a broken one none", () => {
    // The form, immediately. This screen used to ask which kind of device this
    // was before drawing anything, and every device pairs from an invite now,
    // so there is no question to ask: one field, Invite, and one button, Pair.
    expect(of("unpaired")).toMatch(/name {4}Invite$/m);
    expect(of("unpaired")).toContain("button  [Pair]");
    expect(of("unpaired")).not.toContain("Join an existing vault");
    expect(of("unpaired")).not.toContain("Set up a new vault");
    expect(of("unpaired")).not.toContain("Start a new vault");
    expect(prose("unpaired")).not.toMatch(/setup line|recovery key/i);
    // The defaults are present and out of the way.
    expect(of("unpaired")).toContain("More options");
    expect(of("unpaired")).not.toContain("First sync");
    expect(prose("join-confirm")).toContain("Confirm merge");
    expect(prose("join-confirm")).toContain(
      "Files moved or deleted on another device may reappear",
    );

    // Rule 2: unreadable is not absent. A pairing form here would offer to
    // write over a credential that may be the only copy, so there is none, and
    // the question is not asked either.
    expect(of("config-unreadable")).toMatch(/stopped/);
    expect(of("config-unreadable")).not.toMatch(/name {4}Invite$/m);
    expect(of("config-unreadable")).not.toContain("Which is this device?");

    // A pairing being finished is neither: no form to pair over the credential
    // it holds, and no paired panel for a vault not yet told it may connect.
    expect(prose("pairing-finishing")).toContain("Finishing pairing");
    expect(prose("pairing-finishing")).toContain("the same credential");
    expect(of("pairing-finishing")).toContain("button  [Try now]");
    expect(of("pairing-finishing")).not.toMatch(/name {4}Invite$/m);
    expect(of("pairing-finishing")).not.toContain("Sync status");
  });

  it("draws the paired panel's rows, in the order somebody reads them", () => {
    const body = of("paired");
    const rows = [
      // What a panel is opened for, always on screen.
      "Sync status",
      "Recover a deleted note",
      // Pairing, connection settings, then vault management in disclosures.
      "Add another device",
      "Server address",
      "Devices",
      "Unlink this vault",
    ];
    const at = rows.map((row) => body.indexOf(`name    ${row}`));
    for (const [i, row] of rows.entries()) {
      expect(at[i], `the paired panel has no "${row}" row`).toBeGreaterThan(-1);
    }
    expect(at, `the rows are out of order:\n${body}`).toEqual([...at].sort((x, y) => x - y));
  });

  /**
   * The altitude split, pinned against the same text a reviewer reads.
   *
   * design.md: a thing that matters only when something specific happens
   * appears in that moment. Pairing and management have their own disclosures;
   * sync and recovery remain visible. This is a layout claim, which is the kind this
   * artifact can hold on its own.
   */
  it("keeps the everyday rows out of the disclosure and the rare ones in", () => {
    const body = of("paired");
    const disclosure = body.indexOf("<details.trew-manage>");
    expect(disclosure, "the panel has no disclosure at all").toBeGreaterThan(-1);
    expect(body).toContain("Manage this vault");

    const adding = body.indexOf("<details.trew-add-device>");
    expect(adding).toBeGreaterThan(-1);
    expect(adding).toBeLessThan(body.indexOf("<details.trew-server>"));
    expect(body.indexOf("name    Add another device")).toBeGreaterThan(adding);
    for (const row of ["Sync status", "Recover a deleted note"]) {
      expect(
        body.indexOf(`name    ${row}`),
        `"${row}" is behind the disclosure, and it is an everyday row`,
      ).toBeLessThan(adding);
    }
    for (const row of ["Devices", "Unlink this vault"]) {
      expect(
        body.indexOf(`name    ${row}`),
        `"${row}" is on the everyday panel, and it is rare or destructive`,
      ).toBeGreaterThan(disclosure);
    }
  });

  it("uses native setting groups without question-mark controls", () => {
    expect(of("paired")).toContain("setting-group");
    expect(prose("paired").indexOf("Local cursor")).toBeLessThan(
      prose("paired").indexOf("name Server address"),
    );
    expect(prose("paired").indexOf("Connected to")).toBeLessThan(
      prose("paired").indexOf("name Server address"),
    );
    for (const shot of shots) expect(shot.body).not.toContain("trew-help");
  });

  /**
   * A paragraph waiting to be filled takes no room until it is.
   *
   * An empty `<p>` still occupies a line, and with a description under every
   * row that went unnoticed. With rows that are a label and a control it is
   * visible: the gap under "Add another device" was wider than every other
   * gap, and it was two paragraphs holding space for an invite that did not
   * exist yet. Caught in a screenshot, like the three layout faults before it.
   */
  it("reserves no space for a paragraph with nothing in it", () => {
    const empty: string[] = [];
    for (const shot of shots) {
      const lines = shot.body.split("\n");
      for (const [i, line] of lines.entries()) {
        const tag = /^\s*<p(\.[\w.-]+)?>$/.exec(line);
        if (!tag) continue;
        // A paragraph is empty here if the next line is not deeper than it.
        const indent = line.search(/\S/);
        const next = lines[i + 1];
        if (next === undefined || next.search(/\S/) <= indent) {
          empty.push(`${shot.name}: ${line.trim()}`);
        }
      }
    }
    expect(
      empty,
      `these paragraphs are empty and still take a line; build them with later():\n${empty.join("\n")}`,
    ).toEqual([]);
  });

  /**
   * The things the cut was not allowed to take, each still on screen.
   *
   * Every one of them was a paragraph somebody argued for, and each is now a
   * clause. Compressed is fine; gone is not, and this is the difference.
   */
  it("still says the things that were paid for in incidents", () => {
    // What revoking does not do, which is the half that used to be
    // overstated: nothing a device already synced is taken back, and without
    // end-to-end encryption it is readable there as it is.
    expect(prose("devices-revoke-confirming")).toMatch(/Revoking does not un-read anything/);
    expect(prose("devices-revoke-confirming")).toMatch(/stay readable there, in plaintext/);
    // Nothing of the vault-wide key that Basalt's copy leaned on is left.
    expect(prose("devices-revoke-confirming")).not.toMatch(/decryption key/);
    // An invite: one device, once, and it expires, after the hour the server
    // gives it.
    expect(prose("paired")).toMatch(/Create a one-time invite. Expires in one hour/);
    expect(prose("devices-listed")).toMatch(/Expires /);
    // No recovery key: no row for one, and no screen that shows one.
    expect(prose("paired")).not.toMatch(/recovery key/i);
    // And what a hop with nothing in front of it costs, which inverted with
    // the encryption: Basalt could say the notes were sealed anyway and only
    // the credential was exposed, and here both are (plan/strip-ledger.md,
    // hazard 8). The half somebody has to act on is that the notes are.
    expect(prose("paired")).toMatch(
      /No TLS on this hop: your notes and the device credential both cross it in the clear/,
    );
    expect(prose("paired")).not.toMatch(/still sealed/);
  });

  /**
   * de4d519, pinned against the text a reviewer looks at.
   *
   * The device rows are built into a container the panel creates *after* the
   * row that offers them, precisely so they land underneath it. Created first,
   * they rendered above it and the list appeared to belong to whatever setting
   * sat above. That is a child-order bug, so it is visible here, and it is the
   * one bug class this artifact can catch on its own.
   */
  it("puts the device rows below the row that offers them", () => {
    const body = of("devices-listed");
    const offer = body.indexOf("name    Devices");
    const first = body.indexOf("Received latest changes");
    expect(offer, "there is no Devices row at all").toBeGreaterThan(-1);
    expect(first, "no device rows were drawn").toBeGreaterThan(-1);
    expect(first, `the rows came out above the row that offers them:\n${body}`).toBeGreaterThan(
      offer,
    );
    // The outstanding invite is under the rows for the same reason: a row is
    // a device that was added and an invite is one about to be.
    expect(body.indexOf("Outstanding invite")).toBeGreaterThan(first);
    expect(prose("devices-listed")).not.toContain("decryption key");
  });

  it("gives the one-device vault's row its button, without command-line flags", () => {
    const body = of("devices-listed-last-device");
    expect(body).toContain("Received latest changes");
    // The last device may be revoked (hazard 4, decided): the way back into a
    // vault with no devices is `trewd invite` on the server, so the row keeps
    // its button like any other. It is this device, so the button says so.
    expect(body).toContain("button  [Unlink from the server] (warning)");
    expect(prose("devices-listed-last-device")).toContain("1 device");
    expect(body).not.toContain("--allow-last");
  });

  it("says out loud, mid-revocation, that revoking does not un-read anything", () => {
    const body = of("devices-revoke-confirming");
    // The first press only relabels and explains. Nothing has happened yet,
    // which is what makes a destructive button in a panel safe to draw.
    expect(body).toContain("button  [Yes, revoke]");
    expect(prose("devices-revoke-confirming")).toMatch(/Revoking does not un-read anything/);
  });

  it("puts the invite on screen where it can be read", () => {
    // A string somebody has to copy off a screen that may have no clipboard
    // behind it, so it has to be rendered and not only offered.
    expect(of("invite-created")).toContain("trew1i_");
    expect(of("invite-created")).toContain("Pairing code");
    expect(of("invite-created")).toContain("button  [Copy]");
    // Nothing else a person has to write down: there is no recovery key.
    for (const shot of shots) expect(shot.body, shot.name).not.toContain("basalt3");
  });

  it("grows the way out when the server has gone backwards", () => {
    // The rejoin row is drawn rather than updated, so a panel left open when
    // this happens has to redraw itself to offer it.
    expect(of("stopped-offering-rejoin")).toMatch(/[Rr]ejoin/);
  });

  it("offers a revoked device the pairing form, and none of the paired panel", () => {
    const body = of("stopped-revoked");
    expect(body).toContain("Pair this device again");
    expect(prose("stopped-revoked")).toMatch(/notes stay where they are/);
    expect(body).toContain("button  [Pair]");
    for (const dead of ["[Sync now]", "[Create invite]", "[Browse deleted]", "[Unlink]"]) {
      expect(body, `a revoked device was offered ${dead}`).not.toContain(dead);
    }
  });

  /**
   * dae9dcb, pinned the same way, for the three of its four defects that were
   * facts about this tree rather than about geometry.
   */
  it("opens the history on the newest version, says which note, and marks up the diff", () => {
    const body = of("history-newest-version");
    // `setTitle` is invisible under mod-sidebar-layout, which collapses the
    // modal header to nothing, so the path is drawn above the list instead.
    // Without it the modal never says which note you are looking at.
    expect(body).toContain("trew-history-heading");
    expect(body).toContain("Daily/2026-09-04.md");
    // Not an empty pane. The newest version is what somebody opening history
    // is nearly always after, and it is what the pane starts on.
    expect(body, `the pane opened on nothing:\n${body}`).toContain("A second line.");
    // Two versions in the list, because one was written over the other, and a
    // Restore button in the pane, which is the only thing in this modal that
    // changes anything.
    expect([...body.matchAll(/modal-sidebar-list-item-header/g)].length).toBeGreaterThanOrEqual(2);
    expect(body).toContain("Restore");

    // And the diff is marked up rather than dumped. styles.css has had rules
    // for added and removed lines since it was written, and for a while the
    // whole diff went into the `<pre>` as one run of text: both rules matched
    // nothing and every diff rendered in one colour. One element per line is
    // what those rules need, so the count of them is what says they can work.
    const diff = of("history-diff");
    expect(diff).toContain("<pre.trew-history-diff>");
    for (const cls of ["trew-added", "trew-removed"]) {
      expect(diff, `nothing in the diff carries ${cls}:\n${diff}`).toContain(`<span.${cls}>`);
    }
  });

  it("gives every status-bar state a glyph and a tooltip of its own", () => {
    const glyphs = new Map<string, string>();
    for (const shot of shots.filter((s) => s.name.startsWith("status-bar-"))) {
      const icon = /@data-icon {2}(.+)/.exec(shot.body)?.[1];
      const label = /@aria-label {2}(.+)/.exec(shot.body)?.[1];
      expect(icon, `${shot.name} drew no glyph`).toBeTruthy();
      expect(label, `${shot.name} has no tooltip`).toBeTruthy();
      glyphs.set(shot.name, `${icon}`);
    }
    // Rule 7: a status that cannot tell two conditions apart is not a status.
    // Offline and stopped are the pair that matters, because one comes back on
    // its own and the other needs a person.
    expect(glyphs.get("status-bar-offline")).not.toBe(glyphs.get("status-bar-stopped"));
    expect(glyphs.get("status-bar-synced")).not.toBe(
      glyphs.get("status-bar-synced-needing-attention"),
    );
  });

  /**
   * The artifact, written where CI collects it.
   *
   * Its own test rather than an `afterAll`, so that "the panel states were not
   * written" is a line in the report instead of an unexplained empty upload.
   */
  it("writes the states somewhere a person can look at them", async () => {
    await mkdir(OUT, { recursive: true });
    await writeFile(join(OUT, "panel-states.txt"), asText(shots));
    await writeFile(join(OUT, "panel-states.html"), asHtml(shots));

    const text = await readFile(join(OUT, "panel-states.txt"), "utf8");
    // Rule 4: verify the outcome, not the exit code. A capture step that
    // wrote a header and no states would be a green job and an empty
    // artifact, which is the failure that hides for months.
    for (const shot of shots) expect(text, `${shot.name} is not in the file`).toContain(shot.name);
    expect(text).toMatch(/[Nn]ot a screenshot/);
    expect(text.length, "the file is too small to hold what was walked").toBeGreaterThan(5_000);

    const html = await readFile(join(OUT, "panel-states.html"), "utf8");
    expect(html).toContain("<pre>");
    for (const shot of shots) expect(html).toContain(`id="${shot.name}"`);
  });
});
