import {
  NoteError,
  applyNote,
  checkPrepared,
  noteFailure,
  prepareNote,
  preserveNote,
  type MutationResult,
  type NoteMutation,
  type PreparedNote,
} from "./mcp-notes.ts";
import type { NodeVault } from "./vault.ts";

export const BATCH_FILES = 32;
export const BATCH_PATH_BYTES = 16 * 1024;
export function batchBounds(paths: readonly string[]): void {
  if (paths.length > BATCH_FILES || Buffer.byteLength(JSON.stringify(paths)) > BATCH_PATH_BYTES)
    throw new NoteError(
      "batch_too_large",
      "use at most 32 notes and 16 KiB of encoded paths per batch",
    );
}

/** The write slot stays held through preparation, preservation and publication. */
export async function applyBatch(
  vault: NodeVault,
  requests: readonly NoteMutation[],
  changed: (path: string) => void,
) {
  const plans: PreparedNote[] = [];
  const results: (MutationResult & { attempted?: boolean })[] = requests.map((request) => ({
    applied: false,
    path: request.path,
    preserved: [],
    attempted: false,
  }));
  let at = 0;
  let failure: ReturnType<typeof noteFailure> | undefined;
  try {
    batchBounds(requests.map((request) => request.path));
    const paths = new Set<string>();
    for (at = 0; at < requests.length; at++) {
      const plan = await prepareNote(vault, requests[at]!);
      const canonical = vault.canonical(plan.result.path);
      if (paths.has(canonical))
        throw new NoteError("duplicate_path", "a batch cannot mutate the same note twice");
      paths.add(canonical);
      plans.push(plan);
      results[at] = plan.result;
    }
    for (at = 0; at < plans.length; at++) await preserveNote(vault, plans[at]!, changed);
    // Preparing backups one file at a time used to allow the first original
    // to change before a later backup failed. This is the publication barrier.
    for (at = 0; at < plans.length; at++) await checkPrepared(vault, plans[at]!);
    for (at = 0; at < plans.length; at++) {
      const result = await applyNote(vault, plans[at]!, changed);
      results[at] = { ...result, attempted: true };
      if (result.error) {
        failure = result.error;
        break;
      }
    }
  } catch (error) {
    failure = noteFailure(error);
    if (results[at]) results[at] = { ...results[at]!, error: failure };
  }
  for (let i = 0; i < results.length; i++)
    results[i] = { ...results[i]!, attempted: results[i]!.attempted ?? false };
  return {
    complete: failure === undefined,
    results,
    ...(failure ? { error: failure } : {}),
    sync: {
      state: "pending" as const,
      reason: "completed local changes use ordinary sync; batches are not atomic across devices",
    },
  };
}
