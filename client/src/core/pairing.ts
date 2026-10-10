/**
 * What a paired device stores, and the invite it pairs from.
 *
 * It lives in `core` rather than beside either shell because the plugin and the
 * headless client have to read exactly the same configuration and the same
 * invite string. Two parsers for one format is two chances to disagree about a
 * credential.
 *
 * ## The invite
 *
 * A device joins a vault by redeeming a single-use invite: a `trew1i_` string
 * carrying a 16-byte token, the server's address and the vault's name
 * (plan/protocol.md, "The invite string"; the codec is `invite-string.ts`).
 * `trewd serve` writes the first one to `<data>/first-invite`, `trewd invite` on
 * the server prints more, and a paired device mints them over the wire. Anyone
 * holding an unexpired, unspent invite can add a device, so it is shown to the
 * person who asked and to nothing else.
 *
 * ## The credential
 *
 * A paired device holds its own row id and its own random 32-byte token, and
 * nothing else that authenticates. The server stores only the token's SHA-256,
 * so a copy of the server's database opens nothing, and revoking the row is
 * the whole of taking the device away.
 */

import { base64urlDecode, base64urlEncode, randomBytes } from "./digest.ts";
import { parseInviteString, type InviteString } from "./invite-string.ts";

/**
 * The vault every string means when it does not name one.
 *
 * The server has the same constant. It is a default rather than a name, so
 * nothing should read it back to somebody as though they had chosen it. A
 * screen that says `vault "default"` is showing an implementation detail in the
 * place a person looks for confirmation.
 */
export const DEFAULT_VAULT = "default";

/**
 * How a device identifies its own row in the vault's device list.
 *
 * Sixteen random bytes, base64url, chosen here rather than by the server. The
 * server cannot check that the bytes were random and does not try; what makes
 * a collision safe is the redemption refusing an id the vault already holds.
 */
export const DEVICE_ID_BYTES = 16;

/**
 * The length of a device's token, the credential it connects with.
 *
 * Thirty-two random bytes, the length the server insists on (plan/protocol.md,
 * "Device session"): it decodes the token and refuses anything that is not
 * exactly this, so a credential short enough to guess cannot be registered.
 */
export const DEVICE_TOKEN_BYTES = 32;

/** The length of an invite's redemption token. */
export const INVITE_TOKEN_BYTES = 16;

/**
 * A fresh device id.
 *
 * Base64url's alphabet includes `-`, and an id beginning with one is a word a
 * command line reads as an option: `trew revoke -Xy...` was refused with "no
 * such option" rather than revoking anything. `trew revoke` accepts `--`
 * before an id for the ones that arrive from elsewhere, and this makes sure
 * none arrives from here. One character of entropy is given up out of 128 bits,
 * which is not a bound anybody was relying on.
 */
export function generateDeviceId(): string {
  for (;;) {
    const id = base64urlEncode(randomBytes(DEVICE_ID_BYTES));
    if (!id.startsWith("-")) return id;
  }
}

/**
 * A fresh device token: 32 bytes from the platform's secure random source,
 * unpadded base64url, which is 43 characters and safe in JSON and a URL.
 */
export function generateDeviceToken(): string {
  return base64urlEncode(randomBytes(DEVICE_TOKEN_BYTES));
}

/**
 * What a paired device stores.
 *
 * A device holds `deviceId` and `deviceToken`, and nothing else that
 * authenticates. The token connects as this one device and can be revoked on
 * its own; there is no vault-wide credential for a device to hold.
 *
 * The name is local: it is what appears in a conflict copy's filename, so it
 * wants to be the thing you would call the machine rather than anything the
 * other devices agreed on. It is also the label the device's row carries, and
 * it is never an identity: two laptops may both be called laptop.
 */
export interface DeviceConfig {
  /** WebSocket URL of the server, canonical: ws:// or wss://, no trailing slash. */
  readonly url: string;
  /** Which vault on that server. */
  readonly vaultId: string;
  readonly device: string;

