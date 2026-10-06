package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/coder/websocket"

	"github.com/waynehoover/trewsync/internal/dirlock"
	"github.com/waynehoover/trewsync/internal/doctor"
	bodyframe "github.com/waynehoover/trewsync/internal/frame"
	"github.com/waynehoover/trewsync/internal/search"
	"github.com/waynehoover/trewsync/internal/server"
	"github.com/waynehoover/trewsync/internal/store"
	"github.com/waynehoover/trewsync/internal/wire"
)

// cmdRehearse restores a backup where nothing production can reach it, and
// proves it (PLAN.md M5.5, "Restore rehearsal for real"): decrypted into a
// fresh directory, or copied if it is a plaintext one; verified deeply; its
// coverage checked against its own backup.json and, when the live data
// directory is named, against every version the live store holds up to the
// backup's newest uid; served on a loopback port of its own; a device paired
// to it from a new invite, which downloads the whole vault as any new device
// does, every note compared byte for byte with the store; the search index
// rebuilt from the restored store; and the time it all took measured. The
// result is recorded in the live data directory, which `trewd doctor` reads.
//
// It never touches the live store beyond reading it, and never the backup:
// the work directory is its own, inside the live data directory by default,
// where the plaintext already is, and removed afterwards unless -keep is
// given.
func cmdRehearse(ctx context.Context, args []string, out io.Writer) error {
	fs := flag.NewFlagSet("rehearse", flag.ContinueOnError)
	dataDir := dataFlags(fs)
	backup := fs.String("backup", "", "the backup to rehearse: an encrypted archive, or a plaintext backup directory")
	identity := fs.String("identity", "", "the age identity an encrypted backup is read with")
	vault := fs.String("vault", defaultVault, "the vault to rehearse")
	work := fs.String("work", "", "where to restore it (default: a new directory inside the data directory, removed after)")
	keep := fs.Bool("keep", false, "leave the restored directory in place afterwards")
	other := fs.Bool("not-last-backup", false, "rehearse an archive that is not the last backup the data directory recorded, with a warning")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *backup == "" {
		return errors.New("rehearse needs -backup, the backup to restore")
	}
	info, err := os.Stat(*backup)
	if err != nil {
		return fmt.Errorf("the backup: %w", err)
	}
	encrypted := !info.IsDir()
	if encrypted && *identity == "" {
		return errors.New("an encrypted backup is rehearsed with -identity KEY, the age identity it was encrypted to")
	}
	live := *dataDir
	if err := requireDataDir(live, "rehearse a restore of"); err != nil {
		return err
	}
	// An archive is compared with the backup this data directory recorded
	// before anything is decrypted: anyone holding the recipient can make one
	// the identity opens, and a rehearsal that passes on it proves nothing
	// about this server's backups. Refused before the rehearsal starts, so a
	// wrong archive named by mistake does not record a failed rehearsal.
	var origin archiveOrigin
	if encrypted {
		if origin, err = checkArchiveOrigin(*backup, live, *other, out); err != nil {
			return err
		}
	}
	dir := *work
	if dir == "" {
		dir = filepath.Join(live, "rehearsal-"+time.Now().UTC().Format("20060102T150405Z"))
	}
	// A directory of its own, made here, so that removing it afterwards
	// removes only what this rehearsal made: a -work naming a directory that
	// already exists is refused rather than cleared.
	if _, err := os.Lstat(dir); err == nil {
		return fmt.Errorf("-work %s exists; a rehearsal restores into a directory it makes itself", dir)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if !*keep {
		defer os.RemoveAll(dir)
	}

	r := rehearsal{out: out, live: live, vault: *vault, dir: filepath.Join(dir, "restore"), origin: origin}
	rec, err := r.run(ctx, *backup, encrypted, *identity)
	rec.Backup, rec.At, rec.OK = *backup, time.Now().UnixMilli(), err == nil
	var prev doctor.RehearsalRecord
	_, _ = doctor.ReadRecord(live, doctor.RehearsalRecordFile, &prev)
	if err != nil {
		rec.Error, rec.LastOK = firstLine(err.Error()), prev.LastOK
	} else {
		rec.LastOK = rec.At
	}
	if werr := doctor.WriteRecord(live, doctor.RehearsalRecordFile, rec); werr != nil {
		fmt.Fprintf(out, "(the rehearsal record could not be written to %s: %v)\n", live, werr)
	}
	if err != nil {
		fmt.Fprintf(out, "\nTHE REHEARSAL FAILED: %v\nThe backup is untouched. Keep it, take a fresh one, and rehearse that.\n", err)
		return err
	}
	if *keep {
		fmt.Fprintf(out, "The restored directory is at %s, and holds every note in the clear.\n", r.dir)
	}
	return nil
}

// rehearsal is one rehearsal in progress.
type rehearsal struct {
	out   io.Writer
	live  string
	vault string
	dir   string
	start time.Time
	// origin is what the archive's comparison with the backup record found,
	// finished once the archive has been read.
	origin archiveOrigin
}

func (r *rehearsal) step(format string, args ...any) {
	fmt.Fprintf(r.out, "%8.1fs  %s\n", time.Since(r.start).Seconds(), fmt.Sprintf(format, args...))
}

func (r *rehearsal) run(ctx context.Context, backup string, encrypted bool, identity string) (doctor.RehearsalRecord, error) {
	var rec doctor.RehearsalRecord
	r.start = time.Now()
	fmt.Fprintf(r.out, "rehearsing a restore of %s into %s\n", backup, r.dir)

	// 1. The copy.
	if encrypted {
		rep, err := unpackArchive(backup, identity, r.dir)
		if err != nil {
			return rec, err
		}
		r.step("decrypted and unpacked %d bodies (%s), each checked against its name and the manifest",
			rep.Manifest.Bodies, humanBytes(rep.Manifest.BodyBytes))
		if err := r.origin.after(rep, r.out); err != nil {
			return rec, err
		}
	} else {
		if err := store.CheckDataDir(backup); err != nil {
			return rec, fmt.Errorf("the backup at %s: %w", backup, err)
		}
		n, err := copyDataDir(backup, r.dir)
		if err != nil {
			return rec, fmt.Errorf("copying the backup: %w", err)
		}
		r.step("copied %d files of the plaintext backup", n)
	}

	// What the backup says it holds, read before anything opens the copy's
	// database: backup.json describes that file byte for byte, and bringing a
	// copy an older build made up to this build's schema, next, changes it.
	meta, err := store.ReadBackupMeta(r.dir)
	if err != nil {
		return rec, err
	}
	if err := upgradeCopy(r.dir); err != nil {
		return rec, err
	}

	// 2. Checked against itself, deeply.
	dbPath, chunkDir := store.DataDir(r.dir)
	insp, err := store.OpenForInspection(dbPath, chunkDir)
	if err != nil {
		return rec, fmt.Errorf("opening the restored store: %w", err)
	}
	v, err := insp.Verify(true)
	insp.Close()
	if err != nil {
		return rec, err
	}
	if len(v.Faults) > 0 {
		return rec, fmt.Errorf("the restored store has %d faults, the first: %s", len(v.Faults), v.Faults[0])
	}
	if v.Entries == 0 {
		return rec, errors.New("the restored store holds no entries, so it proves nothing")
	}
	r.step("verified deeply: %d entries, %d chunk references, %d registry rows and %d agent operations, no faults",
		v.Entries, v.Chunks, v.Rows, v.Operations)

	st, err := store.Open(dbPath, chunkDir)
	if err != nil {
		return rec, err
	}
	defer st.Close()
	stats, err := st.Stats(r.vault)
	if err != nil {
		return rec, err
	}
	covered := false
	for _, c := range meta.Vaults {
		if c.Vault != r.vault {
			continue
		}
		covered = true
		if c.LatestUID != stats.LatestUID || c.Versions != stats.Versions {
			return rec, fmt.Errorf("the backup's %s says uids up to %d, %d versions, and the restore holds up to %d, %d versions",
				store.BackupMetaFile, c.LatestUID, c.Versions, stats.LatestUID, stats.Versions)
		}
		if t, err := time.Parse(time.RFC3339, meta.TakenAt); err == nil {
			rec.BackupAt = t.UnixMilli()
		}
	}
	if !covered {
		return rec, fmt.Errorf("the backup holds no vault %q", r.vault)
	}
	ops, err := st.OplogCounts()
	if err != nil {
		return rec, err
	}
	rec.Versions, rec.Operations, rec.Pins = stats.Versions, ops.Operations, ops.Pins
	r.step("vault %q holds uids %d to %d, %d versions as backup.json says; %d deleted notes, %d of them recoverable; "+
		"%d agent operations and %d before-image pins carried", r.vault, stats.OldestUID, stats.LatestUID, stats.Versions,
		stats.Deleted, stats.Recoverable, ops.Operations, ops.Pins)

	// 3. Against the live store, when there is one to compare with.
	if n, err := r.compareLive(st, stats.LatestUID); err != nil {
		return rec, err
	} else if n > 0 {
		r.step("every one of the live store's %d versions up to uid %d is in the restore, identical", n, stats.LatestUID)
	}

	// 4. Served, and read back by a device paired from a new invite.
	files, bytes, err := r.serveAndPair(ctx, st, stats.LatestUID)
	if err != nil {
		return rec, err
	}
	rec.Files, rec.Bytes = files, bytes
	rec.TookMs = time.Since(r.start).Milliseconds()
	r.step("a freshly paired device downloaded all %d notes (%s), every one identical to the store: restored in %s",
		files, humanBytes(bytes), time.Duration(rec.TookMs)*time.Millisecond)

	// 5. The search index, rebuilt from the restored store.
	if err := r.rebuildIndex(ctx, st, stats.LatestUID); err != nil {
		return rec, err
	}

	// What the schedule implies.
	fmt.Fprintln(r.out)
	fmt.Fprintf(r.out, "Recovery time: %s from the backup to a device holding every note.\n",
		time.Duration(rec.TookMs)*time.Millisecond)
	if rec.BackupAt > 0 {
		fmt.Fprintf(r.out, "This backup was taken %s, %s ago: a restore from it now would lose whatever was written since.\n"+
			"With a backup every night, that window is up to a day plus the time a backup takes; devices keep\n"+
			"their own copies, and send back what the restored server lacks when they reconnect.\n",
			meta.TakenAt, time.Since(time.UnixMilli(rec.BackupAt)).Round(time.Minute))
	}
	return rec, nil
}

// compareLive checks that every version the live store holds up to latest is
// in the restore, identical, which is what "every expected version" means for
// a backup of this data directory. It returns how many it compared, zero when
// the live store holds none of the vault.
func (r *rehearsal) compareLive(restored *store.Store, latest int64) (int, error) {
	lock, err := dirlock.Shared(r.live, dirlock.Data)
	if err != nil {
		return 0, locked(err, r.live, "rehearse", "A purge is running on the live data directory.")
	}
	defer lock.Release()
	dbPath, chunkDir := store.DataDir(r.live)
	liveStore, err := store.OpenForInspection(dbPath, chunkDir)
	if err != nil {
		return 0, fmt.Errorf("opening the live store to compare with: %w", err)
	}
	defer liveStore.Close()
	n := 0
	err = liveStore.EachEntry(r.vault, func(e store.Entry) error {
		if e.UID > latest {
			return nil
		}
		held, ok, err := restored.EntryByUID(r.vault, e.UID)
		if err != nil {
			return err
		}
		if !ok {
			return fmt.Errorf("the live store's version %d of %q is not in the backup: is this a backup of %s?",
				e.UID, e.Path, r.live)
		}
		if why := sameVersion(e, held); why != "" {
			return fmt.Errorf("the backup's version %d differs from the live store's (%s): is this a backup of %s?",
				e.UID, why, r.live)
		}
		n++
		return nil
	})
	return n, err
}

// serveAndPair serves the restored store on a loopback port nothing else
// knows, pairs a new device to it from an invite, downloads every live note
// the way a device does, and compares each with the store's own bytes.
func (r *rehearsal) serveAndPair(ctx context.Context, st *store.Store, latest int64) (int, int64, error) {
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := server.New(st, quiet)
	srv.Serves(r.vault)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, 0, err
	}
	hs := &http.Server{Handler: server.HTTPHandler(srv, quiet), ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = hs.Serve(ln) }()
	defer func() {
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = hs.Shutdown(sctx)
		_ = srv.Shutdown(sctx)
	}()
	addr := "ws://" + ln.Addr().String()
	r.step("serving the restore at %s, a loopback port no production device knows", addr)

	expires := time.Now().Add(10 * time.Minute).UnixMilli()
	inv, err := srv.OperatorInvite(r.vault, "restore rehearsal", &expires)
	if err != nil {
		return 0, 0, err
	}
	d := pairedDevice{addr: addr, vault: r.vault}
	if err := d.pair(ctx, inv.Token); err != nil {
		return 0, 0, fmt.Errorf("pairing a device to the restore: %w", err)
	}
	heads, err := d.download(ctx, latest)
	if err != nil {
		return 0, 0, fmt.Errorf("downloading the restore: %w", err)
	}
	files := 0
	var total int64
	for path, got := range heads {
		e, state, _, err := st.EntryAsOf(r.vault, path, 0)
		if err != nil {
			return 0, 0, err
		}
		if state != store.PathLive || e.Folder {
			return 0, 0, fmt.Errorf("the device holds %q, and the store says it is %s", path, state)
		}
		want := sha256.New()
		for _, n := range e.Chunks {
			b, err := st.Chunks().Get(r.vault, n)
			if err != nil {
				return 0, 0, fmt.Errorf("reading %q from the store: %w", path, err)
			}
			want.Write(b)
		}
		if string(want.Sum(nil)) != string(got.sum) || got.size != e.Size {
			return 0, 0, fmt.Errorf("the device's %q is not the store's", path)
		}
		files++
		total += got.size
	}
	var live int
	if err := st.EachAsOf(r.vault, 0, store.AsOfRange{}, func(e store.Entry) (bool, error) {
		if !e.Deleted && !e.Folder {
			live++
		}
		return true, nil
	}); err != nil {
		return 0, 0, err
	}
	if live != files {
		return 0, 0, fmt.Errorf("the store holds %d notes and the device downloaded %d", live, files)
	}
	return files, total, nil
}

