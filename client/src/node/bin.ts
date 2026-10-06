/** Connect the CLI to the process, allowing piped output to flush before exit. */

import { interrupt, run } from "./cli.ts";

// Ctrl-C and SIGTERM ask the command to stop rather than killing it where it
// stands, so it releases the vault's lock on the way out (T21, `interrupt`).
// Once each: a second one finds no listener and does what it always did, and
// so does a command still running a few seconds after the first.
let stoppedBy: NodeJS.Signals | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stoppedBy ??= signal;
    interrupt();
    // `trew pair -` may be waiting on standard input, which nothing else ends.
    process.stdin.destroy();
    setTimeout(() => process.kill(process.pid, signal), 5_000).unref();
  });
}

const code = await run(process.argv.slice(2), {
  out: (line) => process.stdout.write(line + "\n"),
  err: (line) => process.stderr.write(line + "\n"),
  // Colour only for a terminal, and never when NO_COLOR is set (no-color.org).
  color: process.stdout.isTTY === true && (process.env["NO_COLOR"] ?? "") === "",
});
// Ended by the signal it was stopped with, as before, so a shell or a service
// manager reads the way it ended the same as it always has.
if (stoppedBy !== undefined) process.kill(process.pid, stoppedBy);
else process.exitCode = code;