  /**
   * This device's row in the vault's device list, and the credential for it.
   *
   * Optional in the type and not in practice: they are written together, and
   * every path that connects goes through `deviceCredential` first, which
   * refuses a config missing either and says what to do. They are optional
   * because a config on disk can be missing one, and a config that will not
   * decode is not the same state as one that is incomplete (rule 2).
   */
  readonly deviceId?: string;
  readonly deviceToken?: string;
  /**
   * Whether this device may send anything to the server (I29).
   *
   * In the config rather than only in a flag, because the point of it is that
   * the capability is absent: a mirror that becomes writable the moment a cron
   * line loses an argument has not been made safe, it has been made
   * conditional. Written by `pair --read-only`, and there is no flag that
   * turns it off again.
   *
   * Absent means writable.
   */
  readonly readOnly?: boolean;
  /**
   * Folder and file names this device never syncs, at any depth (R083-13).
   *
   * Per device and never sent anywhere, which is the point: a phone can leave
   * a media folder alone while the desktop keeps it. A path another device
   * syncs and this one ignores is counted as `ignored`, kept out of the exit
   * code and out of the attention list, so it reads as configuration rather
   * than as something going wrong.
   *
   * One name per entry, not a path: it matches that segment wherever it
   * appears, which is what `--ignore` means on the CLI and what `isNeverSynced`
   * implements. Absent and empty are the same thing.
   */
  readonly ignore?: readonly string[];
  /**
   * Whether this device syncs its Obsidian settings (plan/settings-sync.md):
   * those of the config folder Obsidian runs from here, with every device
   * that runs a folder of the same name. Per device, and off unless a person
   * turns it on here.
   */
  readonly settings?: boolean;
  /**
   * Whose copy wins, the first time, for a setting this device has never
   * synced and holds differently from the server: the server's, which
   * another device sent, or this device's. Asked when settings sync is turned
   * on; absent keeps both, as a first sync of notes does.
   */
  readonly settingsFirstChoice?: "server" | "device";
  /**
   * Ask the server for its whole history at the next start, once: set when
   * settings sync is turned on, because a device that ran an older release
   * was never sent the settings other devices committed meanwhile, and its
   * cursor has moved past them. Forgotten after the first pass.
   */
  readonly settingsReplay?: boolean;
}

/**
 * A pairing that has been started and not finished (plan/protocol.md, "Invite
 * redemption").
 *
 * The joining device makes its id and token first and saves them, with the
 * invite it is redeeming, before the redemption is sent. So a reply lost after
 * the server committed leaves this on disk holding exactly the credential the
 * server registered, and retrying with it is answered `redeemed` again, even
 * after the invite has expired. A redemption refused for good deletes it, so
 * nothing is left saved after a refusal. `redeemed` replaces it with the
 * device's configuration, which holds no invite.
 */
export interface PendingPairing extends DeviceConfig {
  /** The invite token being redeemed, unpadded base64url. */
  readonly invite: string;
  readonly deviceId: string;
  readonly deviceToken: string;
}

/** Whether a stored config is a pairing still waiting for its answer. */
export function isPendingPairing(config: DeviceConfig): config is PendingPairing {
  return typeof (config as Partial<PendingPairing>).invite === "string";
}

/**
 * A pairing about to be sent: fresh ids, and the invite they are for.
 *
 * Nothing is saved here. The caller saves the result before it sends anything,
 * which is the whole point of the shape (`pairWithInvite` in client.ts).
 */
export function startPairing(
  invite: InviteString,
  device: string,
  extra: { readOnly?: boolean | undefined; ignore?: readonly string[] | undefined } = {},
): PendingPairing {
  return {
    url: invite.url,
    vaultId: invite.vault,
    device,
    invite: base64urlEncode(invite.token),
    deviceId: generateDeviceId(),
    deviceToken: generateDeviceToken(),
    ...(extra.readOnly === true ? { readOnly: true } : {}),
    ...(extra.ignore?.length ? { ignore: extra.ignore } : {}),
  };
}

/** The finished device a pending pairing becomes: the same, without the invite. */
export function finishedPairing(pending: PendingPairing): DeviceConfig {
  return {
    url: pending.url,
    vaultId: pending.vaultId,
    device: pending.device,
    deviceId: pending.deviceId,
    deviceToken: pending.deviceToken,
    ...(pending.readOnly === true ? { readOnly: true } : {}),
    ...(pending.ignore?.length ? { ignore: pending.ignore } : {}),
  };
}

