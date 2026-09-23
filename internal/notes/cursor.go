package notes

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"unicode/utf8"

	"github.com/waynehoover/trew/internal/paths"
)

// Continuation cursors are opaque to the agent and self-describing to the
// server: base64url of a small JSON object that names the options it was made
// for, the head the listing is pinned to, and where to resume.
//
//	list_notes:   {"q":sha256(options),"head":H,"path":base64url(path)}
//	search_notes: {"q":sha256(options),"head":H,"path":base64url(path),"line":L,"column":C}
//
// Two rules come from mcp-read.ts. The path travels as base64url of its UTF-8
// bytes rather than as a JSON string, because JSON escaping grew legal paths
// past the cursor's own length cap (a control character costs six bytes
// escaped); the server's path rules now refuse control characters, but the
// encoding costs nothing and keeps the cap honest. And the decoded path must
// be valid UTF-8, the rule Basalt enforced with a fatal decoder: a forged
// cursor cannot smuggle an encoded surrogate or a stray byte into a
// comparison.
//
// Decoding is strict in one step: a cursor is accepted only if encoding what
// it decodes to, under the caller's options, reproduces it exactly. So a
// cursor made for other options, with a different key order, an extra key,
// non-canonical base64 or a number written another way is invalid_cursor, and
// nothing the server did not produce is ever interpreted.

// MaxCursorLength is the longest cursor accepted, in characters. The spec's
// schema caps the parameter at text(8192), as Basalt did.
const MaxCursorLength = 8192

// Option is one query option a cursor binds. Value is a string, a bool, an
// int, an int64 or nil. The tool supplies every option that changes which
// rows a page holds, the store epoch and index generation included, and none
// that only changes how many (the page limit), so a caller can change its page
// size between pages as Basalt allowed.
type Option struct {
	Key   string
	Value any
}

