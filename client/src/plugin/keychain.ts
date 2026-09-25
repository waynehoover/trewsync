/**
 * Where the plugin keeps this device's token: Obsidian's keychain, when the
 * running app has one (PLAN.md section 2.3, "Where the plugin keeps its device
 * token").
 *
 * The point is that the token stops travelling with copies of `.obsidian`.
 * `data.json` is a file in the vault's folder, so a backup, an iCloud copy or a
 * git commit of the vault carried the one credential that makes a device this
 * device, and a copy opened elsewhere connected as the original. The keychain
 * is the app's and not the vault's: a copy of the folder arrives without it.
 *
 * ## The API, as read out of Obsidian 1.13.7
 *
 * `app.secretStorage` is public from 1.11.4 with three methods:
 * `setSecret(id, secret)`, `getSecret(id)` (null when there is none) and
 * `listSecrets()`. `setSecret` throws for an id that is not lowercase
 * alphanumeric and dashes, and the shipped check also refuses one longer than
 * 64 characters (`/^[a-z0-9-]+$/.test(id) && id.length <= 64`). It throws too
 * when the platform has no secure storage at all.
 *
 * What the declarations do not say, and the shipped app does:
 *
 *  - On the desktop the secrets are one JSON object, encrypted with Electron's
 *    `safeStorage` (the macOS Keychain, DPAPI, libsecret) and kept in the
 *    app's localStorage under a key prefixed with the vault's id, so each
 *    vault on a desktop has its own. Where `safeStorage` cannot encrypt, they
 *    are kept unencrypted and Obsidian warns about it once.
 *  - On mobile they are one entry in Capacitor secure storage (the iOS
 *    Keychain, the Android Keystore) with no vault in the key, so every vault
 *    on the phone shares them. That is why the id names the vault.
 *  - `getSecret` answers from memory, loaded before any plugin, and the write
 *    to storage behind `setSecret` is not awaited. Reading back therefore
 *    proves the app accepted the value, and cannot prove it reached the disk;
 *    no public call can. So the token leaves `data.json` in two steps (rule
 *    3): the keychain is written and read back, and the file keeps the token
 *    beside a pending marker naming this app start; only on a later start,
 *    when `getSecret` answers from storage loaded at that start and holds the
 *    same token, is the file rewritten without it. A kill in between leaves
 *    the token in the file, where it always was.
 *  - A load that fails is logged and treated as an empty keychain. So a
 *    missing secret is never taken as proof of anything (rule 2): the saved
 *    pairing stays as it is, and the plugin stops and asks for a new one.
 *  - There is a `deleteSecret(id)` at runtime and none in the declarations.
 *    It is used when it is there; otherwise the secret is overwritten with the
 *    empty string, which is a secret that opens nothing.
 */

import { requireApiVersion, type App, type SecretStorage } from "obsidian";

import { crc32 } from "../core/crc32.ts";
import { hex, randomBytes } from "../core/digest.ts";

/** The first Obsidian with `app.secretStorage`. */
export const KEYCHAIN_SINCE = "1.11.4";

/** The longest id the shipped `setSecret` accepts. */
export const SECRET_ID_MAX = 64;

/**
 * The field `data.json` carries in place of `deviceToken` once the token is in
 * the keychain, and the one value it takes.
 *
 * A marker rather than an absence, because a config with no token and no
 * marker is one nothing here wrote (`deviceCredential` refuses it in its own
 * words), and one with the marker is a device whose token belongs to a
 * keychain: this one, or the one on the device it was copied from.
 */
export const TOKEN_IN = "deviceTokenIn";
export const IN_KEYCHAIN = "keychain";
/**
 * The value `TOKEN_IN` takes while the token is in the keychain and still in
 * `data.json` too, because nothing yet shows the keychain's copy reached its
 * storage. `WRITTEN_AT` names the app start that wrote it.
 */
export const IN_KEYCHAIN_PENDING = "keychain-pending";
export const WRITTEN_AT = "deviceTokenWrittenAt";

/** Where an app start's id is kept: on the app, which outlives a plugin reload. */
const APP_START = Symbol.for("trew.appStart");

/**
 * An id for this start of the app, the same for every load of the plugin
 * until the app itself starts again.
 *
 * Kept on the `App` object rather than in this module, because disabling and
 * enabling the plugin evaluates this module again and leaves the app, and its
 * keychain, as they were: a reload of the plugin is not a start of the app,
 * and a secret written earlier in the same start is still only in memory.
 */
export function appStartOf(app: App): string {
  const holder = app as unknown as Record<symbol, unknown>;
  const known = holder[APP_START];
  if (typeof known === "string") return known;
  const id = hex(randomBytes(8));
  Object.defineProperty(holder, APP_START, { value: id, enumerable: false });
  return id;
}

/** The part of `SecretStorage` this plugin uses, plus the undeclared delete. */
export interface Keychain {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
  listSecrets(): string[];
  deleteSecret?: (id: string) => unknown;
}