/**
 * Raised when a config holds nothing to connect with.
 *
 * Its own class because a shell has to tell it apart from a refusal by a
 * server. Nothing was asked of anybody: `trew status` reports such a device
 * as neither reachable nor refused (rule 7), and calling it "not authorised"
 * sent somebody hunting a server problem that was not there.
 */
export class NoCredential extends Error {}

/**
 * The credential a paired device connects with, or a refusal naming what is
 * missing and what to do about it.
 *
 * Refused rather than defaulted. A config missing either half is not a device
 * with less state, it is a device that never finished joining the vault, and
 * the callers of this are the ones that would otherwise connect as nobody.
 *
 * A pending pairing is refused too, and in its own words: it has a credential,
 * and whether the server registered it is exactly what is not yet known. The
 * shells finish it (`pairWithInvite`) rather than connecting with it.
 */
export function deviceCredential(config: DeviceConfig): { deviceId: string; deviceToken: string } {
  if (isPendingPairing(config)) {
    throw new NoCredential(
      "this device's pairing has not finished: the invite was sent and no answer has been " +
        "heard. Pairing again finishes it with the credential already saved here.",
    );
  }
  const missing: string[] = [];
  if (!config.deviceId) missing.push("a device id");
  if (!config.deviceToken) missing.push("a device token");
  if (missing.length > 0 || !config.deviceId || !config.deviceToken) {
    throw new NoCredential(
      `this device has no credential for the vault: it is missing ${missing.join(" and ")}. ` +
        "Pair this vault again with an invite, from another device or from trewd invite on " +
        "the server.",
    );
  }
  return { deviceId: config.deviceId, deviceToken: config.deviceToken };
}

/** The stored form, which is JSON on both platforms. */
export function encodeConfig(config: DeviceConfig): Record<string, string> {
  return {
    url: config.url,
    vaultId: config.vaultId,
    device: config.device,
    ...(config.deviceId ? { deviceId: config.deviceId } : {}),
    ...(config.deviceToken ? { deviceToken: config.deviceToken } : {}),
    ...(isPendingPairing(config) ? { invite: config.invite } : {}),
    // Written only when true, so a writable config never carries the field,
    // and a reader that does not know it sees a field it ignores rather than
    // a value it misreads.
    ...(config.readOnly === true ? { readOnly: "true" } : {}),
    // JSON rather than a separator, because the names are somebody's folders
    // and a separator is a character a folder is allowed to contain. Written
    // only when there is something to write, for the reason above.
    ...(config.ignore?.length ? { ignore: JSON.stringify(config.ignore) } : {}),
    ...(config.settings === true ? { settings: "true" } : {}),
    ...(config.settingsFirstChoice ? { settingsFirstChoice: config.settingsFirstChoice } : {}),
    ...(config.settingsReplay === true ? { settingsReplay: "true" } : {}),
  };
}

/**
 * Whether a string is one name this device can be told to skip.
 *
 * One segment: `isNeverSynced` matches a name against each segment of a path,
 * so a value with a slash in it would match nothing and quietly sync the
 * folder somebody asked it not to. `.` and `..` are not names, and a
 * dot-prefixed name is already covered by the rule every device shares.
 */
export function isIgnorableName(value: string): boolean {
  return value !== "" && value !== "." && value !== ".." && !value.includes("/");
}

/**
 * The ignore list out of a stored config, or nothing.
 *
 * Anything unreadable is dropped rather than refused. This list is a
 * preference: a config whose ignore field somebody hand-edited into nonsense
 * must still open, because it also holds this device's credential (rule 2).
 * Dropping a name syncs a folder that was meant to be skipped, which is visible
 * and fixable; refusing the file is not.
 */
function ignoreList(record: Record<string, unknown>): { ignore?: readonly string[] } {
  const raw = record["ignore"];
  if (typeof raw !== "string" || raw === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!Array.isArray(parsed)) return {};
  const names = parsed.filter((v): v is string => typeof v === "string" && isIgnorableName(v));
  return names.length > 0 ? { ignore: [...new Set(names)] } : {};
}

