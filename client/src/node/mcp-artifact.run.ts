import { smokeMcpArtifact, smokeHttpArtifact } from "./mcp-artifact-test.ts";
import { cleanupBinary } from "../core/test-server.ts";
import { fileURLToPath } from "node:url";

const [artifact, runtime] = process.argv.slice(2);
if (!artifact || !runtime) throw new Error("supply the packed artifact and Node executable");
try {
  console.info(
    "Packed MCP initialize/list/read/edit and before-image:",
    await smokeMcpArtifact(artifact, runtime, fileURLToPath(new URL("../../..", import.meta.url))),
  );
  console.info(
    "Packed HTTP MCP initialize/list/read/edit and before-image:",
    await smokeHttpArtifact(artifact, runtime, fileURLToPath(new URL("../../..", import.meta.url))),
  );
} finally {
  await cleanupBinary();
}
