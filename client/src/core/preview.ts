export type PreviewAction =
  | "upload"
  | "download"
  | "merge"
  | "copy"
  | "delete-local"
  | "delete-server"
  | "unchanged"
  | "blocked"
  | "held-back";
export interface SyncPreview {
  cursor: number;
  files: { path: string; action: PreviewAction }[];
}
export function previewCounts(preview: SyncPreview): Record<PreviewAction, number> {
  const counts: Record<PreviewAction, number> = {
    upload: 0,
    download: 0,
    merge: 0,
    copy: 0,
    "delete-local": 0,
    "delete-server": 0,
    unchanged: 0,
    blocked: 0,
    "held-back": 0,
  };
  for (const file of preview.files) counts[file.action]++;
  return counts;
}
