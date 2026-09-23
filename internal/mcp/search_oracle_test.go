package mcp

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/waynehoover/trew/internal/store"
)

// The search oracle: mcp-fixtures.json records what Basalt's TypeScript
// search returned, page by page, over small vaults (the generator is
// client/src/node/mcp-oracle.run.ts). internal/notes is held to it one page at
// a time; here the whole tool is, over the store and the index. Page
// boundaries differ where the index lets a page skip notes that cannot match,
// so what must agree is everything the pages return between them: every
// match in order, every note skipped and why, and the refusals.

type oracleText string

func (x *oracleText) UnmarshalJSON(b []byte) error {
	if len(b) > 0 && b[0] == '"' {
		var s string
		err := json.Unmarshal(b, &s)
		*x = oracleText(s)
		return err
	}
	var o struct {
		B64    *string             `json:"b64"`
		Repeat [][]json.RawMessage `json:"repeat"`
	}
	if err := json.Unmarshal(b, &o); err != nil {
		return err
	}
	if o.B64 != nil {
		raw, err := base64.StdEncoding.DecodeString(*o.B64)
		*x = oracleText(raw)
		return err
	}
	var sb strings.Builder
	for _, part := range o.Repeat {
		var s string
		var n int
		if len(part) != 2 || json.Unmarshal(part[0], &s) != nil || json.Unmarshal(part[1], &n) != nil {
			return fmt.Errorf("bad repeat %s", b)
		}
		sb.WriteString(strings.Repeat(s, n))
	}
	*x = oracleText(sb.String())
	return nil
}

type oracleVault struct {
	Notes []struct {
		Path string     `json:"path"`
		Text oracleText `json:"text"`
	} `json:"notes"`
	Queries []struct {
		Input struct {
			Query           string `json:"query"`
			Mode            string `json:"mode"`
			CaseSensitive   bool   `json:"caseSensitive"`
			ContextLines    int    `json:"contextLines"`
			Limit           *int   `json:"limit"`
			IncludeChildren *bool  `json:"includeChildren"`
			Folder          string `json:"folder"`
		} `json:"input"`
		Pages []json.RawMessage `json:"pages"`
	} `json:"queries"`
}

type oracleMatch struct {
	Path    string   `json:"path"`
	Line    int      `json:"line"`
	Column  int      `json:"column"`
	Text    string   `json:"text"`
	Before  []string `json:"before"`
	After   []string `json:"after"`
	Clipped bool     `json:"clipped"`
	Kind    string   `json:"kind"`
}

type oracleSkip struct {
	Path string `json:"path"`
	Why  string `json:"why"`
}

func loadSearchOracle(t *testing.T) []oracleVault {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "mcp-fixtures.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Search []oracleVault `json:"search"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Search) == 0 {
		t.Fatal("mcp-fixtures.json has no search vaults")
	}
	return f.Search
}

// expected is what Basalt's pages returned between them for one query, or
// the code its first page refused with.
func expected(t *testing.T, pages []json.RawMessage) (matches []oracleMatch, skipped []oracleSkip, code string) {
	t.Helper()
	for _, raw := range pages {
		var failed struct {
			Error string `json:"error"`
		}
		if bytes.HasPrefix(bytes.TrimSpace(raw), []byte("{")) && json.Unmarshal(raw, &failed) == nil && failed.Error != "" {
			return nil, nil, failed.Error
		}
		var page struct {
			Matches []oracleMatch `json:"matches"`
			Skipped struct {
				Items []oracleSkip `json:"items"`
			} `json:"skipped"`
		}
		if err := json.Unmarshal(raw, &page); err != nil {
			t.Fatal(err)
		}
		matches = append(matches, page.Matches...)
		skipped = append(skipped, page.Skipped.Items...)
	}
	return matches, skipped, ""
}

// searchAll follows nextCursor to the end, returning every page's matches
// and skips.
func searchAll(t *testing.T, cs *sdk.ClientSession, args map[string]any) (matches []oracleMatch, skipped []oracleSkip, code string, narrowed bool) {
	t.Helper()
	for page := 0; page < 1000; page++ {
		e := invoke(t, cs, "search_notes", args)
		if e.isError {
			return nil, nil, e.errorCode(), false
		}
		var tr struct {
			NextCursor *string `json:"nextCursor"`
			Complete   bool    `json:"complete"`
			Index      struct {
				Usable bool `json:"usable"`
			} `json:"index"`
		}
		e.trusted(t, &tr)
		var un struct {
			Matches []oracleMatch `json:"matches"`
			Skipped []oracleSkip  `json:"skipped"`
		}
		e.untrusted(t, &un)
		matches = append(matches, un.Matches...)
		skipped = append(skipped, un.Skipped...)
		narrowed = narrowed || tr.Index.Usable
		if tr.NextCursor == nil {
			return matches, skipped, "", narrowed
		}
		if tr.Complete {
			t.Fatal("a page with a continuation says it is complete")
		}
		next := map[string]any{}
		for k, v := range args {
			next[k] = v
		}
		next["cursor"] = *tr.NextCursor
		args = next
	}
	t.Fatal("search never ended")
	return nil, nil, "", false
}

