/**
 * The keychain half of where the device token is kept: the id it goes under,
 * and the read-back that decides whether `data.json` may let go of it.
 *
 * The plugin's own behaviour with a real server is in main.test.ts, "where the
 * device token is kept". These are the rules the ids must meet, checked
 * against the stub's `setSecret`, which applies the shipped app's own.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { App as ObsidianApp } from "obsidian";

import { generateDeviceId } from "../core/pairing.ts";
import {
  SECRET_ID_MAX,
  appStartOf,
  keepInKeychain,
  keychainOf,
  removeFromKeychain,
  secretIdFor,
  secretsForDevice,
  tokenInKeychain,
} from "./keychain.ts";
import { App, FakeSecretStorage, resetStub, setApiVersion } from "./stub.ts";

afterEach(() => resetStub());

describe("the secret id", () => {
  it("is trew-<vault>-<device> in the alphabet and length the API accepts", () => {
    const store = new FakeSecretStorage();
    const names = [
      "Notes",
      "My Notes (2026)",
      "Ünïcödé 笔记",
      "",
      "---",
      "a".repeat(200),
      "Work/Projects",
    ];
    for (const name of names) {
      for (let i = 0; i < 20; i++) {
        const id = secretIdFor(name, generateDeviceId());
        expect(id).toMatch(/^trew-[a-z0-9-]+$/);
        expect(id.length).toBeLessThanOrEqual(SECRET_ID_MAX);
        // The stub refuses what the shipped app refuses.
        expect(() => store.setSecret(id, "x")).not.toThrow();
      }
    }
    expect(secretIdFor("My Notes", "AbC_dEf-123")).toBe("trew-my-notes-abc-def-123");
  });

  it("differs by vault and by device, and a long name keeps its difference", () => {
    const device = generateDeviceId();
    expect(secretIdFor("Work", device)).not.toBe(secretIdFor("Home", device));
    expect(secretIdFor("Work", device)).not.toBe(secretIdFor("Work", generateDeviceId()));
    const long = "a very long vault name that goes on ".repeat(3);
    expect(secretIdFor(`${long}one`, device)).not.toBe(secretIdFor(`${long}two`, device));
    expect(secretIdFor(`${long}one`, device).length).toBeLessThanOrEqual(SECRET_ID_MAX);
    // A device id longer than this plugin makes still fits.
    const wide = "A".repeat(64);
    expect(secretIdFor(long, wide).length).toBeLessThanOrEqual(SECRET_ID_MAX);
    expect(secretIdFor(long, wide)).not.toBe(secretIdFor(long, `${"A".repeat(63)}B`));
  });
});

describe("the keychain", () => {
  const app = (store: FakeSecretStorage | null) =>
    new App({ secretStorage: store }) as unknown as ObsidianApp;

  it("is found on 1.11.4 and later, and only when the object is there", () => {
    const store = new FakeSecretStorage();
    expect(keychainOf(app(store))).toBe(store);
    expect(keychainOf(app(null))).toBeUndefined();
    setApiVersion("1.11.3");
    expect(keychainOf(app(store))).toBeUndefined();
    setApiVersion("1.11.4");
    expect(keychainOf(app(store))).toBe(store);
  });

  it("reads back what it keeps, and says why when it did not", () => {
    const store = new FakeSecretStorage();
    expect(keepInKeychain(store, "trew-a-b", "token")).toBeUndefined();
    expect(tokenInKeychain(store, "trew-a-b")).toBe("token");

    store.dropWrites = true;
    expect(keepInKeychain(store, "trew-a-c", "token")).toMatch(/did not read back/);
    store.dropWrites = false;
    store.unavailable = true;
    expect(keepInKeychain(store, "trew-a-c", "token")).toMatch(/refused it/);
    expect(keepInKeychain(new FakeSecretStorage(), "Not Valid", "token")).toMatch(/refused it/);
  });

  it("names one start of the app the same on every load, and another start differently", () => {
    const one = app(new FakeSecretStorage());
    expect(appStartOf(one)).toBe(appStartOf(one));
    expect(appStartOf(app(new FakeSecretStorage()))).not.toBe(appStartOf(one));
    // Not among what a copy of the app's state would carry.
    expect(Object.keys(one)).not.toContain("trew.appStart");
  });

  it("finds this device's secrets under other vault names, and nobody else's", () => {
    const store = new FakeSecretStorage();
    const device = generateDeviceId();
    const here = secretIdFor("Renamed", device);
    const before = secretIdFor("Notes", device);
    const long = secretIdFor("a very long vault name that goes on and on ".repeat(3), device);
    store.setSecret(here, "current");
    store.setSecret(before, "old");
    store.setSecret(long, "older");
    store.setSecret(secretIdFor("Notes", generateDeviceId()), "another device");
    store.setSecret(secretIdFor("Emptied", device), "");
    store.setSecret("other-plugin-secret", "not ours");
    expect(secretsForDevice(store, device, here).sort()).toEqual([before, long].sort());
  });

  it("removes a secret, by emptying it where there is no delete", () => {
    const store = new FakeSecretStorage();
    store.setSecret("trew-a-b", "token");
    removeFromKeychain(store, "trew-a-b");
    expect(store.listSecrets()).toEqual([]);

    const old = new FakeSecretStorage();
    (old as unknown as { deleteSecret: undefined }).deleteSecret = undefined;
    old.setSecret("trew-a-b", "token");
    removeFromKeychain(old, "trew-a-b");
    expect(old.getSecret("trew-a-b")).toBe("");
    expect(tokenInKeychain(old, "trew-a-b")).toBeUndefined();

    const stuck = new FakeSecretStorage();
    stuck.setSecret("trew-a-b", "token");
    stuck.dropWrites = true;
    (stuck as unknown as { deleteSecret: undefined }).deleteSecret = undefined;
    expect(() => removeFromKeychain(stuck, "trew-a-b")).toThrow(/still holds/);
  });
});
