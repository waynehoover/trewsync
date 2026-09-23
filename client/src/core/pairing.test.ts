/**
 * The invite a device pairs from, and the configuration it keeps afterwards.
 *
 * The codec cases were written against Basalt's two strings, the recovery key
 * and its invite, and every property they pinned carries over to the one
 * string left, `trew1i_` (plan/protocol.md, "The invite string"): a version
 * byte, a fixed-length token, length-prefixed fields, a CRC-32, strict
 * base64url. `contract.test.ts` holds the codec to the vectors the reference
 * wrote; these are the ways a person's copy and paste goes wrong, one by one.
 *
 * The configuration is what a paired device stores: its id and its 32-byte
 * token and nothing else that authenticates, or, while an invite is being
 * redeemed, the pending pairing that holds both beside the invite token.
 */

import { describe, expect, it } from "vitest";

import { base64urlDecode, base64urlEncode, randomBytes } from "./digest.ts";
import {
  INVITE_PREFIX,
  INVITE_TOKEN_BYTES as CODEC_INVITE_TOKEN_BYTES,
  formatInviteString,
  parseInviteString,
  type InviteString,
} from "./invite-string.ts";
import {
  DEVICE_ID_BYTES,
  DEVICE_TOKEN_BYTES,
  INVITE_TOKEN_BYTES,
  NoCredential,
  decodeConfig,
  deviceCredential,
  encodeConfig,
  finishedPairing,
  generateDeviceId,
  generateDeviceToken,
  isIgnorableName,
  isPendingPairing,
  joinDestination,
  normaliseUrl,
  parseInvite,
  startPairing,
  type DeviceConfig,
} from "./pairing.ts";

const sample = (over: Partial<InviteString> = {}): InviteString => ({
  token: new Uint8Array(16).map((_, i) => (i * 37) & 0xff),
  url: "ws://laptop.tail1234.ts.net:8384",
  vault: "default",
  ...over,
});

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** The part of an invite after its prefix. */
const bodyOf = (s: string): string => s.slice(INVITE_PREFIX.length);

describe("round tripping", () => {
  it("gives back exactly what went in", () => {
    const inv = sample();
    const back = parseInvite(formatInviteString(inv));
    expect(back.url).toBe(inv.url);
    expect(back.vault).toBe(inv.vault);
    expect([...back.token]).toEqual([...inv.token]);
    // The shells' reader and the codec are one reading.
    expect(parseInviteString(formatInviteString(inv))).toEqual(back);
  });

  it("survives a real generated token, every time", () => {
    // The token is arbitrary bytes, including zeroes and 0xff, and a length
    // byte read as data or a data byte read as a length would only show up
    // for some of them.
    for (let i = 0; i < 200; i++) {
      const inv = sample({ token: randomBytes(16) });
      expect([...parseInvite(formatInviteString(inv)).token]).toEqual([...inv.token]);
    }
  });

  it("survives the whitespace a paste brings with it, and nothing else", () => {
    const s = formatInviteString(sample());
    expect(parseInvite(`  ${s}\n`).url).toBe(sample().url);
    expect(parseInvite(`\t${s}\r\n`).url).toBe(sample().url);
    // ASCII space, tab, CR and LF at the ends, and no other character: both
    // implementations must accept exactly the same strings.
    const nbsp = String.fromCharCode(0xa0);
    expect(() => parseInvite(`${nbsp}${s}`)).toThrow(/should start with trew1i_/);
    expect(() => parseInvite(`${s}${nbsp}`)).toThrow();
  });

  it("carries fields that are not ASCII", () => {
    const vault = `notes-caf${String.fromCodePoint(0xe9)}-${String.fromCodePoint(0x1f4d3)}`;
    expect(parseInvite(formatInviteString(sample({ vault }))).vault).toBe(vault);
  });

  it("is one word, so it survives being sent in a message", () => {
    expect(formatInviteString(sample())).toMatch(/^trew1i_[A-Za-z0-9_-]+$/);
  });

  it("carries its own prefix", () => {
    expect(INVITE_PREFIX).toBe("trew1i_");
    expect(formatInviteString(sample()).startsWith(INVITE_PREFIX)).toBe(true);
  });

  /**
   * One length for the one fixed field. A token of any other length is a bug
   * upstream, and is refused here rather than encoded into a string that would
   * then be read back as something else.
   */
  it("carries a 16-byte token, and refuses any other length", () => {
    const fresh = sample({ token: randomBytes(16) });
    expect([...parseInvite(formatInviteString(fresh)).token]).toEqual([...fresh.token]);
    expect(() => formatInviteString(sample({ token: new Uint8Array(20).fill(7) }))).toThrow(
      /an invite token is 16 bytes, not 20/,
    );
  });
});

