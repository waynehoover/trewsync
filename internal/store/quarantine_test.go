package store

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/waynehoover/trew/internal/chunks"
)

func TestDelayedQuarantinePreservesAcknowledgedRepair(t *testing.T) {
	for _, batched := range []bool{false, true} {
		label := "put"
		if batched {
			label = "writer"
		}
		t.Run(label, func(t *testing.T) {
			h := newTestStore(t)
			body := []byte("a shared encrypted chunk")
			e := h.file(t, "note.md", string(body))
			name := e.Chunks[0]
			p := filepath.Join(h.Chunks().VaultDir("v1"), name[:2], name)
			if err := os.WriteFile(p, []byte("bit rot"), 0o600); err != nil {
				t.Fatal(err)
			}
			// Two fetches read the corrupt file before either quarantines it.
			// The second session retains its corruption observation during repair.
			_, firstErr := h.Chunks().Get("v1", name)
			_, delayedErr := h.Chunks().Get("v1", name)
			if !errors.Is(firstErr, chunks.ErrCorrupt) || !errors.Is(delayedErr, chunks.ErrCorrupt) {
				t.Fatalf("expected two corruption observations: %v / %v", firstErr, delayedErr)
			}
			if err := h.Quarantine("v1", name); err != nil {
				t.Fatal(err)
			}
			if batched {
				w := h.Chunks().NewWriter("v1")
				addErr := w.Add(name, body)
				closeErr := w.Close()
				if addErr != nil || closeErr != nil {
					t.Fatalf("repair batch: add=%v close=%v", addErr, closeErr)
				}
			} else if err := h.Chunks().Put("v1", name, body); err != nil {
				t.Fatal(err)
			}
			// The healed chunk is acknowledged by an entry commit before the
			// delayed fetch acts on its old corruption observation.
			healed := e
			healed.Path = "another-note.md"
			uid, err := h.AppendCurrent("v1", healed, 0, 0)
			if err != nil {
				t.Fatal(err)
			}
			if err := h.Quarantine("v1", name); err != nil {
				t.Fatal(err)
			}
			got, err := h.Chunks().Get("v1", name)
			if err != nil || string(got) != string(body) || !h.Chunks().Has("v1", name) {
				t.Fatalf("delayed quarantine removed acknowledged repair uid=%d: body=%q err=%v", uid, got, err)
			}
			if quarantined, err := os.ReadFile(p + ".corrupt"); err != nil || string(quarantined) != "bit rot" {
				t.Fatalf("original corruption evidence replaced: body=%q err=%v", quarantined, err)
			}
		})
	}
}
