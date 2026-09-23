/**
 * The platform self-check, against the adapter fake on each kind of disk it
 * models, and against a disk made stricter than the rules on purpose.
 */

import { describe, expect, it } from "vitest";

import { FakeAdapter } from "./fake.ts";
import { renderProbeReport, runPlatformProbe, type ProbeReport } from "./platform-probe.ts";

const DIR = ".obsidian/plugins/trew-sync";

/** Every adapter call the probe itself made, after the test's own setup. */
let probeCalls: FakeAdapter["calls"] = [];

async function probe(adapter: FakeAdapter, windows = false): Promise<ProbeReport> {
  await adapter.mkdir(DIR);
  const before = adapter.calls.length;
  const report = await runPlatformProbe({
    adapter,
    pluginDir: DIR,
    windows,
    platform: "test",
    appVersion: "1.13.7",
    pluginVersion: "0.0.0",
    nonce: "fixed",
  });
  probeCalls = adapter.calls.slice(before);
  return report;
}

function verdict(report: ProbeReport, name: string): string {
  const r = report.results.find((x) => x.name === name);
  if (r === undefined) throw new Error(`no case named ${name}`);
  return r.verdict;
}

describe("the platform self-check", () => {
  it("writes only inside its own folder, and leaves nothing behind", async () => {
    const adapter = new FakeAdapter();
    await probe(adapter);
    const writes = probeCalls.filter((c) => ["writeBinary", "mkdir", "rename"].includes(c.op));
    expect(writes.length).toBeGreaterThan(10);
    for (const c of writes) expect(c.path.startsWith(`${DIR}/probe-fixed`), c.path).toBe(true);
    expect(await adapter.exists(`${DIR}/probe-fixed`)).toBe(false);
  });

  it("finds nothing unsafe on a case-sensitive disk, and the rules' extra refusals limited", async () => {
    const report = await probe(new FakeAdapter());
    expect(report.hasUnsafe).toBe(false);
    expect(verdict(report, "Names that differ only by case")).toBe("safe");
    expect(verdict(report, "A non-breaking space")).toBe("limited");
    expect(verdict(report, "A 256-byte name")).toBe("limited");
    expect(verdict(report, "A 255-byte name")).toBe("safe");
    expect(verdict(report, "Renaming onto an existing file refuses")).toBe("safe");
    expect(verdict(report, "Renaming into an empty name keeps the whole file")).toBe("safe");
  });

  it("finds nothing unsafe on a disk that folds case and composition, as macOS does", async () => {
    const adapter = new FakeAdapter();
    adapter.insensitive = true;
    const report = await probe(adapter);
    expect(report.hasUnsafe).toBe(false);
    const cased = report.results.find((r) => r.name === "Names that differ only by case")!;
    expect(cased.actual).toBe(true);
    expect(cased.expected).toBe(true);
    expect(report.results.find((r) => r.name.startsWith("The same name in NFC"))!.actual).toBe(
      true,
    );
  });

  it("reports a device stricter than the rules as unsafe", async () => {
    const adapter = new FakeAdapter();
    // A disk that cannot hold a colon, while the non-Windows rules accept it.
    adapter.fault = (op, path) =>
      op === "writeBinary" && path.includes(":") ? new Error("EINVAL") : undefined;
    const report = await probe(adapter);
    expect(verdict(report, "A colon")).toBe("unsafe");
    expect(report.hasUnsafe).toBe(true);
    expect(renderProbeReport(report)).toContain("Please report this");
  });

  it("applies Windows' rules on Windows, so its refusals are expected there", async () => {
    const adapter = new FakeAdapter();
    adapter.fault = (op, path) =>
      op === "writeBinary" && /[<>:"|?*]/.test(path.slice(path.lastIndexOf("/") + 1))
        ? new Error("EINVAL")
        : undefined;
    const report = await probe(adapter, true);
    for (const name of ["A colon", "A question mark", "An asterisk", "A pipe", "A double quote"]) {
      expect(verdict(report, name), name).toBe("safe");
    }
  });

  it("counts a write that lands under another name as not created", async () => {
    const adapter = new FakeAdapter();
    // What Windows does with a trailing dot: the write succeeds, as another name.
    const strip = (p: string) => p.replace(/\.$/, "");
    const write = adapter.writeBinary.bind(adapter);
    const read = adapter.readBinary.bind(adapter);
    adapter.writeBinary = (p, data, options) => write(strip(p), data, options);
    adapter.readBinary = (p) => read(strip(p));
    const report = await probe(adapter, true);
    const dot = report.results.find((r) => r.name === "A name ending in a dot")!;
    expect(dot.actual).toBe(false);
    expect(dot.verdict).toBe("safe");
  });

  it("renders every case into the report", async () => {
    const report = await probe(new FakeAdapter());
    const text = renderProbeReport(report);
    for (const r of report.results) expect(text).toContain(r.name);
  });
});
