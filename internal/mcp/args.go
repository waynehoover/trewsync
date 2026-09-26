package mcp

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/waynehoover/trewsync/internal/paths"
)

// A tool's arguments are checked by hand, strictly, rather than by a schema
// library (plan/mcp-tools.md, "What is the same"): unknown keys are refused,
// a key given twice is refused, and text(N) bounds a string's UTF-8 bytes,
// which also bounds its characters, and refuses a lone surrogate. JSON can
// spell one as an escape (a lone \ud800), and Go's decoder would quietly turn
// it into U+FFFD, a different string from the one the agent sent; so every
// string's escapes are read here before it is decoded.
//
// A failure is the tool's own error result, not a JSON-RPC error: an agent
// that sent a bad argument sees why, and can correct it (plan/mcp-tools.md,
// "Result envelope").

// args are one call's arguments, read field by field. The first failure is
// kept and every later read returns the zero value, so a tool reads all its
// arguments and asks once at the end whether they were good.
type args struct {
	fields map[string]json.RawMessage
	used   map[string]bool
	fail   *ToolError
}

// parseArgs reads the arguments object. Absent and null are no arguments.
func parseArgs(raw json.RawMessage) *args {
	a := &args{fields: map[string]json.RawMessage{}, used: map[string]bool{}}
	if len(raw) == 0 || string(raw) == "null" {
		return a
	}
	if raw[0] != '{' {
		a.fail = invalidArguments("the arguments must be an object")
		return a
	}
	fields, err := objectFields(raw)
	if err != nil {
		a.fail = invalidArguments("the arguments are not a valid object: " + err.Error())
		return a
	}
	a.fields = fields
	return a
}

func invalidArguments(message string) *ToolError {
	return &ToolError{Code: "invalid_arguments", Message: message}
}

// take is the raw value of key, marking it used, or nil when it is absent,
// null, or an earlier read failed.
func (a *args) take(key string) json.RawMessage {
	a.used[key] = true
	if a.fail != nil {
		return nil
	}
	raw, ok := a.fields[key]
	if !ok || string(raw) == "null" {
		return nil
	}
	return raw
}

func (a *args) refuse(e *ToolError) {
	if a.fail == nil {
		a.fail = e
	}
}

// text is a string of at most max UTF-8 bytes with no lone surrogate, or ""
// when it is absent. present reports whether it was given at all.
func (a *args) text(key string, max int) (value string, present bool) {
	raw := a.take(key)
	if raw == nil {
		return "", false
	}
	s, err := jsonText(raw)
	if err != nil {
		err.Message = key + ": " + err.Message
		a.refuse(err)
		return "", false
	}
	if len(s) > max {
		a.refuse(&ToolError{Code: "input_too_large",
			Message: key + " is " + strconv.Itoa(len(s)) + " bytes of UTF-8, and at most " + strconv.Itoa(max) + " are accepted"})
		return "", false
	}
	return s, true
}

