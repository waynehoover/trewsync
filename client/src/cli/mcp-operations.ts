import type { NodeVault } from "./vault.ts";
import {
  NoteError,
  NOTE_BYTES,
  noteFormat,
  noteText,
  noteFailure,
  backupOf,
  applySourceEdits,
  type SourceEdit,
  type NoteMutation,
  type MutationResult,
} from "./mcp-notes.ts";
import { applyBatch, batchBounds } from "./mcp-batch.ts";
import { changeLinks } from "./mcp-links.ts";
import { changeTags, type TagChange } from "./mcp-markdown.ts";
export type VaultOperation =
  | {
      kind: "tags";
      change: TagChange;
      paths?: readonly string[] | undefined;
      folder?: string | undefined;
    }
  | { kind: "move"; path: string; to: string; updateLinks?: boolean | undefined }
  | { kind: "delete"; path: string; markBroken?: boolean | undefined };
export interface PlannedChange {
  path: string;
  base: string;
  action: "edit" | "move" | "delete";
  to?: string | undefined;
  edits: SourceEdit[];
}

const SCAN_FILES = 512;
const SCAN_BYTES = 8 * NOTE_BYTES;
const PLAN_BYTES = 64 * 1024;
function supported(path: string): boolean {
  try {
    noteFormat(path, true);
    return true;
  } catch {
    return false;
  }
}
async function planOperation(vault: NodeVault, operation: VaultOperation) {
  const changes: PlannedChange[] = [];
  let ambiguousLinks = 0;
  const snapshots = new Map<string, Awaited<ReturnType<NodeVault["readSnapshot"]>>>();
  let readBytes = 0;
  const read = async (path: string) => {
    noteFormat(path, true);
    const found = await vault.readSnapshot(path, NOTE_BYTES);
    noteFormat(found.path, true);
    if (snapshots.has(found.path)) return snapshots.get(found.path)!;
    readBytes += found.size;
    if (snapshots.size >= SCAN_FILES || readBytes > SCAN_BYTES)
      throw new NoteError(
        "scan_incomplete",
        "the operation exceeds 512 notes or 8 MiB; narrow its scope",
      );
    noteText(found.bytes);
    snapshots.set(found.path, found);
    return found;
  };
  let inventory: string[] = [];
  const scan = async (folder = "") => {
    const checked = (await vault.checkPath(folder, { kind: "directory" })).path;
    const files = await vault.list({ forceFull: true, checked: true });
    if (vault.ambiguous().some((entry) => !checked || entry.path.startsWith(checked + "/")))
      throw new NoteError(
        "scan_incomplete",
        "ambiguous paths prevent a complete operation preview",
      );
    inventory = files
      .filter((file) => {
        if (file.folder) return false;
        try {
          vault.assertPathPolicy(file.path);
          return true;
        } catch {
          return false;
        }
      })
      .map((file) => file.path);
    return inventory
      .filter((path) => (!checked || path.startsWith(checked + "/")) && supported(path))
      .sort();
  };
  if (operation.kind === "tags") {
    if (operation.paths && operation.folder !== undefined)
      throw new NoteError("invalid_scope", "supply paths or a folder, not both");
    if (operation.paths) batchBounds(operation.paths);
    const paths = operation.paths ?? (await scan(operation.folder));
    const seen = new Set<string>();
    for (const path of paths) {
      const snapshot = await read(path);
      const key = vault.canonical(snapshot.path);
      if (seen.has(key))
        throw new NoteError("duplicate_path", "each selected note must be distinct");
      seen.add(key);
      const edits = changeTags(noteText(snapshot.bytes), operation.change).edits;
      if (edits.length || operation.paths)
        changes.push({ path: snapshot.path, base: snapshot.base, action: "edit", edits });
    }
  } else {
    const source = await read(operation.path);
    let to: string | undefined;
    if (operation.kind === "move") {
      noteFormat(operation.to, true);
      const destination = await vault.checkPath(operation.to, { allowMissing: true });
      if (vault.canonical(source.path) === vault.canonical(destination.path))
        throw new NoteError("same_destination", "move to a distinct unoccupied path");
      if (destination.exists) throw new NoteError("exists", "the destination is already occupied");
      to = destination.path;
    }
    const paths = operation.kind === "move" || operation.markBroken ? await scan() : [];
    let sourceEdits: SourceEdit[] = [];
    for (const path of paths) {
      if (operation.kind === "delete" && vault.canonical(path) === vault.canonical(source.path))
        continue;
      if (
        operation.kind === "move" &&
        operation.updateLinks === false &&
        vault.canonical(path) !== vault.canonical(source.path)
      )
        continue;
      const snapshot = await read(path);
      const links = changeLinks(noteText(snapshot.bytes), {
        path: snapshot.path,
        from: source.path,
        to,
        inventory,
        canonical: (path) => vault.canonical(path),
      });
      ambiguousLinks += links.ambiguous;
      if (snapshot.path === source.path) sourceEdits = links.edits;
      else if (links.edits.length)
        changes.push({
          path: snapshot.path,
          base: snapshot.base,
          action: "edit",
          edits: links.edits,
        });
    }
    changes.push({
      path: source.path,
      base: source.base,
      action: operation.kind,
      ...(to === undefined ? {} : { to }),
      edits: sourceEdits,
    });
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  batchBounds(changes.flatMap((change) => (change.to ? [change.path, change.to] : [change.path])));
  if (Buffer.byteLength(JSON.stringify(changes)) > PLAN_BYTES)
    throw new NoteError("plan_too_large", "the exact changes exceed 64 KiB; narrow the operation");
  return { changes, ambiguousLinks, snapshots };
}
export async function previewOperation(vault: NodeVault, operation: VaultOperation) {
  const { changes, ambiguousLinks } = await planOperation(vault, operation);
  return {
    changes,
    ambiguousLinks,
    complete: true,
    phase: "preview",
    applied: false,
    instructions:
      "Inspect every exact old-to-new span. To apply, resubmit the same operation with these changes, including every base. New or changed affected notes invalidate the plan.",
  };
}
function samePlan(expected: readonly PlannedChange[], actual: readonly PlannedChange[]): boolean {
  const normalized = (changes: readonly PlannedChange[]) =>
    changes
      .map((change) => ({
        path: change.path,
        base: change.base,
        action: change.action,
        to: change.to ?? null,
        edits: change.edits.map((edit) => ({
          start: edit.start,
          end: edit.end,
          old: edit.old,
          text: edit.text,
        })),
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return JSON.stringify(normalized(expected)) === JSON.stringify(normalized(actual));
}
export async function applyOperation(
  vault: NodeVault,
  observer: NodeVault,
  operation: VaultOperation,
  changes: readonly PlannedChange[],
  changed: (path: string) => void,
) {
  try {
    batchBounds(
      changes.flatMap((change) => (change.to ? [change.path, change.to] : [change.path])),
    );
    if (Buffer.byteLength(JSON.stringify(changes)) > PLAN_BYTES)
      throw new NoteError("plan_too_large", "the exact changes exceed 64 KiB");
    const current = await planOperation(observer, operation);
    if (!samePlan(changes, current.changes))
      throw new NoteError(
        "plan_changed",
        "the affected notes, bases or exact edits changed; preview and reconsider",
      );
    const requests: NoteMutation[] = [];
    const source = current.changes.find((change) => change.action !== "edit");
    if (source?.action === "move") {
      const snapshot = current.snapshots.get(source.path)!;
      requests.push({
        kind: "create",
        path: source.to!,
        content: applySourceEdits(noteText(snapshot.bytes), source.edits),
      });
    }
    for (const change of current.changes)
      if (change.action === "edit")
        requests.push({ kind: "spans", path: change.path, base: change.base, edits: change.edits });
    if (source) requests.push({ kind: "delete", path: source.path, base: source.base });
    const result = await applyBatch(vault, requests, changed);
    return { ...result, ambiguousLinks: current.ambiguousLinks, phase: "apply" };
  } catch (error) {
    return {
      complete: false,
      results: [] as MutationResult[],
      error: noteFailure(error),
      phase: "apply",
    };
  }
}

export async function createDirectory(
  vault: NodeVault,
  path: string,
  changed: (path: string) => void,
): Promise<MutationResult> {
  const result: MutationResult = { path, applied: false, preserved: [] };
  try {
    if (backupOf(path))
      throw new NoteError(
        "reserved_backup",
        "MCP recovery names cannot be used for new directories",
      );
    const destination = await vault.checkPath(path, { kind: "directory", allowMissing: true });
    result.path = destination.path;
    if (destination.exists) return { ...result, noop: true };
    result.applied = "unknown";
    changed(result.path);
    await vault.mkdir(result.path);
    if (!(await vault.checkPath(result.path, { kind: "directory" })).exists)
      throw new NoteError("verification_failed", "the directory could not be verified");
    result.applied = true;
    result.durable = false;
    await vault.flush();
    result.durable = true;
    result.sync = { state: "pending", reason: "ordinary sync scheduled" };
    return result;
  } catch (error) {
    return { ...result, error: noteFailure(error) };
  }
}
