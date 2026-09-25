/** Connect the CLI to the process, allowing piped output to flush before exit. */

import { run } from "./cli.ts";

const code = await run(process.argv.slice(2), {
  out: (line) => process.stdout.write(line + "\n"),
  err: (line) => process.stderr.write(line + "\n"),
  // Colour only for a terminal, and never when NO_COLOR is set (no-color.org).
  color: process.stdout.isTTY === true && (process.env["NO_COLOR"] ?? "") === "",
});
process.exitCode = code;
