/** Resume signals shared by Obsidian desktop and mobile webviews. */
export function watchResume(resume: () => void): () => void {
  const doc = typeof document === "undefined" ? undefined : document;
  const win = typeof window === "undefined" ? undefined : window;
  const visible = () => {
    if (doc?.visibilityState === "visible") resume();
  };
  doc?.addEventListener("visibilitychange", visible);
  win?.addEventListener("focus", visible);
  win?.addEventListener("online", resume);
  return () => {
    doc?.removeEventListener("visibilitychange", visible);
    win?.removeEventListener("focus", visible);
    win?.removeEventListener("online", resume);
  };
}
