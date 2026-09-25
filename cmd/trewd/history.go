package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"time"

	"github.com/waynehoover/trew/internal/store"
)

// The rest of the escape hatch (PLAN.md M5.5, docs/operations.md): a path's
// history and the vault's deleted notes, read from the store with nothing but
// the binary, so the question "is this note lost?" has an answer from the
// shell. Both read the store directly, read-only, under the shared data lock,
// beside a live server, as `trewd cat` does.

// cmdHistory lists a path's versions, newest first: each uid, what it is, who
// wrote it, when by their clock, its size, and the agent operation that wrote
// it when one did. `trewd cat -path P -uid N` prints any of them.
func cmdHistory(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("history", flag.ContinueOnError)
	dataDir := dataFlags(fs)
	vault := fs.String("vault", defaultVault, "the vault to read")
	path := fs.String("path", "", "the note's path in the vault (required)")
	limit := fs.Int("limit", 50, "the most versions to list, up to 500")
	before := fs.Int64("before", 0, "list only versions older than this uid, to page back")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *path == "" {
		return errors.New("history needs -path, the note's path in the vault")
	}
	st, done, err := openToRead(*dataDir, "read")
	if err != nil {
		return err
	}
	defer done()

	versions, err := st.HistoryForPath(*vault, *path, *before, *limit)
	if err != nil {
		return err
	}
	if len(versions) == 0 {
		if *before > 0 {
			fmt.Fprintf(out, "no versions of %q older than uid %d\n", *path, *before)
			return nil
		}
		return fmt.Errorf("vault %q has never held %q (a path is exact: case, spaces and folders count)", *vault, *path)
	}
	head, gone, err := st.Head(*vault, *path)
	if err != nil {
		return err
	}
	uids := make([]int64, len(versions))
	for i, e := range versions {
		uids[i] = e.UID
	}
	ops, err := st.WrittenBy(*vault, uids)
	if err != nil {
		return err
	}

	fmt.Fprintf(out, "%q in vault %q, newest first:\n", *path, *vault)
	if gone && head > versions[0].UID {
		// The head is a rename away, at another path.
		if e, ok, err := st.EntryByUID(*vault, head); err == nil && ok {
			fmt.Fprintf(out, "  uid %-6d renamed to %q by %s, %s\n", e.UID, e.Path, e.Device, clock(e.MTime))
		}
	}
	for _, e := range versions {
		what := fmt.Sprintf("%d bytes", e.Size)
		switch {
		case e.Deleted:
			what = "deleted"
		case e.Folder:
			what = "a folder"
		case e.Prev != "":
			what += fmt.Sprintf(", renamed from %q", e.Prev)
		}
		line := fmt.Sprintf("  uid %-6d %s, by %s, %s", e.UID, what, e.Device, clock(e.MTime))
		if op, ok := ops[e.UID]; ok {
			line += fmt.Sprintf(", %s op %s", op.Tool, op.ID)
			if op.UndoneBy != "" {
				line += " (undone by op " + op.UndoneBy + ")"
			}
		}
		fmt.Fprintln(out, line)
	}
	last := versions[len(versions)-1].UID
	if len(versions) == *limit {
		fmt.Fprintf(out, "older versions may follow: trewd history -path %q -before %d\n", *path, last)
	}
	fmt.Fprintf(out, "trewd cat -path %q -uid N prints a version; trewd export -uid N -to FILE writes one out\n", *path)
	return nil
}

// cmdDeleted lists the notes whose newest version is a deletion, newest first,
// and for each the version to restore it from, or that a purge took them all.
func cmdDeleted(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("deleted", flag.ContinueOnError)
	dataDir := dataFlags(fs)
	vault := fs.String("vault", defaultVault, "the vault to read")
	limit := fs.Int("limit", 100, fmt.Sprintf("the most deletions to list, up to %d", store.DeletedMax))
	before := fs.Int64("before", 0, "list only deletions older than this uid, to page back")
	if err := fs.Parse(args); err != nil {
		return err
	}
	st, done, err := openToRead(*dataDir, "read")
	if err != nil {
		return err
	}
	defer done()

	dels, more, err := st.Deleted(*vault, true, *limit, *before)
	if err != nil {
		return err
	}
	if len(dels) == 0 {
		fmt.Fprintf(out, "vault %q has no deleted notes\n", *vault)
		return nil
	}
	fmt.Fprintf(out, "deleted notes in vault %q, newest first:\n", *vault)
	for _, d := range dels {
		from := "nothing to restore it from: a purge took every version with words in it"
		if d.RestorableUID != 0 {
			from = fmt.Sprintf("restore from uid %d: trewd cat -path %q -uid %d", d.RestorableUID, d.Path, d.RestorableUID)
		}
		fmt.Fprintf(out, "  uid %-6d %q deleted by %s, %s; %s\n", d.UID, d.Path, d.Device, clock(d.MTime), from)
	}
	if more {
		fmt.Fprintf(out, "older deletions follow: trewd deleted -before %d\n", dels[len(dels)-1].UID)
	}
	return nil
}

// clock is a version's time as the device that wrote it said it, which is
// not the server's and can be wrong by as much as that device's clock is.
func clock(ms int64) string {
	if ms <= 0 {
		return "at no recorded time"
	}
	return "at " + time.UnixMilli(ms).UTC().Format(time.RFC3339) + " by its clock"
}