/**
 * Every one of these has to be an error rather than a partial result.
 *
 * An invite that half-parses is a device configured with a truncated token, or
 * pointed at a server or a vault it was never meant for. The token redeems
 * nothing and the device reports that it could not join, which is at least
 * visible; an address read one byte off is a device that uploads to wherever
 * that turns out to be.
 */
describe("refusing a string it cannot read completely", () => {
  it("refuses something that is not an invite at all", () => {
    expect(() => parseInvite("hello")).toThrow(/should start with trew1i_/);
    expect(() => parseInvite("")).toThrow(/should start with trew1i_/);
  });

  /**
   * Trew was forked from Basalt, whose recovery keys and invites look like
   * these and open nothing here. A person migrating will paste one, and the
   * answer they need is what it is and what to paste instead.
   */
  it("names a pasted Basalt string as Basalt's, and says what to pair with", () => {
    for (const basalt of ["basalt3_AAAAAAAA", "basalt3i_AAAAAAAA", "  basalt3i_AAAAAAAA\n"]) {
      expect(() => parseInvite(basalt), basalt).toThrow(/Basalt string/);
      expect(() => parseInvite(basalt), basalt).toThrow(/trew1i_ invite/);
      expect(() => joinDestination(basalt), basalt).toThrow(/Basalt string/);
    }
  });

  /**
   * The decoder used to accept a trailing character that produced no byte, and
   * unused low bits that were flipped. Both leave the decoded body, and so the
   * CRC, exactly as they were, so a damaged string read as the real one: total
   * failure was the contract and this was the hole in it.
   */
  it("refuses an invite with one character appended", () => {
    const base = wholeBytes();
    // A body that is a whole number of triples encodes to a length divisible
    // by four, which is where a spare character adds no byte at all.
    expect(bodyOf(base).length % 4, "setup").toBe(0);
    for (const extra of ["A", "Q", "-"]) {
      expect(() => parseInvite(base + extra), `+ ${extra}`).toThrow(/one more than a whole number/);
    }
  });

  it("refuses an invite whose unused final bits were flipped", () => {
    for (const base of [partialBytes(2), partialBytes(3)]) {
      const body = bodyOf(base);
      expect(body.length % 4, "setup").not.toBe(0);
      const unused = body.length % 4 === 2 ? 4 : 2;
      const last = ALPHABET.indexOf(body[body.length - 1]!);
      for (let flip = 1; flip < 1 << unused; flip++) {
        const damaged = base.slice(0, base.length - 1) + ALPHABET[last ^ flip]!;
        expect(() => parseInvite(damaged), damaged).toThrow(/bits that no byte uses/);
      }
    }
  });

  it("refuses one that lost its end", () => {
    const s = formatInviteString(sample());
    for (const cut of [1, 4, 12, 40]) {
      expect(() => parseInvite(s.slice(0, s.length - cut)), `cut ${cut}`).toThrow();
    }
  });

  it("refuses one with a character changed", () => {
    // The case the checksum exists for. Without it a flipped character inside
    // the token parses cleanly and is simply a token that redeems nothing, and
    // one inside the address is a device pointed somewhere else.
    const s = formatInviteString(sample());
    let caught = 0;
    for (let i = INVITE_PREFIX.length; i < s.length; i++) {
      const ch = s[i] === "A" ? "B" : "A";
      try {
        parseInvite(s.slice(0, i) + ch + s.slice(i + 1));
      } catch {
        caught++;
      }
    }
    const changeable = s.length - INVITE_PREFIX.length;
    expect(caught, `${caught} of ${changeable} single-character changes refused`).toBe(changeable);
  });

  it("refuses two characters swapped", () => {
    // Transposition is the classic typing error, and the reason this is a CRC
    // rather than a sum of bytes, which would not notice.
    const s = formatInviteString(sample());
    let checked = 0;
    for (let i = INVITE_PREFIX.length; i + 1 < s.length; i++) {
      if (s[i] === s[i + 1]) continue;
      const bad = s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2);
      expect(() => parseInvite(bad), `swap at ${i}`).toThrow();
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
  });

  it("refuses a version it does not understand", () => {
    for (const version of [0, 2, 4, 9]) {
      const raw = base64urlDecode(bodyOf(formatInviteString(sample())));
      raw[0] = version;
      // Recompute the checksum, so it is the version that is refused rather
      // than the damage.
      expect(() => parseInvite(INVITE_PREFIX + base64urlEncode(reChecksum(raw)))).toThrow(
        new RegExp(`version ${version}\\b`),
      );
    }
  });

  it("refuses a length that points past the end", () => {
    const raw = base64urlDecode(bodyOf(formatInviteString(sample())));
    raw[1 + 16] = 200; // the address's length byte
    expect(() => parseInvite(INVITE_PREFIX + base64urlEncode(reChecksum(raw)))).toThrow(
      /ends inside/,
    );
  });

  it("refuses trailing rubbish that decoded cleanly", () => {
    const raw = base64urlDecode(bodyOf(formatInviteString(sample())));
    const longer = new Uint8Array(raw.length + 3);
    longer.set(raw.subarray(0, raw.length - 4), 0);
    expect(() => parseInvite(INVITE_PREFIX + base64urlEncode(reChecksum(longer)))).toThrow(
      /more in it/,
    );
  });
});

