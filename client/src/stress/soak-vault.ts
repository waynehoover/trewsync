/**
 * The scratch vault the soak runs on, and the person editing it.
 *
 * The soak (soak.ts) is PLAN.md M5's "a day of real use on a scratch vault",
 * so the vault is shaped like one somebody has kept for a while rather than
 * like the stress suite's numbered notes: daily notes, projects, people,
 * meetings that mention them, reading notes, an inbox, a few attachments,
 * frontmatter with the inconsistencies real frontmatter has, inline tags,
 * wiki links, Markdown links and embeds.
 *
 * The person is a set of edits of the kinds people make, each carrying a
 * marker of its own (`soak-phone-17`), so that afterwards every version a
 * device wrote can be looked for in the server's history even when the engine
 * merged it with somebody else's and its exact bytes never reached the server.
 * No edit removes text an earlier one wrote, which is what makes "the marker
 * is somewhere in history" a statement about loss rather than about editing.
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** A small seeded generator, so a failing run can be run again. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    // mulberry32
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  pick<T>(xs: readonly T[]): T {
    if (xs.length === 0) throw new Error("pick from nothing");
    return xs[Math.floor(this.next() * xs.length)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

export const sha256 = (b: Uint8Array | string): string =>
  createHash("sha256").update(b).digest("hex");

const FIRST = [
  "Ada",
  "Ben",
  "Chloe",
  "Dev",
  "Elena",
  "Farid",
  "Grace",
  "Hiro",
  "Ines",
  "Jonas",
  "Kemi",
  "Liam",
  "Maya",
  "Noor",
  "Oscar",
  "Priya",
  "Quinn",
  "Rosa",
  "Sam",
  "Tomas",
  "Uma",
  "Victor",
  "Wren",
  "Xia",
  "Yusuf",
  "Zoe",
];
const LAST = [
  "Okafor",
  "Lindqvist",
  "Moreau",
  "Tanaka",
  "Reyes",
  "Novak",
  "Haddad",
  "Kowalski",
  "Singh",
  "Brennan",
  "Castillo",
  "Ivanova",
  "Mensah",
  "Fischer",
  "Duarte",
];
const PROJECTS = [
  "Garden shed",
  "Kitchen remodel",
  "Tax return 2026",
  "Home network",
  "Book club",
  "Marathon training",
  "Photo archive",
  "Trip to Lisbon",
  "Budget spreadsheet",
  "Podcast pilot",
  "Bike overhaul",
  "Recipe collection",
  "Language exchange",
  "Volunteer rota",
  "Solar panels",
  "Backyard pond",
  "Wedding speech",
  "Car sale",
  "Home office",
  "Reading challenge",
  "Sourdough",
  "Family tree",
  "Newsletter",
  "Camping gear",
  "Piano practice",
];
const BOOKS = [
  "The Overstory",
  "Piranesi",
  "Deep Work",
  "A Pattern Language",
  "The Dispossessed",
  "Klara and the Sun",
  "Thinking in Systems",
  "The Remains of the Day",
  "Braiding Sweetgrass",
  "The Left Hand of Darkness",
  "Four Thousand Weeks",
  "Station Eleven",
  "The Design of Everyday Things",
  "Middlemarch",
  "The Art of Gathering",
  "Project Hail Mary",
  "How to Take Smart Notes",
  "The Name of the Rose",
  "Educated",
  "Gödel, Escher, Bach",
];
const WORDS = (
  "the a we should maybe later check call email follow up plan draft review decide " +
  "compare budget order schedule move clean fix test write read ask share finish start " +
  "garden kitchen invoice meeting notes idea list draft window paint shelf cable router " +
  "chapter theme argument quote question answer timeline estimate receipt ticket"
).split(" ");
/** Tags as people type them: the same tag in several spellings, which tidying fixes. */
const TAGS = [
  "project",
  "Project",
  "idea",
  "Idea",
  "todo",
  "reading",
  "book",
  "Book",
  "person",
  "meeting",
  "home",
  "health",
  "finance",
  "Finance",
  "travel",
  "draft",
  "someday",
  "waiting",
];

