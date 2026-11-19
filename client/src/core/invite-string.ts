/**
 * The protocol 1 invite string (plan/protocol.md, "The invite string"):
 *
 * ```text
 * PREFIX || base64url(body || crc32)
 * body = version (1 byte, 1) || token (16 bytes)
 *        || len(url) (1 byte) || url || len(vault) (1 byte) || vault
 * ```
 *
 * base64url is unpadded and canonical, crc32 is IEEE CRC-32 over the body in
 * big endian, and nothing may follow the vault. The checksum catches a bad
 * paste; the token is what makes an invite hard to guess. The Go half is
 * `internal/invite`, and both are checked against `protocol-fixtures.json`.
 */

import { crc32Bytes } from "./crc32.ts";
import { base64urlDecode, base64urlEncode } from "./digest.ts";

/** What every invite starts with. Derived from the product name, which is not final. */
export const INVITE_PREFIX = "trew1i_";
/** The layout version the body starts with. */
export const INVITE_VERSION = 1;
/** The length of the redemption token an invite carries. */
export const INVITE_TOKEN_BYTES = 16;
/** The longest vault name, as everywhere on the wire. */
export const MAX_VAULT_NAME_BYTES = 64;

/** What an invite string says. */
export interface InviteString {
  readonly token: Uint8Array;
  /** The server's WebSocket address, canonical: ws:// or wss://, no trailing slash. */
  readonly url: string;
  readonly vault: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

/**
 * The one shape of address an invite carries: `scheme://host[:port][/path]`.
 *
 * The host is a name of letters, digits, `.`, `-`, `_` and `~`, or an IPv6
 * literal in brackets; the path, if any, is RFC 3986 path characters other
 * than `@`. There is no userinfo, query, fragment or backslash, because each
 * lets the text a person reads name one host while a socket dials another:
 * `wss://sync.my-tailnet.ts.net@evil.example` connects to evil.example (the
 * security review's M3). `internal/invite` holds the same expression.
 */
const ADDRESS =
  /^wss?:\/\/([A-Za-z0-9._~-]+|\[[0-9A-Fa-f:.]+\])(?::([0-9]{1,5}))?(?:\/[A-Za-z0-9._~!$&'()*+,;=:%/-]*)?$/;

/** Refuses an address that is not in the one form both implementations accept. */
function checkUrl(url: string): void {
  const rest = url.startsWith("wss://")
    ? url.slice(6)
    : url.startsWith("ws://")
      ? url.slice(5)
      : undefined;
  if (rest === undefined || rest === "") {
    throw new Error(`the server address ${JSON.stringify(url)} is not ws:// or wss://`);
  }
  if (!/^[\x21-\x7e]+$/.test(url)) {
    throw new Error("the server address has a character outside printable ASCII");
  }
  if (url.endsWith("/") || url.length > 255) {
    throw new Error(`the server address ${JSON.stringify(url)} is not in canonical form`);
  }
  const m = ADDRESS.exec(url);
  if (m === null || (m[2] !== undefined && Number(m[2]) > 65535)) {
    throw new Error(
      `the server address ${JSON.stringify(url)} is not ws://host[:port][/path], with no ` +
        `user name, query or fragment`,
    );
  }
}

/**
 * The host and port an address connects to, for a person to check before
 * pairing. Only for an address the codec accepted, which has exactly one.
 */
export function addressHost(url: string): string {
  const m = ADDRESS.exec(url);
  if (m === null) throw new Error(`${url} is not an address an invite carries`);
  return m[2] === undefined ? m[1]! : `${m[1]!}:${m[2]}`;
}

/**
 * Whether an address sends notes in the clear over a network: `ws://` to
 * anything but this machine. Loopback is left out because nothing else can
 * see that hop, and `trewd serve -localhost` hands out exactly that.
 */
export function plaintextOverNetwork(url: string): boolean {
  if (!url.startsWith("ws://")) return false;
  const host = ADDRESS.exec(url)?.[1]?.toLowerCase() ?? "";
  return !/^(localhost|127(\.[0-9]{1,3}){3}|\[::1\])$/.test(host);
}

/** What a person is told before pairing with an address that has no TLS. */
export const PLAINTEXT_WARNING =
  "This address has no TLS: your notes and this device's credential would cross the " +
  "network in the clear.";

function checkVault(vault: string): void {
  const bytes = enc.encode(vault).length;
  // eslint-disable-next-line no-control-regex -- control characters are what this refuses
  if (vault === "" || bytes > MAX_VAULT_NAME_BYTES || /[\x00-\x1f\x7f]/.test(vault)) {
    throw new Error(
      `the vault name is empty, over ${MAX_VAULT_NAME_BYTES} bytes, or has a control character`,
    );
  }
}

/** Renders an invite as the string a person copies. */
export function formatInviteString(inv: InviteString): string {
  if (inv.token.length !== INVITE_TOKEN_BYTES) {
    throw new Error(`an invite token is ${INVITE_TOKEN_BYTES} bytes, not ${inv.token.length}`);
  }
  checkUrl(inv.url);
  checkVault(inv.vault);
  const url = enc.encode(inv.url);
  const vault = enc.encode(inv.vault);
  const body = new Uint8Array(1 + INVITE_TOKEN_BYTES + 1 + url.length + 1 + vault.length);
  let at = 0;
  body[at++] = INVITE_VERSION;
  body.set(inv.token, at);
  at += INVITE_TOKEN_BYTES;
  body[at++] = url.length;
  body.set(url, at);
  at += url.length;
  body[at++] = vault.length;
  body.set(vault, at);
  const out = new Uint8Array(body.length + 4);
  out.set(body, 0);
  out.set(crc32Bytes(body), body.length);
  return INVITE_PREFIX + base64urlEncode(out);
}

/**
 * Reads an invite string, refusing anything it cannot read completely.
 * Surrounding ASCII space, tab, CR and LF are trimmed, and nothing else.
 */
export function parseInviteString(input: string): InviteString {
  const text = input.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  if (!text.startsWith(INVITE_PREFIX)) {
    throw new Error(`not an invite: it should start with ${INVITE_PREFIX}`);
  }
  let raw: Uint8Array;
  try {
    raw = base64urlDecode(text.slice(INVITE_PREFIX.length));
  } catch (err) {
    throw new Error(`this invite is damaged: ${(err as Error).message}`, { cause: err });
  }
  if (raw.length < 1 + INVITE_TOKEN_BYTES + 2 + 4)
    throw new Error("this invite is too short to be complete");
  const body = raw.subarray(0, raw.length - 4);
  const want = crc32Bytes(body);
  for (let i = 0; i < 4; i++) {
    if (raw[body.length + i] !== want[i])
      throw new Error("this invite is damaged: it did not survive being copied");
  }
  if (body[0] !== INVITE_VERSION) {
    throw new Error(
      `this invite is version ${body[0]}, and this device understands ${INVITE_VERSION}`,
    );
  }
  let at = 1 + INVITE_TOKEN_BYTES;
  const fields: string[] = [];
  for (const what of ["server address", "vault name"]) {
    if (at >= body.length) throw new Error(`this invite ends before its ${what}`);
    const n = body[at++]!;
    if (at + n > body.length) throw new Error(`this invite ends inside its ${what}`);
    try {
      fields.push(dec.decode(body.subarray(at, at + n)));
    } catch {
      throw new Error(`this invite's ${what} is not UTF-8`);
    }
    at += n;
  }
  if (at !== body.length) throw new Error("this invite has more in it than it should");
  const [url, vault] = fields as [string, string];
  checkUrl(url);
  checkVault(vault);
  return { token: body.slice(1, 1 + INVITE_TOKEN_BYTES), url, vault };
}
