import { createHash, randomBytes } from "node:crypto";
import { conflictCopyPath } from "../core/merge.ts";
import { firstFreeName, splitName } from "../core/paths.ts";
import { composite, seam } from "../core/seam.ts";
import { CheckedPathError, PreservationError, type NodeVault } from "./vault.ts";

export const NOTE_BYTES = 1024 * 1024;
export const EDIT_BYTES = 8 * 1024;
export const INPUT_BYTES = 64 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export const midNoteMutation = composite({
  backupVerified: seam("cli/mcp:backupVerified"),
  backupDurable: seam("cli/mcp:backupDurable"),
  published: seam("cli/mcp:published"),
  durable: seam("cli/mcp:durable"),
});

export type NoteMutation =
  | { kind: "edit"; path: string; base: string; edits: readonly { old: string; new: string }[] }
  | { kind: "append"; path: string; base: string; text: string }
  | { kind: "prepend"; path: string; base: string; text: string }
  | { kind: "create"; path: string; content: string }
  | { kind: "delete"; path: string; base: string }
  | { kind: "spans"; path: string; base: string; edits: readonly SourceEdit[] };
export type Certainty = boolean | "unknown";
export interface MutationResult {
  applied: Certainty;
  durable?: Certainty;
  path: string;
  base?: string;
  bytesBefore?: number;
  bytesAfter?: number;
  beforeImage?: string;
  preserved: string[];
  noop?: boolean;
  error?: { code: string; message: string };
  sync?: { state: "pending"; reason: string };
}

export class NoteError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function noteDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function noteText(bytes: Uint8Array): string {
  if (bytes.length > NOTE_BYTES)
    throw new NoteError("note_too_large", "notes must be at most 1 MiB");
  try {
    return decoder.decode(bytes);
  } catch {
    throw new NoteError("invalid_utf8", "the note is not valid UTF-8");
  }
}

export function inputText(value: string, cap: number): Uint8Array {
  if (typeof value !== "string" || /\p{Surrogate}/u.test(value)) {
    throw new NoteError(
      "invalid_text",
      "text must contain valid Unicode without unpaired surrogates",
    );
  }
  if (Buffer.byteLength(value) > cap)
    throw new NoteError("input_too_large", "the supplied text exceeds its byte limit");
  return encoder.encode(value);
}

export function backupOf(path: string): string | undefined {
  const match = /^(.*) \(MCP (?:backup|recovery) \d{8}T\d{6}Z [a-f0-9]{8,32}\)(\.[^/]*)?$/isu.exec(
    path,
  );
  return match ? `${match[1]}${match[2] ?? ""}` : undefined;
}

export function noteFormat(path: string, mutable = false): void {
  if (
    typeof path !== "string" ||
    !/\.(md|txt)$/iu.test(path) ||
    (mutable && /\.excalidraw\.md$/iu.test(path))
  ) {
    throw new NoteError(
      "unsupported_format",
      "agent notes must be Markdown or plain text, excluding drawings",
    );
  }
  if (mutable && backupOf(path) !== undefined) {
    throw new NoteError(
      "reserved_backup",
      "MCP recovery copies can be read but cannot be changed by an agent",
    );
  }
}

export function noteFailure(error: unknown): { code: string; message: string } {
  if (error instanceof NoteError || error instanceof CheckedPathError)
    return { code: error.code, message: error.message };
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT")
    return {
      code: "not_found_local",
      message: "the path is not present locally; it may still be catching up",
    };
  if (code === "EACCES" || code === "EPERM")
    return { code: "unreadable", message: "the filesystem refused access to this path" };
  return {
    code: "io_error",
    message:
      "the local operation could not be verified; inspect the reported recovery paths before retrying",
  };
}

export interface SourceEdit {
  start: number;
  end: number;
  old: string;
  text: string;
}
export function sourceEdit(source: string, start: number, end: number, text: string): SourceEdit {
  return { start, end, old: source.slice(start, end), text };
}

