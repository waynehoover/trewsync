import { plainDigest } from "./digest.ts";
import { looksLikeText } from "./chunk.ts";
import { conflictCopyPath } from "./merge.ts";
import { firstFreeName } from "./paths.ts";
import type { FileStat, Vault } from "./vault.ts";

export interface ConflictPair {
  original: string;
  copy: string;
}
export interface ReviewedFile {
  path: string;
  digest: string;
  stat: FileStat;
  text?: string;
}
export interface ConflictReview extends ConflictPair {
  current?: ReviewedFile;
  preserved: ReviewedFile;
}
export type ConflictChoice = "original" | "copy" | "edited";
const TEXT_LIMIT = 128 * 1024;

/** Copies remain discoverable on other devices and after the local log rotates. */
export function conflictOriginal(copy: string): string | undefined {
  const match = /^(.*) \(Conflicted copy [^/]+ \d{12}\)(?: \d+)?(\.[^/]*)?$/.exec(copy);
  return match ? match[1] + (match[2] ?? "") : undefined;
}

async function digest(vault: Vault, path: string): Promise<string | undefined> {
  if (vault.contentDigest) {
    const id = await vault.contentDigest(path);
    if (id === undefined && (await vault.stat(path)))
      throw new Error("Cannot read a conflict file. Nothing was resolved.");
    return id;
  }
  if (!(await vault.stat(path))) return undefined;
  return plainDigest(await vault.read(path));
}

async function reviewFile(vault: Vault, path: string): Promise<ReviewedFile | undefined> {
  const stat = await vault.stat(path);
  if (!stat) return undefined;
  if (stat.folder)
    throw new Error("A conflict path is now a folder. Review it in the file explorer.");
  if (looksLikeText(path) && stat.size <= TEXT_LIMIT) {
    const bytes = await vault.read(path);
    const text =
      bytes.length <= TEXT_LIMIT
        ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
        : undefined;
    return {
      path,
      stat,
      digest: await plainDigest(bytes),
      ...(text !== undefined ? { text } : {}),
    };
  }
  const id = await digest(vault, path);
  if (id === undefined) return undefined;
  return { path, stat, digest: id };
}

export async function reviewConflict(vault: Vault, pair: ConflictPair): Promise<ConflictReview> {
  if (pair.original === pair.copy || conflictOriginal(pair.copy) !== pair.original)
    throw new Error("Choose a Trew conflict copy to review.");
  const current = await reviewFile(vault, pair.original);
  const preserved = await reviewFile(vault, pair.copy);
  if (!preserved)
    throw new Error("This conflict copy has moved or was already removed. Refresh the list.");
  return { ...pair, ...(current ? { current } : {}), preserved };
}

/** Run in Client.serial so sync cannot interleave; adapters guard editor races. */
export async function resolveConflict(
  vault: Vault,
  review: ConflictReview,
  choice: ConflictChoice,
  edited?: string,
): Promise<void> {
  if (!vault.replace || !vault.removeExpecting)
    throw new Error("This vault cannot safely resolve conflicts.");
  if (choice === "original" && !review.current)
    throw new Error("The original file no longer exists.");
  if (
    choice === "edited" &&
    (edited === undefined ||
      review.current?.text === undefined ||
      review.preserved.text === undefined)
  )
    throw new Error("Open these files to edit them; they cannot be merged in this preview.");
  if (
    (await digest(vault, review.original)) !== review.current?.digest ||
    (await digest(vault, review.copy)) !== review.preserved.digest
  )
    throw new Error(
      "One of these files changed. Refresh the comparison before choosing a version.",
    );
  const keepAt = (path: string) =>
    firstFreeName(conflictCopyPath(path, "review", new Date()), (p) => vault.exists(p));
  if (choice !== "original") {
    const bytes =
      // `edited` is defined whenever the choice is "edited": refused above otherwise.
      choice === "edited" ? new TextEncoder().encode(edited) : await vault.read(review.copy);
    // The read above may have raced an editor after the comparison.
    if (choice === "copy" && (await plainDigest(bytes)) !== review.preserved.digest)
      throw new Error("The conflict copy changed. Refresh the comparison.");
    const result = await vault.replace(
      review.original,
      review.current ? { contentId: review.current.digest, idOf: plainDigest } : undefined,
      bytes,
      { mtime: Date.now(), ctime: review.current?.stat.ctime ?? review.preserved.stat.ctime },
      await keepAt(review.original),
    );
    if (!result.landed || result.keptAt)
      throw new Error(
        "A file changed while applying your choice. Both versions were kept; refresh the list.",
      );
    await vault.flush?.(); // The selected version must survive before removing its copy.
  }
  const result = await vault.removeExpecting(
    review.copy,
    { contentId: review.preserved.digest, idOf: plainDigest },
    await keepAt(review.copy),
  );
  await vault.flush?.();
  if (result.keptAt || !result.landed)
    throw new Error(
      "The copy changed while resolving it. Its latest version was preserved; refresh the list.",
    );
}