function sentence(r: Rng, n = r.int(6, 14)): string {
  const w: string[] = [];
  for (let i = 0; i < n; i++) w.push(r.pick(WORDS));
  const s = w.join(" ");
  return s[0]!.toUpperCase() + s.slice(1) + ".";
}

function dayString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Paths of the seed vault, for a scripted agent that wants to pick its targets. */
export interface SeedShape {
  people: string[];
  projects: string[];
  meetings: string[];
  reading: string[];
  inbox: string[];
  dailies: string[];
  attachments: string[];
  placeholders: string[];
}

/**
 * Writes a vault of about `notes` notes and `attachments` attachments into
 * `dir`, deterministically from `seed`. `today` is the day the soak's
 * compressed day is, so the daily notes run up to the day before it.
 */
export async function seedVault(
  dir: string,
  opts: { notes: number; attachments: number; seed: number; today: string },
): Promise<SeedShape> {
  const r = new Rng(opts.seed);
  const files = new Map<string, string | Uint8Array>();
  const shape: SeedShape = {
    people: [],
    projects: [],
    meetings: [],
    reading: [],
    inbox: [],
    dailies: [],
    attachments: [],
    placeholders: [],
  };
  const share = (f: number) => Math.max(2, Math.round(opts.notes * f));

  const people: string[] = [];
  const seen = new Set<string>();
  while (people.length < Math.min(share(0.13), FIRST.length * LAST.length)) {
    const name = `${r.pick(FIRST)} ${r.pick(LAST)}`;
    if (seen.has(name)) continue;
    seen.add(name);
    people.push(name);
  }
  const projects = PROJECTS.slice(0, Math.min(share(0.08), PROJECTS.length));
  const books = BOOKS.slice(0, Math.min(share(0.07), BOOKS.length));

  // Attachments first, so notes can embed them.
  for (let i = 1; i <= opts.attachments; i++) {
    const kind = i % 3 === 0 ? "pdf" : "png";
    const path = `Attachments/${kind === "png" ? "Pasted image" : "scan"} ${2026_0900 + i}.${kind}`;
    const size = r.int(2_000, 40_000);
    const bytes = new Uint8Array(size);
    for (let j = 0; j < size; j++) bytes[j] = r.int(0, 255);
    if (kind === "png") bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    else bytes.set(new TextEncoder().encode("%PDF-1.7\n"));
    files.set(path, bytes);
    shape.attachments.push(path);
  }
  const embed = () =>
    shape.attachments.length && r.chance(0.3)
      ? `\n![[${r.pick(shape.attachments).slice("Attachments/".length)}]]\n`
      : "";

  for (const name of people) {
    const path = `People/${name}.md`;
    const tag = r.chance(0.7) ? "person" : "Person";
    files.set(
      path,
      `---\ntags: [${tag}]\n${r.chance(0.5) ? "Status: active" : "status: active"}\n---\n# ${name}\n\n` +
        `Met through ${r.pick(projects)}. ${sentence(r)}\n\n## Notes\n\n- ${sentence(r)}\n- ${sentence(r)}\n`,
    );
    shape.people.push(path);
  }
  for (const p of projects) {
    const path = `Projects/${p}.md`;
    const who = [r.pick(people), r.pick(people)];
    files.set(
      path,
      `---\ntags: [${r.pick(["project", "Project"])}, ${r.pick(TAGS)}]\nstatus: ${r.pick(["active", "Active", "paused", "done"])}\n` +
        `created: 2026-0${r.int(1, 8)}-1${r.int(0, 9)}\n---\n# ${p}\n\nWith [[${who[0]}]] and ${who[1]}.\n\n` +
        `## Next\n\n- [ ] ${sentence(r)}\n- [ ] ${sentence(r)}\n- [x] ${sentence(r)}\n\n## Log\n\n${sentence(r)} ${sentence(r)}\n${embed()}`,
    );
    shape.projects.push(path);
  }
  for (const b of books) {
    const path = `Reading/${b}.md`;
    files.set(
      path,
      `---\ntags: [${r.pick(["book", "Book", "reading"])}]\nrating: ${r.int(2, 5)}\n---\n# ${b}\n\n` +
        `> ${sentence(r)}\n\n${sentence(r)} ${sentence(r)}\n\nSee also [${r.pick(books)}](${encodeURI(r.pick(books))}.md).\n`,
    );
    shape.reading.push(path);
  }
  const base = new Date(`${opts.today}T12:00:00Z`);
  const dailyCount = share(0.2);
  for (let i = dailyCount; i >= 1; i--) {
    const d = dayString(new Date(base.getTime() - i * 86_400_000));
    const path = `Daily/${d}.md`;
    files.set(
      path,
      `# ${d}\n\n## Log\n\n- ${sentence(r)}\n- Talked to [[${r.pick(people)}]] about [[${r.pick(projects)}]].\n` +
        `- ${sentence(r)} #${r.pick(TAGS)}\n${embed()}`,
    );
    shape.dailies.push(path);
  }
  const meetingCount = share(0.25);
  for (let i = 1; i <= meetingCount; i++) {
    const d = dayString(new Date(base.getTime() - r.int(1, 120) * 86_400_000));
    const topic = r.pick(projects);
    const path = `Meetings/2026/${d} ${topic} ${i}.md`;
    const a = r.pick(people),
      b = r.pick(people);
    files.set(
      path,
      `---\ntags: [meeting]\ndate: ${d}\nattendees: ["${a}", "${b}"]\n---\n# ${topic}\n\n` +
        // One attendee linked and one only named, which "add backlinks" fixes.
        `Attendees: [[${a}]], ${b}\n\n## Discussion\n\n- ${sentence(r)}\n- ${sentence(r)}\n\n## Actions\n\n- [ ] ${b}: ${sentence(r, 6)}\n`,
    );
    shape.meetings.push(path);
  }
  const areas = ["Health", "Finance", "Home", "Career", "Friends", "Learning"];
  for (const a of areas) {
    files.set(
      `Areas/${a}.md`,
      `# ${a}\n\n#${a.toLowerCase()}\n\n${sentence(r)}\n\n- [[${r.pick(projects)}]]\n`,
    );
  }
  files.set(
    "Home.md",
    `# Home\n\n- [[Areas/Health|Health]] · [[Areas/Finance|Finance]] · [[Areas/Home|Home]]\n- Projects: ${projects
      .slice(0, 5)
      .map((p) => `[[${p}]]`)
      .join(", ")}\n- Reading: [${books[0]}](Reading/${encodeURI(books[0]!)}.md)\n`,
  );
  let n = files.size;
  let i = 0;
  while (n < opts.notes) {
    i++;
    const path = `Inbox/${r.chance(0.2) ? "Untitled" : sentence(r, 3).slice(0, -1)} ${i}.md`;
    if (r.chance(0.15)) {
      files.set(path, "");
      shape.placeholders.push(path);
    } else {
      files.set(
        path,
        `${sentence(r)}\n\n${r.chance(0.5) ? `#${r.pick(TAGS)} ` : ""}${sentence(r)} [[${r.pick(people)}]]\n`,
      );
    }
    shape.inbox.push(path);
    n++;
  }
  for (const [path, body] of files) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), body);
  }
  return shape;
}