// Fingerprint is the lowercase hex SHA-256 of the options serialised the way
// JavaScript's JSON.stringify serialises an object with these keys in this
// order, which is how Basalt fingerprinted its query objects.
func Fingerprint(options []Option) string {
	b := []byte{'{'}
	for i, o := range options {
		if i > 0 {
			b = append(b, ',')
		}
		b = appendJSString(b, o.Key)
		b = append(b, ':')
		b = appendJSValue(b, o.Value)
	}
	b = append(b, '}')
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func appendJSValue(b []byte, v any) []byte {
	switch v := v.(type) {
	case nil:
		return append(b, "null"...)
	case string:
		return appendJSString(b, v)
	case bool:
		return strconv.AppendBool(b, v)
	case int:
		return strconv.AppendInt(b, int64(v), 10)
	case int64:
		return strconv.AppendInt(b, v, 10)
	default:
		panic(fmt.Sprintf("notes: option value of type %T", v))
	}
}

// Position is where a search page stopped: after the match at Line and Column
// of Path. Line 0 is the file-name row; Line MaxSafeLine means the whole note
// was consumed, the marker Basalt used.
type Position struct {
	Path   string
	Line   int64
	Column int64
}

// MaxSafeLine is JavaScript's Number.MAX_SAFE_INTEGER, the line a search
// cursor names when it resumes after the whole of a note.
const MaxSafeLine = maxSafeInteger

// EncodeListCursor is the continuation for a list_notes page that ended at
// path, pinned to head.
func EncodeListCursor(options []Option, head int64, path string) string {
	b := []byte(`{"q":`)
	b = appendJSString(b, Fingerprint(options))
	b = append(b, `,"head":`...)
	b = strconv.AppendInt(b, head, 10)
	b = append(b, `,"path":`...)
	b = appendJSString(b, encodeCursorPath(path))
	b = append(b, '}')
	return base64.RawURLEncoding.EncodeToString(b)
}

// DecodeListCursor returns the head and path an EncodeListCursor value holds,
// or invalid_cursor if the value is anything else, including a cursor made
// for other options.
func DecodeListCursor(value string, options []Option) (head int64, path string, err error) {
	var c struct {
		Q    string `json:"q"`
		Head int64  `json:"head"`
		Path string `json:"path"`
	}
	if !decodeCursorJSON(value, &c) {
		return 0, "", invalidCursor()
	}
	path, ok := decodeCursorPath(c.Path)
	if !ok || c.Head < 0 || c.Head > maxSafeInteger || EncodeListCursor(options, c.Head, path) != value {
		return 0, "", invalidCursor()
	}
	return c.Head, path, nil
}

// EncodeSearchCursor is the continuation for a search_notes page that
// stopped at at, pinned to head.
func EncodeSearchCursor(options []Option, head int64, at Position) string {
	b := []byte(`{"q":`)
	b = appendJSString(b, Fingerprint(options))
	b = append(b, `,"head":`...)
	b = strconv.AppendInt(b, head, 10)
	b = append(b, `,"path":`...)
	b = appendJSString(b, encodeCursorPath(at.Path))
	b = append(b, `,"line":`...)
	b = strconv.AppendInt(b, at.Line, 10)
	b = append(b, `,"column":`...)
	b = strconv.AppendInt(b, at.Column, 10)
	b = append(b, '}')
	return base64.RawURLEncoding.EncodeToString(b)
}

// DecodeSearchCursor returns what an EncodeSearchCursor value holds, or
// invalid_cursor.
func DecodeSearchCursor(value string, options []Option) (head int64, at Position, err error) {
	var c struct {
		Q      string `json:"q"`
		Head   int64  `json:"head"`
		Path   string `json:"path"`
		Line   int64  `json:"line"`
		Column int64  `json:"column"`
	}
	if !decodeCursorJSON(value, &c) {
		return 0, Position{}, invalidCursor()
	}
	path, ok := decodeCursorPath(c.Path)
	at = Position{Path: path, Line: c.Line, Column: c.Column}
	if !ok || c.Head < 0 || c.Head > maxSafeInteger || c.Line < 0 || c.Line > maxSafeInteger ||
		c.Column < 0 || c.Column > maxSafeInteger || EncodeSearchCursor(options, c.Head, at) != value {
		return 0, Position{}, invalidCursor()
	}
	return c.Head, at, nil
}

func invalidCursor() error {
	return refuse("invalid_cursor", "the continuation does not match these query options")
}

// decodeCursorJSON checks the outer form Basalt checked (at most
// MaxCursorLength characters of the base64url alphabet, nothing else) and
// parses what it decodes to. The caller's round trip does the rest.
func decodeCursorJSON(value string, into any) bool {
	if value == "" || len(value) > MaxCursorLength {
		return false
	}
	for i := 0; i < len(value); i++ {
		if !base64URLChar(value[i]) {
			return false
		}
	}
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return false
	}
	return json.Unmarshal(raw, into) == nil
}

func base64URLChar(c byte) bool {
	return 'A' <= c && c <= 'Z' || 'a' <= c && c <= 'z' || '0' <= c && c <= '9' || c == '-' || c == '_'
}

// encodeCursorPath is the path as it travels inside a cursor: base64url of its
// UTF-8 bytes, without padding.
func encodeCursorPath(path string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(path))
}

// decodeCursorPath reverses encodeCursorPath, refusing a value that is not
// base64url of at most paths.MaxPathBytes bytes of valid UTF-8. Basalt allowed
// 4,096 bytes because its paths could be that long; the server's are not.
func decodeCursorPath(value string) (string, bool) {
	for i := 0; i < len(value); i++ {
		if !base64URLChar(value[i]) {
			return "", false
		}
	}
	b, err := base64.RawURLEncoding.Strict().DecodeString(value)
	if err != nil || len(b) > paths.MaxPathBytes || !utf8.Valid(b) {
		return "", false
	}
	return string(b), true
}