describe("refusing to make a string it could not read back", () => {
  it("refuses a token of the wrong length", () => {
    for (const n of [0, 8, 15, 17, 32, 64]) {
      expect(() => formatInviteString(sample({ token: new Uint8Array(n) })), `${n}`).toThrow(
        new RegExp(`is 16 bytes, not ${n}\\b`),
      );
    }
  });

  it("refuses a field too long for its length byte", () => {
    const at255 = "ws://" + "h".repeat(250);
    expect(at255).toHaveLength(255);
    expect(parseInvite(formatInviteString(sample({ url: at255 }))).url).toBe(at255);
    expect(() => formatInviteString(sample({ url: at255 + "h" }))).toThrow(/not in canonical form/);
  });

  /**
   * Encoders write the one canonical form and decoders refuse any other,
   * rather than normalising, so both implementations accept exactly the same
   * strings (plan/protocol.md). A shell normalises what a person typed with
   * `normaliseUrl` before anything is formatted.
   */
  it("refuses an address or a vault name that is not in the one form both sides read", () => {
    for (const url of [
      "http://host:3003",
      "host:3003",
      "ws://",
      "wss://host/",
      `wss://b${String.fromCodePoint(0xfc)}cher.example`,
      "wss://ho st",
    ]) {
      expect(() => formatInviteString(sample({ url })), url).toThrow(/server address/);
    }
    for (const vault of ["", "v".repeat(65), "a\tb", "a\u007fb"]) {
      expect(() => formatInviteString(sample({ vault })), JSON.stringify(vault)).toThrow(
        /vault name/,
      );
    }
    expect(parseInvite(formatInviteString(sample({ vault: "v".repeat(64) }))).vault).toBe(
      "v".repeat(64),
    );
  });
});

/**
 * review finding I6. A hostname is bounded by the length byte and has to be
 * ASCII on the wire. An internationalised one is converted the way every
 * socket would convert it before connecting, so the stored address and the
 * connected address are one string on every device; a host that cannot be
 * converted is refused rather than guessed at.
 */