export function applySourceEdits(source: string, edits: readonly SourceEdit[]): string {
  let at = 0;
  const out: string[] = [];
  for (const edit of [...edits].sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (
      !Number.isSafeInteger(edit.start) ||
      !Number.isSafeInteger(edit.end) ||
      edit.start < at ||
      edit.end < edit.start ||
      edit.end > source.length ||
      source.slice(edit.start, edit.end) !== edit.old
    ) {
      throw new NoteError(
        "invalid_edits",
        "source edits overlap or differ from the inspected bytes",
      );
    }
    out.push(source.slice(at, edit.start), edit.text);
    at = edit.end;
  }
  out.push(source.slice(at));
  const result = out.join("");
  inputText(result, NOTE_BYTES);
  return result;
}

function replacement(
  source: string,
  edits: Extract<NoteMutation, { kind: "edit" }>["edits"],
): Uint8Array {
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > 32)
    throw new NoteError("invalid_edits", "supply between 1 and 32 exact edits");
  let input = 0;
  const spans = edits.map((edit) => {
    input += inputText(edit.old, EDIT_BYTES).length + inputText(edit.new, EDIT_BYTES).length;
    if (!edit.old.length) throw new NoteError("invalid_edits", "an old span cannot be empty");
    const start = source.indexOf(edit.old);
    if (start < 0)
      throw new NoteError(
        "no_match",
        "an old span does not occur in the source; read and reconsider",
      );
    if (source.indexOf(edit.old, start + 1) >= 0)
      throw new NoteError(
        "ambiguous_edit",
        "an old span occurs more than once; include unique surrounding text",
      );
    return { start, end: start + edit.old.length, text: edit.new };
  });
  if (input > INPUT_BYTES)
    throw new NoteError("input_too_large", "the combined edit input exceeds 64 KiB");
  spans.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i]!.start < spans[i - 1]!.end)
      throw new NoteError("overlapping_edits", "the edits overlap in the original source");
  }
  let at = 0;
  const pieces: string[] = [];
  for (const span of spans) {
    pieces.push(source.slice(at, span.start), span.text);
    at = span.end;
  }
  pieces.push(source.slice(at));
  return inputText(pieces.join(""), NOTE_BYTES);
}

function sibling(path: string, kind: "backup" | "recovery"): string {
  const { stem, ext } = splitName(path);
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "Z");
  return `${stem} (MCP ${kind} ${stamp} ${randomBytes(8).toString("hex")})${ext}`;
}

export interface PreparedNote {
  readonly request: NoteMutation;
  readonly before: Awaited<ReturnType<NodeVault["readSnapshot"]>> | undefined;
  readonly proposed: Uint8Array | undefined;
  readonly times: { mtime: number; ctime: number };
  readonly result: MutationResult;
  consumed: boolean;
}

export async function verifyNote(
  vault: NodeVault,
  path: string,
  expected: Uint8Array,
): Promise<void> {
  const found = await vault.readSnapshot(path, NOTE_BYTES, { flush: true });
  if (
    found.size !== expected.length ||
    found.base !== noteDigest(expected) ||
    !Buffer.from(found.bytes).equals(expected)
  )
    throw new NoteError("verification_failed", "the written bytes differ from the intended bytes");
}

