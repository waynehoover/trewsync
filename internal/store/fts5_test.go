package store

import (
	"database/sql"
	"path/filepath"
	"testing"
)

// TestThePinnedDriverHasFTS5 is the M0 probe PLAN §2.5 rests on.
//
// Search is built on an FTS5 virtual table, and whether FTS5 is compiled into
// the pure-Go driver is a property of the pinned modernc.org/sqlite version,
// not of SQLite in general. The design reviews checked it with the local
// sqlite3 CLI, which answers a different question. This asks the driver the
// server actually links, including the two things search needs beyond CREATE:
// ranked MATCH and the unicode61 tokenizer folding diacritics, so "resume"
// finds "résumé".
func TestThePinnedDriverHasFTS5(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "fts5.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	if _, err := db.Exec(`CREATE VIRTUAL TABLE notes USING fts5(path, body,
		tokenize = 'unicode61 remove_diacritics 2')`); err != nil {
		t.Fatalf("the pinned driver cannot create an FTS5 table: %v", err)
	}
	for _, row := range [][2]string{
		{"a.md", "My résumé, updated in September"},
		{"b.md", "Nothing to see here"},
	} {
		if _, err := db.Exec(`INSERT INTO notes (path, body) VALUES (?, ?)`, row[0], row[1]); err != nil {
			t.Fatal(err)
		}
	}

	var path string
	err = db.QueryRow(`SELECT path FROM notes WHERE notes MATCH ? ORDER BY bm25(notes) LIMIT 1`, "resume").Scan(&path)
	if err != nil {
		t.Fatalf("ranked MATCH failed: %v", err)
	}
	if path != "a.md" {
		t.Fatalf("MATCH resume found %q, want a.md", path)
	}
}