// rebuildIndex builds the search index from the restored store, in its own
// directory, and waits for it to reach the head.
func (r *rehearsal) rebuildIndex(ctx context.Context, st *store.Store, latest int64) error {
	idx, err := search.Open(r.dir, st, r.vault, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		return fmt.Errorf("opening a search index for the restore: %w", err)
	}
	defer idx.Close()
	idx.Start()
	wctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	began := time.Now()
	if !idx.Await(wctx, latest) {
		return fmt.Errorf("the search index did not reach uid %d within ten minutes: %+v", latest, idx.Status())
	}
	s := idx.Status()
	if !s.Usable || s.IndexedHead < latest {
		return fmt.Errorf("the rebuilt search index is not usable: %+v", s)
	}
	r.step("rebuilt the search index from the restore: generation %d, %d notes, current at uid %d, in %s",
		s.Generation, s.Notes, s.IndexedHead, time.Since(began).Round(time.Millisecond))
	return nil
}

// copyDataDir copies the database, backup.json and the chunk tree of a
// plaintext backup into a new directory, and nothing else: no lock files, no
// socket, no staging debris.
func copyDataDir(from, to string) (int, error) {
	if err := os.MkdirAll(to, 0o700); err != nil {
		return 0, err
	}
	dbPath, chunkDir := store.DataDir(from)
	n := 0
	copyFile := func(src, dst string) error {
		in, err := os.Open(src)
		if err != nil {
			return err
		}
		defer in.Close()
		if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
			return err
		}
		outFile, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err != nil {
			return err
		}
		if _, err := io.Copy(outFile, in); err != nil {
			outFile.Close()
			return err
		}
		n++
		return outFile.Close()
	}
	for _, name := range []string{filepath.Base(dbPath), store.BackupMetaFile} {
		if err := copyFile(filepath.Join(from, name), filepath.Join(to, name)); err != nil {
			return n, err
		}
	}
	err := filepath.WalkDir(chunkDir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, err := filepath.Rel(from, p)
		if err != nil {
			return err
		}
		return copyFile(p, filepath.Join(to, rel))
	})
	return n, err
}