/**
 * Reads stored config, refusing anything it cannot read completely.
 *
 * A config that half-parses is the worst outcome available: a token short by a
 * byte is one the server refuses at every hello, and a shell told it is paired
 * retries for ever. `where` names the file, so the error says which one.
 *
 * What is *not* refused here is a config that is incomplete in a way that is
 * still readable: a device id with no token. Refusing to decode that would
 * turn an incomplete pairing into an unreadable file, which the shells treat
 * differently (rule 2). `deviceCredential` is where an unusable config is
 * refused, at the moment something tries to connect with it, and it says what
 * is missing and what to do.
 */
export function decodeConfig(raw: unknown, where: string): DeviceConfig {
  if (typeof raw !== "object" || raw === null)
    throw new Error(`${where} does not hold a configuration`);
  const record = raw as Record<string, unknown>;
  const str = (key: string): string => {
    const value = record[key];
    if (typeof value !== "string" || value === "") throw new Error(`${where} has no ${key}`);
    return value;
  };
  const config = {
    url: str("url"),
    vaultId: str("vaultId"),
    device: str("device"),
    ...deviceId(record, where),
    ...token(record, "deviceToken", DEVICE_TOKEN_BYTES, "a device token", where),
    ...token(record, "invite", INVITE_TOKEN_BYTES, "an invite token", where),
    // Only the exact string this writes turns it on. Anything else, including
    // a missing field and including some other truthy word, means writable,
    // because a device silently refusing to send would look exactly like a
    // device with nothing to send (I29).
    ...(record["readOnly"] === "true" ? { readOnly: true } : {}),
    ...ignoreList(record),
    // The same rule as readOnly: only the string this writes turns it on.
    ...(record["settings"] === "true" ? { settings: true } : {}),
    ...(record["settingsFirstChoice"] === "server" || record["settingsFirstChoice"] === "device"
      ? { settingsFirstChoice: record["settingsFirstChoice"] }
      : {}),
    ...(record["settingsReplay"] === "true" ? { settingsReplay: true } : {}),
  } as DeviceConfig & { invite?: string };
  if (config.deviceId === undefined) {
    // Not a state anything here writes: a pairing is saved with its id and
    // token from the moment it starts. Rule 2: a file that cannot be read as a
    // pairing is not an unpaired vault, and treating it as one would pair over
    // it and throw away whatever it was holding.
    throw new Error(
      `${where} holds no device id, so there is nothing in it to connect with or to finish`,
    );
  }
  if (config.invite !== undefined && config.deviceToken === undefined) {
    throw new Error(
      `${where} holds a pairing in progress with no device token, so it cannot be finished`,
    );
  }
  return config;
}

/** The device id: absent, or base64url within the server's bound. */
function deviceId(record: Record<string, unknown>, where: string): { deviceId?: string } {
  const value = record["deviceId"];
  if (value === undefined || value === null) return {};
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new Error(
      `${where} holds a deviceId that is not base64url of at most 64 characters, ` +
        `which is not an id any server would answer to`,
    );
  }
  return { deviceId: value };
}

/**
 * One stored token: absent, or unpadded base64url of exactly the length it
 * must be.
 *
 * Length-checked rather than merely decoded, because the server refuses a
 * device token of any other length at every hello, and an invite token of any
 * other length redeems nothing; either would be a pairing that looks finished
 * and fails for ever.
 */
function token(
  record: Record<string, unknown>,
  field: string,
  length: number,
  what: string,
  where: string,
): Record<string, string> {
  const value = record[field];
  if (value === undefined || value === null) return {};
  if (typeof value !== "string" || value === "") {
    throw new Error(`${where} holds a ${field} that is not a string`);
  }
  let bytes: Uint8Array;
  try {
    bytes = base64urlDecode(value);
  } catch (err) {
    throw new Error(`${where} holds a ${field} that is not base64url: ${(err as Error).message}`);
  }
  if (bytes.length !== length) {
    throw new Error(
      `${where} holds a ${bytes.length} byte ${field}, and ${what} is ${length} bytes`,
    );
  }
  return { [field]: value };
}

