/** Structured diagnostics: never include note contents, credentials or raw frames. */
export type ActivityAction =
  | "uploaded"
  | "downloaded"
  | "merged"
  | "deleted-local"
  | "deleted-server"
  | "conflict"
  | "error"
  | "resolved";
export interface Activity {
  at: number;
  action: ActivityAction;
  path?: string;
  copy?: string;
}
