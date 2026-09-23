package store

import (
	"fmt"
	"path/filepath"
	"testing"
)

// BenchmarkABatchOfNewNotes is one full batch of new notes three folders deep,
// committed through AppendMany without an fsync: the cost of the collision
// rule and its live set on the hot path of a first sync (see liveSchema).
func BenchmarkABatchOfNewNotes(b *testing.B) {
	dir := b.TempDir()
	st, err := OpenWithSync(filepath.Join(dir, "telimus.db"), filepath.Join(dir, "chunks"), SyncNormal)
	if err != nil {
		b.Fatal(err)
	}
	defer st.Close()
	if err := st.EnsureVault("v1", 1); err != nil {
		b.Fatal(err)
	}
	n := 0
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		entries := make([]Entry, 256)
		for k := range entries {
			entries[k] = Entry{Path: fmt.Sprintf("area-%d/project-%d/notes/note-%d.md", n%7, n%31, n),
				MTime: 1}
			n++
		}
		if _, err := st.AppendMany("v1", entries, make([]int64, 256), make([]int64, 256)); err != nil {
			b.Fatal(err)
		}
	}
}