/**
 * Reads an invite a person pasted, refusing anything it cannot read completely.
 *
 * `parseInviteString` is the codec, shared with the Go server through
 * `protocol-fixtures.json`. This adds the one thing a person needs that the
 * codec cannot know: a string from Basalt, the project TrewSync was forked from,
 * named as such, since its recovery keys and invites look like these and open
 * nothing here.
 */
export function parseInvite(input: string): InviteString {
  const text = input.trim();
  if (text.startsWith("basalt3_") || text.startsWith("basalt3i_")) {
    throw new Error(
      "that is a Basalt string, and TrewSync does not read them. Pair with a trew1i_ invite: " +
        "trewd invite on the server makes one, and so does a paired device's panel.",
    );
  }
  return parseInviteString(input);
}

/**
 * Where a pasted invite would connect this device.
 *
 * An invite carries a server address, and until this existed the panel showed
 * none: a person pressed Pair on a string of base64 and found out where their
 * vault had gone by watching it upload (R083-05). An invite that arrived
 * through `obsidian://trew?invite=...` is worse again, because it can be sent
 * by anybody who can get a link in front of somebody, and the panel filled the
 * field in for them.
 *
 * Throws for anything it cannot read, with the message that says why, so a
 * caller can put the reason on screen and leave the button disabled: no
 * address on screen, nothing to press.
 */
export function joinDestination(input: string): { url: string; vaultId: string } {
  const invite = parseInvite(input);
  return { url: invite.url, vaultId: invite.vault };
}

/**
 * Accepts what a person is likely to type as a server address.
 *
 * `http` and `https` because that is what somebody copies out of a browser, and
 * a bare host because that is what somebody types. A bare host gets TLS, because
 * TLS is terminated in front of the server and the plain case is the one worth
 * being explicit about.
 *
 * Here rather than in a shell because both shells need it, and they had a
 * byte-identical copy each. That is the thing `core` exists to prevent: two
 * copies of a rule are two rules, and only one of them had a test.
 */
export function normaliseUrl(input: string): string {
  const text = input.trim().replace(/\/+$/, "");
  if (text === "") throw new Error("that is not a server address");
  let url: string;
  if (text.startsWith("ws://") || text.startsWith("wss://")) url = text;
  else if (text.startsWith("http://")) url = "ws://" + text.slice("http://".length);
  else if (text.startsWith("https://")) url = "wss://" + text.slice("https://".length);
  else if (text.includes("://"))
    throw new Error(`a server address is ws:// or wss://, not ${text.split("://")[0]}://`);
  else url = "wss://" + text;
  return asciiHost(url);
}

/**
 * Puts an internationalised hostname into the form the wire carries.
 *
 * A hostname with characters outside ASCII is legal to type and illegal on
 * the wire; every WebSocket implementation converts it to punycode before
 * connecting, and the server logs and compares what it was sent. An invite is
 * copied between devices as text, so it has to carry the form every device
 * agrees on, and the invite codec takes printable ASCII only. The URL parser
 * does the conversion (IDNA, to `xn--`), the same one the socket would apply,
 * and does it here so the stored address and the connected address are one
 * string. A host the parser cannot make sense of is refused as not an address.
 */
function asciiHost(url: string): string {
  // Cheap path, and the common one: nothing to convert.
  if (/^[\x21-\x7e]*$/.test(url)) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${url} is not a server address this device can connect to`);
  }
  if (!/^[\x21-\x7e]*$/.test(parsed.hostname)) {
    throw new Error(
      `the hostname in ${url} has characters outside ASCII that cannot be converted; ` +
        `give it in punycode (xn--...) instead`,
    );
  }
  // Rebuilt from the parts rather than from `href`, which appends a slash
  // to a bare host and would make the same address two different strings.
  const port = parsed.port === "" ? "" : `:${parsed.port}`;
  const path = parsed.pathname === "/" ? "" : parsed.pathname;
  return `${parsed.protocol}//${parsed.hostname}${port}${path}${parsed.search}`;
}
