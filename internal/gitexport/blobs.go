package gitexport

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strconv"

	"github.com/waynehoover/trewsync/internal/store"
)

// Blobs the repository already holds, named rather than streamed again
// (ops review, performance).
//
// group wrote every version a commit changes into fast-import and only then
// compared the blob with the one the path already had, so content the
// repository held was read from the store, hashed and streamed for nothing:
// a rename is a new path with old bytes, and a restore's commit is every live
// note. For a file over the LFS threshold that was a full read, a temporary
// copy and an fsync as well, about a gigabyte of I/O to rename a 500 MB
// recording. The blobs table remembers what each fast-import wrote, by the
// content's identity, so the next time the same bytes appear the commit names
// the blob by its sha and nothing is read.

// knownBlob is a blob the repository holds, by the content it holds.
type knownBlob struct {
	content string
	lfs     bool
	ref     blobRef
	oid     string
	// mark is the blob's mark in the stream that wrote it, or 0 for one an
	// earlier stream wrote, which a commit names by its sha.
	mark int
}

// contentKey names an entry's bytes without reading them: its size and its
// chunk list, each chunk named by the SHA-256 of its bytes.
func contentKey(e store.Entry) string {
	h := sha256.New()
	h.Write([]byte(strconv.FormatInt(e.Size, 10)))
	for _, c := range e.Chunks {
		h.Write([]byte{0})
		h.Write([]byte(c))
	}
	return hex.EncodeToString(h.Sum(nil))
}

// knownFor is the blob of e's bytes the repository already holds, as an LFS
// pointer or not, if there is one it can still use: written by this stream,
// or by an earlier one, and for an LFS pointer only while the object it points
// to is still in the repository's LFS store.
func (w *importer) knownFor(e store.Entry, lfs bool) (knownBlob, bool, error) {
	key := contentKey(e)
	if k, ok := w.known[key+strconv.FormatBool(lfs)]; ok {
		return k, true, nil
	}
	k := knownBlob{content: key, lfs: lfs}
	err := w.x.db.QueryRow(`SELECT sha, oid FROM blobs WHERE content = ? AND lfs = ?`, key, lfs).Scan(&k.ref.sha, &k.oid)
	if errors.Is(err, sql.ErrNoRows) {
		return k, false, nil
	}
	if err != nil {
		return k, false, err
	}
	k.ref.lfs = lfs
	if lfs {
		info, err := os.Stat(w.x.lfsObject(k.oid))
		if err != nil || info.Size() != e.Size {
			return k, false, nil
		}
	}
	return k, true, nil
}

// wrote records a blob this stream wrote, for the rest of the stream and,
// once fast-import has finished, for the streams after it.
func (w *importer) wrote(e store.Entry, ref blobRef, oid string, mark int) {
	k := knownBlob{content: contentKey(e), lfs: ref.lfs, ref: ref, oid: oid, mark: mark}
	if w.known == nil {
		w.known = map[string]knownBlob{}
	}
	w.known[k.content+strconv.FormatBool(k.lfs)] = k
	w.fresh = append(w.fresh, k)
}

// rememberBlobs records the blobs a fast-import that finished wrote.
func (x *Exporter) rememberBlobs(fresh []knownBlob) error {
	if len(fresh) == 0 {
		return nil
	}
	return inTx(x.db, func(tx *sql.Tx) error {
		for _, k := range fresh {
			if _, err := tx.Exec(`INSERT INTO blobs (content, lfs, sha, oid) VALUES (?, ?, ?, ?)
			  ON CONFLICT(content, lfs) DO UPDATE SET sha = excluded.sha, oid = excluded.oid`,
				k.content, k.lfs, k.ref.sha, k.oid); err != nil {
				return err
			}
		}
		return nil
	})
}

// forgetBlobs empties the blobs table, after a fast-import that failed: if a
// blob it named was gone from the repository, every later step would fail the
// same way, and streaming everything again is the way back.
func (x *Exporter) forgetBlobs() {
	if _, err := x.db.Exec(`DELETE FROM blobs`); err != nil {
		x.log.Warn("the git export could not forget the blobs it had written", "err", err)
	}
}

// lfsObject is where oid lives in the repository's LFS store.
func (x *Exporter) lfsObject(oid string) string {
	if len(oid) < 4 {
		return filepath.Join(x.dataDir, Dir, RepoDir, "lfs", "objects", "missing")
	}
	return filepath.Join(x.dataDir, Dir, RepoDir, "lfs", "objects", oid[:2], oid[2:4], oid)
}