/** No client or wire calls belong here. The caller owns the serial write slot. */
export async function prepareNote(vault: NodeVault, request: NoteMutation): Promise<PreparedNote> {
  noteFormat(request.path, true);
  const result: MutationResult = { applied: false, path: request.path, preserved: [] };
  let before: PreparedNote["before"];
  let proposed: Uint8Array | undefined;
  let times = { mtime: Date.now(), ctime: Date.now() };
  if (request.kind === "create") {
    proposed = inputText(request.content, NOTE_BYTES);
    const destination = await vault.checkPath(request.path, { allowMissing: true });
    result.path = destination.path;
    if (destination.exists) throw new NoteError("exists", "the destination is already occupied");
    result.bytesBefore = 0;
  } else {
    if (typeof request.base !== "string" || !/^[a-f0-9]{64}$/u.test(request.base))
      throw new NoteError("invalid_base", "supply the complete SHA-256 base from read_note");
    before = await vault.readSnapshot(request.path, NOTE_BYTES);
    result.path = before.path;
    noteFormat(result.path, true);
    if (before.base !== request.base)
      throw new NoteError("stale", "the note changed; read it and reconsider the edit");
    const source = noteText(before.bytes);
    if (request.kind === "append" || request.kind === "prepend") {
      const inserted = inputText(request.text, INPUT_BYTES);
      if (!inserted.length) throw new NoteError("invalid_text", "inserted text cannot be empty");
      if (request.kind === "append") proposed = Buffer.concat([before.bytes, inserted]);
      else {
        const bom = source.startsWith("\ufeff") ? 3 : 0;
        proposed = Buffer.concat([
          before.bytes.subarray(0, bom),
          inserted,
          before.bytes.subarray(bom),
        ]);
      }
    } else if (request.kind === "spans") {
      proposed = inputText(applySourceEdits(source, request.edits), NOTE_BYTES);
    } else if (request.kind === "edit") proposed = replacement(source, request.edits);
    else if (request.kind !== "delete")
      throw new NoteError("invalid_operation", "unknown note operation");
    if (proposed && proposed.length > NOTE_BYTES)
      throw new NoteError("note_too_large", "the resulting note exceeds 1 MiB");
    result.bytesBefore = before.size;
    result.bytesAfter = proposed?.length ?? 0;
    if (proposed && Buffer.from(before.bytes).equals(proposed)) {
      result.base = before.base;
      result.noop = true;
    }
    times = { mtime: Date.now(), ctime: before.ctime };
  }
  return { request, before, proposed, times, result, consumed: false };
}

async function saveSibling(
  vault: NodeVault,
  plan: PreparedNote,
  bytes: Uint8Array,
  kind: "backup" | "recovery",
  changed: (path: string) => void,
): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const path = sibling(plan.result.path, kind);
    await vault.checkPath(path, { allowMissing: true });
    // A failed exclusive-open fallback can leave partial bytes. Report its
    // attempted name and never delete it merely because verification failed.
    plan.result.preserved.push(path);
    changed(path);
    if (!(await vault.create(path, bytes, plan.times))) {
      plan.result.preserved.pop();
      continue;
    }
    await verifyNote(vault, path, bytes);
    if (kind === "backup") await midNoteMutation.backupVerified(plan.result.path);
    await vault.flush();
    return path;
  }
  throw new NoteError("backup_collision", "could not claim a free recovery name");
}

export async function preserveNote(
  vault: NodeVault,
  plan: PreparedNote,
  changed: (path: string) => void,
): Promise<void> {
  if (!plan.before || plan.result.noop) return;
  if (plan.result.beforeImage)
    throw new NoteError("invalid_operation", "this before-image was already prepared");
  plan.result.durable = false;
  // Rules 3 and 5: a matching base says nothing about unsent prose the
  // requested edit removes. Preserve an independent, verified copy first.
  const backup = await saveSibling(vault, plan, plan.before.bytes, "backup", changed);
  plan.result.beforeImage = backup;
  plan.result.preserved = plan.result.preserved.filter((path) => path !== backup);
  await midNoteMutation.backupDurable(plan.result.path);
}

export async function checkPrepared(vault: NodeVault, plan: PreparedNote): Promise<void> {
  if (!plan.before) return;
  if (!plan.result.noop) {
    if (!plan.result.beforeImage)
      throw new NoteError("missing_backup", "the verified before-image is required");
    await verifyNote(vault, plan.result.beforeImage, plan.before.bytes);
  }
  const again = await vault.readSnapshot(plan.result.path, NOTE_BYTES);
  if (again.base !== plan.before.base)
    throw new NoteError(
      "stale",
      "the note changed while its before-image was saved; read and reconsider",
    );
}

