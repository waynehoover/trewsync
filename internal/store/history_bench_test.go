package store

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/waynehoover/telimus/internal/chunks"
)

// The four queries that grow with history, against a database shaped like a
// vault that has been used (I10).
//
//	go test -run XXX -bench BenchmarkHistory -benchtime 1x ./internal/store/
//
// The reason to measure before adding an index: the entries table is
// append-only and every index is paid on every push and in every backup, while
// the queries below run when a person asks a question. Two of them already have
// an index that was added on evidence (entries_by_prev, 112 ms to 5.6 ms) and
// the note beside it records the trade. This is the harness that produces that
// kind of evidence rather than a guess.
//
// The shape that matters is versions per path, not paths. A vault of many notes
// each saved once and a vault of few notes each saved a thousand times have the
// same row count and nothing else in common: history, deletion paging and stats
// all group by path, and the second shape is what a daily note looks like after
// a year of a sync engine that keeps every version.

type vaultShape struct {
	name     string
	paths    int
	versions int
	deleted  int // how many of the paths end in a deletion
}

func buildVault(tb testing.TB, sh vaultShape) (*Store, string) {
	tb.Helper()
	dir := tb.TempDir()
	st, err := Open(filepath.Join(dir, "telimus.db"), filepath.Join(dir, "chunks"))
	if err != nil {
		tb.Fatal(err)
	}
	tb.Cleanup(func() { _ = st.Close() })
	const vaultID = "default"
	if err := st.EnsureVault(vaultID, time.Now().UnixMilli()); err != nil {
		tb.Fatal(err)
	}

	mac := func(s string) string {
		sum := sha256.Sum256([]byte(s))
		return hex.EncodeToString(sum[:])
	}

	// A real body per version, because AppendEntry checks that every chunk an
	// entry names is present before it will commit it. One shared body per
	// version index rather than one per row: the queries below group and count
	// rows, and how many distinct bodies exist behind them changes nothing they
	// do while changing how long this takes to build by a lot.
	bodies := make([]string, sh.versions)
	for v := range bodies {
		body := []byte(fmt.Sprintf("version %d of something", v))
		bodies[v] = chunks.Name(body)
		if err := st.Chunks().Put(vaultID, bodies[v], body); err != nil {
			tb.Fatal(err)
		}
	}
	for p := range sh.paths {
		path := fmt.Sprintf("area-%d/topic-%d/note-%05d.md", p%11, p%7, p)
		for v := range sh.versions {
			e := Entry{
				Path: path, Size: 400, CTime: 1000, MTime: int64(1000 + v),
				Device: "a", Mac: mac(fmt.Sprintf("%s/%d", path, v)),
				Chunks: []string{bodies[v]},
			}
			if _, err := st.AppendEntry(vaultID, e); err != nil {
				tb.Fatal(err)
			}
		}
		if p < sh.deleted {
			e := Entry{
				Path: path, Deleted: true, CTime: 1000, MTime: 2000,
				Device: "a", Mac: mac(path + "/gone"),
			}
			if _, err := st.AppendEntry(vaultID, e); err != nil {
				tb.Fatal(err)
			}
		}
	}
	return st, vaultID
}

func BenchmarkHistory(b *testing.B) {
	shapes := []vaultShape{
		// Many notes, saved a few times each. The ordinary vault.
		{name: "2000 notes x 5 versions", paths: 2000, versions: 5, deleted: 200},
		// Few notes with deep history. A daily note after a year, and the shape
		// the entries_by_path index exists for.
		{name: "50 notes x 400 versions", paths: 50, versions: 400, deleted: 10},
		// Many deletions, which is what Deleted() and Stats() actually walk.
		{name: "2000 notes x 3 versions, 1500 deleted", paths: 2000, versions: 3, deleted: 1500},
	}
	for _, sh := range shapes {
		b.Run(sh.name, func(b *testing.B) {
			st, vaultID := buildVault(b, sh)
			rows := sh.paths*sh.versions + sh.deleted
			b.Logf("%d entry rows", rows)

			b.Run("history of one path", func(b *testing.B) {
				path := fmt.Sprintf("area-%d/topic-%d/note-%05d.md", 0, 0, 0)
				for b.Loop() {
					if _, err := st.HistoryForPath(vaultID, path, 0, 100); err != nil {
						b.Fatal(err)
					}
				}
			})

			b.Run("first page of deletions", func(b *testing.B) {
				for b.Loop() {
					if _, _, err := st.Deleted(vaultID, true, 20, 0); err != nil {
						b.Fatal(err)
					}
				}
			})

			// The page a person reaches by clicking "older" a few times, which
			// is the one a naive query re-walks from the top for.
			b.Run("a later page of deletions", func(b *testing.B) {
				list, _, err := st.Deleted(vaultID, true, 20, 0)
				if err != nil || len(list) == 0 {
					b.Skip("no deletions in this shape")
				}
				before := list[len(list)-1].Entry.UID
				b.ResetTimer()
				for b.Loop() {
					if _, _, err := st.Deleted(vaultID, true, 20, before); err != nil {
						b.Fatal(err)
					}
				}
			})

			b.Run("stats", func(b *testing.B) {
				for b.Loop() {
					if _, err := st.Stats(vaultID); err != nil {
						b.Fatal(err)
					}
				}
			})

			// What a device catching up asks for, repeatedly, and the one on
			// the sync path rather than a person's.
			b.Run("a batch from the cursor", func(b *testing.B) {
				for b.Loop() {
					if _, _, err := st.NextBatch(vaultID, 0, 500); err != nil {
						b.Fatal(err)
					}
				}
			})
		})
	}
}
