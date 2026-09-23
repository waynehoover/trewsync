package server

import (
	"os"
	"testing"

	"github.com/waynehoover/trew/internal/chunks"
	"github.com/waynehoover/trew/internal/store"
	"github.com/waynehoover/trew/internal/wire"
)

func TestResendIncludesEncryptionOverheadAtALowFileCeiling(t *testing.T) {
	r := newRig(t)
	r.srv.SetPerFileMax(1)
	// One plaintext byte still has a nonce and authentication tag on disk.
	body := []byte("one-byte note plus encryption overhead")
	name := chunks.Name(body)
	if err := r.st.Chunks().Put(testVault, name, body); err != nil {
		t.Fatal(err)
	}
	uid, err := r.st.AppendEntry(testVault, store.Entry{
		Path: "note.md", Size: 1, CTime: 1, MTime: 1, Mac: testMac, Chunks: []string{name},
	})
	if err != nil {
		t.Fatal(err)
	}
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
