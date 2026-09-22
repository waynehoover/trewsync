import { createHash } from "node:crypto";
import type { FileStat } from "../core/vault.ts";
import {
  backupOf,
  inputText,
  NOTE_BYTES,
  NoteError,
  noteFailure,
  noteFormat,
  noteText,
} from "./mcp-notes.ts";
import type { NodeVault } from "./vault.ts";
import { matchesTag, tagOccurrences, validateTag } from "./mcp-markdown.ts";

export const PAGE_TEXT_BYTES = 64 * 1024;
const PAGE_ROWS_BYTES = 192 * 1024;
const SEARCH_BYTES = 8 * 1024 * 1024;
const SEARCH_FILES = 512;
interface Position {
  path: string;
  line: number;
  column: number;
}
export interface ListNotesInput {
  folder?: string | undefined;
  nameContains?: string | undefined;
  after?: string | undefined;
  limit?: number | undefined;
  includeBackups?: boolean | undefined;
}
export interface ReadNoteInput {
  path: string;
  startLine?: number | undefined;
  maxLines?: number | undefined;
  base?: string | undefined;
}
export interface SearchNotesInput {
  query: string;
  mode?: "content" | "filename" | "both" | "tag" | undefined;
  includeChildren?: boolean | undefined;
  folder?: string | undefined;
  caseSensitive?: boolean | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
  contextLines?: number | undefined;
  includeBackups?: boolean | undefined;
}

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new NoteError("cancelled", "the read was cancelled");
}
function bound(value: number | undefined, fallback: number, max: number, min = 1): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max)
    throw new NoteError("invalid_limit", "the requested page limit is invalid");
  return result;
}
function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function token(query: unknown, at: Position): string {
  // JSON escaping expanded legal Linux paths past the cursor's own input cap.
  // Encode the UTF-8 path separately so control characters cost no extra space.
  const path = Buffer.from(at.path).toString("base64url");
  return Buffer.from(JSON.stringify({ query: fingerprint(query), at: { ...at, path } })).toString(
    "base64url",
  );
}
function position(value: string | undefined, query: unknown): Position | undefined {
  if (value === undefined) return undefined;
  if (value.length > 8192 || !/^[A-Za-z0-9_-]+$/u.test(value))
    throw new NoteError("invalid_cursor", "the continuation is invalid");
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      query?: unknown;
      at?: Partial<Position>;
    };
    if (
      parsed.query !== fingerprint(query) ||
      typeof parsed.at?.path !== "string" ||
      !/^[A-Za-z0-9_-]*$/u.test(parsed.at.path) ||
      !Number.isSafeInteger(parsed.at.line) ||
      !Number.isSafeInteger(parsed.at.column) ||
      parsed.at.line! < 0 ||
      parsed.at.column! < 0
    )
      throw new Error();
    const bytes = Buffer.from(parsed.at.path, "base64url");
    if (bytes.length > 4096 || bytes.toString("base64url") !== parsed.at.path) throw new Error();
    const path = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return { path, line: parsed.at.line!, column: parsed.at.column! };
  } catch {
    throw new NoteError("invalid_cursor", "the continuation does not match these query options");
  }
}
function supported(path: string): boolean {
  try {
    noteFormat(path);
    return true;
  } catch {
    return false;
  }
}
function inFolder(path: string, folder: string): boolean {
  return !folder || path.startsWith(folder + "/");
}
function byteSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}
function clip(text: string, max = 2048): string {
  let result = text.slice(0, max);
  if (/\p{Surrogate}$/u.test(result)) result = result.slice(0, -1);
  return result;
}

