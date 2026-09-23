// Package invite is the protocol 1 invite string: what one device, or the
// server, hands the next device so it can join the vault.
//
// The layout (plan/protocol.md, "The invite string"):
//
//	Prefix || base64url(body || crc32)
//	body = version (1 byte, 1) || token (16 bytes)
//	       || len(url) (1 byte) || url || len(vault) (1 byte) || vault
//
// base64url is unpadded and canonical, crc32 is IEEE CRC-32 over body in big
// endian, and nothing may follow the vault. The checksum catches a bad paste;
// it is not a defence against anybody, which the token is.
//
// The server needs Format, for `trew invite`; Parse is here so the Go side
// consumes the same fixtures the TypeScript decoder does (PLAN.md M0.5).
package invite

import (
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"strings"
	"unicode/utf8"
)

// Prefix begins every invite string. Derived from the product name, which is
// not final (PLAN.md section 10).
const Prefix = "trew1i_"

// Version is the layout version the body starts with.
const Version = 1

// TokenBytes is the length of the redemption token an invite carries.
const TokenBytes = 16

// MaxNameBytes is the longest vault name, as everywhere else on the wire.
const MaxNameBytes = 64

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

// Invite is what an invite string says.
type Invite struct {
	Token []byte
	URL   string
	Vault string
}

// ErrDamaged is wrapped by every refusal Parse makes.
var ErrDamaged = errors.New("invite")

// Format renders an invite as the string a person copies.
func Format(inv Invite) (string, error) {
	if len(inv.Token) != TokenBytes {
		return "", fmt.Errorf("an invite token is %d bytes, not %d", TokenBytes, len(inv.Token))
	}
	if err := checkURL(inv.URL); err != nil {
		return "", err
	}
	if err := checkVault(inv.Vault); err != nil {
		return "", err
	}
	body := make([]byte, 0, 1+TokenBytes+2+len(inv.URL)+len(inv.Vault)+4)
	body = append(body, Version)
	body = append(body, inv.Token...)
	body = append(body, byte(len(inv.URL)))
	body = append(body, inv.URL...)
	body = append(body, byte(len(inv.Vault)))
	body = append(body, inv.Vault...)
	body = binary.BigEndian.AppendUint32(body, crc32.ChecksumIEEE(body))
	return Prefix + base64.RawURLEncoding.EncodeToString(body), nil
}

// Parse reads an invite string, refusing anything it cannot read completely.
// Surrounding ASCII space, tab, CR and LF are trimmed, and nothing else.
func Parse(s string) (Invite, error) {
	s = strings.Trim(s, " \t\r\n")
	if !strings.HasPrefix(s, Prefix) {
		return Invite{}, fmt.Errorf("%w: it does not start with %s", ErrDamaged, Prefix)
	}
	encoded := s[len(Prefix):]
	// Checked before decoding: Go's base64 decoder skips CR and LF inside
	// its input, so a string the TypeScript decoder refuses would otherwise
	// parse here.
	for i := 0; i < len(encoded); i++ {
		if strings.IndexByte(alphabet, encoded[i]) < 0 {
			return Invite{}, fmt.Errorf("%w: a character outside base64url at %d", ErrDamaged, i)
		}
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	if err != nil {
		return Invite{}, fmt.Errorf("%w: %v", ErrDamaged, err)
	}
	if len(raw) < 1+TokenBytes+2+4 {
		return Invite{}, fmt.Errorf("%w: too short to be complete", ErrDamaged)
	}
	body, sum := raw[:len(raw)-4], raw[len(raw)-4:]
	if crc32.ChecksumIEEE(body) != binary.BigEndian.Uint32(sum) {
		return Invite{}, fmt.Errorf("%w: it did not survive being copied", ErrDamaged)
	}
	if body[0] != Version {
		return Invite{}, fmt.Errorf("%w: version %d, and this server understands %d", ErrDamaged, body[0], Version)
	}
	at := 1 + TokenBytes
	var fields [2]string
	for i, what := range []string{"server address", "vault name"} {
		if at >= len(body) {
			return Invite{}, fmt.Errorf("%w: it ends before its %s", ErrDamaged, what)
		}
		n := int(body[at])
		at++
		if at+n > len(body) {
			return Invite{}, fmt.Errorf("%w: it ends inside its %s", ErrDamaged, what)
		}
		fields[i] = string(body[at : at+n])
		at += n
	}
	if at != len(body) {
		return Invite{}, fmt.Errorf("%w: it has more in it than it should", ErrDamaged)
	}
	inv := Invite{Token: append([]byte(nil), body[1:1+TokenBytes]...), URL: fields[0], Vault: fields[1]}
	if err := checkURL(inv.URL); err != nil {
		return Invite{}, fmt.Errorf("%w: %v", ErrDamaged, err)
	}
	if err := checkVault(inv.Vault); err != nil {
		return Invite{}, fmt.Errorf("%w: %v", ErrDamaged, err)
	}
	return inv, nil
}

// checkURL enforces the canonical form: ws:// or wss://, printable ASCII, no
// trailing slash. Canonical rather than lenient, so both implementations can
// agree on exactly which strings are addresses.
func checkURL(u string) error {
	rest, ok := strings.CutPrefix(u, "wss://")
	if !ok {
		rest, ok = strings.CutPrefix(u, "ws://")
	}
	if !ok || rest == "" {
		return fmt.Errorf("the server address %q is not ws:// or wss://", u)
	}
	for i := 0; i < len(u); i++ {
		if u[i] < 0x21 || u[i] > 0x7e {
			return fmt.Errorf("the server address has a character outside printable ASCII")
		}
	}
	if strings.HasSuffix(u, "/") || len(u) > 255 {
		return fmt.Errorf("the server address %q is not in canonical form", u)
	}
	return nil
}

func checkVault(v string) error {
	if v == "" || len(v) > MaxNameBytes || !utf8.ValidString(v) {
		return fmt.Errorf("the vault name is empty, invalid, or over %d bytes", MaxNameBytes)
	}
	for i := 0; i < len(v); i++ {
		if v[i] < 0x20 || v[i] == 0x7f {
			return fmt.Errorf("the vault name has a control character")
		}
	}
	return nil
}
