package mcp

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/waynehoover/trewsync/internal/server"
	"github.com/waynehoover/trewsync/internal/store"
	"github.com/waynehoover/trewsync/internal/wire"
)

// A device's search (protocol 2, `trew search`) and an agent's search_notes
// are one search (internal/search). Held to that over the oracle corpus, with
// the index and without: every query's matches across its pages, the version
// each is in, the notes skipped and why, and the refusals, are the same
// through both doors, and the device's are Basalt's exactly, since no
// envelope stands between them and the note.

type deviceMatch struct {
	oracleMatch
	UID int64 `json:"uid"`
}

// searchDevice follows nextAfter to the end on a device's session, returning
// every page's matches and skips, or the refusal's reason: the text before
// the colon of a badentry, or badpath.
func searchDevice(t *testing.T, d *device, in wire.In) (matches []deviceMatch, skipped []oracleSkip, code string) {
	t.Helper()
	for range 1000 {
		in.Op, in.ID = "search", d.id()
		d.send(in)
		m, err := d.await(10*time.Second, "searched", "err")
		if err != nil {
			t.Fatal(err)
		}
		if m["res"] == "err" {
			if m["code"] == wire.CodeBadPath {
				return nil, nil, "badpath"
			}
			msg, _ := m["msg"].(string)
			reason, _, _ := strings.Cut(msg, ":")
			return nil, nil, reason
		}
		b, _ := json.Marshal(m)
		var page struct {
			Matches   []deviceMatch `json:"matches"`
			Skipped   []oracleSkip  `json:"skipped"`
			NextAfter *string       `json:"nextAfter"`
			Complete  bool          `json:"complete"`
		}
		if err := json.Unmarshal(b, &page); err != nil {
			t.Fatal(err)
		}
		matches = append(matches, page.Matches...)
		skipped = append(skipped, page.Skipped...)
		if page.NextAfter == nil {
			return matches, skipped, ""
		}
		if page.Complete {
			t.Fatal("a device's page with a continuation says it is complete")
		}
		in.After = *page.NextAfter
	}
	t.Fatal("a device's search never ended")
	return nil, nil, ""
}

func TestADevicesSearchIsSearchNotesOverTheCorpus(t *testing.T) {
	vaults := loadSearchOracle(t)
	for _, indexed := range []bool{true, false} {
		name := "with the index"
		if !indexed {
			name = "scanning"
		}
		t.Run(name, func(t *testing.T) {
			checked := 0
			for vi, v := range vaults {
				generous := withLimits(Limits{TokenBurst: 1e6, TokenRate: 1e6, TokenBytesBurst: 1 << 40, TokenBytesRate: 1 << 40})
				var r *rig
				if indexed {
					r = newRig(t, generous)
				} else {
					r = newRig(t, generous, withoutIndex())
				}
				r.srv.SetSearchLimits(server.SearchLimits{Burst: 1e6, Rate: 1e6, BytesBurst: 1 << 40, BytesRate: 1 << 40})
				for _, n := range v.Notes {
					if _, err := writeEntry(r.st, store.Entry{Path: n.Path}, []byte(n.Text)); err != nil {
						t.Fatalf("vault %d: writing %s: %v", vi, n.Path, err)
					}
				}
				r.indexed()
				token, _ := r.token(store.ScopeRead)
				cs := r.mustConnect(token, Version20251125)
				laptop := r.device("laptop")
				for qi, q := range v.Queries {
					args := map[string]any{"query": q.Input.Query}
					in := wire.In{Query: q.Input.Query, Mode: q.Input.Mode, CaseSensitive: q.Input.CaseSensitive,
						ContextLines: q.Input.ContextLines, IncludeChildren: q.Input.IncludeChildren, Folder: q.Input.Folder}
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
						in.Limit = *q.Input.Limit
					}
					if q.Input.IncludeChildren != nil {
						args["includeChildren"] = *q.Input.IncludeChildren
					}
					if q.Input.Folder != "" {
						args["folder"] = q.Input.Folder
					}
					where := fmt.Sprintf("vault %d query %d %q", vi, qi, q.Input.Query)
					wantMatches, wantSkipped, wantCode := expected(t, q.Pages)
					agentMatches, agentSkipped, agentCode, _ := searchAll(t, cs, args)
					gotMatches, gotSkipped, gotCode := searchDevice(t, laptop, in)
					if gotCode != agentCode || gotCode != wantCode {
						t.Errorf("%s: the device was refused %q, the agent %q, Basalt %q", where, gotCode, agentCode, wantCode)
						continue
					}
					if len(gotMatches) != len(agentMatches) || len(gotMatches) != len(wantMatches) {
						t.Errorf("%s: the device has %d matches, the agent %d, Basalt %d", where,
							len(gotMatches), len(agentMatches), len(wantMatches))
						continue
					}
					for i := range gotMatches {
						g := gotMatches[i].oracleMatch
						if !reflect.DeepEqual(g, wantMatches[i]) {
							t.Errorf("%s match %d:\n device %+v\n Basalt %+v", where, i, g, wantMatches[i])
						}
						if !reflect.DeepEqual(normalized(g), agentMatches[i]) {
							t.Errorf("%s match %d:\n device %+v\n agent  %+v", where, i, g, agentMatches[i])
						}
						if head, _, _, _ := r.st.EntryAsOf(testVault, g.Path, 0); gotMatches[i].UID != head.UID {
							t.Errorf("%s match %d: the device was told uid %d, the head is %d", where, i, gotMatches[i].UID, head.UID)
						}
					}
					if !reflect.DeepEqual(append([]oracleSkip{}, gotSkipped...), append([]oracleSkip{}, agentSkipped...)) ||
						!reflect.DeepEqual(append([]oracleSkip{}, gotSkipped...), append([]oracleSkip{}, wantSkipped...)) {
						t.Errorf("%s: the device skipped %+v, the agent %+v, Basalt %+v", where, gotSkipped, agentSkipped, wantSkipped)
					}
					checked++
				}
			}
			total := 0
			for _, v := range vaults {
				total += len(v.Queries)
			}
			if checked != total {
				t.Fatalf("%d of the oracle's %d queries were checked", checked, total)
			}
		})
	}
}