/** One thing a device's person did, as the soak's ledger keeps it. */
export interface Edit {
  readonly device: string;
  readonly n: number;
  readonly at: number;
  readonly op: string;
  /** The path the edit wrote, or the destination of a rename. */
  readonly path: string;
  readonly from?: string;
  /** The file's bytes before, when there was a file. */
  readonly beforeHash?: string;
  /** What the edit left, absent for a deletion. */
  readonly afterHash?: string;
  readonly after?: string;
  /** The text this edit introduced, unique to it; absent for a rename or deletion. */
  readonly marker?: string;
}

const COPY = /\(Conflicted copy /;

/** Every Markdown note in a device's directory, as its person could open it. */
export async function markdownIn(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (at: string, prefix: string): Promise<void> => {
    let items;
    try {
      items = await readdir(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (item.name.startsWith(".")) continue;
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) await walk(join(at, item.name), path);
      else if (item.name.endsWith(".md") && !COPY.test(item.name)) out.push(path);
    }
  };
  await walk(dir, "");
  return out.sort();
}

async function readMaybe(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * A person at one device. Every `act` makes one edit of the kinds people make
 * and records it in the ledger; it never removes text an earlier edit wrote.
 */
export class Person {
  private n = 0;
  constructor(
    readonly device: string,
    readonly dir: string,
    private readonly r: Rng,
    readonly ledger: Edit[],
    private readonly today: string,
  ) {}

  private marker(): string {
    return `soak-${this.device}-${++this.n}`;
  }

  private clock(): string {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }

  /** Writes `text` at `path`, recording the edit. */
  private async write(op: string, path: string, text: string, marker: string): Promise<Edit> {
    const abs = join(this.dir, path);
    const before = await readMaybe(abs);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, text);
    const e: Edit = {
      device: this.device,
      n: this.n,
      at: Date.now(),
      op,
      path,
      marker,
      ...(before === undefined ? {} : { beforeHash: sha256(before) }),
      afterHash: sha256(text),
      after: text,
    };
    this.ledger.push(e);
    return e;
  }

  async act(): Promise<Edit | undefined> {
    const notes = await markdownIn(this.dir);
    const others = notes.filter((p) => !p.startsWith("Daily/"));
    const roll = this.r.next();
    try {
      if (roll < 0.25 || others.length === 0) return await this.daily();
      if (roll < 0.45) return await this.extendLine(this.r.pick(others));
      if (roll < 0.6) return await this.bullet(this.r.pick(others));
      if (roll < 0.7) return await this.inlineTag(this.r.pick(others));
      if (roll < 0.8) return await this.frontmatter(this.r.pick(others));
      if (roll < 0.88) return await this.create(notes);
      if (roll < 0.94) return await this.rename(others);
      if (roll < 0.97) return await this.remove(others);
      return await this.attach(others);
    } catch (err) {
      // A file that vanished under the edit, because a sync moved or deleted
      // it a moment ago, is what a person sees too: they try something else.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  private async daily(): Promise<Edit> {
    const path = `Daily/${this.today}.md`;
    const m = this.marker();
    const before = (await readMaybe(join(this.dir, path))) ?? `# ${this.today}\n\n## Log\n\n`;
    const sep = before.endsWith("\n") || before === "" ? "" : "\n";
    return this.write(
      "daily",
      path,
      `${before}${sep}- ${this.clock()} ${sentence(this.r)} ${m}\n`,
      m,
    );
  }

  /** Adds words to the end of one body line, keeping the line. */
  private async extendLine(path: string): Promise<Edit | undefined> {
    const text = await readMaybe(join(this.dir, path));
    if (text === undefined) return undefined;
    const lines = text.split("\n");
    const body = bodyStart(lines);
    const candidates = lines.map((_, i) => i).filter((i) => i >= body && lines[i]!.trim() !== "");
    if (candidates.length === 0) return this.bullet(path);
    const i = this.r.pick(candidates);
    const m = this.marker();
    lines[i] = `${lines[i]} ${sentence(this.r, 4).slice(0, -1).toLowerCase()} ${m}`;
    return this.write("extend", path, lines.join("\n"), m);
  }

  /** Inserts a bullet after a random body line. */
  private async bullet(path: string): Promise<Edit | undefined> {
    const text = await readMaybe(join(this.dir, path));
    if (text === undefined) return undefined;
    const lines = text.split("\n");
    const at = this.r.int(bodyStart(lines), lines.length);
    const m = this.marker();
    lines.splice(at, 0, `- ${sentence(this.r)} ${m}`);
    return this.write("bullet", path, lines.join("\n"), m);
  }

  private async inlineTag(path: string): Promise<Edit | undefined> {
    const text = await readMaybe(join(this.dir, path));
    if (text === undefined) return undefined;
    const m = this.marker();
    const sep = text === "" || text.endsWith("\n") ? "" : "\n";
    return this.write("tag", path, `${text}${sep}#${this.r.pick(TAGS)} ${m}\n`, m);
  }

  /** Adds or extends frontmatter with a line of its own. */
  private async frontmatter(path: string): Promise<Edit | undefined> {
    const text = await readMaybe(join(this.dir, path));
    if (text === undefined) return undefined;
    const m = this.marker();
    const line = `reviewed: ${this.today} ${m}`;
    if (text.startsWith("---\n")) {
      const end = text.indexOf("\n---", 4);
      if (end > 0)
        return this.write(
          "frontmatter",
          path,
          `${text.slice(0, end)}\n${line}${text.slice(end)}`,
          m,
        );
    }
    return this.write("frontmatter", path, `---\n${line}\n---\n${text}`, m);
  }

  private async create(notes: string[]): Promise<Edit> {
    const m = this.marker();
    const target = notes.length ? this.r.pick(notes) : "Home.md";
    const name = target.slice(target.lastIndexOf("/") + 1, -3);
    const path = `Inbox/${sentence(this.r, 3).slice(0, -1)} ${m}.md`;
    return this.write(
      "create",
      path,
      `# ${sentence(this.r, 4).slice(0, -1)}\n\nAbout [[${name}]]. ${sentence(this.r)} ${m}\n`,
      m,
    );
  }

  private async rename(notes: string[]): Promise<Edit | undefined> {
    const from = this.r.pick(
      notes
        .filter((p) => p.startsWith("Inbox/") || p.startsWith("Projects/"))
        .concat(notes.slice(0, 1)),
    );
    const abs = join(this.dir, from);
    const before = await readMaybe(abs);
    if (before === undefined) return undefined;
    const folder = from.includes("/") ? from.slice(0, from.lastIndexOf("/")) : "";
    const dest = this.r.chance(0.5)
      ? folder
      : this.r.pick(["Areas", "Projects", "Inbox", "Reading"]);
    const stem = from.slice(from.lastIndexOf("/") + 1, -3).replace(/ \(renamed \d+\)$/, "");
    const to = `${dest ? `${dest}/` : ""}${stem} (renamed ${++this.n}).md`;
    await mkdir(dirname(join(this.dir, to)), { recursive: true });
    await rename(abs, join(this.dir, to));
    const e: Edit = {
      device: this.device,
      n: this.n,
      at: Date.now(),
      op: "rename",
      path: to,
      from,
      beforeHash: sha256(before),
      afterHash: sha256(before),
      after: before,
    };
    this.ledger.push(e);
    return e;
  }

  private async remove(notes: string[]): Promise<Edit | undefined> {
    const inbox = notes.filter((p) => p.startsWith("Inbox/"));
    if (inbox.length === 0) return undefined;
    const path = this.r.pick(inbox);
    const before = await readMaybe(join(this.dir, path));
    if (before === undefined) return undefined;
    await rm(join(this.dir, path));
    const e: Edit = {
      device: this.device,
      n: ++this.n,
      at: Date.now(),
      op: "delete",
      path,
      beforeHash: sha256(before),
    };
    this.ledger.push(e);
    return e;
  }

  /** Pastes an image into a note: a new attachment, and an embed of it. */
  private async attach(notes: string[]): Promise<Edit | undefined> {
    const path = this.r.pick(notes);
    const text = await readMaybe(join(this.dir, path));
    if (text === undefined) return undefined;
    const m = this.marker();
    const name = `Pasted image ${m}.png`;
    const bytes = new Uint8Array(this.r.int(3_000, 20_000));
    for (let i = 0; i < bytes.length; i++) bytes[i] = this.r.int(0, 255);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await mkdir(join(this.dir, "Attachments"), { recursive: true });
    await writeFile(join(this.dir, "Attachments", name), bytes);
    this.ledger.push({
      device: this.device,
      n: this.n,
      at: Date.now(),
      op: "attachment",
      path: `Attachments/${name}`,
      afterHash: sha256(bytes),
      marker: m,
    });
    const sep = text === "" || text.endsWith("\n") ? "" : "\n";
    return this.write("embed", path, `${text}${sep}\n![[${name}]] ${m}\n`, m);
  }
}

function bodyStart(lines: string[]): number {
  if (lines[0] !== "---") return 0;
  const end = lines.indexOf("---", 1);
  return end < 0 ? 0 : end + 1;
}
