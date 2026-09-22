package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/waynehoover/telimus/internal/store"
	"github.com/waynehoover/telimus/internal/wire"
)

func TestFanoutSharesImmutableFramesAcrossLiveAndCatchingUpPeers(t *testing.T) {
	hub := NewHub()
	first, second, catchingUp, origin := newBareSession(t, 8), newBareSession(t, 8), newBareSession(t, 8), newBareSession(t, 8)
	for _, s := range []*Session{first, second, origin} {
		s.catchupDone = true
	}
	for _, s := range []*Session{first, second, catchingUp, origin} {
		hub.join("v1", s)
	}
	e := store.Entry{UID: 7, Path: "note.md", Mac: testMac, Chunks: []string{strings.Repeat("a", 64)}}
	hub.broadcast("v1", e, origin)
	a, b, own := <-first.out, <-second.out, <-origin.out
	if len(catchingUp.pending) != 1 {
		t.Fatalf("catch-up buffered %d changes", len(catchingUp.pending))
	}
	buffered := catchingUp.pending[0].frame
	// The same immutable backing bytes must serve every peer; retaining a
	// separate attachment-sized encoding per peer defeats the allocation bound.
	if &a.data[0] != &b.data[0] || &a.data[0] != &buffered[0] {
		t.Fatal("one update retains a different encoded body for each peer")
	}
	if first.queued.Load() != int64(len(a.data)) || second.queued.Load() != int64(len(b.data)) || catchingUp.pendingBytes != int64(len(buffered)) {
		t.Fatal("sharing bytes changed per-peer queue accounting")
	}
	var ownBatch wire.Batch
	if err := json.Unmarshal(own.data, &ownBatch); err != nil || ownBatch.From != 7 || ownBatch.To != 7 || len(ownBatch.Entries) != 0 || !bytes.Contains(own.data, []byte(`"entries":[]`)) {
		t.Fatalf("origin frame: %s %v", own.data, err)
	}
	want := append([]byte(nil), a.data...)
	// Reusing the source entry for another commit must not mutate an old frame
	// retained by a slow or catching-up peer.
	e.UID = 8
	e.Path = "next.md"
	e.Chunks[0] = strings.Repeat("b", 64)
	hub.broadcast("v1", e, origin)
	if !bytes.Equal(a.data, want) || !bytes.Equal(buffered, want) {
		t.Fatal("a later broadcast changed the retained earlier update")
	}
	first.queued.Add(-int64(len(a.data)))
	first.inflight.Add(-1)
	if second.queued.Load() <= 0 || catchingUp.pendingBytes != int64(len(buffered)+len(catchingUp.pending[1].frame)) {
		t.Fatal("draining one peer changed another peer's accounting")
	}
	if cursor := catchingUp.flushPending(6); cursor != 8 {
		t.Fatalf("catch-up reached %d, want 8", cursor)
	}
	got := drainBatchFrames(t, catchingUp)
	if len(got) != 2 || got[0].To != 7 || got[1].To != 8 || got[0].Entries[0].Path != "note.md" || got[0].Entries[0].Chunks[0] != strings.Repeat("a", 64) || got[1].Entries[0].Path != "next.md" {
		t.Fatalf("catch-up lost or changed retained entries: %+v", got)
	}
}

func BenchmarkLiveFanout(b *testing.B) {
	for _, count := range []int{1, 512} {
		for _, peers := range []int{2, 8, 32} {
			b.Run(fmt.Sprintf("chunks=%d/peers=%d", count, peers), func(b *testing.B) {
				e := store.Entry{UID: 1, Path: strings.Repeat("p", 160), Device: "laptop", Mac: testMac, Size: int64(count) * 4096, Chunks: make([]string, count)}
				for i := range e.Chunks {
					e.Chunks[i] = fmt.Sprintf("%064x", i)
				}
				hub := NewHub()
				sessions := make([]*Session, peers)
				for i := range sessions {
					sessions[i] = &Session{out: make(chan outFrame, 1), dead: make(chan struct{}), catchupDone: true}
					hub.join("v", sessions[i])
				}
				b.ReportAllocs()
				b.ResetTimer()
				for b.Loop() {
					hub.broadcast("v", e, sessions[0])
					for _, s := range sessions {
						f := <-s.out
						s.queued.Add(-int64(len(f.data)))
						s.inflight.Add(-1)
					}
				}
			})
		}
	}
}