func nonNilStrings(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// normalized is a Basalt match as this server must return it: every string
// through Normalize, which is the one difference the envelope makes. Basalt
// handed a model the control characters of a note as they were; here they
// arrive as U+FFFD, counted in the envelope's security block.
func normalized(m oracleMatch) oracleMatch {
	norm := func(ss []string) []string {
		out := []string{}
		for _, s := range ss {
			out = append(out, Normalize(s).String())
		}
		return out
	}
	m.Path, m.Text = Normalize(m.Path).String(), Normalize(m.Text).String()
	m.Before, m.After = norm(m.Before), norm(m.After)
	return m
}

func TestSearchMatchesBasaltsLiteralScanOverTheCorpus(t *testing.T) {
	vaults := loadSearchOracle(t)
	for _, indexed := range []bool{true, false} {
		name := "with the index"
		if !indexed {
			name = "scanning"
		}
		t.Run(name, func(t *testing.T) {
			checked, narrowedBy := 0, 0
			for vi, v := range vaults {
				// Budgets out of the way: this is hundreds of calls in a
				// moment from one token, which is what they exist to stop.
				generous := withLimits(Limits{TokenBurst: 1e6, TokenRate: 1e6, TokenBytesBurst: 1 << 40, TokenBytesRate: 1 << 40})
				var r *rig
				if indexed {
					r = newRig(t, generous)
				} else {
					r = newRig(t, generous, withoutIndex())
				}
				for _, n := range v.Notes {
					if _, err := writeEntry(r.st, store.Entry{Path: n.Path}, []byte(n.Text)); err != nil {
						t.Fatalf("vault %d: writing %s: %v", vi, n.Path, err)
					}
				}
				r.indexed()
				token, _ := r.token(store.ScopeRead)
				cs := r.mustConnect(token, Version20251125)
				for qi, q := range v.Queries {
					args := map[string]any{"query": q.Input.Query}
					if q.Input.Mode != "" {
						args["mode"] = q.Input.Mode
					}
					if q.Input.CaseSensitive {
						args["caseSensitive"] = true
					}
					if q.Input.ContextLines != 0 {
						args["contextLines"] = q.Input.ContextLines
					}
					if q.Input.Limit != nil {
						args["limit"] = *q.Input.Limit
					}
					if q.Input.IncludeChildren != nil {
						args["includeChildren"] = *q.Input.IncludeChildren
					}
					if q.Input.Folder != "" {
						args["folder"] = q.Input.Folder
					}
					wantMatches, wantSkipped, wantCode := expected(t, q.Pages)
					gotMatches, gotSkipped, gotCode, narrowed := searchAll(t, cs, args)
					if narrowed {
						if !indexed {
							t.Fatal("a search with no index says an index narrowed it")
						}
						narrowedBy++
					}
					where := fmt.Sprintf("vault %d query %d %q", vi, qi, q.Input.Query)
					if gotCode != wantCode {
						t.Errorf("%s: refused %q, Basalt %q", where, gotCode, wantCode)
						continue
					}
					if len(gotMatches) != len(wantMatches) {
						t.Errorf("%s: %d matches, Basalt %d", where, len(gotMatches), len(wantMatches))
						continue
					}
					for i := range gotMatches {
						g, w := gotMatches[i], normalized(wantMatches[i])
						g.Before, g.After = nonNilStrings(g.Before), nonNilStrings(g.After)
						if !reflect.DeepEqual(g, w) {
							t.Errorf("%s match %d:\n got  %+v\n want %+v", where, i, g, w)
						}
					}
					if !reflect.DeepEqual(append([]oracleSkip{}, gotSkipped...), append([]oracleSkip{}, wantSkipped...)) {
						t.Errorf("%s: skipped %+v, Basalt %+v", where, gotSkipped, wantSkipped)
					}
					checked++
				}
			}
			total := 0
			for _, v := range vaults {
				total += len(v.Queries)
			}
			if checked != total || total < 80 {
				t.Fatalf("%d of the oracle's %d queries were checked", checked, total)
			}
			// The index took part: queries of three characters or more were
			// answered from its proposals, not by scanning every note.
			if indexed && narrowedBy < 30 {
				t.Fatalf("the index narrowed only %d of %d searches", narrowedBy, total)
			}
		})
	}
}
