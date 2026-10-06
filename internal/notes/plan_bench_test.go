package notes

import (
	"fmt"
	"testing"
)

// What a move's plan costs in a vault of ten thousand notes (T50).
//
//	go test -run XXX -bench BenchmarkAMove -benchtime 3x ./internal/notes/
//
// Every note a plan read had its links resolved by two resolvers built over
// the whole vault for that note alone, 27 ms a note at this size, so a
// preview that read a note's 300 backlinks took eight seconds, only to answer
// batch_too_large, and one that read the 512 notes a scan may took fourteen.

// benchHub is the note the benchmarks move.
const benchHub = "area-01/topic-1/note-00001.md"

// benchVault is ten thousand notes in fifty folders, each linking to two
// others by name and by relative path, the first backlinks of them to
// benchHub as well.
func benchVault(backlinks int) mapView {
	m := mapView{notes: map[string]Version{}}
	for i := 0; i < 10000; i++ {
		path := fmt.Sprintf("area-%02d/topic-%d/note-%05d.md", i%50, i%4, i)
		j := (i*7919 + 13) % 10000
		if j == 1 {
			j = 0 // only the backlinks below link to the hub
		}
		body := fmt.Sprintf("# Note %05d\n\nSee [[note-%05d]] and [that](../topic-%d/note-%05d.md).\n", i, j, j%4, j)
		if i >= 2 && i < backlinks+2 {
			body += "Hub: [[note-00001]]\n"
		}
		m.files = append(m.files, path)
		m.notes[path] = Version{UID: int64(i + 1), Bytes: []byte(body)}
	}
	return m
}

// A move without the link index reads notes until the scan bound refuses it.
func BenchmarkAMoveScanningTheVault(b *testing.B) {
	v := benchVault(0)
	for b.Loop() {
		if _, err := PlanMove(v, benchHub, "moved/hub.md", true); codeOf(err) != "scan_incomplete" {
			b.Fatal(err)
		}
	}
}

// A move through the link index of a note 300 notes link to.
func BenchmarkAMoveWithManyBacklinks(b *testing.B) {
	v := narrowed(benchVault(300))
	for b.Loop() {
		if _, err := PlanMove(v, benchHub, "moved/hub.md", true); codeOf(err) != "batch_too_large" {
			b.Fatal(err)
		}
	}
}

// A move through the link index of a note ten notes link to, which is a plan.
func BenchmarkAMoveWithAFewBacklinks(b *testing.B) {
	v := narrowed(benchVault(10))
	for b.Loop() {
		if p, err := PlanMove(v, benchHub, "moved/hub.md", true); err != nil || len(p.Changes) != 11 {
			b.Fatal(len(p.Changes), err)
		}
	}
}