export async function applyNote(
  vault: NodeVault,
  plan: PreparedNote,
  changed: (path: string) => void,
): Promise<MutationResult> {
  const { result, before, proposed, times } = plan;
  let publishing = false;
  let raced = false;
  try {
    if (plan.consumed)
      throw new NoteError("invalid_operation", "a prepared operation cannot be repeated");
    plan.consumed = true;
    if (result.noop) {
      await checkPrepared(vault, plan);
      return result;
    }
    if (!before) {
      const destination = await vault.checkPath(result.path, { allowMissing: true });
      if (destination.exists) throw new NoteError("exists", "the destination is already occupied");
      publishing = true;
      result.applied = "unknown";
      changed(result.path);
      if (!(await vault.create(result.path, proposed!, times))) {
        publishing = false;
        result.applied = false;
        throw new NoteError("exists", "another writer occupied the destination");
      }
    } else {
      await checkPrepared(vault, plan);
      const keepAt = await firstFreeName(
        conflictCopyPath(result.path, "MCP", new Date()),
        async (path) => (await vault.checkPath(path, { allowMissing: true })).exists,
      );
      await vault.checkPath(result.path);
      publishing = true;
      result.applied = "unknown";
      changed(result.path);
      changed(keepAt);
      const expectation = {
        contentId: before.base,
        idOf: async (bytes: Uint8Array) => noteDigest(bytes),
      };
      const replaced =
        proposed === undefined
          ? await vault.removeExpecting(result.path, expectation, keepAt)
          : await vault.replace(result.path, expectation, proposed, times, keepAt);
      if (replaced.keptAt) {
        result.preserved.push(replaced.keptAt);
        changed(replaced.keptAt);
        await vault.readSnapshot(replaced.keptAt, NOTE_BYTES, { flush: true });
        raced = true;
      }
      if (!replaced.landed) {
        result.applied = false;
        if (proposed) await saveSibling(vault, plan, proposed, "recovery", changed);
        await vault.flush();
        result.durable = true;
        return {
          ...result,
          error: {
            code: "race",
            message: "another writer took the destination; inspect the reported recovery paths",
          },
        };
      }
    }
    await midNoteMutation.published(result.path);
    if (proposed) {
      await verifyNote(vault, result.path, proposed);
      result.applied = true;
      result.bytesAfter = proposed.length;
      result.base = noteDigest(proposed);
    } else {
      result.applied = !(await vault.checkPath(result.path, { allowMissing: true })).exists;
      if (!result.applied) raced = true;
    }
    await vault.flush();
    result.durable = true;
    await midNoteMutation.durable(result.path);
    if (raced)
      return {
        ...result,
        error: {
          code: "race",
          message:
            "an independent local save raced with this operation; inspect the current note and recovery paths",
        },
      };
    result.sync = { state: "pending", reason: "ordinary sync scheduled" };
    return result;
  } catch (error) {
    if (error instanceof PreservationError) {
      for (const path of error.preserved) {
        if (!result.preserved.includes(path)) result.preserved.push(path);
        changed(path);
      }
    }
    if (publishing) {
      // Publication can have succeeded even when the adapter threw. Never
      // turn a lost acknowledgement into permission to repeat an append.
      if (proposed) {
        let matches = false;
        try {
          await verifyNote(vault, result.path, proposed);
          matches = true;
          result.applied = true;
        } catch {
          /* A later writer owns the target; never roll it back. */
        }
        if (!matches) {
          try {
            await saveSibling(vault, plan, proposed, "recovery", changed);
          } catch {
            /* Its attempted path is retained in preserved. */
          }
        }
      } else {
        try {
          result.applied = !(await vault.checkPath(result.path, { allowMissing: true })).exists;
        } catch {
          /* The removal remains unknown until the path can be inspected. */
        }
      }
      result.durable = false;
    }
    return { ...result, error: noteFailure(error) };
  }
}

export async function mutateNote(
  vault: NodeVault,
  request: NoteMutation,
  changed: (path: string) => void,
): Promise<MutationResult> {
  let plan: PreparedNote | undefined;
  try {
    plan = await prepareNote(vault, request);
    await preserveNote(vault, plan, changed);
    return await applyNote(vault, plan, changed);
  } catch (error) {
    return {
      ...(plan?.result ?? { applied: false, path: request.path, preserved: [] }),
      error: noteFailure(error),
    };
  }
}
