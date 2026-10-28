/**
 * Attachments on demand, the part both shells share: which files the setting
 * leaves on the server. The engine decides from it (`EngineOptions.onDemand`)
 * and frees space by it (`Engine.release`); the plugin's links and the
 * command line's arguments are how each shell asks for a file back.
 */

import { looksLikeText } from "./chunk.ts";
import { isConfigPath } from "./path-policy.ts";

/** Whether a file of this size is one the setting leaves on the server. */
export function coveredBy(threshold: number | undefined, path: string, size: number): boolean {
  return (
    threshold !== undefined && size >= threshold && !looksLikeText(path) && !isConfigPath(path)
  );
}
