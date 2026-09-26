package mcp

import (
	"context"
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"

	"github.com/waynehoover/trewsync/internal/chunks"
	"github.com/waynehoover/trewsync/internal/search"
)

// A uid names a version only within its store epoch (PLAN.md section 2.8), so
// a mutation names the epoch its uids were read under and is refused as stale
// when the store has another. Operation.Epoch alone catches a restore between
// preparing and committing; this is the rest, a restore between the read and
// the write, where the restored store has issued the same uid to other bytes.
func TestAnEpochBindsTheUIDsAcrossABackupAndARestore(t *testing.T) {
	r := newRig(t)
	a := r.writer("agent")
	base := r.write("n.md", "one\n")
	oldEpoch := r.epoch()
	keyed := map[string]any{"path": "n.md", "base": base, "epoch": oldEpoch, "text": "two\n", "idempotencyKey": "k"}
	second := wrote(t, invoke(t, a.cs, "append_note", keyed)).Entries[0].UID
	backup := filepath.Join(t.TempDir(), "backup")
	if _, err := r.st.Backup(backup, true); err != nil {
		t.Fatal(err)
	}
	// The original goes on, and the agent reads what it wrote next.
	third := wrote(t, invoke(t, a.cs, "append_note", map[string]any{"path": "n.md", "base": second,
		"epoch": oldEpoch, "text": "three\n"})).Entries[0].UID

	// The backup is restored, which is serving it: a new epoch, the same
	// token rows, and uids above the snapshot issued again, here to a
	// device's other words at the same path.
	restored := newRig(t, at(backup))
	if restored.epoch() == oldEpoch {
		t.Fatal("the restore kept its epoch")
	}
	if uid := restored.write("n.md", "a device's other words\n"); uid != third {
		t.Fatalf("the restored store issued uid %d, and the test needs it to reissue %d", uid, third)
	}
	cs := restored.mustConnect(a.token, "")

	// The agent's base names uid 3, and so does the restored head: only the
	// epoch tells them apart. Refused, and nothing written.
	stale := map[string]any{"path": "n.md", "base": third, "epoch": oldEpoch, "text": "four\n"}
	if code := refused(t, invoke(t, cs, "append_note", stale)); code != "stale" {
		t.Fatalf("a base from before the restore: %s", code)
	}
	if got := restored.bytesAt(restored.head("n.md")); got != "a device's other words\n" {
		t.Fatalf("the restored note reads %q", got)
	}
	// The retry of the keyed request from before the backup, sent as it was
	// sent, is not replayed: its reply names the old history's uids.
	if code := refused(t, invoke(t, cs, "append_note", keyed)); code != "stale" {
		t.Fatalf("a key from before the restore: %s", code)
	}
	// A preview from before the restore cannot be applied after it either.
	p := previewed(t, invoke(t, a.cs, "add_tags", map[string]any{"paths": []any{"n.md"}, "tags": []any{"t"}}))
	if code := refused(t, invoke(t, cs, "add_tags", apply(map[string]any{"paths": []any{"n.md"}, "tags": []any{"t"}}, p))); code != "stale" {
		t.Fatalf("a preview from before the restore: %s", code)
	}
	if restored.operations() != 1 {
		t.Fatalf("the restored store has %d operations, the one it was backed up with", restored.operations())
	}

	// Read again under the restored store's epoch, the same base is the
	// version the agent has now read, and the write goes ahead: the epoch was
	// all that stood between the agent and bytes it never read.
	e := invoke(t, cs, "read_note", map[string]any{"path": "n.md"})
	var read struct {
		UID   int64  `json:"uid"`
		Epoch string `json:"epoch"`
	}
	e.trusted(t, &read)
	if read.UID != third || read.Epoch != restored.epoch() {
		t.Fatalf("the read after the restore: %s", e.raw)
	}
	stale["epoch"] = read.Epoch
	wrote(t, invoke(t, cs, "append_note", stale))
	if got := restored.bytesAt(restored.head("n.md")); got != "a device's other words\nfour\n" {
		t.Fatalf("the note reads %q", got)
	}
}

// heldIndex is the search index as a move meets it when the worker has not
// reached the head: it narrows nothing, and waiting for it does not help.
type heldIndex struct{ *search.Index }

func (h heldIndex) Await(context.Context, int64) bool { return false }

func (h heldIndex) Backlinks(ctx context.Context, head int64, keys []string) (search.Backlinks, error) {
	b, err := h.Index.Backlinks(ctx, head, keys)
	return search.Backlinks{Generation: b.Generation, IndexedHead: b.IndexedHead - 1,
		Why: "held behind the head for the test"}, err
}

func withHeldIndex() rigOption {
	return func(_ *Config, s *rigSettings) {
		s.wrap = func(idx *search.Index) SearchIndex { return heldIndex{idx} }
	}
}

