/**
 * `scripts/pack-check.sh`'s run of the file the npm tarball installed:
 * paired, synced both ways, under the given Node, with the repository denied
 * on macOS.
 *
 *     bun run src/node/artifact.run.ts PATH/TO/trew.mjs "$(command -v node)"
 */

import { smokeArtifact } from "./artifact-test.ts";
import { cleanupBinary } from "../core/test-server.ts";
import { fileURLToPath } from "node:url";

const [artifact, runtime] = process.argv.slice(2);
if (!artifact || !runtime) throw new Error("supply the packed artifact and Node executable");
try {
  console.info(
    "Packed CLI pair, sync both ways and status:",
    await smokeArtifact(artifact, runtime, fileURLToPath(new URL("../../..", import.meta.url))),
  );
} finally {
  await cleanupBinary();
}
