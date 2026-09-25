package search

import (
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// Inspection is what the index file says about itself, read without the store
// and without writing: for `trewd doctor`, which must not change what it is
// diagnosing, on a server that may not be running.
type Inspection struct {
	// OwnerEpoch and OwnerVault are the store epoch and vault the index was
	// built for; an index for another is dropped and rebuilt when the
	// endpoint next opens it.
	OwnerEpoch, OwnerVault string
	// Generation, Version and IndexedHead describe the active generation,
	// zero when there is none yet.
	Generation  int64
	Version     int
	IndexedHead int64
	// Building is whether a new generation is being built, and BuildingHead
	// the head its snapshot is of.
	Building     bool
	BuildingHead int64
	// Notes, Unreadable, TagFailures and LinkFailures are the active
	// generation's counters.
	Notes, Unreadable, TagFailures, LinkFailures int64
}

// Inspect reads the index in dataDir read-only. Absent is (false, nil).
func Inspect(dataDir string) (Inspection, bool, error) {
	path, err := filepath.Abs(filepath.Join(dataDir, FileName))
	if err != nil {
		return Inspection{}, false, err
	}
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return Inspection{}, false, nil
	}
	u := &url.URL{Scheme: "file", Path: filepath.ToSlash(path), RawQuery: "mode=ro"}
	db, err := sql.Open("sqlite", u.String()+"&_pragma=busy_timeout(5000)")
	if err != nil {
		return Inspection{}, true, err
	}
	defer db.Close()
	var in Inspection
	var owner string
	err = db.QueryRow(`SELECT value FROM meta WHERE key = 'owner'`).Scan(&owner)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return in, true, fmt.Errorf("reading the search index: %w", err)
	}
	in.OwnerEpoch, in.OwnerVault, _ = strings.Cut(owner, ownerSeparator)
	rows, err := db.Query(`SELECT ` + genCols + ` FROM generations ORDER BY gen`)
	if err != nil {
		return in, true, fmt.Errorf("reading the search index: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		g, err := scanGeneration(rows)
		if err != nil {
			return in, true, fmt.Errorf("reading the search index: %w", err)
		}
		switch g.state {
		case "active":
			in.Generation, in.Version, in.IndexedHead = g.gen, g.version, g.through
			in.Notes, in.Unreadable, in.TagFailures, in.LinkFailures = g.notes, g.unreadable, g.tagFailures, g.linkFailures
		case "building":
			in.Building, in.BuildingHead = true, g.builtHead
		}
	}
	return in, true, rows.Err()
}

// ownerSeparator separates the epoch from the vault in the owner row.
const ownerSeparator = "\x00"