/* ---------------------------------------------------------------- *
 * The rehearsal's device
 * ---------------------------------------------------------------- */

// pairedDevice is a device that pairs and downloads over the wire, as a
// new device does, and holds nothing but a digest of each note.
type pairedDevice struct {
	addr, vault string
	id, token   string
}

type heldNote struct {
	size int64
	sum  []byte
}

// pair redeems invite, choosing the device's id and token first, as a device
// does (plan/protocol.md, "Invite redemption").
func (d *pairedDevice) pair(ctx context.Context, invite []byte) error {
	idBytes, tok := make([]byte, 16), make([]byte, 32)
	if _, err := rand.Read(idBytes); err != nil {
		return err
	}
	if _, err := rand.Read(tok); err != nil {
		return err
	}
	d.id, d.token = base64.RawURLEncoding.EncodeToString(idBytes), store.EncodeToken(tok)
	conn, err := d.dial(ctx)
	if err != nil {
		return err
	}
	defer conn.CloseNow()
	if err := sendJSON(ctx, conn, wire.In{Op: "hello", ID: 1, Proto: wire.Proto, Vault: d.vault, Device: "restore rehearsal",
		Invite: store.EncodeToken(invite), DeviceID: d.id, Token: d.token}); err != nil {
		return err
	}
	var got wire.Redeemed
	if err := readJSON(ctx, conn, &got); err != nil {
		return err
	}
	if got.Res != "redeemed" || got.DeviceID != d.id {
		return fmt.Errorf("the restore answered the redemption with %+v", got)
	}
	return nil
}

