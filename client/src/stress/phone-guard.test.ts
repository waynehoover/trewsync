/**
 * The refusals `bench-phone-10k.ts` rests on, held without a phone.
 *
 * The phone run is the one script here that reaches a device with somebody's
 * notes on it, so what it refuses is tested rather than read: a vault that is
 * somebody's by name, any adb argument naming a path outside the bench vault,
 * a removal of the vault itself, and an evaluation that runs in whichever
 * vault happens to be open.
 */

import { expression, guard, refuseVault } from "../../bench-phone-10k.ts";

const BENCH = "/sdcard/Documents/TrewBench10k";

describe("the phone run's refusals", () => {
  it("refuses the vaults that hold real notes, in any case", () => {
    for (const name of ["My Vault", "my vault", "Test", "TEST", "Trew M3"]) {
      expect(() => refuseVault(name), name).toThrow(/real notes/);
    }
    for (const name of ["", "a/b", ".hidden"]) expect(() => refuseVault(name), name).toThrow();
    expect(() => refuseVault("TrewBench10k")).not.toThrow();
  });

  it("allows commands inside the bench vault", () => {
    for (const parts of [
      ["mkdir", "-p", `${BENCH}/.obsidian/plugins/trew-sync`],
      ["tar", "-xf", `${BENCH}/corpus.tar`, "-C", BENCH],
      ["rm", "-rf", `${BENCH}/Journal`],
      ["rm", "-f", `${BENCH}/.obsidian/plugins/trew-sync/data.json`],
      ["find", BENCH, "-type", "f", "-exec", "sha256sum", "{}", "+"],
      ["push", "/tmp/x.tar", `${BENCH}/corpus.tar`],
      ["reverse", "tcp:3999", "tcp:3999"],
    ]) {
      expect(() => guard(parts, BENCH), parts.join(" ")).not.toThrow();
    }
  });

  it("refuses anything outside it", () => {
    for (const parts of [
      ["rm", "-rf", "/sdcard/Documents/My Vault/Journal"],
      ["rm", "-rf", "/sdcard/Documents/Test"],
      ["push", "/tmp/x", "/sdcard/Documents/Other/x"],
      ["ls", "/sdcard/Documents"],
      ["rm", "-rf", `${BENCH}/../My Vault`],
      ["rm", "-rf", `${BENCH}2/Journal`],
      ["shell", "echo", "example"],
    ]) {
      expect(() => guard(parts, BENCH), parts.join(" ")).toThrow(/refusing/);
    }
  });

  it("refuses to remove the vault itself, or anything not under it", () => {
    expect(() => guard(["rm", "-rf", BENCH], BENCH)).toThrow(/only things inside/);
    expect(() => guard(["rm", "-rf", "Journal"], BENCH)).toThrow(/only things inside/);
  });

  it("checks the open vault's name before an evaluation does anything", async () => {
    const ran: string[] = [];
    const app = (name: string) => ({
      vault: { getName: () => name },
      plugins: { plugins: { "trew-sync": { touch: () => ran.push(name) } } },
    });
    const run = (name: string) =>
      new Function("app", `return ${expression("plugin.touch(); return 1;", "TrewBench10k")}`)(
        app(name),
      ) as Promise<string>;
    await expect(run("My Vault")).rejects.toThrow(/wrong vault/);
    expect(ran).toEqual([]);
    expect(JSON.parse(await run("TrewBench10k"))).toBe(1);
    expect(ran).toEqual(["TrewBench10k"]);
  });
});
