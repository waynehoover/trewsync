// Package gitexport keeps a Git history of the vault: a bare repository in
// the data directory, one commit per agent operation and one per quiet run of
// a device's versions, pushed to a remote when one is configured.
//
// It is derived state, maintained the way the search index is (PLAN.md
// section 2.5), and never the source of truth (plan/research/syncidian.md
// section 7). Four rules shape it.
//
// It can never refuse or delay a write. One worker goroutine reads committed
// entries and chunks, never takes the store's write lock or the server's
// commit lock, and runs git in child processes. What it has exported is
// recorded durably, per branch, as the last uid a commit covers and the commit
// the branch is at, so a restart resumes from the last step that finished. A
// push that fails sets the export's status and nothing else.
//
// It is one-way. Nothing is read back from the repository into the store,
// ever: no import, no pull, no reset, no reconciliation. If the repository's
// branch, or the remote's, is found somewhere the export did not put it, the
// export refuses to go on and says so in its status, the log and `trewd
// doctor`; it never moves either back.
//
// It is deterministic. Which versions make which commit, and every byte of
// every commit, are a function of the store and the settings (plan.go), so an
// export rebuilt from scratch has the same commit names as the one made as the
// notes arrived, and a step interrupted anywhere is simply done again.
//
// It is plaintext, for good. A commit pushed to a remote is readable by
// whoever hosts it, and `trewd purge` cannot take a version back out of it
// (docs/security.md).
package gitexport

import (
	"bufio"
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/waynehoover/trewsync/internal/fsync"
	"github.com/waynehoover/trewsync/internal/store"
)

// How much one step reads before it writes what it has: the entries and the
// bytes of the commits it will make. Variables so the crash test can make a
// step small.
var (
	stepEntries int64 = 5000
	stepBytes   int64 = 256 << 20
)

// batchSize is how many entries one read of the store takes.
const batchSize = 500

// pollEvery is how often an idle worker looks even when nothing nudged it.
const pollEvery = 30 * time.Second

// The push's retry pace after a failure: doubling from the first to the last.
const (
	pushRetryFirst = 30 * time.Second
	pushRetryMax   = 30 * time.Minute
)

// Exporter is one vault's Git export.
type Exporter struct {
	dataDir string
	vault   string
	st      *store.Store
	log     *slog.Logger

	mu          sync.Mutex
	settings    Settings
	settingsErr string
	// generation moves on every Reconfigure, so the worker knows to write
	// the repository's config again, and lookAgain asks it to clear the
	// remote's refusal for the new settings.
	generation int
	lookAgain  bool
	status     workerStatus

	// Owned by the worker.
	db          *sql.DB
	configured  int
	tools       *Tools
	toolsAt     time.Time
	tree        map[string]blobRef
	treeOf      string
	nextPushAt  time.Time
	pushBackoff time.Duration

	// step is held by the worker for each cycle and by Adopt, which works on
	// the same repository and state from another goroutine.
	step chan struct{}

	sub  store.Committed
	wake chan struct{}
	stop chan struct{}
	done chan struct{}
	once sync.Once

	// crash, when set, runs at each named point of a step, so a test can
	// kill the process exactly there. Nil otherwise.
	crash func(point string)
}

// workerStatus is what the worker last found, for Status.
type workerStatus struct {
	tools        Tools
	lastError    string
	refused      string
	lastExportAt int64
	excluded     map[string]bool
}

// Open prepares the export for vault in dataDir with settings s, or with why
// they are not usable in settingsErr. Nothing is created on disk until the
// worker runs with the export enabled.
func Open(dataDir string, st *store.Store, vault string, s Settings, settingsErr error, log *slog.Logger) *Exporter {
	if log == nil {
		log = slog.Default()
	}
	x := &Exporter{dataDir: dataDir, vault: vault, st: st, log: log,
		step: make(chan struct{}, 1), wake: make(chan struct{}, 1), stop: make(chan struct{}), done: make(chan struct{})}
	x.setSettings(s, settingsErr)
	return x
}

func (x *Exporter) setSettings(s Settings, err error) {
	x.mu.Lock()
	defer x.mu.Unlock()
	x.settings = s
	x.settingsErr = ""
	if err != nil {
		x.settingsErr = err.Error()
	}
	x.generation++
	x.status.refused = ""
}

// Reconfigure replaces the settings and wakes the worker. The remote's
// refusal, if the remote's branch had been found somewhere the export did not
// put it, is cleared for these settings: running `trewd git-export set` is the
// operator saying to look again. The export still never pushes over a commit
// it did not make.
func (x *Exporter) Reconfigure(s Settings, settingsErr error) {
	x.setSettings(s, settingsErr)
	x.mu.Lock()
	x.nextPushAt, x.pushBackoff = time.Time{}, 0
	x.lookAgain = true
	x.mu.Unlock()
	x.nudge()
}

// Start starts the worker.
func (x *Exporter) Start() {
	x.sub = x.st.Subscribe()
	go x.run()
}

