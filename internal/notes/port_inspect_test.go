package notes

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
)

// The cases of client/src/cli/mcp-inspect.test.ts that exercise compareText.
// The delivery-status case tests the device client, which is not ported.

func TestPortedCompareReconstructsTheLaterText(t *testing.T) {
	// "reconstructs exact line bytes across insertions, removals, CRLF and
	// missing final newlines"
	texts := []string{"", "one\n", "one\r\ntwo", "\ufeffone\n\nthree\n", "three\ntwo\none\n", "one\ntwo\nthree\n"}
	for _, before := range texts {
		for _, after := range texts {
			c := CompareLines(before, after)
			lines := splitLines(before)
			for i := len(c.Changes) - 1; i >= 0; i-- {
				row := c.Changes[i]
				at := row.FromLine - 1
				if got := strings.Join(lines[at:at+row.OldLines], ""); got != row.Old {
					t.Fatalf("%q -> %q: change %d names %q, the lines are %q", before, after, i, row.Old, got)
				}
				lines = append(lines[:at], append([]string{row.New}, lines[at+row.OldLines:]...)...)
			}
			if got := strings.Join(lines, ""); got != after {
				t.Errorf("%q -> %q: rebuilt %q", before, after, got)
			}
		}
	}
}

func TestPortedCompareCapIsOneDeterministicHunk(t *testing.T) {
	// "uses a deterministic broad hunk for comparisons exceeding the work cap"
	var before, after strings.Builder
	for i := 0; i < 2000; i++ {
		fmt.Fprintf(&before, "old %d\n", i)
		fmt.Fprintf(&after, "new %d\n", i)
	}
	got := CompareLines(before.String(), after.String())
	want := Comparison{Coarse: true, Changes: []Change{{
		FromLine: 1, ToLine: 1, Old: before.String(), New: after.String(), OldLines: 2000, NewLines: 2000,
	}}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got coarse %v with %d changes", got.Coarse, len(got.Changes))
	}
	if again := CompareLines(before.String(), after.String()); !reflect.DeepEqual(again, got) {
		t.Error("a second comparison differs")
	}
}
