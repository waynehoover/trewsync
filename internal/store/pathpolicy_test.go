package store

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/waynehoover/trewsync/internal/chunks"
	"github.com/waynehoover/trewsync/internal/paths"
)

// Every path vector in protocol-fixtures.json, through Entry.Validate, as a
// file, a folder, a deletion and a rename's source: the store refuses exactly
// what the fixture refuses, with exactly its reason, whatever kind of entry
// carries the path (F20: a rule applied to one kind of entry and not the
// others is how rows every reader refuses got stored). The vectors come from
// scripts/protocol-vectors.py; the TypeScript client checks the same ones.
//
// The session's matrix sends the same vectors over a real connection. This one
// also reaches the vectors that are not UTF-8, which a JSON frame cannot carry.
func TestValidateRefusesExactlyTheFixturesPaths(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "protocol-fixtures.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Paths struct {
			Cases []struct {
				Name   string  `json:"name"`
				Hex    string  `json:"hex"`
				Valid  bool    `json:"valid"`
				Reason *string `json:"reason"`
			} `json:"cases"`
		} `json:"paths"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Paths.Cases) < 20 {
		t.Fatalf("only %d vectors", len(f.Paths.Cases))
	}
	chunk := chunks.Name([]byte("x"))
	accepted, refused := 0, 0
	for _, c := range f.Paths.Cases {
		b, err := hex.DecodeString(c.Hex)
		if err != nil {
			t.Fatal(err)
		}
		p := string(b)
		if paths.IsConfig(p) {
			// The store holds protocol 3's settings, and a profile root's
			// verdicts are TestValidateHoldsSettingsToProtocol3sRule's.
			continue
		}
		kinds := []struct {
			entry Entry
			field string
		}{
			{Entry{Path: p, Size: 1, Chunks: []string{chunk}}, "path"},
			{Entry{Path: p, Folder: true}, "path"},
			{Entry{Path: p, Deleted: true}, "path"},
		}
		if p != "" {
			// An empty prev is no rename, so that vector has no source to test.
			kinds = append(kinds, struct {
				entry Entry
				field string
			}{Entry{Path: "dest.md", Prev: p}, "prev"})
		}
		for _, k := range kinds {
			err := k.entry.Validate()
			if c.Valid {
				if err != nil {
					t.Errorf("%s (%s): a legal path was refused: %v", c.Name, k.field, err)
				}
				accepted++
				continue
			}
			refused++
			var pe *PathError
			if !errors.As(err, &pe) {
				t.Errorf("%s (%s): answered %v, want a PathError", c.Name, k.field, err)
				continue
			}
			if pe.Field != k.field || string(pe.Reason) != *c.Reason {
				t.Errorf("%s: refused as %s/%s, want %s/%s", c.Name, pe.Field, pe.Reason, k.field, *c.Reason)
			}
			// The message is what the person reads (PLAN.md section 4.9), so
			// a reason the contract grows must arrive with its explanation,
			// not the fallback that only says the path was refused.
			if strings.HasSuffix(pe.Error(), " is refused") {
				t.Errorf("%s: %q explains nothing about %s", c.Name, pe.Error(), pe.Reason)
			}
		}
	}
	if accepted == 0 || refused == 0 {
		t.Fatalf("the vectors cover one verdict only: %d accepted, %d refused", accepted, refused)
	}
}

// The settings vectors through Entry.Validate, which is protocol 3's rule
// because the store holds what a session of 3 may write, and through
// CheckNotePaths, the notes rule a session of 1 or 2 and every MCP operation
// are held to. A rename's source is renamed within its own side of the
// boundary, so the boundary rule (configmove) is not what answers it.
func TestValidateHoldsSettingsToProtocol3sRule(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "protocol-fixtures.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Config struct {
			Cases []struct {
				Name   string  `json:"name"`
				Hex    string  `json:"hex"`
				Notes  *string `json:"notes"`
				Config *string `json:"config"`
			} `json:"cases"`
		} `json:"config"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Config.Cases) < 30 {
		t.Fatalf("only %d vectors", len(f.Config.Cases))
	}
	reason := func(err error) string {
		var pe *PathError
		if err == nil || !errors.As(err, &pe) {
			return fmt.Sprint(err)
		}
		if strings.HasSuffix(pe.Error(), " is refused") {
			t.Errorf("%q explains nothing about %s", pe.Error(), pe.Reason)
		}
		return string(pe.Reason)
	}
	want := func(r *string) string {
		if r == nil {
			return "<nil>"
		}
		return *r
	}
	chunk := chunks.Name([]byte("x"))
	for _, c := range f.Config.Cases {
		b, err := hex.DecodeString(c.Hex)
		if err != nil {
			t.Fatal(err)
		}
		p := string(b)
		dest := "dest.md"
		if paths.IsConfig(p) {
			dest = ".obsidian/dest.json"
		}
		for i, e := range []Entry{
			{Path: p, Size: 1, Chunks: []string{chunk}},
			{Path: p, Deleted: true},
			{Path: dest, Prev: p},
		} {
			if got := reason(e.Validate()); got != want(c.Config) {
				t.Errorf("%s: Validate gives %s for %+v, the reference %s", c.Name, got, e, want(c.Config))
			}
			// The notes rule refuses a settings destination before it reads
			// the source, so the rename is Validate's alone.
			if i < 2 {
				if got := reason(e.CheckNotePaths()); got != want(c.Notes) {
					t.Errorf("%s: CheckNotePaths gives %s for %+v, the reference %s", c.Name, got, e, want(c.Notes))
				}
			}
		}
	}
}

// A length refusal names the length that is wrong, and for a name too long
// that is the name's, not the whole path's: "a path of 1003 bytes" would send
// the person looking at the wrong thing.
func TestALengthRefusalNamesTheLengthThatIsWrong(t *testing.T) {
	name := strings.Repeat("n", 300)
	for _, c := range []struct {
		entry Entry
		want  string
	}{
		{Entry{Path: "Notes/" + name + ".md", Deleted: true},
			"segmenttoolong: the path has a file or folder name of 303 bytes of UTF-8, and a name is at most 255"},
		{Entry{Path: "dest.md", Prev: name + "/a.md"},
			"segmenttoolong: the prev has a file or folder name of 300 bytes of UTF-8, and a name is at most 255"},
		{Entry{Path: strings.Repeat("abcd/", 206) + "x.md", Deleted: true},
			"toolong: the path is 1034 bytes of UTF-8, and a path is at most 1024"},
	} {
		err := c.entry.Validate()
		if err == nil || !strings.HasPrefix(err.Error(), c.want) {
			t.Errorf("%.40q... answered %v, want it to begin %q", c.entry.Path, err, c.want)
		}
	}
}