describe("server addresses that are long or not ASCII", () => {
  it("refuses an address too long to carry", () => {
    const long = "wss://" + "h".repeat(250) + ".example:3003";
    expect(() => formatInviteString(sample({ url: long }))).toThrow(/not in canonical form/);
  });

  it("converts an internationalised hostname to punycode, once, on the way in", () => {
    const converted = normaliseUrl(`wss://b${String.fromCodePoint(0xfc)}cher.example:3003`);
    expect(converted).toBe("wss://xn--bcher-kva.example:3003");
    // Round trip through an invite, unchanged.
    expect(parseInvite(formatInviteString(sample({ url: converted }))).url).toBe(converted);
    // And an address that was already ASCII is left exactly as it was.
    expect(normaliseUrl("wss://homelab.tailnet.ts.net")).toBe("wss://homelab.tailnet.ts.net");
    expect(normaliseUrl("ws://127.0.0.1:3003")).toBe("ws://127.0.0.1:3003");
  });

  it("refuses a hostname that cannot be made into an address", () => {
    expect(() => normaliseUrl("wss://exa mple.com")).toThrow(/not a server address/);
  });
});

/**
 * An invite and a pairing string both answer "where would this device go", and
 * until this existed the panel showed nothing: a person pressed Pair on a
 * string of base64 and found out where their vault had gone by watching it
 * upload (R083-05). Nothing is pressable until this answers.
 */
describe("where a pasted invite points", () => {
  it("names the vault and the server a pasted invite would join", () => {
    expect(joinDestination(formatInviteString(sample()))).toEqual({
      url: sample().url,
      vaultId: sample().vault,
    });
    expect(joinDestination(`  ${formatInviteString(sample({ vault: "work" }))}\n`)).toEqual({
      url: sample().url,
      vaultId: "work",
    });
    // And it refuses in the shape of the field it was typed into, so the
    // reason on screen tells somebody what they should have pasted.
    expect(() => joinDestination("not an invite at all")).toThrow(/should start with trew1i_/);
  });
});

/** A finished device, as the shells store it, to break one field at a time. */
const paired = (): DeviceConfig => ({
  url: "wss://homelab.example.ts.net",
  vaultId: "default",
  device: "phone",
  deviceId: "aaaaaaaaaaaaaaaaaaaaaa",
  deviceToken: base64urlEncode(new Uint8Array(32).fill(4)),
});

describe("the names a device is told to skip", () => {
  it("survives a round trip through the stored config", () => {
    // Per device, and it goes nowhere near the server (R083-13): a phone
    // leaves a media folder alone while the desktop keeps it.
    const config = { ...paired(), ignore: ["Attachments", "Scratch"] };
    expect(decodeConfig(encodeConfig(config), "data.json").ignore).toEqual([
      "Attachments",
      "Scratch",
    ]);
  });

  it("is absent from a config that skips nothing", () => {
    // Byte for byte what a build without the field wrote, so a build without
    // it reading this back sees exactly what it wrote.
    expect(encodeConfig(paired())["ignore"]).toBeUndefined();
    expect(encodeConfig({ ...paired(), ignore: [] })["ignore"]).toBeUndefined();
    expect(decodeConfig(encodeConfig(paired()), "data.json").ignore).toBeUndefined();
  });

  it("drops a name it cannot use rather than refusing the file", () => {
    // Rule 2: this config also holds the only copy of this device's token, so
    // a preference somebody hand-edited into nonsense must not make it
    // unreadable. A dropped name syncs a folder that was meant to be skipped,
    // which is visible and fixable; a config that will not open is not.
    const record = { ...encodeConfig(paired()), ignore: '["ok","a/b","",".",".."]' };
    expect(decodeConfig(record, "data.json").ignore).toEqual(["ok"]);
    expect(
      decodeConfig({ ...encodeConfig(paired()), ignore: "not json" }, "data.json").ignore,
    ).toBeUndefined();
    expect(
      decodeConfig({ ...encodeConfig(paired()), ignore: '"a string"' }, "data.json").ignore,
    ).toBeUndefined();
  });

  it("accepts one name and no path", () => {
    // `isNeverSynced` matches a name against each segment of a path, so a
    // value with a slash in it would match nothing and quietly sync the folder
    // somebody asked it to skip.
    expect(isIgnorableName("Attachments")).toBe(true);
    expect(isIgnorableName("a b.md")).toBe(true);
    for (const bad of ["", ".", "..", "a/b", "/"]) {
      expect(isIgnorableName(bad), bad).toBe(false);
    }
  });
});