export function pageNote(bytes: Uint8Array, path: string, input: ReadNoteInput) {
  const base = createHash("sha256").update(bytes).digest("hex");
  if (input.base !== undefined && input.base !== base)
    throw new NoteError("stale", "the note changed between pages; read and reconsider");
  const source = noteText(bytes);
  const start = bound(input.startLine, 1, Number.MAX_SAFE_INTEGER);
  const maxLines = bound(input.maxLines, 200, 1000);
  // Keep line terminators in their original form, including a trailing CR.
  const lines = source.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const page: string[] = [];
  let used = 0;
  let index = Math.min(start - 1, lines.length);
  for (; index < lines.length && page.length < maxLines; index++) {
    const line = lines[index]!;
    const size = Buffer.byteLength(line);
    if (used + size > PAGE_TEXT_BYTES) {
      if (!page.length)
        throw new NoteError("line_too_large", "this line exceeds the 64 KiB page budget");
      break;
    }
    page.push(line);
    used += size;
  }
  return {
    path,
    source: "local" as const,
    content: page.join(""),
    base,
    size: bytes.length,
    startLine: start,
    endLine: start + page.length - 1,
    nextLine: index < lines.length ? index + 1 : null,
    complete: index >= lines.length,
    observedAt: Date.now(),
  };
}

/** The observe-only adapter owns mutable walk caches, even though it writes no notes. */
export class McpReader {
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  constructor(readonly vault: NodeVault) {}

