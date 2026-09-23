package store

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/waynehoover/trew/internal/chunks"
)

// A verifier must not allocate the same large body once per historical
// reference. The generous ceiling is a resource bound, not a timing assertion.
func TestDeepVerifyAllocationTracksUniqueBodies(t *testing.T) {
	h := sharedVerificationStore(t, 128, 256<<10)
	if _, err := h.Verify(true); err != nil {
		t.Fatal(err)
	}
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	got, err := h.Verify(true)
	runtime.ReadMemStats(&after)
	if err != nil || len(got.Faults) != 0 || got.Chunks != 128 || got.Entries != 128 {
		t.Fatalf("verification: %+v %v", got, err)
	}
	if allocated := after.TotalAlloc - before.TotalAlloc; allocated > 8<<20 {
		t.Fatalf("verifying one 256 KiB body reused by 128 versions allocated %d bytes; budget is 8 MiB", allocated)
	}
}

func sharedVerificationStore(tb testing.TB, refs, size int) *Store {
	tb.Helper()
	dir := tb.TempDir()
	h, err := Open(filepath.Join(dir, "trew.db"), filepath.Join(dir, "chunks"))
	if err != nil {
		tb.Fatal(err)
	}
	tb.Cleanup(func() { _ = h.Close() })
	if err := h.EnsureVault("v1", 1); err != nil {
		tb.Fatal(err)
	}
	body := bytes.Repeat([]byte("a"), size)
	name := chunks.Name(body)
	if err := h.chunks.Put("v1", name, body); err != nil {
		tb.Fatal(err)
	}
	// The store's normal publication and commit paths seed the fixture.
	for i := range refs {
		if _, err := h.AppendEntry("v1", Entry{Path: fmt.Sprintf("note-%d.md", i%10),
			Size: int64(size), MTime: 1, Device: "laptop", Chunks: []string{name}}); err != nil {
			tb.Fatal(err)
		}
	}
	return h
}

func TestDeepVerifyReportsEverySharedReferenceAndChecksAgainNextTime(t *testing.T) {
	h := newTestStore(t)
	a := h.file(t, "a.md", "good", "shared", "shared")
	b := h.file(t, "b.md", "shared", "missing")
	bad := h.file(t, "malformed.md")
	// A size with no chunks behind it, which reads as an empty note.
	if _, err := h.db.Exec(`UPDATE entries SET size=5 WHERE vault_id='v1' AND uid=?`, bad.UID); err != nil {
		t.Fatal(err)
	}
	if err := h.RegisterDevice("v1", "laptop", "Laptop", hashA, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := h.db.Exec(`UPDATE devices SET auth_hash='broken' WHERE vault_id='v1'`); err != nil {
		t.Fatal(err)
	}
	if err := h.EnsureVault("v2", 1); err != nil {
		t.Fatal(err)
	}
	other := h.put(t, "v2", "shared")
	if _, err := h.AppendEntry("v2", Entry{Path: "other.md", Size: 6, MTime: 1, Device: "other", Chunks: other}); err != nil {
		t.Fatal(err)
	}
	corrupt, _ := h.chunks.Path("v1", a.Chunks[1])
	missing, _ := h.chunks.Path("v1", b.Chunks[1])
	if err := os.WriteFile(corrupt, []byte("broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(missing); err != nil {
		t.Fatal(err)
	}
	got, err := h.Verify(true)
	if err != nil || got.Chunks != 6 || got.Entries != 4 || got.Rows != 1 || len(got.Faults) != 6 {
		t.Fatalf("full verification: %+v %v", got, err)
	}
	want := []struct {
		uid                 int64
		path, chunk, reason string
	}{
		{a.UID, a.Path, a.Chunks[1], "corrupt"},
		{a.UID, a.Path, a.Chunks[2], "corrupt"},
		{b.UID, b.Path, b.Chunks[0], "corrupt"},
		{b.UID, b.Path, b.Chunks[1], "missing"},
		{bad.UID, bad.Path, "", "nochunks"},
	}
	for i, expected := range want {
		f := got.Faults[i]
		if f.VaultID != "v1" || f.UID != expected.uid || f.Path != expected.path || f.Chunk != expected.chunk || f.Reason != expected.reason {
			t.Fatalf("fault %d: %+v, want %+v", i, f, expected)
		}
		if expected.reason == "corrupt" && (f.Detail == "" || f.Detail != got.Faults[0].Detail) {
			t.Fatalf("shared body error lost its diagnostic detail: %+v", f)
		}
	}
	if got.Faults[5].Reason != "baddevice" {
		t.Fatalf("registry check missing: %+v", got.Faults[5])
	}
	// Other vaults using the same content address are checked independently.
	if body, err := h.chunks.Get("v2", other[0]); err != nil || string(body) != "shared" {
		t.Fatalf("other vault's body: %q %v", body, err)
	}
	// No result survives an invocation: an external repair clears these faults.
	if err := os.WriteFile(corrupt, []byte("shared"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := h.chunks.Put("v1", b.Chunks[1], []byte("missing")); err != nil {
		t.Fatal(err)
	}
	again, err := h.Verify(true)
	if err != nil || again.Chunks != 6 || again.Entries != 4 || again.Rows != 1 || len(again.Faults) != 2 {
		t.Fatalf("verification retained stale body failures or skipped other checks: %+v %v", again, err)
	}
	if again.Faults[0].Reason != "nochunks" || again.Faults[1].Reason != "baddevice" {
		t.Fatalf("remaining faults: %+v", again.Faults)
	}
}

func BenchmarkDeepVerifySharedHistory(b *testing.B) {
	h := sharedVerificationStore(b, 500, 64<<10)
	b.ReportAllocs()
	b.ResetTimer()
	for b.Loop() {
		got, err := h.Verify(true)
		if err != nil || len(got.Faults) != 0 || got.Chunks != 500 || got.Entries != 500 {
			b.Fatalf("verification: %+v %v", got, err)
		}
	}
}
