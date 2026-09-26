package main

import (
	"database/sql"
	"strings"
	"testing"

	"github.com/waynehoover/trewsync/internal/store"
)

// `trewd verify -deep` names a version whose declared size its chunks do not
// hold, and fails; a shallow verify does not open the bodies and passes.
func TestVerifyDeepNamesAVersionOfTheWrongSize(t *testing.T) {
	dir := seeded(t)
	dbPath, _ := store.DataDir(dir)
	onDisk(t, dbPath, func(db *sql.DB) {
		if _, err := db.Exec(`UPDATE entries SET size = size + 1 WHERE path = 'other.md'`); err != nil {
			t.Fatal(err)
		}
	})
	mustRun(t, "verify", "-data", dir)
	out, err := trew(t, "verify", "-deep", "-data", dir)
	if err == nil {
		t.Fatalf("verify -deep passed a version of the wrong size:\n%s", out)
	}
	if !strings.Contains(out, "badsize") || !strings.Contains(out, "other.md") {
		t.Fatalf("the fault does not name the reason and the note:\n%s", out)
	}
}
