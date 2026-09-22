package server

import (
	"os"
	"testing"

	"github.com/waynehoover/telimus/internal/chunks"
	"github.com/waynehoover/telimus/internal/store"
	"github.com/waynehoover/telimus/internal/wire"
)

// A repair body belongs to a version the vault already holds, and that version
// may be larger than the file ceiling the server advertises today: the ceiling
// can be lowered after a large file was stored. So `resend` bounds its bodies
// by the chunk ceiling, never by the per-file limit, or the one body that can
// heal an old version would be refused for a limit that version predates.
//
// Basalt's version of this test was about encryption overhead making a stored
// chunk larger than its plaintext. That reason is gone with the encryption;
// this one is not.
func TestResendIsBoundedByTheChunkCeilingNotTheFileCeiling(t *testing.T) {
	r := newRig(t)
	body := []byte("a note stored before the ceiling came down")
	name := chunks.Name(body)
	if err := r.st.Chunks().Put(testVault, name, body); err != nil {
		t.Fatal(err)
	}
	uid, err := r.st.AppendEntry(testVault, store.Entry{
		Path: "note.md", Size: int64(len(body)), CTime: 1, MTime: 1, Mac: testMac, Chunks: []string{name},
	})
	if err != nil {
		t.Fatal(err)
	}
	// Lowered below the version's own size after it was stored.
	r.srv.SetPerFileMax(1)
	path, err := r.st.Chunks().Path(testVault, name)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	cl := r.dial("repairing")
	cl.hello(0)
	cl.sendJSON(wire.In{Op: "resend", Chunks: []string{name}})
	cl.recvInto("want", &wire.Want{})
	cl.sendBinary(body)
	var repaired wire.Resent
	cl.recvInto("resent", &repaired)
	if repaired.Stored != 1 || repaired.Missing != 0 {
		t.Fatalf("repair did not replace the lost body: %+v", repaired)
	}
	if got := cl.fetch(name); len(got) != 1 || string(got[0]) != string(body) {
		t.Fatalf("repaired content changed: %q", got)
	}
	if latest, err := r.st.LatestUID(testVault); err != nil || latest != uid {
		t.Fatalf("repair changed history: latest %d, expected %d; %v", latest, uid, err)
	}
}
