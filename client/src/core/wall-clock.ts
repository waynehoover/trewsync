/**
 * A date and time on this machine's clock, as the instant it names: exactly
 * that one, or refused with why.
 *
 * `new Date(y, m, d, h, mi)` answers every input. A date that does not exist
 * rolls into the next month; a time the clocks skip going forward moves past
 * the gap; a time the clocks go back through, which happens twice, becomes
 * the earlier of the two. Each is an instant nobody asked for, and a restore
 * to it writes over a folder. So the answer is checked back against what was
 * asked, and an hour the clocks repeat is refused rather than guessed, with
 * an offset as the way to say which.
 */
export type WallClock =
  { readonly ms: number } | { readonly problem: "not a date" | "skipped" | "twice" };

export function wallClock(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  milli = 0,
): WallClock {
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return { problem: "not a date" };
  }
  const ms = new Date(year, month - 1, day, hour, minute, second, milli).getTime();
  if (!Number.isFinite(ms)) return { problem: "not a date" };
  const reads = (t: number) => {
    const x = new Date(t);
    return {
      date: x.getFullYear() === year && x.getMonth() === month - 1 && x.getDate() === day,
      time: x.getHours() === hour && x.getMinutes() === minute && x.getSeconds() === second,
    };
  };
  const back = reads(ms);
  if (!back.date && back.time) return { problem: "not a date" };
  if (!back.date || !back.time) {
    // The day itself exists if its noon does: the hour asked for is in a gap.
    const noon = reads(new Date(year, month - 1, day, 12).getTime());
    return { problem: noon.date ? "skipped" : "not a date" };
  }
  // The later of two readings of this wall clock, which `Date` never picks.
  for (const minutes of [30, 60, 120]) {
    const later = reads(ms + minutes * 60_000);
    if (later.date && later.time) return { problem: "twice" };
  }
  return { ms };
}

/** What a refused wall clock means, for a person. */
export function wallClockWhy(problem: "not a date" | "skipped" | "twice"): string {
  switch (problem) {
    case "not a date":
      return "is not a date";
    case "skipped":
      return "does not exist here: the clocks skipped it, going forward. Give the time after the change, or an offset";
    case "twice":
      return "happens twice here, as the clocks go back. Give an offset, such as +02:00, to say which";
  }
}