// A move's backlinks through the link index (M5 task 6): in a vault of more
// notes than the scan reads, a move plans through the index when it has
// indexed the head, reading only the notes that may link to the note, and the
// backlink a device has just written is in the plan; with the index behind,
// the same move reads every note, as Basalt did, and so is scan_incomplete,
// never a plan without a backlink.
func TestAMoveThroughTheLinkIndexAndWithoutIt(t *testing.T) {
	build := func(r *rig) int64 {
		for i := 0; i < 600; i++ {
			r.write(fmt.Sprintf("bulk/%03d.md", i), "nothing to see here\n")
		}
		src := r.write("topic.md", "# Topic\n")
		r.write("links/one.md", "see [[topic]]\n")
		return src
	}
	limits := withLimits(Limits{TokenBurst: 1000, TokenRate: 1000})

	r := newRig(t, limits)
	a := r.writer("agent")
	src := build(r)
	r.indexed()
	// Written just before the preview: the index may not have it yet, and
	// the preview waits for it rather than plan without it.
	d := r.device("phone")
	d.put("links/two.md", "also [the topic](../topic.md)\n", 0)
	args := map[string]any{"path": "topic.md", "base": src, "to": "moved/topic.md", "epoch": r.epoch()}
	p := previewed(t, invoke(t, a.cs, "move_note", args))
	if p.Scan.Method != "index" || p.Count != 3 {
		t.Fatalf("the preview through the index: %s", p.raw)
	}
	w := wrote(t, invoke(t, a.cs, "move_note", apply(args, p)))
	// Four: the two backlinks, the move, and the folder it moves into.
	if got := r.bytesAt(r.head("links/two.md")); got != "also [the topic](../moved/topic.md)\n" || w.Count != 4 {
		t.Fatalf("the new backlink reads %q after %+v", got, w.Entries)
	}

	// The same vault with the index held behind the head.
	held := newRig(t, limits, withHeldIndex())
	b := held.writer("agent")
	src = build(held)
	held.indexed()
	args = map[string]any{"path": "topic.md", "base": src, "to": "moved/topic.md", "epoch": held.epoch()}
	if code := refused(t, invoke(t, b.cs, "move_note", args)); code != "scan_incomplete" {
		t.Fatalf("a move over 600 notes with the index behind: %s", code)
	}
	// Moved without rewriting links, nothing else is read, and it goes
	// ahead.
	args["updateLinks"] = false
	p = previewed(t, invoke(t, b.cs, "move_note", args))
	if p.Scan.Method != "none" || p.Count != 1 {
		t.Fatalf("a move that leaves links alone: %s", p.raw)
	}

	// And in a small vault the held index still misses nothing: every note
	// is read.
	small := newRig(t, limits, withHeldIndex())
	c := small.writer("agent")
	src = small.write("topic.md", "# Topic\n")
	small.write("one.md", "see [[topic]]\n")
	small.indexed()
	small.write("two.md", "and a backlink the index never saw: [[topic]]\n")
	args = map[string]any{"path": "topic.md", "base": src, "to": "moved.md", "epoch": small.epoch()}
	p = previewed(t, invoke(t, c.cs, "move_note", args))
	if p.Scan.Method != "vault" || p.Count != 3 || !strings.Contains(p.Scan.Why, "held") {
		t.Fatalf("the preview with the index held: %s", p.raw)
	}
	wrote(t, invoke(t, c.cs, "move_note", apply(args, p)))
	if got := small.bytesAt(small.head("two.md")); got != "and a backlink the index never saw: [[moved]]\n" {
		t.Fatalf("the backlink the index never saw reads %q", got)
	}
}

// The seams a crash matrix kills the server at (PLAN.md M5 task 9) come in
// order, around one commit: bodies durable and nothing committed; committed
// and nothing broadcast; broadcast and nothing replied.
func TestAWritesSeamsComeInOrderAroundItsCommit(t *testing.T) {
	r := newRig(t)
	a := r.writer("agent")
	d := r.device("phone")
	var seen []string
	r.h.seam = func(point string) {
		head, _ := r.st.LatestUID(testVault)
		seen = append(seen, fmt.Sprintf("%s@%d", point, head))
		if point == SeamCommitted {
			if _, err := d.batchWith(head, 0); err == nil {
				t.Error("the device had the entry before the broadcast")
			}
		}
	}
	w := wrote(t, invoke(t, a.cs, "create_note", map[string]any{"path": "n.md", "content": "x"}))
	uid := w.Entries[0].UID
	want := fmt.Sprintf("[%s@%d %s@%d %s@%d]", SeamBodies, uid-1, SeamCommitted, uid, SeamBroadcast, uid)
	if got := fmt.Sprint(seen); got != want {
		t.Fatalf("seams %s, want %s", got, want)
	}

	// A write of several bodies passes SeamUploading first, with the first
	// body durable and the second not yet written.
	r.h.seam = nil
	r.write("one.md", "one\n")
	head := r.write("two.md", "two\n")
	args := map[string]any{"paths": []any{"one.md", "two.md"}, "tags": []any{"crash"}}
	p := previewed(t, invoke(t, a.cs, "add_tags", args))
	seen = nil
	var stored map[string]bool
	r.h.seam = func(point string) {
		seen = append(seen, point)
		if point == SeamUploading {
			stored = chunkNames(t, r.st.Chunks().VaultDir(testVault))
		}
	}
	w = wrote(t, invoke(t, a.cs, "add_tags", apply(args, p)))
	r.h.seam = nil
	if got := fmt.Sprint(seen); got != fmt.Sprint([]string{SeamUploading, SeamBodies, SeamCommitted, SeamBroadcast}) {
		t.Fatalf("the seams of a write of two bodies: %s", got)
	}
	var durable int
	for _, e := range w.Entries {
		if stored[chunks.Name([]byte(r.bytesAt(e.UID)))] {
			durable++
		}
	}
	if len(w.Entries) != 2 || durable != 1 || w.Entries[0].UID != head+1 {
		t.Fatalf("at %s, %d of the %d bodies were durable, want 1 of 2", SeamUploading, durable, len(w.Entries))
	}
}

// chunkNames is every body stored under dir.
func chunkNames(t *testing.T, dir string) map[string]bool {
	t.Helper()
	names := map[string]bool{}
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() && chunks.ValidName(d.Name()) {
			names[d.Name()] = true
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return names
}