/**
 * What a config that is not a device gets told, which is the last thing
 * standing between somebody and a vault they cannot sync.
 *
 * Rule 2: a failed read is not an empty result, and a config that cannot
 * connect is not an unpaired vault to be quietly paired over. So an incomplete
 * config still decodes, and the refusal comes at the moment something tries to
 * connect with it, saying what is missing and what to do.
 */
describe("a config that cannot connect", () => {
  const base = { url: "wss://homelab:3003", vaultId: "default", device: "laptop" };

  it("says to pair again when there is a device id and no token", () => {
    let thrown: unknown;
    try {
      deviceCredential({ ...base, deviceId: "abcd" });
    } catch (err) {
      thrown = err;
    }
    // Its own class, so a shell can tell "nothing to connect with" from "the
    // server said no": trew status reports the first as neither reachable nor
    // refused.
    expect(thrown).toBeInstanceOf(NoCredential);
    const message = (thrown as Error).message;
    // Names what is missing rather than saying "not authorised", which is the
    // wording that sent somebody looking for a server problem.
    expect(message).toMatch(/missing a device token/);
    expect(message).toMatch(/Pair this vault again with an invite/);
    expect(message).toMatch(/trew invite on\s+the server/);
    expect(message).not.toMatch(/authoris/i);
    // And both halves, when both are missing.
    expect(() => deviceCredential({ ...base })).toThrow(/missing a device id and a device token/);
  });

  it("still decodes a config it will refuse, because refusing to read it is another state", () => {
    const back = decodeConfig(encodeConfig({ ...base, deviceId: "abcd" }), "test");
    expect(back.deviceId).toBe("abcd");
    expect(back.deviceToken).toBeUndefined();
    expect(() => deviceCredential(back)).toThrow(NoCredential);
    // A config with nothing to connect with or to finish is not one anything
    // here writes, and it is refused as unreadable rather than read as unpaired.
    expect(() => decodeConfig({ ...base, deviceToken: paired().deviceToken }, "data.json")).toThrow(
      /data\.json holds no device id/,
    );
  });

  it("keeps nothing a device is not meant to hold", () => {
    // A paired device stores its own row id and its own token, and there is no
    // field left for a root, a data key, a first-run token or a wrapping. An
    // old config holding one is read for what it has and the extra is dropped.
    const stored = encodeConfig(paired());
    expect(Object.keys(stored).sort()).toEqual([
      "device",
      "deviceId",
      "deviceToken",
      "url",
      "vaultId",
    ]);
    const everything = encodeConfig({ ...paired(), readOnly: true, ignore: ["Scratch"] });
    expect(Object.keys(everything).sort()).toEqual([
      "device",
      "deviceId",
      "deviceToken",
      "ignore",
      "readOnly",
      "url",
      "vaultId",
    ]);
    const old = decodeConfig(
      {
        ...stored,
        secret: "AAAA",
        dataKey: "BBBB",
        deviceSecret: "CCCC",
        bootstrap: "TOKEN",
        wrapped: "WRAP",
      },
      "test",
    );
    expect(Object.keys(old).sort()).toEqual([
      "device",
      "deviceId",
      "deviceToken",
      "url",
      "vaultId",
    ]);
    expect(old).toEqual(paired());
  });

  it("refuses a device token that is not 32 bytes, rather than one the server always refuses", () => {
    for (const n of [0, 16, 31, 33, 64]) {
      const record = { ...encodeConfig(paired()), deviceToken: base64urlEncode(new Uint8Array(n)) };
      if (n === 0) {
        // An empty string is no token written, which is its own refusal.
        expect(() => decodeConfig(record, "data.json")).toThrow(/deviceToken that is not a string/);
        continue;
      }
      expect(() => decodeConfig(record, "data.json"), `${n}`).toThrow(
        new RegExp(`data\\.json holds a ${n} byte deviceToken, and a device token is 32 bytes`),
      );
    }
    expect(() =>
      decodeConfig({ ...encodeConfig(paired()), deviceToken: "not base64url!" }, "data.json"),
    ).toThrow(/deviceToken that is not base64url/);
    expect(() =>
      decodeConfig({ ...encodeConfig(paired()), deviceId: "-".repeat(65) }, "data.json"),
    ).toThrow(/deviceId that is not base64url of at most 64 characters/);
  });

  it("turns read-only on for the one value it writes, and for nothing else", () => {
    // I29: a device silently refusing to send would look exactly like one
    // with nothing to send, so only the exact string written means read-only.
    expect(decodeConfig(encodeConfig({ ...paired(), readOnly: true }), "t").readOnly).toBe(true);
    for (const value of ["yes", "1", "TRUE", true]) {
      expect(decodeConfig({ ...encodeConfig(paired()), readOnly: value }, "t").readOnly).toBe(
        undefined,
      );
    }
    expect(encodeConfig({ ...paired(), readOnly: false })["readOnly"]).toBeUndefined();
  });
});

