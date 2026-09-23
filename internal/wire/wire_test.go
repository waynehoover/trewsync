package wire

import (
	"encoding/json"
	"errors"
	"os"
	"regexp"
	"strings"
	"testing"
)

// The retryable column of the error table in plan/protocol.md, the protocol 1
// specification, is what Retryable returns. Read from the spec rather than
// restated here, so the two cannot drift without this failing, and every code
// this package defines has a row there.
//
// It read docs/protocol.md, which still documents protocol 7 until the docs
// are rewritten (PLAN.md M9); the wire this package speaks is the spec's.
func TestI2RetryableMatchesTheProtocolDoc(t *testing.T) {
	doc, err := os.ReadFile("../../plan/protocol.md")
	if err != nil {
		t.Fatalf("the protocol specification is not beside the source: %v", err)
	}
	row := regexp.MustCompile("(?m)^\\| `([a-z]+)` \\| [^|]* \\| (yes|no)[^|]* \\| ")
	rows := row.FindAllStringSubmatch(string(doc), -1)
	if len(rows) < 10 {
		t.Fatalf("found %d error rows in the doc, expected the whole table", len(rows))
	}
	seen := map[string]bool{}
	for _, m := range rows {
		code, want := m[1], m[2] == "yes"
		seen[code] = true
		if got := Retryable(code); got != want {
			t.Errorf("Retryable(%q) = %v, the doc says %v", code, got, want)
		}
	}
	for _, code := range []string{CodeProto, CodeAuth, CodeCursor, CodeBusy, CodeProtoState,
		CodeBadChunk, CodeBadPath, CodeCollision, CodeStale, CodeBadEntry, CodeBadName, CodeToolarge, CodeNoSpace,
		CodeNoUID, CodeNoContent, CodeNoChunk, CodeNoDevice, CodeNoUndo, CodeInternal} {
		if !seen[code] {
			t.Errorf("code %q has no row in the doc's error table", code)
		}
	}
}

// Every error carries retryable, whatever else it carries: id only when it
// answers a request, retryAfterMs only when there is a hint to give.
func TestI2ErrShapes(t *testing.T) {
	answering := Error(CodeNoUID, "m")
	answering.ID = 7
	if b, _ := json.Marshal(answering); string(b) != `{"res":"err","id":7,"code":"nouid","msg":"m","retryable":false}` {
		t.Fatalf("the shape of an error answering a request: %s", b)
	}
	unsolicited := Error(CodeBusy, "m")
	unsolicited.RetryAfterMs = 5000
	b, _ := json.Marshal(unsolicited)
	if strings.Contains(string(b), `"id"`) || !strings.Contains(string(b), `"retryAfterMs":5000`) ||
		!strings.Contains(string(b), `"retryable":true`) {
		t.Fatalf("the shape of an unsolicited error: %s", b)
	}
	// Nothing can build an error without the verdict, because the field is not
	// omitted and not a pointer: the zero value is a stated "do not retry".
	if b, _ := json.Marshal(Err{Res: "err", Code: CodeAuth, Msg: "m"}); !strings.Contains(string(b), `"retryable":false`) {
		t.Fatalf("an error was built with no retryable: %s", b)
	}
}

// A text frame JSON decoding would change is refused before it is decoded:
// Go's decoder turns invalid UTF-8 and an unpaired surrogate escape into
// U+FFFD without a word, and for a path that is a rename nobody asked for.
func TestValidTextRefusesWhatDecodingWouldChange(t *testing.T) {
	good := []string{
		`{"op":"put","path":"a.md"}`,
		`{"path":"\ud83d\ude00 face.md"}`, // a pair, escaped
		`{"path":"😀 face.md"}`,
		`{"path":"\\ud800 is text, not an escape"}`,
		`{"path":"a\"b\\"}`,
		`{"path":"\u00e9t\u00E9"}`,
		"{\"path\":\"\uFFFD is a character\"}",
		`{"path":"a\`, // an escape cut off by the end: the decoder's to refuse
		`"\ud8`,       // a malformed escape: the decoder's to refuse
	}
	for _, g := range good {
		if err := ValidText([]byte(g)); err != nil {
			t.Errorf("%s was refused: %v", g, err)
		}
	}
	bad := []string{
		"{\"path\":\"a\xffb.md\"}",
		"{\"path\":\"a\xed\xa0\x80.md\"}", // a surrogate, encoded
		`{"path":"\ud800.md"}`,
		`{"path":"\udc00.md"}`,
		`{"path":"\ud800\u0041.md"}`,
		`{"path":"\ud800\ud800.md"}`,
		`{"path":"x\ud83d"}`,
	}
	for _, b := range bad {
		if err := ValidText([]byte(b)); !errors.Is(err, ErrNotText) {
			t.Errorf("%q was answered %v, want ErrNotText", b, err)
		}
	}
	// And each of the bad ones really is changed by decoding, which is the
	// whole reason for refusing it: a check against a harmless shape would
	// refuse nothing anybody sends.
	for _, b := range bad {
		var m map[string]string
		if err := json.Unmarshal([]byte(b), &m); err != nil {
			continue
		}
		if !strings.Contains(m["path"], "\uFFFD") {
			t.Errorf("%q decodes to %q, unchanged, so refusing it protects nothing", b, m["path"])
		}
	}
}
