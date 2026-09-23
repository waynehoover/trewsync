package store

import (
	"os"
	"strings"
	"testing"
)

// verify -deep checks the size invariant again, from what is on the disk: a
// version declaring a length its chunks do not hold is a file every reader
// assembles wrong, and the commit that should have refused it was not the
// writer (plan/protocol.md, "Chunk bodies"). The shallow pass does not look,
// because it does not open the bodies.
func TestDeepVerifyChecksEverySizeAgainstItsChunks(t *testing.T) {
	h := newTestStore(t)
	good := h.file(t, "good.md", "abc", "defg")
	bent := h.file(t, "bent.md", "hij", "klmn")
	if _, err := h.db.Exec(`UPDATE entries SET size = size + 1 WHERE vault_id = 'v1' AND uid = ?`, bent.UID); err != nil {
		t.Fatal(err)
	}

	deep, err := h.Verify(true)
	if err != nil {
		t.Fatal(err)
	}
	if len(deep.Faults) != 1 {
		t.Fatalf("verify -deep found %v, want the one size fault", deep.Faults)
	}
	f := deep.Faults[0]
	if f.Reason != "badsize" || f.UID != bent.UID || f.Path != "bent.md" ||
		!strings.Contains(f.Detail, "declares 8 bytes") || !strings.Contains(f.Detail, "hold 7") {
		t.Fatalf("the size fault is %+v", f)
	}
	shallow, err := h.Verify(false)
	if err != nil {
		t.Fatal(err)
	}
	if len(shallow.Faults) != 0 {
		t.Fatalf("a shallow pass reported %v; it opens no bodies, so it cannot know", shallow.Faults)
	}

	// A version with a chunk already reported corrupt is not also reported for
	// its size: one fault for one broken body.
	p, err := h.Chunks().Path("v1", good.Chunks[1])
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("defgXX"), 0o600); err != nil {
		t.Fatal(err)
	}
	deep, err = h.Verify(true)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range deep.Faults {
		if f.UID == good.UID && f.Reason == "badsize" {
			t.Fatalf("a corrupt body was reported twice: %v", deep.Faults)
		}
	}
}
