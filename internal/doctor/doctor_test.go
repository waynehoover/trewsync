package doctor

import (
	"context"
	"os"
	"testing"

	"github.com/waynehoover/trewsync/internal/chunks"
	"github.com/waynehoover/trewsync/internal/store"
)

// A deep run reads every body in its store check and samples none, so its
// chunk check reports what that pass found. It reported every reference
// "read and hashed by the deep pass above, all sound" beside the store
// check's own fail for the same rotted body (Neon review, Low finding on
// doctor.go).
func TestADeepRunsChunkCheckReportsTheBodiesTheDeepPassFoundUnsound(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(store.DataDir(dir))
	if err != nil {
		t.Fatal(err)
	}
	if err := st.EnsureVault("default", 1); err != nil {
		t.Fatal(err)
	}
	body := []byte("the only copy of a note")
	name := chunks.Name(body)
	if err := st.Chunks().Put("default", name, body); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AppendEntry("default", store.Entry{Path: "a.md", Size: int64(len(body)), MTime: 1, Device: "d",
		Chunks: []string{name}}); err != nil {
		t.Fatal(err)
	}
	p, err := st.Chunks().Path("default", name)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	rot := append([]byte{}, body...)
	rot[0] ^= 0x20
	if err := os.WriteFile(p, rot, 0o600); err != nil {
		t.Fatal(err)
	}

	rep := Run(context.Background(), Options{DataDir: dir, Deep: true,
		Storage: func(d string) (Storage, error) { return Storage{Dir: d, FSType: "ext4", MountPoint: "/"}, nil }})
	for _, f := range rep.Findings {
		if f.Check == CheckChunks {
			if f.Status != Fail {
				t.Fatalf("the chunk check is %s with a rotted body in the store: %s", f.Status, f.Summary)
			}
			return
		}
	}
	t.Fatalf("no chunk check: %+v", rep.Findings)
}