/**
 * A pairing started and not finished (plan/protocol.md, "Invite redemption"):
 * the ids and the invite, saved before the redemption goes, so a reply lost
 * after the server committed leaves exactly the credential it registered.
 */
describe("a pairing in progress", () => {
  it("starts from an invite with fresh ids, and says where it is going", () => {
    const invite = sample();
    const pending = startPairing(invite, "phone");
    expect(isPendingPairing(pending)).toBe(true);
    expect(pending.url).toBe(invite.url);
    expect(pending.vaultId).toBe(invite.vault);
    expect(pending.device).toBe("phone");
    expect([...base64urlDecode(pending.invite)]).toEqual([...invite.token]);
    expect(base64urlDecode(pending.deviceId)).toHaveLength(DEVICE_ID_BYTES);
    expect(base64urlDecode(pending.deviceToken)).toHaveLength(DEVICE_TOKEN_BYTES);
    expect("readOnly" in pending || "ignore" in pending, "options nobody asked for").toBe(false);
    // Fresh every time: two devices pairing from two invites never share a
    // row, and a retried start is a new pairing, not the old one.
    const again = startPairing(invite, "phone");
    expect(again.deviceId).not.toBe(pending.deviceId);
    expect(again.deviceToken).not.toBe(pending.deviceToken);
    const options = startPairing(invite, "mirror", { readOnly: true, ignore: ["Scratch"] });
    expect(options.readOnly).toBe(true);
    expect(options.ignore).toEqual(["Scratch"]);
  });

  it("finishes into a device that holds no invite", () => {
    const pending = startPairing(sample(), "mirror", { readOnly: true, ignore: ["Scratch"] });
    const device = finishedPairing(pending);
    expect(isPendingPairing(device)).toBe(false);
    expect("invite" in device, "a finished device kept the invite token").toBe(false);
    expect(device).toEqual({
      url: pending.url,
      vaultId: pending.vaultId,
      device: "mirror",
      deviceId: pending.deviceId,
      deviceToken: pending.deviceToken,
      readOnly: true,
      ignore: ["Scratch"],
    });
    expect(encodeConfig(device)["invite"]).toBeUndefined();
    expect(deviceCredential(device)).toEqual({
      deviceId: pending.deviceId,
      deviceToken: pending.deviceToken,
    });
  });

  it("survives the disk as a pairing in progress, and is not taken for a device", () => {
    const pending = startPairing(sample(), "phone");
    const stored = encodeConfig(pending);
    expect(stored["invite"]).toBe(pending.invite);
    const back = decodeConfig(JSON.parse(JSON.stringify(stored)), "data.json");
    expect(isPendingPairing(back)).toBe(true);
    expect(back).toEqual(pending);
    // It has a credential, and whether the server registered it is exactly
    // what is not yet known, so nothing connects with it as a device.
    expect(() => deviceCredential(back)).toThrow(NoCredential);
    expect(() => deviceCredential(back)).toThrow(/pairing has not finished/);
  });

  it("refuses a stored pairing it could not finish", () => {
    const stored = encodeConfig(startPairing(sample(), "phone"));
    expect(() =>
      decodeConfig({ ...stored, invite: base64urlEncode(new Uint8Array(8)) }, "data.json"),
    ).toThrow(/data\.json holds a 8 byte invite, and an invite token is 16 bytes/);
    const { deviceToken: _token, ...noToken } = stored;
    expect(() => decodeConfig(noToken, "data.json")).toThrow(/in progress with no device token/);
  });
});

