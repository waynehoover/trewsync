package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/waynehoover/trewsync/internal/dirlock"
	"github.com/waynehoover/trewsync/internal/fsync"
	"github.com/waynehoover/trewsync/internal/store"
)

// The escape hatch: a note's bytes straight out of the store, with no device
// and no client (PLAN.md M1). Basalt could not have one, because what it held
// was ciphertext; TrewSync holds the notes in the clear, and the day every
// device is broken is the day somebody needs to read one from the server.
//
// Both commands read the store directly, read-only, under the shared data lock,
// so they run beside a live server and never beside a purge. Every chunk is
// checked against its name as it is read and the whole against the version's
// declared size, so what comes out is the version or an error, never a note
// that is almost it.

// readVersion assembles one version's bytes, verified.
func readVersion(st *store.Store, vault string, e store.Entry) ([]byte, error) {
	if !e.HasBody() {
		kind := "folder"
		if e.Deleted {
			kind = "deletion"
		}
		return nil, fmt.Errorf("uid %d of %q is a %s, which has no contents", e.UID, e.Path, kind)
	}
	out := make([]byte, 0, e.Size)
	for i, name := range e.Chunks {
		body, err := st.Chunks().Get(vault, name)
		if err != nil {
			return nil, fmt.Errorf("uid %d of %q: chunk %d of %d (%s): %w; `trewd verify -deep` says "+
				"what else is affected", e.UID, e.Path, i+1, len(e.Chunks), name, err)
		}
		out = append(out, body...)
	}
	if int64(len(out)) != e.Size {
		return nil, fmt.Errorf("uid %d of %q assembles to %d bytes and declares %d, so these are not its contents",
			e.UID, e.Path, len(out), e.Size)
	}
	return out, nil
}

// openToRead opens a data directory the way the escape hatch reads it.
func openToRead(dataDir, verb string) (*store.Store, func(), error) {
	if err := requireDataDir(dataDir, verb); err != nil {
		return nil, nil, err
	}
	lock, err := dirlock.Shared(dataDir, dirlock.Data)
	if err != nil {
		return nil, nil, locked(err, dataDir, verb, stopFirst)
	}
	st, err := openForInspection(dataDir, verb)
	if err != nil {
		lock.Release()
		return nil, nil, err
	}
	return st, func() { st.Close(); lock.Release() }, nil
}

// cmdCat prints a note: the version that is live at the path, or the one -uid
// names.
func cmdCat(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("cat", flag.ContinueOnError)
	dataDir := dataFlags(fs)
	vault := fs.String("vault", defaultVault, "the vault to read")
	path := fs.String("path", "", "the note's path in the vault (required)")
	uid := fs.Int64("uid", 0, "a version of that path to print instead of the live one")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *path == "" {
		return errors.New("cat needs -path, the note's path in the vault")
	}
	st, done, err := openToRead(*dataDir, "read")
	if err != nil {
		return err
	}
	defer done()

	var e store.Entry
	if *uid != 0 {
		var ok bool
		e, ok, err = st.EntryByUID(*vault, *uid)
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("vault %q has no uid %d", *vault, *uid)
		}
		if e.Path != *path {
			return fmt.Errorf("uid %d is a version of %q, not of %q", *uid, e.Path, *path)
		}
	} else {
		head, gone, err := st.Head(*vault, *path)
		if err != nil {
			return err
		}
		if head == 0 {
			return fmt.Errorf("vault %q has never held %q", *vault, *path)
		}
		if gone {
			return fmt.Errorf("%q was deleted or renamed away at uid %d; %s", *path, head,
				versionsHint(st, *vault, *path))
		}
		var ok bool
		e, ok, err = st.EntryByUID(*vault, head)
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("vault %q lost uid %d while it was being read", *vault, head)
		}
	}
	body, err := readVersion(st, *vault, e)
	if err != nil {
		return err
	}
	_, err = out.Write(body)
	return err
}

// versionsHint names the versions of a path that have contents, newest first,
// which is where somebody looking for a deleted note goes next.
func versionsHint(st *store.Store, vault, path string) string {
	history, err := st.HistoryForPath(vault, path, 0, 20)
	if err != nil {
		return "`trewd cat -path P -uid N` prints an earlier version"
	}
	var uids []string
	for _, e := range history {
		if e.HasBody() {
			uids = append(uids, fmt.Sprint(e.UID))
		}
	}
	if len(uids) == 0 {
		return "and no version of it had contents"
	}
	return fmt.Sprintf("versions with contents are uids %s; print one with -uid", strings.Join(uids, ", "))
}

// cmdExport writes one version to a file. The file must not exist: this is the
// command for the day something has gone wrong, and it is not going to make
// that day worse by writing over whatever was at the path.
func cmdExport(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("export", flag.ContinueOnError)
	dataDir := dataFlags(fs)
	vault := fs.String("vault", defaultVault, "the vault to read")
	uid := fs.Int64("uid", 0, "the version to export (required)")
	to := fs.String("to", "", "the file to write it to, which must not exist (required)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *uid <= 0 || *to == "" {
		return errors.New("export needs -uid, the version, and -to, a file that does not exist yet")
	}
	if _, err := os.Lstat(*to); err == nil {
		return fmt.Errorf("%s already exists, and export does not write over anything", *to)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	st, done, err := openToRead(*dataDir, "export")
	if err != nil {
		return err
	}
	defer done()
	e, ok, err := st.EntryByUID(*vault, *uid)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("vault %q has no uid %d", *vault, *uid)
	}
	body, err := readVersion(st, *vault, e)
	if err != nil {
		return err
	}
	if err := writeNewFile(*to, body); err != nil {
		return err
	}
	fmt.Fprintf(out, "wrote uid %d of %q, %d bytes, to %s\n", e.UID, e.Path, len(body), *to)
	return nil
}

// writeNewFile writes body to path, which must not exist, durably and at 0600:
// a temporary file in the same directory, synced, then linked into place, so a
// crash leaves either nothing at path or the whole file, and a file that
// appeared at path meanwhile is refused rather than replaced.
func writeNewFile(path string, body []byte) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(body); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	// Link rather than rename: link refuses an existing target, rename would
	// replace it.
	if err := os.Link(tmpName, path); err != nil {
		if errors.Is(err, os.ErrExist) {
			return fmt.Errorf("%s appeared while it was being written, and export does not write over anything", path)
		}
		return err
	}
	return fsync.Dir(dir)
}
