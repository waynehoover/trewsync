package store

import "testing"

func TestPurgePreservesDeletionOfAReusedName(t *testing.T) {
	for _, editDestination := range []bool{false, true} {
		name := "rename-is-destination-head"
		if editDestination {
			name = "destination-edited"
		}
		t.Run(name, func(t *testing.T) {
			h := newTestStore(t)
			h.file(t, "from.md", "original")
			renameCurrent(t, h, "from.md", "to.md", "original")
			reused := h.file(t, "from.md", "new incarnation")
			if _, err := h.AppendCurrent("v1", Entry{Path: "from.md", Deleted: true, Mac: testMac}, reused.UID, 0); err != nil {
				t.Fatal(err)
			}
			if editDestination {
				h.file(t, "to.md", "edited after moving")
			}
			check := func() {
				t.Helper()
				deleted, _, err := h.Deleted("v1", true, 0, 0)
				if err != nil || len(deleted) != 1 || deleted[0].Path != "from.md" || deleted[0].RestorableUID != reused.UID {
					t.Fatalf("real deletion or its retained version disappeared: deleted=%+v err=%v", deleted, err)
				}
				stats, err := h.Stats("v1")
				if err != nil || stats.Deleted != 1 || stats.Recoverable != 1 || stats.Files != 1 {
					t.Fatalf("wrong deletion counts: stats=%+v err=%v", stats, err)
				}
				entry, ok, err := h.EntryByUID("v1", reused.UID)
				if err != nil || !ok || len(entry.Chunks) != 1 {
					t.Fatalf("missing recoverable version: entry=%+v ok=%v err=%v", entry, ok, err)
				}
				body, err := h.Chunks().Get("v1", entry.Chunks[0])
				if err != nil || string(body) != "new incarnation" {
					t.Fatalf("lost the advertised recoverable content: body=%q err=%v", body, err)
				}
			}
			check()
			predicted, err := h.Reclaimable("v1", 0)
			if err != nil {
				t.Fatal(err)
			}
			report, err := h.Purge("v1", 0)
			if err != nil {
				t.Fatal(err)
			}
			if report.VersionsRemoved != predicted.Versions || report.ChunksDeleted != predicted.Bodies || report.BytesDeleted != predicted.Bytes {
				t.Fatalf("purge differs from preview: report=%+v predicted=%+v", report, predicted)
			}
			check()
			again, err := h.Purge("v1", 0)
			if err != nil || again.VersionsRemoved != 0 || again.ChunksDeleted != 0 {
				t.Fatalf("purge is not idempotent: %+v err=%v", again, err)
			}
			check()
		})
	}
}

func TestPurgeKeepsLegacyRenameDeletionsSuppressed(t *testing.T) {
	for _, deleteFirst := range []bool{false, true} {
		name := "rename-first"
		if deleteFirst {
			name = "delete-first"
		}
		t.Run(name, func(t *testing.T) {
			h := newTestStore(t)
			old := h.file(t, "from.md", "original")
			remove := func() {
				if _, err := h.AppendEntry("v1", Entry{Path: "from.md", Deleted: true, Mac: testMac}); err != nil {
					t.Fatal(err)
				}
			}
			if deleteFirst {
				remove()
			}
			if _, err := h.AppendEntry("v1", Entry{Path: "to.md", Prev: "from.md", Size: old.Size, Chunks: old.Chunks, Mac: testMac}); err != nil {
				t.Fatal(err)
			}
			if !deleteFirst {
				remove()
			}
			h.file(t, "to.md", "new destination version")
			for range 2 {
				if _, err := h.Purge("v1", 0); err != nil {
					t.Fatal(err)
				}
				got, _, err := h.Deleted("v1", true, 0, 0)
				if err != nil || len(got) != 0 {
					t.Fatalf("legacy rename became a deletion: %+v err=%v", got, err)
				}
			}
		})
	}
}

func TestPurgeDoesNotPromiseContentForARetainedDeletionPredecessor(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "from.md", "original")
	renameCurrent(t, h, "from.md", "to.md", "original")
	reused := h.file(t, "from.md", "new incarnation")
	for range 2 {
		if _, err := h.AppendEntry("v1", Entry{Path: "from.md", Deleted: true, Mac: testMac}); err != nil {
			t.Fatal(err)
		}
	}
	before, _, err := h.Deleted("v1", true, 0, 0)
	if err != nil || len(before) != 1 || before[0].RestorableUID != reused.UID {
		t.Fatalf("before=%+v err=%v", before, err)
	}
	for range 2 {
		predicted, err := h.Reclaimable("v1", 0)
		if err != nil {
			t.Fatal(err)
		}
		report, err := h.Purge("v1", 0)
		if err != nil {
			t.Fatal(err)
		}
		if predicted.Versions != report.VersionsRemoved || predicted.Bodies != report.ChunksDeleted || predicted.Bytes != report.BytesDeleted {
			t.Fatalf("preview=%+v report=%+v", predicted, report)
		}
		after, _, err := h.Deleted("v1", true, 0, 0)
		if err != nil || len(after) != 1 || after[0].RestorableUID != 0 {
			t.Fatalf("a retained deletion was advertised as content: %+v err=%v", after, err)
		}
		stats, err := h.Stats("v1")
		if err != nil || stats.Recoverable != 0 || stats.Deleted != 1 {
			t.Fatalf("stats=%+v err=%v", stats, err)
		}
		if _, ok, err := h.EntryByUID("v1", reused.UID); err != nil || ok {
			t.Fatalf("unneeded content survived: ok=%v err=%v", ok, err)
		}
		if h.Chunks().Has("v1", reused.Chunks[0]) {
			t.Fatal("purged unreferenced content body survived")
		}
	}
}