  run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.pending >= 16)
      return Promise.reject(new NoteError("busy", "the note reader queue is full"));
    this.pending++;
    const next = this.queue.then(async () => {
      aborted(signal);
      return work();
    });
    this.queue = next.catch(() => undefined);
    return next.finally(() => {
      this.pending--;
    });
  }
  async drain(): Promise<void> {
    await this.queue;
  }
  private async folder(value?: string): Promise<string> {
    return (await this.vault.checkPath(value ?? "", { kind: "directory" })).path;
  }
  private async inventory(folder: string): Promise<FileStat[]> {
    const files = await this.vault.list({ forceFull: true, checked: true });
    return files
      .filter((file) => {
        try {
          this.vault.assertPathPolicy(file.path, file.folder ? "directory" : "file");
        } catch {
          return false;
        }
        return inFolder(file.path, folder);
      })
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  private ambiguous(folder: string) {
    return this.vault.ambiguous().filter((entry) => {
      try {
        this.vault.assertPathPolicy(entry.path);
      } catch {
        return false;
      }
      return inFolder(entry.path, folder);
    });
  }
  read(input: ReadNoteInput, signal?: AbortSignal) {
    return this.run(async () => {
      noteFormat(input.path);
      const snapshot = await this.vault.readSnapshot(input.path, NOTE_BYTES);
      aborted(signal);
      return pageNote(snapshot.bytes, snapshot.path, input);
    }, signal);
  }
  list(input: ListNotesInput, signal?: AbortSignal) {
    return this.run(async () => {
      const limit = bound(input.limit, 100, 500);
      if (input.nameContains !== undefined) inputText(input.nameContains, 1024);
      const folder = await this.folder(input.folder);
      const query = {
        folder,
        nameContains: input.nameContains ?? "",
        includeBackups: input.includeBackups ?? false,
      };
      const after = position(input.after, query);
      const files = await this.inventory(folder);
      const entries: {
        path: string;
        kind: "note" | "attachment" | "folder" | "backup";
        size: number;
        mtime: number;
        backupOf?: string;
      }[] = [];
      let omittedBackups = 0;
      let used = 0;
      let more = false;
      for (const file of files) {
        aborted(signal);
        if (query.nameContains && !file.path.split("/").pop()!.includes(query.nameContains))
          continue;
        const backup = file.folder ? undefined : backupOf(file.path);
        if (!query.includeBackups && backup !== undefined) {
          omittedBackups++;
          continue;
        }
        if (after && file.path <= after.path) continue;
        const entry = {
          path: file.path,
          kind: file.folder
            ? ("folder" as const)
            : backup !== undefined
              ? ("backup" as const)
              : supported(file.path)
                ? ("note" as const)
                : ("attachment" as const),
          size: file.size,
          mtime: file.mtime,
          ...(backup !== undefined ? { backupOf: backup } : {}),
        };
        const size = byteSize(entry);
        if (more || entries.length >= limit || used + size > PAGE_ROWS_BYTES) {
          more = true;
          continue;
        }
        entries.push(entry);
        used += size;
      }
      const ambiguous = this.ambiguous(folder);
      const last = entries.at(-1);
      return {
        entries,
        nextAfter: more && last ? token(query, { path: last.path, line: 0, column: 0 }) : null,
        ambiguous: ambiguous.slice(0, 20).map((entry) => ({
          path: clip(entry.path, 512),
          spellings: entry.spellings.slice(0, 4).map((name) => clip(name, 128)),
        })),
        ambiguousCount: ambiguous.length,
        ambiguousTruncated:
          ambiguous.length > 20 ||
          ambiguous.some(
            (entry) =>
              entry.spellings.length > 4 ||
              entry.path.length > 512 ||
              entry.spellings.some((name) => name.length > 128),
          ),
        omitted: { backups: omittedBackups, unsupported: 0 },
        observedAt: Date.now(),
      };
    }, signal);
  }
  search(input: SearchNotesInput, signal?: AbortSignal) {
    return this.run(async () => {
      inputText(input.query, 1024);
      if (!input.query.length)
        throw new NoteError("invalid_query", "the search literal cannot be empty");
      const limit = bound(input.limit, 50, 200);
      const context = bound(input.contextLines, 0, 3, 0);
      const folder = await this.folder(input.folder);
      const query = {
        query: input.query,
        mode: input.mode ?? "content",
        includeChildren: input.includeChildren ?? true,
        folder,
        caseSensitive: input.caseSensitive ?? false,
        includeBackups: input.includeBackups ?? false,
        contextLines: context,
      };
      if (!["content", "filename", "both", "tag"].includes(query.mode))
        throw new NoteError("invalid_query", "unknown search mode");
      if (query.mode === "tag") validateTag(input.query);
      const after = position(input.cursor, query);
      const pattern = new RegExp(
        input.query.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
        query.caseSensitive ? "gu" : "giu",
      );
      const files = await this.inventory(folder);
      const omitted = { backups: 0, unsupported: 0 };
      const candidates = files.filter((file) => {
        if (file.folder) return false;
        if (!query.includeBackups && backupOf(file.path) !== undefined) {
          omitted.backups++;
          return false;
        }
        if (!supported(file.path)) {
          omitted.unsupported++;
          return false;
        }
        return !after || file.path >= after.path;
      });
      const matches: {
        path: string;
        line: number;
        column: number;
        text: string;
        before: string[];
        after: string[];
        clipped: boolean;
        kind?: "filename" | "tag";
      }[] = [];
      const skipped: { count: number; items: { path: string; why: string }[]; truncated: boolean } =
        { count: 0, items: [], truncated: false };
      const skip = (path: string, why: string): void => {
        skipped.count++;
        if (skipped.items.length < 20) skipped.items.push({ path: clip(path), why });
        else skipped.truncated = true;
      };
      // The inventory omits ambiguous paths, including whole subtrees. A
      // suffix cannot prove they held only attachments or backups. Report
      // them on every page so the last page cannot silently claim coverage.
      for (const entry of this.ambiguous(folder)) skip(entry.path, "ambiguous_path");
      let scanned = 0;
      let scannedBytes = 0;
      let outputBytes = 0;
      let last: Position | undefined = after;
      let more = false;
      fileLoop: for (const file of candidates) {
        aborted(signal);
        if (after?.path === file.path && after.line === Number.MAX_SAFE_INTEGER) continue;
        if (scanned >= SEARCH_FILES || (scannedBytes >= SEARCH_BYTES && last)) {
          more = true;
          break;
        }
        scanned++;
        pattern.lastIndex = 0;
        if (
          (query.mode === "filename" || query.mode === "both") &&
          pattern.test(file.path.split("/").pop()!) &&
          !(after?.path === file.path)
        ) {
          const row = {
            path: file.path,
            line: 0,
            column: 1,
            text: file.path,
            before: [],
            after: [],
            clipped: false,
            kind: "filename" as const,
          };
          const size = byteSize(row);
          if (matches.length >= limit || outputBytes + size > PAGE_TEXT_BYTES) {
            more = true;
            break;
          }
          matches.push(row);
          outputBytes += size;
          last = { path: file.path, line: 0, column: 1 };
        }
        let source: string;
        let tags: ReturnType<typeof tagOccurrences> = [];
        try {
          if (query.mode === "filename") source = "";
          else {
            const snapshot = await this.vault.readSnapshot(file.path, NOTE_BYTES);
            source = noteText(snapshot.bytes);
            scannedBytes += snapshot.size;
            if (query.mode === "tag") tags = tagOccurrences(source);
          }
        } catch (error) {
          skip(file.path, noteFailure(error).code);
          last = { path: file.path, line: Number.MAX_SAFE_INTEGER, column: 0 };
          continue;
        }
        aborted(signal);
        const lines = source.split("\n");
        const offsets = [0];
        for (let i = 0; i < lines.length - 1; i++) offsets.push(offsets[i]! + lines[i]!.length + 1);
        pattern.lastIndex = 0;
        const hits: Iterable<{ index: number }> =
          query.mode === "tag"
            ? [
                ...new Set(
                  tags
                    .filter((tag) =>
                      matchesTag(tag.tag, validateTag(input.query), query.includeChildren),
                    )
                    .map((tag) => tag.start),
                ),
              ].map((index) => ({ index }))
            : query.mode === "filename"
              ? []
              : source.matchAll(pattern);
        let line = 0;
        for (const match of hits) {
          aborted(signal);
          while (line + 1 < offsets.length && offsets[line + 1]! <= match.index) line++;
          const column = match.index - offsets[line]! + 1;
          if (
            after?.path === file.path &&
            (line + 1 < after.line || (line + 1 === after.line && column <= after.column))
          )
            continue;
          const raw = lines[line]!;
          let start = Math.max(0, column - 1 - 256);
          if (raw.charCodeAt(start) >= 0xdc00 && raw.charCodeAt(start) <= 0xdfff) start++;
          // Escaped control characters cost six JSON bytes apiece. Seven
          // full context lines could otherwise fill a page before its first hit.
          const text = clip(raw.slice(start), 1024);
          const before = lines
            .slice(Math.max(0, line - context), line)
            .map((value) => clip(value, 256));
          const next = lines.slice(line + 1, line + 1 + context).map((value) => clip(value, 256));
          const row = {
            path: file.path,
            line: line + 1,
            column,
            text,
            before,
            after: next,
            clipped:
              start > 0 ||
              text.length < raw.length ||
              before.some(
                (value, i) => value.length < lines[Math.max(0, line - context) + i]!.length,
              ) ||
              next.some((value, i) => value.length < lines[line + 1 + i]!.length),
            ...(query.mode === "tag" ? { kind: "tag" as const } : {}),
          };
          const size = byteSize(row);
          if (matches.length >= limit || outputBytes + size > PAGE_TEXT_BYTES) {
            more = true;
            break fileLoop;
          }
          matches.push(row);
          outputBytes += size;
          last = { path: file.path, line: line + 1, column };
        }
        last = { path: file.path, line: Number.MAX_SAFE_INTEGER, column: 0 };
      }
      return {
        matches,
        nextCursor: more && last ? token(query, last) : null,
        scanned,
        scannedBytes,
        skipped,
        omitted,
        complete: !more && skipped.count === 0,
        observedAt: Date.now(),
      };
    }, signal);
  }
}
