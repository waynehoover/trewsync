package store

import (
	"fmt"
	"strings"
	"testing"
)

func renameCurrent(t *testing.T, h *harness, from, to, body string) int64 {
	t.Helper()
	base, err := h.CurrentUID("v1", from)
	if err != nil {
		t.Fatal(err)
	}
	uid, err := h.AppendCurrent("v1", Entry{
		Path: to, Prev: from, Size: int64(len(body)), Mac: testMac,
		Chunks: h.put(t, "v1", body),
	}, 0, base)
	if err != nil {
		t.Fatal(err)
	}
	return uid
}

func TestPurgePreservesRenameSourceHeads(t *testing.T) {
	for _, useRememberedHead := range []bool{false, true} {
		name := "new-file-base"
		if useRememberedHead {
			name = "remembered-retirement-base"
		}
		t.Run(name, func(t *testing.T) {
			h := newTestStore(t)
			h.file(t, "from.md", "original content")
			retired := renameCurrent(t, h, "from.md", "to.md", "edited while moving")
			h.file(t, "to.md", "obsolete destination revision")
			h.file(t, "to.md", "latest destination content")

			preview, err := h.Reclaimable("v1", 0)
			if err != nil {
				t.Fatal(err)
			}
			if preview.Versions != 1 {
				t.Errorf("preview offers %d versions, including the required source retirement", preview.Versions)
			}
			report, err := h.Purge("v1", 0)
			if err != nil {
				t.Fatal(err)
			}
			if report.VersionsRemoved != 1 || report.VersionsRemoved != preview.Versions ||
				report.ChunksDeleted != preview.Bodies || report.BytesDeleted != preview.Bytes {
				t.Errorf("purge and preview disagree with retained history: report=%+v preview=%+v", report, preview)
			}
			head, gone, err := pathHead(h.db, "v1", "from.md")
			if err != nil || head != retired || !gone {
				t.Errorf("purge resurrected the source: head=%d deleted=%v err=%v; want retirement=%d", head, gone, err, retired)
			}
			// The retained metadata must remain readable, with its authenticated
			// body intact; it is also delivered to newly paired clients.
			entry, ok, err := h.EntryByUID("v1", retired)
			if err != nil || !ok || len(entry.Chunks) != 1 {
				t.Errorf("lost required rename entry: entry=%+v ok=%v err=%v", entry, ok, err)
			} else if body, err := h.Chunks().Get("v1", entry.Chunks[0]); err != nil || string(body) != "edited while moving" {
				t.Errorf("lost retained rename body: body=%q err=%v", body, err)
			}
			second, err := h.Purge("v1", 0)
			if err != nil || second.VersionsRemoved != 0 || second.ChunksDeleted != 0 {
				t.Errorf("purge is not idempotent: report=%+v err=%v", second, err)
			}
			base := int64(0)
			if useRememberedHead {
				base = retired
			}
			if _, err := h.AppendCurrent("v1", Entry{Path: "from.md", Mac: testMac}, base, 0); err != nil {
				t.Errorf("cannot recreate the moved-away path with base=%d: %v", base, err)
			}
		})
	}
}

func TestPurgePreservesChainedRenameHeads(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "a.md", "original")
	aHead := renameCurrent(t, h, "a.md", "b.md", "first move")
	bHead := renameCurrent(t, h, "b.md", "c.md", "second move")
	cHead := h.file(t, "c.md", "latest content").UID
	if _, err := h.Purge("v1", 0); err != nil {
		t.Fatal(err)
	}
	for path, want := range map[string]int64{"a.md": aHead, "b.md": bHead, "c.md": cHead} {
		uid, deleted, err := pathHead(h.db, "v1", path)
		if err != nil || uid != want || deleted != (path != "c.md") {
			t.Errorf("logical head changed for %s: uid=%d deleted=%v err=%v; want uid=%d", path, uid, deleted, err, want)
		}
	}
}

