package main

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/waynehoover/trewsync/internal/wire"
)

// Every serve builds the search index, not only one under -mcp, so a device's
// search (`trew search`) is index-assisted by default: once the index has
// caught up, a search against a plain `trewd serve` reports the index usable,
// how far it has indexed, and a complete answer that read fewer notes than
// the vault holds.
func TestADeviceSearchIsIndexAssistedWithoutMCP(t *testing.T) {
	dir := t.TempDir()
	addr := fmt.Sprintf("127.0.0.1:%d", freeTestPort(t))
	ctx, cancel := context.WithCancel(context.Background())
	out := &safeBuffer{}
	done := make(chan error, 1)
	go func() { done <- run(ctx, []string{"serve", "-data", dir, "-addr", addr}, out) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("serve ended with %v", err)
			}
		case <-time.After(15 * time.Second):
			t.Error("the server did not stop")
		}
	})
	waitForServer(t, addr, out)

	dctx, dcancel := context.WithTimeout(context.Background(), time.Minute)
	defer dcancel()
	dialFirstDevice(t, "ws://"+addr, readFirstInvite(t, dir)).conn.CloseNow()
	dev, err := connectDevice(dctx, addr)
	if err != nil {
		t.Fatal(err)
	}
	defer dev.conn.CloseNow()

	const notes = 20
	var head int64
	for i := 0; i < notes; i++ {
		text := fmt.Sprintf("an ordinary note, number %d\n", i)
		if i%5 == 0 {
			text += "the lighthouse keeper's log\n"
		}
		if head, err = dev.put(fmt.Sprintf("notes/%02d.md", i), text, 0); err != nil {
			t.Fatal(err)
		}
	}

	search := func() wire.Searched {
		t.Helper()
		if err := dev.send(wire.In{Op: "search", ID: dev.id(), Query: "lighthouse"}); err != nil {
			t.Fatal(err)
		}
		m, err := dev.until("searched")
		if err != nil {
			t.Fatal(err)
		}
		b, _ := json.Marshal(m)
		var s wire.Searched
		if err := json.Unmarshal(b, &s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	deadline := time.Now().Add(30 * time.Second)
	s := search()
	for !(s.Index.Usable && s.IndexedHead >= head) {
		if time.Now().After(deadline) {
			t.Fatalf("a search against serve without -mcp never used the index: %+v\n%s", s, out.String())
		}
		// Slower than the device budget of five searches a second, so polling
		// is never refused toomany however long the build takes.
		time.Sleep(250 * time.Millisecond)
		s = search()
	}
	if !s.Complete || s.IndexedHead != s.Head || len(s.Matches) != notes/5 || s.Scanned >= notes {
		t.Fatalf("the index-assisted search: complete %v, indexed %d of head %d, %d matches, %d read of %d notes",
			s.Complete, s.IndexedHead, s.Head, len(s.Matches), s.Scanned, notes)
	}
}