/**
 * The running app's keychain, or undefined on an app without one.
 *
 * Behind both checks, for the reason the command line handlers in main.ts
 * are: `requireApiVersion` is what the community directory's review reads, and
 * the `typeof` checks ask the object itself, because a build can report a
 * version without carrying everything it promises. `minAppVersion` stays at
 * 1.7.2 so an older phone keeps getting updates, and there the token stays in
 * `data.json` as it always did.
 */
export function keychainOf(app: App): Keychain | undefined {
  const store = (app as { secretStorage?: SecretStorage | null }).secretStorage ?? undefined;
  return requireApiVersion("1.11.4") &&
    store !== undefined &&
    typeof store.getSecret === "function" &&
    typeof store.setSecret === "function" &&
    typeof store.listSecrets === "function"
    ? store
    : undefined;
}

/** Lowercase alphanumeric runs joined by single dashes, the alphabet the API accepts. */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Eight hex digits of a string's CRC-32, for telling apart what a cut made alike. */
function mark(text: string): string {
  return crc32(new TextEncoder().encode(text)).toString(16).padStart(8, "0");
}

/**
 * The keychain id for this vault's device: `trew-<vault>-<device>`.
 *
 * Both halves, because on a phone every vault shares one keychain. The device
 * id alone would already keep two pairings apart, but it is written in
 * `data.json`, so a copy of the vault on the same phone would name the same
 * secret and find it. The vault's name is what differs between a vault and its
 * copy there.
 *
 * Lowercased and reduced to the alphabet the API accepts, which loses case
 * from the base64url device id: two ids equal but for case, in vaults of the
 * same name, would share a secret, and at 128 random bits that is not a
 * collision anybody will meet. Kept to 64 characters, the API's limit, by
 * cutting the vault's name and marking the cut with a checksum of the whole
 * name, so two long names that begin alike still differ. A device id is 22
 * characters as this plugin makes them; a longer one is cut the same way.
 */
export function secretIdFor(vaultName: string, deviceId: string): string {
  const device = devicePart(deviceId);
  const room = SECRET_ID_MAX - "trew-".length - 1 - device.length;
  let vault = slug(vaultName) || "vault";
  if (vault.length > room)
    vault = `${vault.slice(0, room - 9).replace(/-+$/, "")}-${mark(vaultName)}`;
  return `trew-${vault}-${device}`;
}

/** The device half of a secret id, as `secretIdFor` writes it. */
function devicePart(deviceId: string): string {
  const device = slug(deviceId) || "device";
  return device.length > 32
    ? `${device.slice(0, 23).replace(/-+$/, "")}-${mark(deviceId)}`
    : device;
}

/**
 * Every secret this keychain holds for this device under some vault name
 * other than `except`: what renaming the vault leaves behind, since the id
 * names the vault (`trew-*-<device>`).
 *
 * Only ids with a token in them, because an emptied secret is one that was
 * removed where the app has no delete.
 */
export function secretsForDevice(keychain: Keychain, deviceId: string, except: string): string[] {
  const suffix = `-${devicePart(deviceId)}`;
  return keychain
    .listSecrets()
    .filter(
      (id) =>
        id !== except &&
        id.startsWith("trew-") &&
        id.endsWith(suffix) &&
        id.length > "trew-".length + suffix.length &&
        tokenInKeychain(keychain, id) !== undefined,
    );
}

/**
 * Puts the token in the keychain and reads it back (rule 4).
 *
 * Returns undefined when the keychain holds exactly this token, and otherwise
 * what went wrong, in words for a person: the caller keeps the token in
 * `data.json` and says so, rather than removing the only copy on the strength
 * of a call that returned.
 */
export function keepInKeychain(keychain: Keychain, id: string, token: string): string | undefined {
  try {
    keychain.setSecret(id, token);
  } catch (err) {
    return `Obsidian's keychain refused it (${(err as Error).message})`;
  }
  let back: string | null;
  try {
    back = keychain.getSecret(id);
  } catch (err) {
    return `Obsidian's keychain could not be read back (${(err as Error).message})`;
  }
  if (back !== token) return "Obsidian's keychain did not read back what was written to it";
  return undefined;
}

/** The token the keychain holds under `id`, or undefined for none or an emptied one. */
export function tokenInKeychain(keychain: Keychain, id: string): string | undefined {
  const value = keychain.getSecret(id);
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Removes a secret, and checks that it is gone.
 *
 * `deleteSecret` where the app has it; otherwise the secret is overwritten
 * with the empty string, which the keychain lists and which opens nothing.
 * Throws when the token can still be read afterwards.
 */
export function removeFromKeychain(keychain: Keychain, id: string): void {
  if (keychain.getSecret(id) === null) return;
  if (typeof keychain.deleteSecret === "function") keychain.deleteSecret(id);
  else keychain.setSecret(id, "");
  if (tokenInKeychain(keychain, id) !== undefined) {
    throw new Error(`the keychain still holds ${id} after it was removed`);
  }
}
