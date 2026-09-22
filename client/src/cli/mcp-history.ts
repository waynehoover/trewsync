import type { Client, Version } from "../core/client.ts";
import { previewCounts } from "../core/preview.ts";
import { NOTE_BYTES, NoteError, noteFormat, noteText } from "./mcp-notes.ts";
import { McpReader, pageNote, type ReadNoteInput } from "./mcp-read.ts";

const PAGE_BYTES = 128 * 1024;
export const HISTORY_LOOKUP_VERSIONS = 5000;
export interface HistoryInput {
  path: string;
  before?: number | undefined;
  limit?: number | undefined;
}
export interface DeletedInput {
  before?: number | undefined;
  limit?: number | undefined;
}
export interface PreviewInput {
  preview?: boolean | undefined;
  after?: string | undefined;
  limit?: number | undefined;
}
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new NoteError("cancelled", "the history request was cancelled");
}
function budget(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}
function metadata(version: Version) {
  const { uid, size, mtime, ctime, device, deleted, folder, previousPath } = version;
  return {
    uid,
    size,
    mtime,
    ctime,
    device,
    deleted,
    folder,
    ...(previousPath ? { previousPath } : {}),
  };
}

export class McpHistory {
  constructor(
    private readonly reader: McpReader,
    private readonly live: () => Client | undefined,
  ) {}
  connection(): Client {
    const client = this.live();
    if (!client || client.transport.isClosed)
      throw new NoteError(
        "history_unavailable",
        "history requires a settled connection to the server",
      );
    return client;
  }
  async path(path: string, signal?: AbortSignal): Promise<string> {
    noteFormat(path);
    return this.reader.run(
      async () => (await this.reader.vault.checkPath(path, { allowMissing: true })).path,
      signal,
    );
  }
  async history(input: HistoryInput, signal?: AbortSignal) {
    const path = await this.path(input.path, signal);
    const client = this.connection();
    const limit = input.limit ?? 20;
    // One extra entry distinguishes a full final page from a continuation.
    const versions = await client.history(path, {
      limit: limit + 1,
      ...(input.before !== undefined ? { before: input.before } : {}),
    });
    cancelled(signal);
    const rows: ReturnType<typeof metadata>[] = [];
    let bytes = 0;
    for (const version of versions) {
      const row = metadata(version);
      if (rows.length >= limit) break;
      if (bytes + budget(row) > PAGE_BYTES) {
        if (!rows.length)
          throw new NoteError(
            "entry_too_large",
            "this history entry exceeds the reply page budget",
          );
        break;
      }
      rows.push(row);
      bytes += budget(row);
    }
    return {
      path,
      versions: rows,
      nextBefore: rows.length < versions.length ? (rows.at(-1)?.uid ?? null) : null,
      observedAt: Date.now(),
    };
  }
  async content(path: string, uid: number, signal?: AbortSignal, captured?: Client) {
    const checked = await this.path(path, signal);
    const client = captured ?? this.connection();
    let examined = 0;
    const version = await client.findVersion(checked, (version) => {
      cancelled(signal);
      if (++examined > HISTORY_LOOKUP_VERSIONS)
        throw new NoteError(
          "lookup_incomplete",
          "the version lookup reached its work limit; its absence has not been established",
        );
      return version.uid === uid;
    });
    cancelled(signal);
    if (!version)
      throw new NoteError("version_not_found", "this path has no available version with that UID");
    if (version.deleted || version.folder)
      throw new NoteError(
        "not_note_content",
        "this version records a folder or deletion, not note content",
      );
    if (version.size > NOTE_BYTES)
      throw new NoteError("note_too_large", "this historical note exceeds 1 MiB");
    const bytes = await client.contentAt(version);
    cancelled(signal);
    // A signed size is a preflight bound, not a substitute for checking the body.
    noteText(bytes);
    return { client, version, bytes, path: checked };
  }
  async read(input: ReadNoteInput & { uid: number }, signal?: AbortSignal) {
    const content = await this.content(input.path, input.uid, signal);
    return {
      ...pageNote(content.bytes, content.path, input),
      source: "history" as const,
      uid: content.version.uid,
    };
  }
  async deleted(input: DeletedInput, signal?: AbortSignal) {
    const client = this.connection();
    const page = await client.deleted(input.limit ?? 50, input.before);
    cancelled(signal);
    const notes: { path: string; uid: number; mtime: number; restorable: number }[] = [];
    let omitted = 0,
      bytes = 0;
    let before = input.before ?? null;
    let remaining = false;
    await this.reader.run(async () => {
      for (const version of page.notes) {
        cancelled(signal);
        const row = {
          path: version.path,
          uid: version.uid,
          mtime: version.mtime,
          restorable: version.restorable,
        };
        try {
          noteFormat(row.path);
          await this.reader.vault.checkPath(row.path, { allowMissing: true });
        } catch {
          omitted++;
          before = version.uid;
          continue;
        }
        if (bytes + budget(row) > PAGE_BYTES) {
          if (!notes.length)
            throw new NoteError(
              "entry_too_large",
              "this deletion entry exceeds the reply page budget",
            );
          remaining = true;
          break;
        }
        before = version.uid;
        notes.push(row);
        bytes += budget(row);
      }
    }, signal);
    const more = remaining || page.more;
    return { notes, omitted, more, nextBefore: more ? before : null, observedAt: Date.now() };
  }
  async preview(input: PreviewInput, signal?: AbortSignal) {
    const client = this.connection();
    let after = "";
    if (input.after !== undefined) {
      const encoded = input.after.slice(3);
      if (!input.after.startsWith("p1:") || !/^[a-zA-Z0-9_-]+$/u.test(encoded))
        throw new NoteError("invalid_cursor", "invalid preview continuation");
      const bytes = Buffer.from(encoded, "base64url");
      if (bytes.toString("base64url") !== encoded || bytes.length > 4096)
        throw new NoteError("invalid_cursor", "invalid preview continuation");
      after = noteText(bytes);
      this.reader.vault.assertPathPolicy(after);
    }
    const stats = await this.reader.run(
      () => this.reader.vault.list({ forceFull: true, checked: true }),
      signal,
    );
    cancelled(signal);
    const preview = await client.preview(stats);
    cancelled(signal);
    const observed = new Set(stats.map((stat) => stat.path));
    const visible = await this.reader.run(async () => {
      const rows = [];
      for (const file of preview.files) {
        cancelled(signal);
        try {
          // The checked scan already admitted these paths. Re-enumerating
          // their ancestors per row makes a flat inventory quadratic.
          // Remote-only paths still need the same fresh policy check.
          if (!observed.has(file.path))
            await this.reader.vault.checkPath(file.path, { allowMissing: true });
          rows.push(file);
        } catch {
          /* Excluded or inaccessible paths are counted below. */
        }
      }
      return rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    }, signal);
    const files: typeof preview.files = [];
    let used = 0,
      more = false;
    for (const file of visible) {
      if (file.path <= after) continue;
      if (files.length >= (input.limit ?? 100) || used + budget(file) > PAGE_BYTES) {
        more = true;
        break;
      }
      files.push(file);
      used += budget(file);
    }
    return {
      cursor: preview.cursor,
      files,
      counts: previewCounts({ ...preview, files: visible }),
      omitted: preview.files.length - visible.length,
      nextAfter: more ? "p1:" + Buffer.from(files.at(-1)!.path).toString("base64url") : null,
      estimated: true as const,
    };
  }
}