func (d *pairedDevice) dial(ctx context.Context) (*websocket.Conn, error) {
	conn, _, err := websocket.Dial(ctx, d.addr, nil)
	if err != nil {
		return nil, err
	}
	conn.SetReadLimit(1 << 27)
	return conn, nil
}

// download connects as the paired device from cursor 0, follows the backlog
// to its end, and fetches every live note's bodies, returning each note's
// size and digest by path.
func (d *pairedDevice) download(ctx context.Context, latest int64) (map[string]heldNote, error) {
	conn, err := d.dial(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.CloseNow()
	if err := sendJSON(ctx, conn, wire.In{Op: "hello", ID: 1, Proto: wire.Proto, Vault: d.vault, Device: "restore rehearsal",
		DeviceID: d.id, Token: d.token, Cursor: 0}); err != nil {
		return nil, err
	}
	var ready wire.Ready
	if err := readJSON(ctx, conn, &ready); err != nil {
		return nil, err
	}
	if ready.Res != "ready" {
		return nil, fmt.Errorf("the restore refused the paired device: %+v", ready)
	}
	heads := map[string]store.Entry{}
	cursor := int64(0)
	for done := false; !done; {
		_, b, err := conn.Read(ctx)
		if err != nil {
			return nil, err
		}
		var probe struct {
			Op string `json:"op"`
		}
		_ = json.Unmarshal(b, &probe)
		switch probe.Op {
		case "batch":
			var batch wire.Batch
			if err := json.Unmarshal(b, &batch); err != nil {
				return nil, err
			}
			if batch.From != cursor+1 {
				return nil, fmt.Errorf("the restore's history has a gap: a batch from uid %d after uid %d", batch.From, cursor)
			}
			for _, e := range batch.Entries {
				if e.Prev != "" {
					delete(heads, e.Prev)
				}
				if e.Deleted || e.Folder {
					delete(heads, e.Path)
					continue
				}
				heads[e.Path] = e
			}
			cursor = batch.To
		case "caught-up":
			done = true
		default:
			return nil, fmt.Errorf("unexpected during the backlog: %s", b)
		}
	}
	if cursor != latest {
		return nil, fmt.Errorf("the backlog ended at uid %d, and the store is at %d", cursor, latest)
	}

	out := map[string]heldNote{}
	id := int64(2)
	for path, e := range heads {
		sum := sha256.New()
		var size int64
		for i := 0; i < len(e.Chunks); i += 64 {
			names := e.Chunks[i:min(i+64, len(e.Chunks))]
			if err := sendJSON(ctx, conn, wire.In{Op: "fetch", ID: id, Chunks: names}); err != nil {
				return nil, err
			}
			id++
			var head wire.Bodies
			if err := readJSON(ctx, conn, &head); err != nil {
				return nil, err
			}
			if head.Res != "bodies" || head.Count != len(names) {
				return nil, fmt.Errorf("the restore answered a fetch for %q with %+v", path, head)
			}
			for _, n := range names {
				typ, framed, err := conn.Read(ctx)
				if err != nil {
					return nil, err
				}
				if typ != websocket.MessageBinary {
					return nil, fmt.Errorf("a body of %q came as text: %s", path, framed)
				}
				raw, err := bodyframe.Decode(framed, store.ChunkMax)
				if err != nil {
					return nil, fmt.Errorf("a body of %q does not decode: %w", path, err)
				}
				if got := sha256.Sum256(raw); fmt.Sprintf("%x", got) != n {
					return nil, fmt.Errorf("a body of %q does not hash to its name", path)
				}
				sum.Write(raw)
				size += int64(len(raw))
			}
		}
		out[path] = heldNote{size: size, sum: sum.Sum(nil)}
	}
	return out, nil
}

func sendJSON(ctx context.Context, conn *websocket.Conn, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, b)
}

// readJSON reads the next text frame into v, taking an error frame as the
// error it is.
func readJSON(ctx context.Context, conn *websocket.Conn, v any) error {
	typ, b, err := conn.Read(ctx)
	if err != nil {
		return err
	}
	if typ != websocket.MessageText {
		return errors.New("a binary frame where a reply was expected")
	}
	var e struct {
		Res  string `json:"res"`
		Code string `json:"code"`
		Msg  string `json:"msg"`
	}
	if json.Unmarshal(b, &e) == nil && e.Res == "err" {
		return fmt.Errorf("the restore refused: %s: %s", e.Code, e.Msg)
	}
	return json.Unmarshal(b, v)
}