/**
 * No id this project mints begins with `-`.
 *
 * Base64url's alphabet includes it, and a word beginning with one is a word a
 * command line reads as an option: `trew revoke -Xy...` was refused with "no
 * such option" rather than revoking anything.
 *
 * Five thousand, because "never" over a random generator is not a thing one
 * sample can show. Without the rule this fails with certainty for every
 * practical purpose; with it, it cannot fail at all.
 */
describe("ids somebody has to type", () => {
  const many = 5000;

  it("never mints a device id that a shell reads as an option", () => {
    const bad: string[] = [];
    for (let n = 0; n < many; n++) {
      const id = generateDeviceId();
      if (id.startsWith("-")) bad.push(id);
    }
    expect(bad, `${bad.length} of ${many} device ids began with a dash`).toEqual([]);
    // And the rule costs a retry, not a byte.
    expect(base64urlDecode(generateDeviceId())).toHaveLength(DEVICE_ID_BYTES);
  });

  it("keeps the invite token the length the wire format requires", () => {
    expect(INVITE_TOKEN_BYTES).toBe(16);
    expect(INVITE_TOKEN_BYTES).toBe(CODEC_INVITE_TOKEN_BYTES);
    expect(base64urlDecode(startPairing(sample(), "d").invite)).toHaveLength(INVITE_TOKEN_BYTES);
  });
});

/**
 * The credential a device connects with (plan/protocol.md, "Device session"):
 * 32 random bytes, unpadded base64url, which the server decodes and refuses at
 * any other length. It replaces the device secret Basalt derived an auth key
 * from, and it has to be as unguessable and as wire-safe as that key was.
 */
describe("the device token", () => {
  it("is 32 random bytes, in wire-safe base64url", () => {
    const token = generateDeviceToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(base64urlDecode(token)).toHaveLength(DEVICE_TOKEN_BYTES);
    expect(DEVICE_TOKEN_BYTES).toBe(32);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generateDeviceToken());
    expect(seen.size, "two device tokens agreed").toBe(200);
    // And one a stored config accepts, which is the same length check.
    expect(decodeConfig({ ...encodeConfig(paired()), deviceToken: token }, "t").deviceToken).toBe(
      token,
    );
  });
});

/** Rewrites the trailing checksum over whatever the body now says. */
function reChecksum(raw: Uint8Array): Uint8Array {
  const body = raw.subarray(0, raw.length - 4);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const out = raw.slice();
  out.set(
    [(crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff],
    raw.length - 4,
  );
  return out;
}

/**
 * An invite whose body is a whole number of three-byte groups, so its
 * base64url is divisible by four and a spare character adds no byte. The vault
 * name is grown until the arithmetic lands there, because which length does it
 * depends on the address, and a test that hard-coded one would silently stop
 * testing the case.
 */
function wholeBytes(): string {
  return untilLength(0);
}

/** The same, sized so the last character carries bits nothing reads. */
function partialBytes(want: 2 | 3): string {
  return untilLength(want);
}

function untilLength(want: number): string {
  for (let n = 1; n <= 4; n++) {
    const s = formatInviteString(sample({ vault: "v".repeat(n) }));
    if (bodyOf(s).length % 4 === want) return s;
  }
  throw new Error(`no vault name of one to four characters gives a body of length %4 == ${want}`);
}
