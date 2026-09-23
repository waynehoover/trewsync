import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { Args } from "./cli.ts";
import { lockVault } from "./lock.ts";

export interface McpVaultRoot {
  readonly id: string;
  readonly dir: string;
}
export async function mcpVaultRoots(args: Args): Promise<McpVaultRoot[]> {
  const configured = args.mcpVaults ?? [`default=${args.dir}`];
  if (!configured.length || configured.length > 10)
    throw new Error("configure between one and ten vaults");
  const names = new Set<string>(),
    identities = new Set<string>();
  const roots: McpVaultRoot[] = [];
  for (const value of configured) {
    const at = value.indexOf("="),
      id = value.slice(0, at),
      path = value.slice(at + 1);
    if (at < 1 || !/^[a-z][a-z0-9_-]{0,31}$/u.test(id) || names.has(id) || !isAbsolute(path))
      throw new Error(
        "--vault requires a distinct lowercase name and an absolute directory: name=/path",
      );
    names.add(id);
    const dir = await realpath(path),
      info = await stat(dir, { bigint: true });
    if (!info.isDirectory()) throw new Error("a configured vault root is not a directory");
    const identity = `${info.dev}:${info.ino}`;
    if (identities.has(identity))
      throw new Error("configured vault roots must be distinct, including directory aliases");
    identities.add(identity);
    roots.push({ id, dir });
  }
  // String prefixes miss case aliases on APFS. Compare ancestor identities
  // so two differently spelled roots cannot expose the same nested notes.
  for (const root of roots)
    for (let parent = dirname(root.dir); ; parent = dirname(parent)) {
      const info = await stat(parent, { bigint: true });
      if (identities.has(`${info.dev}:${info.ino}`))
        throw new Error("configured vault roots cannot contain one another");
      if (parent === dirname(parent)) break;
    }
  return roots;
}
export async function withMcpLocks<T>(
  roots: readonly McpVaultRoot[],
  work: () => Promise<T>,
): Promise<T> {
  const releases: (() => Promise<void>)[] = [];
  try {
    for (const root of [...roots].sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0)))
      releases.push(await lockVault(root.dir, "trew mcp"));
    return await work();
  } finally {
    for (const release of releases.reverse()) await release().catch(() => {});
  }
}