// Close stops the worker, waiting for the step it is in: a git process it
// runs is told to stop with SIGTERM, which git answers by removing the locks
// it holds, and killed only if it has not ended ten seconds later
// (stopGently, T44). A step stopped part way is done again at the next start.
func (x *Exporter) Close() error {
	started := x.sub.C != nil
	x.once.Do(func() { close(x.stop) })
	if started {
		<-x.done
		x.sub.Stop()
	}
	if x.db != nil {
		return x.db.Close()
	}
	return nil
}

func (x *Exporter) nudge() {
	select {
	case x.wake <- struct{}{}:
	default:
	}
}

func (x *Exporter) run() {
	defer close(x.done)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		select {
		case <-x.stop:
			cancel()
		case <-ctx.Done():
		}
	}()
	var retry time.Duration
	for {
		select {
		case <-x.stop:
			return
		default:
		}
		select {
		case <-x.stop:
			return
		case x.step <- struct{}{}:
		}
		progressed, due, err := x.cycle(ctx)
		<-x.step
		x.mu.Lock()
		if err != nil {
			x.status.lastError = err.Error()
		} else if progressed {
			x.status.lastError = ""
		}
		x.mu.Unlock()
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			retry = min(max(2*retry, time.Second), 5*time.Minute)
			x.log.Warn("the git export failed a step; it will try again", "err", err, "in", retry)
			select {
			case <-x.stop:
				return
			case <-x.wake:
			case <-time.After(retry):
			}
			continue
		}
		retry = 0
		if progressed {
			continue
		}
		wait := pollEvery
		if !due.IsZero() {
			wait = min(wait, max(time.Until(due), 50*time.Millisecond))
		}
		select {
		case <-x.stop:
			return
		case <-x.sub.C:
		case <-x.wake:
		case <-time.After(wait):
		}
	}
}

// cycle does one step of whatever is owed: export what has closed, then push.
// due is when something will next be owed without a nudge.
func (x *Exporter) cycle(ctx context.Context) (progressed bool, due time.Time, err error) {
	x.mu.Lock()
	s, bad, gen := x.settings, x.settingsErr, x.generation
	x.mu.Unlock()
	if !s.Enabled || bad != "" {
		return false, time.Time{}, nil
	}
	r, err := x.prepare(ctx, s, gen)
	if err != nil {
		return false, time.Time{}, err
	}
	x.mu.Lock()
	again := x.lookAgain
	x.lookAgain = false
	x.mu.Unlock()
	if again && s.Remote != "" {
		if _, err := x.db.Exec(`UPDATE remotes SET refused = '' WHERE remote = ? AND branch = ?`,
			s.Remote, s.Branch); err != nil {
			return false, time.Time{}, err
		}
	}
	progressed, openUntil, err := x.exportStep(ctx, r, s)
	if err != nil {
		return false, time.Time{}, err
	}
	if openUntil > 0 {
		due = time.UnixMilli(openUntil)
	}
	if !progressed {
		if next := x.pushStep(ctx, r, s); !next.IsZero() && (due.IsZero() || next.Before(due)) {
			due = next
		}
	}
	return progressed, due, nil
}

// stateDB opens the state database, creating the export's directory.
func (x *Exporter) stateDB() (*sql.DB, error) {
	if x.db != nil {
		return x.db, nil
	}
	dir := filepath.Join(x.dataDir, Dir)
	if err := os.MkdirAll(filepath.Join(dir, "home"), 0o700); err != nil {
		return nil, err
	}
	db, err := openState(dir, false)
	if err != nil {
		return nil, fmt.Errorf("opening the export's state: %w", err)
	}
	x.db = db
	return db, nil
}

// prepare finds git, opens the state, makes the repository if it is not
// there, and writes the settings into its config when they have changed.
func (x *Exporter) prepare(ctx context.Context, s Settings, gen int) (*runner, error) {
	if x.tools == nil || len(x.tools.Missing) > 0 && time.Since(x.toolsAt) > time.Minute {
		t := FindTools(ctx)
		x.tools, x.toolsAt = &t, time.Now()
		x.mu.Lock()
		x.status.tools = t
		x.mu.Unlock()
	}
	if x.tools.Git == "" || !atLeast(x.tools.GitVersion, MinGit) {
		return nil, fmt.Errorf("the git export needs git %s or later on PATH: %s", MinGit,
			strings.Join(x.tools.Missing, "; "))
	}
	if _, err := x.stateDB(); err != nil {
		return nil, err
	}
	dir := filepath.Join(x.dataDir, Dir)
	r := &runner{git: x.tools.Git, gitDir: filepath.Join(dir, RepoDir), home: filepath.Join(dir, "home"), s: s}
	if _, err := os.Stat(filepath.Join(r.gitDir, "HEAD")); errors.Is(err, os.ErrNotExist) {
		if _, err := r.run(ctx, localTimeout, nil, "init", "--bare", "--quiet"); err != nil {
			return nil, err
		}
		x.configured = 0
	}
	if x.configured == gen {
		return r, nil
	}
	if _, err := r.run(ctx, localTimeout, nil, "symbolic-ref", "HEAD", "refs/heads/"+s.Branch); err != nil {
		return nil, err
	}
	if s.Remote == "" {
		// Exit status 5 is "there was no such key", which is the state wanted.
		if _, err := r.run(ctx, localTimeout, nil, "config", "--unset-all", "remote."+remoteName+".url"); err != nil &&
			exitCode(err) != 5 {
			return nil, err
		}
	} else if _, err := r.run(ctx, localTimeout, nil, "config", "remote."+remoteName+".url", s.Remote); err != nil {
		return nil, err
	}
	if s.Transport == TransportSSH && s.Source["known_hosts"] == "default" {
		if err := writeKnownHosts(s.KnownHosts); err != nil {
			return nil, err
		}
	}
	x.configured = gen
	return r, nil
}

