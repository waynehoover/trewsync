/** Test-only entry point. IPC controls seams; stdin/stdout stay real MCP. */
import { seamNamed } from "../core/seam.ts";
import "./mcp-notes.ts";
import "./vault.ts";
import "./lock.ts";

let release: (() => void) | undefined;
process.on("message", (message: { hold?: string; release?: boolean }) => {
  if (message.release) release?.();
  if (message.hold) {
    const point = seamNamed(message.hold);
    let fired = false;
    point.hold(async (path) => {
      if (fired) return;
      fired = true;
      await new Promise<void>((resolve) => {
        release = resolve;
        process.send?.({ reached: point.name, path });
      });
    });
    process.send?.({ armed: point.name });
  }
});

await import("./bin.ts");
if (process.connected) process.disconnect();
