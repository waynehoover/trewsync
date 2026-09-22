/** Connect the CLI to the process, allowing piped output to flush before exit. */

import { run } from "./cli.ts";

const code = await run(process.argv.slice(2), {
  out: (line) => process.stdout.write(line + "\n"),
  err: (line) => process.stderr.write(line + "\n"),
});
process.exitCode = code;