// jsonText decodes a JSON string, refusing any value that is not one and any
// escape that is half of a surrogate pair. The body has already been checked
// as UTF-8, so a surrogate can only arrive escaped.
func jsonText(raw json.RawMessage) (string, *ToolError) {
	if len(raw) == 0 || raw[0] != '"' {
		return "", invalidArguments("expected a string")
	}
	if !pairedSurrogates(raw) {
		return "", &ToolError{Code: "invalid_text", Message: "text must contain valid Unicode without unpaired surrogates"}
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil || !utf8.ValidString(s) {
		return "", &ToolError{Code: "invalid_text", Message: "text must contain valid Unicode without unpaired surrogates"}
	}
	return s, nil
}

// pairedSurrogates reports whether every \u escape in a JSON string that names
// a surrogate is a high one followed at once by a low one.
func pairedSurrogates(raw []byte) bool {
	s := string(raw)
	for i := 0; i < len(s); i++ {
		if s[i] != '\\' {
			continue
		}
		i++
		if i >= len(s) || s[i] != 'u' {
			continue // any other escape is one character; the decoder checks it
		}
		u, ok := hex4(s, i+1)
		if !ok {
			return false
		}
		i += 4
		switch {
		case 0xdc00 <= u && u <= 0xdfff:
			return false
		case 0xd800 <= u && u <= 0xdbff:
			if i+2 >= len(s) || s[i+1] != '\\' || s[i+2] != 'u' {
				return false
			}
			low, ok := hex4(s, i+3)
			if !ok || low < 0xdc00 || low > 0xdfff {
				return false
			}
			i += 6
		}
	}
	return true
}

func hex4(s string, at int) (int, bool) {
	if at+4 > len(s) {
		return 0, false
	}
	v, err := strconv.ParseUint(s[at:at+4], 16, 16)
	return int(v), err == nil
}

// integer is an integer from min to max, or def when absent. A number with a
// fraction, or outside the range, is refused with code; JSON numbers are
// doubles to a JavaScript client, so 5 and 5.0 are both accepted as 5.
func (a *args) integer(key string, min, max, def int64, code string) int64 {
	raw := a.take(key)
	if raw == nil {
		return def
	}
	if raw[0] != '-' && (raw[0] < '0' || raw[0] > '9') {
		a.refuse(invalidArguments(key + " must be an integer"))
		return def
	}
	n, err := strconv.ParseInt(string(raw), 10, 64)
	if err != nil {
		f, ferr := strconv.ParseFloat(string(raw), 64)
		if ferr != nil || f != math.Trunc(f) || math.Abs(f) > 1<<53 {
			a.refuse(&ToolError{Code: code, Message: key + " must be an integer from " +
				strconv.FormatInt(min, 10) + " to " + strconv.FormatInt(max, 10)})
			return def
		}
		n = int64(f)
	}
	if n < min || n > max {
		a.refuse(&ToolError{Code: code, Message: key + " must be an integer from " +
			strconv.FormatInt(min, 10) + " to " + strconv.FormatInt(max, 10)})
		return def
	}
	return n
}

// boolean is true or false, or def when absent.
func (a *args) boolean(key string, def bool) bool {
	raw := a.take(key)
	if raw == nil {
		return def
	}
	switch string(raw) {
	case "true":
		return true
	case "false":
		return false
	}
	a.refuse(invalidArguments(key + " must be true or false"))
	return def
}

// oneOf is one of the given words, or def when absent.
func (a *args) oneOf(key, def, code string, words ...string) string {
	raw := a.take(key)
	if raw == nil {
		return def
	}
	s, err := jsonText(raw)
	if err != nil {
		err.Message = key + ": " + err.Message
		a.refuse(err)
		return def
	}
	for _, w := range words {
		if s == w {
			return s
		}
	}
	a.refuse(&ToolError{Code: code, Message: key + " must be one of " + strings.Join(words, ", ")})
	return def
}

// path is a vault path the server's path rules accept (plan/protocol.md,
// "Paths"), required when required is set. A path the rules refuse is badpath
// with the rule's reason, the code a device's put gets for the same path.
func (a *args) path(key string, required bool) string {
	p, present := a.text(key, paths.MaxPathBytes)
	if a.fail != nil {
		return ""
	}
	if !present {
		if required {
			a.refuse(invalidArguments(key + " is required"))
		}
		return ""
	}
	if r := paths.Check(p); r != "" {
		a.refuse(&ToolError{Code: "badpath", Message: key + ": " + string(r) + ": the server refuses this path"})
		return ""
	}
	return p
}

// folder is a folder's path, or "" for the whole vault, which is also what an
// empty string asks for.
func (a *args) folder(key string) string {
	p, present := a.text(key, paths.MaxPathBytes)
	if !present || p == "" || a.fail != nil {
		return ""
	}
	if r := paths.Check(p); r != "" {
		a.refuse(&ToolError{Code: "badpath", Message: key + ": " + string(r) + ": the server refuses this path"})
		return ""
	}
	return p
}

// list is a JSON array of at most max items, and min when present, each as
// its raw value, or nil when it is absent. present reports whether it was
// given.
func (a *args) list(key string, min, max int) (items []json.RawMessage, present bool) {
	raw := a.take(key)
	if raw == nil {
		return nil, false
	}
	if raw[0] != '[' || json.Unmarshal(raw, &items) != nil {
		a.refuse(invalidArguments(key + " must be an array"))
		return nil, false
	}
	if len(items) < min || len(items) > max {
		a.refuse(invalidArguments(key + " must hold from " + strconv.Itoa(min) + " to " + strconv.Itoa(max) + " items"))
		return nil, false
	}
	return items, true
}

// texts is an array of text(maxBytes), each at least minBytes long, between
// min and max of them, or nil when absent.
func (a *args) texts(key string, min, max, minBytes, maxBytes int) ([]string, bool) {
	items, present := a.list(key, min, max)
	if !present {
		return nil, false
	}
	out := make([]string, len(items))
	for i, raw := range items {
		item := key + "[" + strconv.Itoa(i) + "]"
		s, err := jsonText(raw)
		switch {
		case err != nil:
			err.Message = item + ": " + err.Message
			a.refuse(err)
			return nil, false
		case len(s) > maxBytes:
			a.refuse(&ToolError{Code: "input_too_large",
				Message: item + " is " + strconv.Itoa(len(s)) + " bytes of UTF-8, and at most " + strconv.Itoa(maxBytes) + " are accepted"})
			return nil, false
		case len(s) < minBytes:
			a.refuse(invalidArguments(item + " must not be empty"))
			return nil, false
		}
		out[i] = s
	}
	return out, true
}

// objects is an array of objects, each read as arguments of its own with the
// same strictness, between min and max of them. Each item's reads are the
// caller's; its finish, with the item named, is what item does after them.
func (a *args) objects(key string, min, max int) ([]*args, bool) {
	items, present := a.list(key, min, max)
	if !present {
		return nil, false
	}
	out := make([]*args, len(items))
	for i, raw := range items {
		if len(raw) == 0 || raw[0] != '{' {
			a.refuse(invalidArguments(key + "[" + strconv.Itoa(i) + "] must be an object"))
			return nil, false
		}
		out[i] = parseArgs(raw)
	}
	return out, true
}

// adopt takes an item's first failure, prefixed with where the item is, as
// this call's.
func (a *args) adopt(item *args, where string) {
	if e := item.finish(); e != nil {
		c := *e
		c.Message = where + ": " + c.Message
		a.refuse(&c)
	}
}

// finish is the first failure, or one for a key no read asked for.
func (a *args) finish() *ToolError {
	if a.fail != nil {
		return a.fail
	}
	for key := range a.fields {
		if !a.used[key] {
			return invalidArguments("unknown argument " + quoteKey(key))
		}
	}
	return nil
}