// writeKnownHosts writes GitHub's keys to the export's own known_hosts, once.
func writeKnownHosts(path string) error {
	if _, err := os.Stat(path); err == nil {
		return nil
	}
	if err := os.WriteFile(path+".tmp", []byte(knownGitHubHosts), 0o600); err != nil {
		return err
	}
	if err := os.Rename(path+".tmp", path); err != nil {
		return err
	}
	return fsync.Dir(filepath.Dir(path))
}

// refuse records why the export cannot go on with the local repository.
func (x *Exporter) refuse(why string) error {
	x.mu.Lock()
	changed := x.status.refused != why
	x.status.refused = why
	x.mu.Unlock()
	if changed {
		x.log.Error("the git export stopped: the repository was changed outside the export", "why", why,
			"hint", "the export never moves a branch back; `trewd doctor` says what to do")
	}
	return nil
}

// branchRef is the branch's full ref name.
func branchRef(branch string) string { return "refs/heads/" + branch }

// revParse is the commit a ref names, or "" when it does not exist.
func revParse(ctx context.Context, r *runner, ref string) (string, error) {
	out, err := r.run(ctx, localTimeout, nil, "rev-parse", "-q", "--verify", ref+"^{commit}")
	if err != nil {
		if exitCode(err) == 1 && len(out) == 0 {
			return "", nil
		}
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

/* ---------------------------------------------------------------- *
 * The step
 * ---------------------------------------------------------------- */

// exportStep exports the next closed groups, or reports when the open one
// closes. A step's order is what makes a crash anywhere in it harmless:
//
//  1. fast-import writes the commits' objects and leaves the last on a
//     scratch ref; the branch has not moved.
//  2. The state row records it as pending, synced.
//  3. The branch moves to it, from where the state row says it was, which
//     git checks (update-ref's old value), synced by core.fsync.
//  4. The state row records it as the branch's commit.
//
// Killed before 2, the next step makes the same objects again, which Git
// already has. Killed between 2 and 3, the branch is where the state row
// said, and the pending commit is dropped and made again, identically.
// Killed between 3 and 4, the branch is at the pending commit, which is the
// export's own and is recorded as done. A branch anywhere else was moved by
// somebody else, and the export refuses.
func (x *Exporter) exportStep(ctx context.Context, r *runner, s Settings) (bool, int64, error) {
	b, found, err := loadBranch(x.db, s.Branch)
	if err != nil {
		return false, 0, err
	}
	ref, err := revParse(ctx, r, branchRef(s.Branch))
	if err != nil {
		return false, 0, err
	}
	switch {
	case b.pendingSHA != "" && ref == b.pendingSHA:
		b = b.promoted(x.st.Now().UnixMilli())
		if err := saveBranch(x.db, b); err != nil {
			return false, 0, err
		}
	case b.pendingSHA != "" && ref == b.commit:
		b.pendingSHA, b.pendingThrough, b.pendingLastAt, b.pendingEpoch = "", 0, 0, ""
		if err := saveBranch(x.db, b); err != nil {
			return false, 0, err
		}
	case ref != b.commit && !found:
		return false, 0, x.refuse(fmt.Sprintf("the repository has a branch %s at %s that the export did not make",
			s.Branch, short(ref)))
	case ref != b.commit && ref == "":
		return false, 0, x.refuse(fmt.Sprintf("the branch %s was deleted from the repository; the export had it at %s",
			s.Branch, short(b.commit)))
	case ref != b.commit:
		return false, 0, x.refuse(fmt.Sprintf("the branch %s is at %s, and the export left it at %s",
			s.Branch, short(ref), short(b.commit)))
	}
	if found && b.vault != x.vault {
		return false, 0, x.refuse(fmt.Sprintf("the branch %s was exported from vault %q, and this server serves %q",
			s.Branch, b.vault, x.vault))
	}
	x.mu.Lock()
	x.status.refused = ""
	x.mu.Unlock()

	epoch := x.st.Epoch()
	if !found {
		b = branchState{branch: s.Branch, vault: x.vault, epoch: epoch, adopted: s.Adopted}
	}
	switch {
	case b.adopted == s.Adopted:
	case b.commit == "":
		b.adopted = s.Adopted
	case s.Adopted != "":
		// Only a hand edit of the file gets here: `trewd git-export adopt`
		// sets aside a branch made on anything else.
		return false, 0, x.refuse(fmt.Sprintf("the branch %s was exported on top of %s, and the settings adopt %s; "+
			"`trewd git-export adopt` says what the remote holds", s.Branch, orNothing(b.adopted), short(s.Adopted)))
	}
	// Otherwise the settings adopt nothing for this remote, and the branch
	// goes on from the commits it has.
	if b.commit == "" && b.adopted != "" {
		if err := x.haveAdopted(ctx, r, s, b.adopted); err != nil {
			return false, 0, err
		}
	}
	if b.epoch != epoch {
		if b.commit == "" {
			b.epoch, b.through, b.lastAt = epoch, 0, 0
			return true, 0, saveBranch(x.db, b)
		}
		return true, 0, x.restoreCommit(ctx, r, s, b, epoch)
	}

	p := &planner{quiet: s.Quiet, lastAt: b.lastAt, fallback: x.st.Identity().CreatedAt}
	cursor, reachedEnd := b.through, false
	full := func() bool { return p.closedEntries >= stepEntries || p.closedBytes >= stepBytes }
	for !full() {
		batch, ok, err := x.st.NextBatch(x.vault, cursor, batchSize)
		if err != nil {
			return false, 0, err
		}
		if !ok {
			reachedEnd = true
			break
		}
		times, err := x.st.CommitTimes(x.vault, batch.From, batch.To)
		if err != nil {
			return false, 0, err
		}
		ops, err := x.st.OperationStamps(x.vault, batch.From, batch.To)
		if err != nil {
			return false, 0, err
		}
		// Stopping anywhere is safe: only closed groups are written, and the
		// next step reads again from the last one's end.
		for _, e := range batch.Entries {
			at, timed := times[e.UID]
			var op *store.OpStamp
			if o, ok := ops[e.UID]; ok {
				op = &o
			}
			p.add(e, at, timed, op)
			if full() {
				break
			}
		}
		cursor = batch.To
	}
	if reachedEnd {
		p.finish(x.st.Now().UnixMilli())
	}
	if len(p.closed) == 0 {
		return false, p.openUntil(), nil
	}
	last := p.closed[len(p.closed)-1]
	adopt := ""
	if b.commit == "" {
		adopt = b.adopted
	}
	tip, oids, err := x.write(ctx, r, s, b.commit, adopt, func(w *importer) error {
		for _, g := range p.closed {
			if err := w.group(g); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return false, 0, err
	}
	next := b
	next.through, next.lastAt = last.last(), last.lastAt
	if err := x.land(ctx, r, s, b, next, tip, oids); err != nil {
		return false, 0, err
	}
	return true, 0, nil
}

// promoted is b with its pending commit made the branch's.
func (b branchState) promoted(now int64) branchState {
	b.commit, b.through, b.lastAt, b.epoch = b.pendingSHA, b.pendingThrough, b.pendingLastAt, b.pendingEpoch
	b.pendingSHA, b.pendingThrough, b.pendingLastAt, b.pendingEpoch = "", 0, 0, ""
	b.updatedAt = now
	return b
}

// land records tip as next's commit, by steps 2 to 4 of exportStep, or just
// records next when the step made no commit.
func (x *Exporter) land(ctx context.Context, r *runner, s Settings, b, next branchState, tip string, oids []lfsObject) error {
	now := x.st.Now().UnixMilli()
	if tip == b.commit {
		next.updatedAt = now
		if err := saveBranch(x.db, next); err != nil {
			return err
		}
		x.exported(now)
		return nil
	}
	x.point("imported")
	pending := b
	pending.pendingSHA, pending.pendingThrough, pending.pendingLastAt, pending.pendingEpoch =
		tip, next.through, next.lastAt, next.epoch
	pending.updatedAt = now
	err := inTx(x.db, func(tx *sql.Tx) error {
		for _, o := range oids {
			if _, err := tx.Exec(`INSERT INTO lfs_objects (oid, size) VALUES (?, ?) ON CONFLICT(oid) DO NOTHING`,
				o.oid, o.size); err != nil {
				return err
			}
		}
		return saveBranch(tx, pending)
	})
	if err != nil {
		return err
	}
	x.point("pending")
	if _, err := r.run(ctx, localTimeout, nil, "update-ref", "-m", "trew git export", branchRef(s.Branch), tip,
		b.commit); err != nil {
		return err
	}
	x.point("moved")
	if err := saveBranch(x.db, pending.promoted(now)); err != nil {
		return err
	}
	x.exported(now)
	x.point("recorded")
	return nil
}

func (x *Exporter) exported(now int64) {
	x.mu.Lock()
	x.status.lastExportAt = now
	x.mu.Unlock()
}

func (x *Exporter) point(name string) {
	if x.crash != nil {
		x.crash(name)
	}
}

// restoreCommit is the one commit that is not a function of the store's
// history: the store's epoch changed, which is what a restore from a backup
// does, so the versions the branch was exported from are not this store's
// any more. The branch is not rewritten. One clearly marked commit replaces
// its tree with the restored store's notes as they are now, and the export
// goes on from there.
func (x *Exporter) restoreCommit(ctx context.Context, r *runner, s Settings, b branchState, epoch string) error {
	head, err := x.st.LatestUID(x.vault)
	if err != nil {
		return err
	}
	now := x.st.Now().UnixMilli()
	tip, oids, err := x.write(ctx, r, s, b.commit, "", func(w *importer) error {
		return w.restore(head, b.epoch, epoch, now)
	})
	if err != nil {
		return err
	}
	next := b
	next.epoch, next.through, next.lastAt = epoch, head, max(b.lastAt, now)
	x.log.Warn("the store was restored from a backup; the git export marked it with a commit and goes on",
		"previousEpoch", b.epoch, "epoch", epoch, "throughUid", head, "commit", short(tip))
	return x.land(ctx, r, s, b, next, tip, oids)
}

func short(sha string) string {
	if len(sha) > 12 {
		return sha[:12]
	}
	if sha == "" {
		return "nothing"
	}
	return sha
}

/* ---------------------------------------------------------------- *
 * Writing commits
 * ---------------------------------------------------------------- */

// lfsObject is an LFS object a commit references.
type lfsObject struct {
	oid  string
	size int64
}

// importer writes one fast-import stream.
type importer struct {
	x      *Exporter
	s      Settings
	w      *bufio.Writer
	mark   int
	parent string
	// adopt, when parent is "", is the adopted commit the first commit is
	// written on top of, with a tree of its own (adopt.go).
	adopt   string
	commits int
	tree    map[string]blobRef
	lfs     int // how many tree entries are LFS pointers
	oids    []lfsObject
	// known are the blobs this stream has written or named, by content, and
	// fresh the ones it wrote, for the blobs table once it has finished
	// (blobs.go).
	known map[string]knownBlob
	fresh []knownBlob
}

// write runs fast-import over what fill writes, from parent, and returns the
// last commit, parent itself when fill made none. With no parent and adopt
// set, the first commit is a child of the adopted commit.
func (x *Exporter) write(ctx context.Context, r *runner, s Settings, parent, adopt string,
	fill func(*importer) error) (string, []lfsObject, error) {
	tree, err := x.loadTree(ctx, r, parent)
	if err != nil {
		return "", nil, err
	}
	// The tree is changed as commits are written, and is good only if the
	// stream is: dropped now, and kept again below once the branch's new
	// commit is known.
	x.tree, x.treeOf = nil, ""
	ctx, cancel := context.WithTimeout(ctx, importTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, r.git, append(r.config(), "fast-import", "--done", "--quiet", "--force")...)
	cmd.Env, cmd.Dir = r.env(), r.home
	stderr := &limited{max: stderrLimit}
	cmd.Stdout, cmd.Stderr = io.Discard, stderr
	stopGently(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return "", nil, err
	}
	if err := cmd.Start(); err != nil {
		return "", nil, err
	}
	if parent != "" {
		adopt = ""
	}
	w := &importer{x: x, s: s, w: bufio.NewWriterSize(stdin, 1<<20), parent: parent, adopt: adopt, tree: tree}
	for _, ref := range tree {
		if ref.lfs {
			w.lfs++
		}
	}
	fmt.Fprintf(w.w, "reset %s\n", scratchRef)
	err = fill(w)
	if err == nil {
		x.point("streamed")
		_, err = w.w.WriteString("done\n")
	}
	if err == nil {
		err = w.w.Flush()
	}
	cerr := stdin.Close()
	if err != nil {
		// fast-import is told nothing more and told to stop, as every git
		// call is (stopGently, T44): what it wrote is objects no ref names,
		// which the next step writes again.
		_ = cmd.Process.Signal(syscall.SIGTERM)
		_ = cmd.Wait()
		return "", nil, err
	}
	if werr := cmd.Wait(); werr != nil || cerr != nil {
		x.forgetBlobs()
		return "", nil, &gitError{args: "fast-import", err: errors.Join(werr, cerr), stderr: r.redact(stderr.String())}
	}
	// What it wrote is in the repository now, named whatever happens to the
	// branch, so later streams name it rather than write it again.
	if err := x.rememberBlobs(w.fresh); err != nil {
		return "", nil, err
	}
	if w.commits == 0 {
		x.tree, x.treeOf = tree, parent
		return parent, nil, nil
	}
	tip, err := revParse(ctx, r, scratchRef)
	if err != nil {
		return "", nil, err
	}
	// Rule 4: the outcome, not the exit status. The new commits are a line
	// of exactly as many as were written, on top of the parent.
	span := tip
	switch {
	case parent != "":
		span = parent + ".." + tip
	case adopt != "":
		span = adopt + ".." + tip
	}
	out, err := r.run(ctx, localTimeout, nil, "rev-list", "--count", span)
	if err != nil {
		return "", nil, err
	}
	if n, _ := strconv.Atoi(strings.TrimSpace(string(out))); n != w.commits {
		return "", nil, fmt.Errorf("fast-import was given %d commits after %s and the repository has %d", w.commits,
			short(parent), n)
	}
	x.tree, x.treeOf = w.tree, tip
	return tip, w.oids, nil
}

// loadTree is the files a commit holds, from the cache when it is that
// commit's.
func (x *Exporter) loadTree(ctx context.Context, r *runner, commit string) (map[string]blobRef, error) {
	if commit == "" {
		return map[string]blobRef{}, nil
	}
	if x.tree != nil && x.treeOf == commit {
		return x.tree, nil
	}
	out, err := r.run(ctx, localTimeout, nil, "ls-tree", "-r", "-z", "--full-tree", commit)
	if err != nil {
		return nil, err
	}
	tree := map[string]blobRef{}
	attrs := ""
	for _, rec := range strings.Split(string(out), "\x00") {
		if rec == "" {
			continue
		}
		meta, path, ok := strings.Cut(rec, "\t")
		f := strings.Fields(meta)
		if !ok || len(f) != 3 || f[0] != "100644" || f[1] != "blob" {
			return nil, fmt.Errorf("commit %s has %q, which the export does not write", short(commit), rec)
		}
		if path == attributesPath {
			attrs = f[2]
			continue
		}
		tree[path] = blobRef{sha: f[2]}
	}
	if attrs != "" {
		b, err := r.run(ctx, localTimeout, nil, "cat-file", "blob", attrs)
		if err != nil {
			return nil, err
		}
		lfs, err := parseAttributes(b)
		if err != nil {
			return nil, err
		}
		for p := range lfs {
			ref, ok := tree[p]
			if !ok {
				return nil, fmt.Errorf("commit %s's .gitattributes names %q, which it does not hold", short(commit), p)
			}
			ref.lfs = true
			tree[p] = ref
		}
	}
	return tree, nil
}

// final is what one path is left as by a group.
type final struct {
	entry  store.Entry
	remove bool
}

// finals are the paths a group changes, in the order it first touches them,
// each with the state its last version leaves it in: a later version
// supersedes an earlier one, and a rename takes its source away.
func finals(entries []store.Entry) ([]string, map[string]final) {
	out := map[string]final{}
	var order []string
	touch := func(p string, f final) {
		if _, seen := out[p]; !seen {
			order = append(order, p)
		}
		out[p] = f
	}
	for _, e := range entries {
		if e.Prev != "" {
			touch(e.Prev, final{remove: true})
		}
		touch(e.Path, final{entry: e, remove: e.Deleted || e.Folder})
	}
	return order, out
}

// modify is one file line of a commit: the blob by its mark in this stream,
// or by its sha when an earlier stream wrote it (mark 0).
type modify struct {
	path string
	mark int
	sha  string
}

// group writes one group's blobs and, if its tree differs from its parent's,
// its commit.
func (w *importer) group(g *group) error {
	order, fs := finals(g.entries)
	var changes []change
	var mods []modify
	var dels []string
	lfsBefore := w.lfs
	lfsChanged := false
	for _, p := range order {
		f := fs[p]
		if !gitSafe(p) {
			w.x.excludedPath(p)
			continue
		}
		old, had := w.tree[p]
		if f.remove {
			if had {
				dels = append(dels, p)
				changes = append(changes, change{'D', p})
				delete(w.tree, p)
				if old.lfs {
					w.lfs--
					lfsChanged = true
				}
			}
			continue
		}
		ref, mark, err := w.blob(f.entry)
		if err != nil {
			return err
		}
		if had && old == ref {
			continue
		}
		kind := byte('A')
		if had {
			kind = 'M'
			if old.lfs {
				w.lfs--
			}
		}
		if ref.lfs {
			w.lfs++
		}
		if old.lfs != ref.lfs {
			lfsChanged = true
		}
		mods = append(mods, modify{p, mark, ref.sha})
		changes = append(changes, change{kind, p})
		w.tree[p] = ref
	}
	if len(changes) == 0 {
		return nil
	}
	author, msg := message(g, changes)
	writeAttrs := lfsChanged || (lfsBefore == 0) != (w.lfs == 0)
	if w.continues() {
		// The adopted commit's tree is not the export's: this commit's tree
		// is the files the export holds and nothing else of it.
		return w.commit(author, g.at, continuation(w.adopt, msg), nil, mods, w.lfs > 0, true)
	}
	return w.commit(author, g.at, msg, dels, mods, writeAttrs, false)
}

// continues reports whether the next commit is the first on top of an
// adopted commit.
func (w *importer) continues() bool { return w.commits == 0 && w.parent == "" && w.adopt != "" }

// blob writes e's bytes as a blob, or as an LFS pointer with the object
// stored beside the repository, and returns its name and its mark.
//
// Bytes the repository already holds are not read again: the blob is named by
// its sha, mark 0, or by its mark when this stream wrote it (blobs.go).
func (w *importer) blob(e store.Entry) (blobRef, int, error) {
	lfs := w.s.LFSThreshold > 0 && e.Size > w.s.LFSThreshold
	if k, ok, err := w.knownFor(e, lfs); err != nil {
		return blobRef{}, 0, err
	} else if ok {
		if lfs {
			w.oids = append(w.oids, lfsObject{k.oid, e.Size})
		}
		return k.ref, k.mark, nil
	}
	if lfs {
		oid, err := w.x.storeLFS(e)
		if err != nil {
			return blobRef{}, 0, err
		}
		ptr := lfsPointer(oid, e.Size)
		w.oids = append(w.oids, lfsObject{oid, e.Size})
		w.mark++
		fmt.Fprintf(w.w, "blob\nmark :%d\ndata %d\n", w.mark, len(ptr))
		w.w.Write(ptr)
		w.w.WriteByte('\n')
		ref := blobRef{sha: gitBlobName(ptr), lfs: true}
		w.wrote(e, ref, oid, w.mark)
		return ref, w.mark, nil
	}
	w.mark++
	fmt.Fprintf(w.w, "blob\nmark :%d\ndata %d\n", w.mark, e.Size)
	h := sha1.New()
	fmt.Fprintf(h, "blob %d\x00", e.Size)
	n, err := w.x.copyChunks(e, io.MultiWriter(w.w, h))
	if err != nil {
		return blobRef{}, 0, err
	}
	if n != e.Size {
		return blobRef{}, 0, fmt.Errorf("uid %d assembles to %d bytes and declares %d", e.UID, n, e.Size)
	}
	w.w.WriteByte('\n')
	ref := blobRef{sha: hex.EncodeToString(h.Sum(nil))}
	w.wrote(e, ref, "", w.mark)
	return ref, w.mark, nil
}

// commit writes one commit on the scratch ref. writeAttrs says the
// .gitattributes must be written again, from the tree as it now stands.
func (w *importer) commit(author string, atMillis int64, msg string, dels []string, mods []modify,
	writeAttrs, deleteAll bool) error {
	when := atMillis / 1000
	fmt.Fprintf(w.w, "commit %s\nauthor %s %d +0000\ncommitter %s %d +0000\ndata %d\n%s\n",
		scratchRef, author, when, committerIdent, when, len(msg), msg)
	switch {
	case w.commits == 0 && w.parent != "":
		fmt.Fprintf(w.w, "from %s\n", w.parent)
	case w.continues():
		fmt.Fprintf(w.w, "from %s\n", w.adopt)
	}
	if deleteAll {
		w.w.WriteString("deleteall\n")
	}
	for _, p := range dels {
		fmt.Fprintf(w.w, "D %s\n", cQuote(p))
	}
	for _, m := range mods {
		if m.mark == 0 {
			fmt.Fprintf(w.w, "M 100644 %s %s\n", m.sha, cQuote(m.path))
			continue
		}
		fmt.Fprintf(w.w, "M 100644 :%d %s\n", m.mark, cQuote(m.path))
	}
	if writeAttrs {
		var lfs []string
		for p, ref := range w.tree {
			if ref.lfs {
				lfs = append(lfs, p)
			}
		}
		if attrs := attributesFor(lfs); attrs == nil {
			if !deleteAll {
				fmt.Fprintf(w.w, "D %s\n", attributesPath)
			}
		} else {
			fmt.Fprintf(w.w, "M 100644 inline %s\ndata %d\n", attributesPath, len(attrs))
			w.w.Write(attrs)
			w.w.WriteByte('\n')
		}
	}
	w.w.WriteByte('\n')
	w.commits++
	return nil
}

// restore writes the marked commit of a restore: every live file at head.
func (w *importer) restore(head int64, from, to string, now int64) error {
	w.tree = map[string]blobRef{}
	w.lfs = 0
	var mods []modify
	err := w.x.st.EachAsOf(w.x.vault, head, store.AsOfRange{}, func(e store.Entry) (bool, error) {
		if e.Deleted || e.Folder {
			return true, nil
		}
		if !gitSafe(e.Path) {
			w.x.excludedPath(e.Path)
			return true, nil
		}
		full, ok, err := w.x.st.EntryByUID(w.x.vault, e.UID)
		if err != nil {
			return false, err
		}
		if !ok {
			return false, fmt.Errorf("uid %d went while the export was reading it", e.UID)
		}
		ref, mark, err := w.blob(full)
		if err != nil {
			return false, err
		}
		if ref.lfs {
			w.lfs++
		}
		w.tree[e.Path] = ref
		mods = append(mods, modify{e.Path, mark, ref.sha})
		return true, nil
	})
	if err != nil {
		return err
	}
	msg := fmt.Sprintf("Restore: the store was restored from a backup\n\n"+
		"The store's epoch changed, which is what a restore from a backup does, so the\n"+
		"versions this branch was exported from are not the restored store's. This\n"+
		"commit's tree is the restored store's notes at version %d, and the export goes\n"+
		"on from there. History before this commit is the store as it was before the\n"+
		"restore; nothing in it was rewritten.\n\n"+
		"Trew-Restore: true\nTrew-Previous-Epoch: %s\nTrew-Epoch: %s\nTrew-Versions: %d\n", head, from, to, head)
	return w.commit(committerIdent, now, msg, nil, mods, w.lfs > 0, true)
}

// message is a group's author and commit message.
func message(g *group, changes []change) (author, msg string) {
	var b strings.Builder
	if g.op != nil {
		label := identName(g.op.ActorLabel, "agent")
		email := agentEmail
		switch g.op.ActorKind {
		case store.ActorOperator:
			email = operatorEmail
		case store.ActorDevice:
			email = deviceEmail
		}
		author = label + " <" + email + ">"
		fmt.Fprintf(&b, "%s by %s: %s\n\n", oneLine(g.op.Tool), label, summary(changes))
		b.WriteString(listChanges(changes))
		fmt.Fprintf(&b, "\nTrew-Operation: %s\nTrew-Tool: %s\nTrew-Actor: %s\nTrew-Actor-Kind: %s\nTrew-Versions: %s\n",
			oneLine(g.op.ID), oneLine(g.op.Tool), label, oneLine(g.op.ActorKind), uidRange(g.first(), g.last()))
		return author, b.String()
	}
	label := identName(g.device, "unknown device")
	author = label + " <" + deviceEmail + ">"
	fmt.Fprintf(&b, "%s: %s\n\n", label, summary(changes))
	b.WriteString(listChanges(changes))
	fmt.Fprintf(&b, "\nTrew-Device: %s\nTrew-Versions: %s\n", label, uidRange(g.first(), g.last()))
	return author, b.String()
}

// gitBlobName is the name Git gives b as a blob.
func gitBlobName(b []byte) string {
	h := sha1.New()
	fmt.Fprintf(h, "blob %d\x00", len(b))
	h.Write(b)
	return hex.EncodeToString(h.Sum(nil))
}

// copyChunks writes e's bytes to w, each chunk checked against its name as
// the chunk store reads it, and returns how many there were. A chunk that
// cannot be read fails the step (rule 2): the export stops at that version
// rather than commit a note it could not read.
func (x *Exporter) copyChunks(e store.Entry, w io.Writer) (int64, error) {
	var n int64
	for _, name := range e.Chunks {
		body, err := x.st.Chunks().Get(x.vault, name)
		if err != nil {
			return n, fmt.Errorf("reading uid %d (%s): %w; `trewd verify -deep` says more", e.UID, e.Path, err)
		}
		k, err := w.Write(body)
		n += int64(k)
		if err != nil {
			return n, err
		}
	}
	return n, nil
}

// storeLFS writes e's bytes to the repository's LFS store, where git-lfs
// finds them, and returns their oid.
func (x *Exporter) storeLFS(e store.Entry) (string, error) {
	lfsDir := filepath.Join(x.dataDir, Dir, RepoDir, "lfs")
	tmpDir := filepath.Join(lfsDir, "tmp")
	if err := os.MkdirAll(tmpDir, 0o700); err != nil {
		return "", err
	}
	f, err := os.CreateTemp(tmpDir, "trew-")
	if err != nil {
		return "", err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	var h hash.Hash = sha256.New()
	n, err := x.copyChunks(e, io.MultiWriter(f, h))
	if err == nil && n != e.Size {
		err = fmt.Errorf("uid %d assembles to %d bytes and declares %d", e.UID, n, e.Size)
	}
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return "", err
	}
	oid := hex.EncodeToString(h.Sum(nil))
	dir := filepath.Join(lfsDir, "objects", oid[:2], oid[2:4])
	final := filepath.Join(dir, oid)
	if info, err := os.Stat(final); err == nil && info.Size() == e.Size {
		return oid, nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, final); err != nil {
		return "", err
	}
	return oid, fsync.Dir(dir)
}

// excludedPath records a path Git cannot hold, which the export leaves out.
func (x *Exporter) excludedPath(p string) {
	x.mu.Lock()
	defer x.mu.Unlock()
	if x.status.excluded == nil {
		x.status.excluded = map[string]bool{}
	}
	if !x.status.excluded[p] {
		x.status.excluded[p] = true
		x.log.Warn("the git export leaves out a path Git cannot hold", "path", p)
	}
}

// sortedKeys is m's keys in order, at most n of them.
func sortedKeys(m map[string]bool, n int) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	if len(out) > n {
		out = out[:n]
	}
	return out
}