func TestPurgeDropsRenameHistoryAfterSourceReuse(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "from.md", "original")
	retired := renameCurrent(t, h, "from.md", "to.md", "moving")
	target := h.file(t, "to.md", "updated destination")
	h.file(t, "from.md", "new incarnation")
	source := h.file(t, "from.md", "new incarnation updated")
	report, err := h.Purge("v1", 0)
	if err != nil || report.VersionsAfter != 2 {
		t.Fatalf("obsolete retirement was retained: report=%+v err=%v", report, err)
	}
	if _, ok, err := h.EntryByUID("v1", retired); err != nil || ok {
		t.Errorf("obsolete rename survived: ok=%v err=%v", ok, err)
	}
	for _, want := range []Entry{source, target} {
		uid, deleted, err := pathHead(h.db, "v1", want.Path)
		if err != nil || deleted || uid != want.UID {
			t.Errorf("source reuse changed at %s: uid=%d deleted=%v err=%v", want.Path, uid, deleted, err)
		}
	}
}

func TestPurgeRollsBackIfARequiredRenameIsRemoved(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "from.md", "original")
	retired := renameCurrent(t, h, "from.md", "to.md", "moving")
	obsolete := h.file(t, "to.md", "old destination")
	h.file(t, "to.md", "current destination")
	// Model an erroneous deletion of a required record while ordinary
	// history is pruned. Checking only the post-delete number of paths
	// accepted this: from.md and to.md still each have one entry.
	if _, err := h.db.Exec(`CREATE TRIGGER remove_required_retirement
		AFTER DELETE ON entries WHEN OLD.uid = ` + fmt.Sprint(obsolete.UID) + `
		BEGIN DELETE FROM entries WHERE vault_id = 'v1' AND uid = ` + fmt.Sprint(retired) + `; END`); err != nil {
		t.Fatal(err)
	}
	if report, err := h.Purge("v1", 0); err == nil || report != (PurgeReport{}) {
		t.Fatalf("a required deletion was committed: report=%+v err=%v", report, err)
	}
	uid, deleted, err := pathHead(h.db, "v1", "from.md")
	if err != nil || uid != retired || !deleted {
		t.Errorf("rollback lost the source retirement: uid=%d deleted=%v err=%v", uid, deleted, err)
	}
	if _, ok, err := h.EntryByUID("v1", obsolete.UID); err != nil || !ok {
		t.Errorf("rollback lost ordinary history: ok=%v err=%v", ok, err)
	}
}

func TestStatsAndCapacityExcludeRetiredRenameSources(t *testing.T) {
	h := newTestStore(t)
	h.file(t, "from.md", strings.Repeat("a", 100))
	renameCurrent(t, h, "from.md", "to.md", strings.Repeat("a", 100))
	h.file(t, "to.md", "small")
	stats, err := h.Stats("v1")
	if err != nil || stats.Files != 1 || stats.Bytes != 5 {
		t.Errorf("retired source is counted as live: stats=%+v err=%v", stats, err)
	}
	over, err := h.FilesOver("v1", 10)
	if err != nil || len(over) != 0 {
		t.Errorf("retired source blocks a smaller limit: over=%+v err=%v", over, err)
	}
	deleted, _, err := h.Deleted("v1", true, 0, 0)
	if err != nil || len(deleted) != 0 {
		t.Errorf("rename appeared as a deleted note: deleted=%+v err=%v", deleted, err)
	}
	// Reusing the source name creates another real file, which must count.
	reused := h.file(t, "from.md", "new content")
	stats, err = h.Stats("v1")
	if err != nil || stats.Files != 2 || stats.Bytes != 16 {
		t.Errorf("reused source was hidden: stats=%+v err=%v", stats, err)
	}
	over, err = h.FilesOver("v1", 10)
	if err != nil || len(over) != 1 || over[0].Size != 11 {
		t.Errorf("reused source escaped the size limit: over=%+v err=%v", over, err)
	}
	// Its later deletion is real and remains available to recovery, even
	// though an earlier incarnation of the same name was moved away.
	if _, err := h.AppendCurrent("v1", Entry{Path: "from.md", Deleted: true, Mac: testMac}, reused.UID, 0); err != nil {
		t.Fatal(err)
	}
	deleted, _, err = h.Deleted("v1", true, 0, 0)
	if err != nil || len(deleted) != 1 || deleted[0].Path != "from.md" || deleted[0].RestorableUID != reused.UID {
		t.Errorf("real deletion after name reuse was hidden: deleted=%+v err=%v", deleted, err)
	}
	stats, err = h.Stats("v1")
	if err != nil || stats.Files != 1 || stats.Deleted != 1 || stats.Recoverable != 1 {
		t.Errorf("real deletion after name reuse was miscounted: stats=%+v err=%v", stats, err)
	}
}
