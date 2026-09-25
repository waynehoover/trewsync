package doctor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/waynehoover/trew/internal/chunks"
	"github.com/waynehoover/trew/internal/control"
	"github.com/waynehoover/trew/internal/dirlock"
	"github.com/waynehoover/trew/internal/metrics"
	"github.com/waynehoover/trew/internal/search"
	"github.com/waynehoover/trew/internal/server"
	"github.com/waynehoover/trew/internal/store"
)

// `trewd doctor` (PLAN.md M5.5): one command that diagnoses, so the
// maintainer does not have to infer. Modelled on `hister doctor`, which checks
// configuration, connectivity, authentication and index compatibility and
// says plainly that it does not repair data. Nothing here writes to the store,
// the index or a device: a diagnostic that cannot mutate is one to run while
// worried. It reads the data directory, the store opened for inspection, the
// index read-only, the records the commands leave, and, when a server is
// running, what that server says of itself over its control socket.
//
// Every finding has a status and, when it is not ok, a remedy: a sentence
// that says what to do, because "chunks: 3 missing" alone sends somebody to a
// search engine at 2am. warn and fail are actionable and make the command exit
// non-zero; note is information that asks nothing (a thing doctor cannot
// tell, an accepted risk); an operator can accept a named check, which turns
// its warn or fail into accepted, printed as such, so a condition decided on
// once (backups deferred, an unencrypted volume) does not keep the exit code
// red and hide the next real one.

// Status is a finding's verdict.
type Status string

// The verdicts. Warn and Fail are actionable.
const (
	OK       Status = "ok"
	Note     Status = "note"
	Warn     Status = "warn"
	Fail     Status = "fail"
	Accepted Status = "accepted"
)

// The checks, by the names findings carry and -accept takes.
const (
	CheckDataDir    = "data-dir"
	CheckStorage    = "storage"
	CheckEncryption = "encryption"
	CheckServer     = "server"
	CheckRestarts   = "restarts"
	CheckIdentity   = "identity"
	CheckStore      = "store"
	CheckChunks     = "chunks"
	CheckSpace      = "space"
	CheckIndex      = "index"
	CheckTokens     = "tokens"
	CheckDevices    = "devices"
	CheckCommits    = "commits"
	CheckBackup     = "backup"
	CheckRehearsal  = "rehearsal"
	CheckOrigin     = "origin"
)

// Checks is every check, in the order doctor runs and prints them.
var Checks = []string{
	CheckDataDir, CheckStorage, CheckEncryption, CheckServer, CheckRestarts, CheckIdentity, CheckStore,
	CheckChunks, CheckSpace, CheckIndex, CheckTokens, CheckDevices, CheckCommits, CheckBackup,
	CheckRehearsal, CheckOrigin,
}

// Finding is one check's verdict.
type Finding struct {
	Check   string   `json:"check"`
	Status  Status   `json:"status"`
	Summary string   `json:"summary"`
	Detail  []string `json:"detail,omitempty"`
	Remedy  string   `json:"remedy,omitempty"`
}

// Report is everything one run found.
type Report struct {
	DataDir  string    `json:"dataDir"`
	Vault    string    `json:"vault"`
	At       int64     `json:"at"`
	Running  bool      `json:"running"`
	Findings []Finding `json:"findings"`
	Sizes    *Sizes    `json:"sizes,omitempty"`
	// Metrics is the running server's, when one answered.
	Metrics *metrics.Snapshot `json:"metrics,omitempty"`
}

// Actionable is how many findings need somebody to act.
func (r Report) Actionable() int {
	n := 0
	for _, f := range r.Findings {
		if f.Status == Warn || f.Status == Fail {
			n++
		}
	}
	return n
}

// Sizes is what the data directory takes on disk.
type Sizes struct {
	Database         int64 `json:"database"`
	WAL              int64 `json:"wal"`
	Index            int64 `json:"index"`
	Bodies           int   `json:"bodies"`
	BodyBytes        int64 `json:"bodyBytes"`
	Quarantined      int   `json:"quarantined"`
	QuarantinedBytes int64 `json:"quarantinedBytes"`
	Temp             int   `json:"temp"`
	TempBytes        int64 `json:"tempBytes"`
	FreeBytes        int64 `json:"freeBytes"`
	TotalBytes       int64 `json:"totalBytes"`
}

// Options are what a run looks at and how.
type Options struct {
	DataDir string
	// Vault is the vault to examine, "default" when empty.
	Vault string
	// URL is the address devices reach the server at, ws:// or wss://, whose
	// /health is asked; when empty, the running server's own addresses are.
	URL string
	// Sample is how many chunk references to read and hash, chosen at
	// random; Deep reads every one instead.
	Sample int
	Deep   bool
	// Quick leaves out the walk of every entry and chunk reference, for the
	// server's own alerts, which run every few minutes: the sampled bodies,
	// the records and the running server's report are what they read.
	Quick bool
	// Accept are the checks whose warn or fail the operator has accepted.
	Accept map[string]bool
	// Now is the clock; Storage reads the mount table; HTTP asks the origin.
	// Each defaults to the real thing, and is a seam for the tests that
	// inject faults.
	Now     func() time.Time
	Storage func(dir string) (Storage, error)
	HTTP    *http.Client
	// Space, when set, stands in for the filesystem's free and total bytes,
	// which no test can make small on a real disk.
	Space func(dir string) (free, total int64)
}

// The thresholds, each a judgement written down once.
const (
	// DefaultSample is how many chunk references a run reads and hashes.
	DefaultSample = 256
	// DeviceQuietAfter is how long a device may go unseen before doctor asks
	// whether it is lost: a month, longer than any holiday a phone is left
	// in a drawer for.
	DeviceQuietAfter = 30 * 24 * time.Hour
	// AppliedStuckAfter is how long a connected device may sit behind the
	// vault's head without its applied checkpoint moving before it is called
	// stopped: well beyond any download the plugin does in one pass.
	AppliedStuckAfter = 15 * time.Minute
	// IndexLagUIDs is how far the running index may trail the head before it
	// is behind rather than busy.
	IndexLagUIDs = 500
	// TokenExpiresSoon is how close to its expiry a token is worth renewing.
	TokenExpiresSoon = 14 * 24 * time.Hour
	// LowSpaceWarn is free space below which doctor warns; the store refuses
	// writes itself at store.LowSpaceBytes.
	LowSpaceWarn = 1 << 30
	// WALWarn is a write-ahead log large enough to mean checkpoints are not
	// happening: a reader held open for hours, most likely.
	WALWarn = 512 << 20
	// BackupMaxAge is how old the last good backup may be: two nightly runs.
	BackupMaxAge = 48 * time.Hour
	// RehearsalMaxAge is how long a rehearsal proves anything for: a quarter,
	// or one release cycle of the schema and the backup format.
	RehearsalMaxAge = 90 * 24 * time.Hour
	// RestartLoopStarts within RestartLoopWindow, the last of them within
	// RestartLoopRecent, is a restart loop.
	RestartLoopStarts = 5
	RestartLoopWindow = 10 * time.Minute
	RestartLoopRecent = time.Hour
	// CommitFailuresFail is consecutive commit failures that mean the store
	// has stopped taking notes rather than had a bad moment.
	CommitFailuresFail = 3
)

// run is one doctor run in progress.
type run struct {
	opt    Options
	now    time.Time
	rep    Report
	status *control.Status
	health *healthState
	st     *store.Store
	latest int64
}

// healthState is what the running server's /health would answer.
type healthState struct {
	CanPersist bool   `json:"canPersist"`
	Reason     string `json:"reason"`
	FreeBytes  int64  `json:"freeBytes"`
	TotalBytes int64  `json:"totalBytes"`
}

// Run diagnoses the data directory. It never returns an error: every problem,
// its own included, is a finding.
func Run(ctx context.Context, opt Options) Report {
	if opt.Vault == "" {
		opt.Vault = "default"
	}
	if opt.Sample <= 0 {
		opt.Sample = DefaultSample
	}
	if opt.Now == nil {
		opt.Now = time.Now
	}
	if opt.Storage == nil {
		opt.Storage = StorageOf
	}
	if opt.HTTP == nil {
		opt.HTTP = &http.Client{Timeout: 5 * time.Second}
	}
	r := &run{opt: opt, now: opt.Now()}
	r.rep = Report{DataDir: opt.DataDir, Vault: opt.Vault, At: r.now.UnixMilli()}

	if !r.dataDir() {
		return r.finish()
	}
	r.storage()
	r.server(ctx)
	r.restarts()
	if release, ok := r.openStore(); ok {
		r.identity()
		if !opt.Quick {
			r.storeChecks()
		}
		r.chunks()
		r.space()
		r.index()
		r.tokens()
		r.devices()
		_ = r.st.Close()
		release()
	}
	r.commits()
	r.backup()
	r.rehearsal()
	r.origin(ctx)
	return r.finish()
}

// finish applies the accepted checks and orders the findings.
func (r *run) finish() Report {
	order := map[string]int{}
	for i, c := range Checks {
		order[c] = i
	}
	sort.SliceStable(r.rep.Findings, func(a, b int) bool {
		return order[r.rep.Findings[a].Check] < order[r.rep.Findings[b].Check]
	})
	for i, f := range r.rep.Findings {
		if r.opt.Accept[f.Check] && (f.Status == Warn || f.Status == Fail) {
			r.rep.Findings[i].Status = Accepted
		}
	}
	return r.rep
}

func (r *run) add(f Finding) { r.rep.Findings = append(r.rep.Findings, f) }

func (r *run) ok(check, summary string, detail ...string) {
	r.add(Finding{Check: check, Status: OK, Summary: summary, Detail: detail})
}

func (r *run) note(check, summary string, detail ...string) {
	r.add(Finding{Check: check, Status: Note, Summary: summary, Detail: detail})
}

func (r *run) bad(status Status, check, summary, remedy string, detail ...string) {
	r.add(Finding{Check: check, Status: status, Summary: summary, Remedy: remedy, Detail: detail})
}

/* ---------------------------------------------------------------- *
 * The directory, its storage, and who holds it
 * ---------------------------------------------------------------- */

// dataDir checks the directory is a trewd data directory this build reads,
// and private. False means nothing else can be examined.
func (r *run) dataDir() bool {
	dir := r.opt.DataDir
	info, err := os.Stat(dir)
	switch {
	case errors.Is(err, os.ErrNotExist):
		r.bad(Fail, CheckDataDir, fmt.Sprintf("there is no directory at %s", dir),
			"Check the -data path, or TREW_DATA. `trewd serve` creates a data directory on its first start.")
		return false
	case err != nil:
		r.bad(Fail, CheckDataDir, fmt.Sprintf("%s cannot be read: %v", dir, err),
			"Run doctor as the account the server runs as, or fix the directory's permissions.")
		return false
	case !info.IsDir():
		r.bad(Fail, CheckDataDir, fmt.Sprintf("%s is not a directory", dir), "Check the -data path.")
		return false
	}
	dbPath, _ := store.DataDir(dir)
	if _, err := os.Stat(dbPath); errors.Is(err, os.ErrNotExist) {
		r.bad(Fail, CheckDataDir, fmt.Sprintf("%s holds no %s, so it is not a data directory yet", dir, filepath.Base(dbPath)),
			"Check the -data path. `trewd serve` creates the store on its first start.")
		return false
	}
	if err := store.CheckDataDir(dir); err != nil {
		remedy := "Point -data at a trewd data directory. Nothing here was changed."
		if errors.Is(err, store.ErrFutureSchema) {
			remedy = "Run the trewd that wrote it, or a newer one. This build must not open it, and did not."
		}
		r.bad(Fail, CheckDataDir, err.Error(), remedy)
		return false
	}
	if perm := info.Mode().Perm(); perm&0o077 != 0 {
		r.bad(Warn, CheckDataDir, fmt.Sprintf("%s is mode %04o, so other accounts on this machine can read into it", dir, perm),
			fmt.Sprintf("chmod 700 %s. The store holds every note in the clear.", dir))
		return true
	}
	r.ok(CheckDataDir, fmt.Sprintf("%s is a trewd data directory, private to its owner", dir))
	return true
}

// storage checks the directory is not on storage a restart or a container
// replacement erases (the check adapted from Syncidian), and says what can be
// told about encryption at rest (threat model S1).
func (r *run) storage() {
	s, err := r.opt.Storage(r.opt.DataDir)
	if err != nil {
		r.bad(Warn, CheckStorage, fmt.Sprintf("the mount table could not be read: %v", err),
			"Check /proc/self/mounts is readable, or run doctor on the host.")
		return
	}
	where := fmt.Sprintf("%s mounted at %s", s.FSType, s.MountPoint)
	switch {
	case s.FSType == "":
		// macOS and Windows have no mount table to read, and "survives a
		// restart" would be a claim nothing here checked.
		r.note(CheckStorage, fmt.Sprintf("%s is on storage doctor cannot inspect on this platform, so it cannot "+
			"tell whether a restart erases it", s.Dir), "A RAM disk or a container's own layer would lose every note; "+
			"check the data directory is on a persistent disk or volume.")
	case s.Ephemeral:
		why := "a RAM-backed filesystem, erased at the next restart"
		if !ramBacked[s.FSType] {
			why = "the container's own writable layer, erased when the container is replaced, which every upgrade does"
		}
		r.bad(Fail, CheckStorage, fmt.Sprintf("%s is on %s: %s", s.Dir, where, why),
			"Mount a persistent volume at the data directory (compose.yaml mounts ./trew/data at /data) and move the "+
				"store onto it with the server stopped. Until then every note here is one restart from gone.")
	default:
		r.ok(CheckStorage, fmt.Sprintf("%s is on %s, which survives a restart", s.Dir, where))
	}
	if enc := s.Encryption(); enc != "" {
		r.ok(CheckEncryption, "the volume looks encrypted at rest: "+enc)
		return
	}
	r.note(CheckEncryption, "doctor cannot tell whether this volume is encrypted at rest",
		"The store holds every note and its history in the clear, and so does every copy of this directory.",
		"docs/operations.md says how to put it on an encrypted volume (threat model S1).")
}

// server asks a running server what it knows of itself, and tells a server
// that holds the directory and does not answer from one that is not running.
func (r *run) server(ctx context.Context) {
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	reply, err := control.Call(cctx, r.opt.DataDir, control.Request{Op: "status", Vault: r.opt.Vault})
	switch {
	case err == nil && reply.Error != nil:
		r.bad(Fail, CheckServer, "the running server refused doctor's question: "+reply.Error.Msg,
			"If it serves another vault, run doctor with -vault naming it.")
		return
	case err == nil && reply.Status != nil:
		r.status = reply.Status
		r.rep.Running = true
		var h healthState
		_ = json.Unmarshal(reply.Status.Health, &h)
		r.health = &h
		var m metrics.Snapshot
		if json.Unmarshal(reply.Status.Metrics, &m) == nil {
			r.rep.Metrics = &m
		}
		since := time.UnixMilli(reply.Status.StartedAt).UTC().Format(time.RFC3339)
		if !h.CanPersist {
			r.bad(Fail, CheckServer, fmt.Sprintf("the server (%s, up since %s) cannot take a note: %s",
				reply.Status.Version, since, h.Reason), remedyForHealth(h.Reason))
			return
		}
		r.ok(CheckServer, fmt.Sprintf("trewd %s is serving vault %q, up since %s, and can take a note",
			reply.Status.Version, reply.Status.Vault, since))
		return
	}
	if holder, alive := liveHolder(r.opt.DataDir, dirlock.Server); alive {
		r.bad(Fail, CheckServer, fmt.Sprintf("%s holds this data directory and does not answer on its control socket", holder),
			"The server is hung or starting slowly. Wait a minute and run doctor again; if it still does not answer, "+
				"read its log (journalctl -u trew, or docker compose logs trew) and restart it.")
		return
	}
	r.note(CheckServer, "no server is running on this data directory",
		"Checks that need a running server (health as it serves, delivery, metrics) are skipped.")
}

// remedyForHealth is what to do about each word /health answers.
func remedyForHealth(reason string) string {
	switch store.HealthReason(reason) {
	case store.HealthNoSpace:
		return "Free space on the data volume, or grow it: the store refuses writes below 64 MiB free. `trewd stats` " +
			"says whether a purge would help."
	case store.HealthUnwritable:
		return "The database refuses writes: check the filesystem is not mounted read-only (dmesg for I/O errors) and " +
			"that the data directory is owned by the server's account."
	case store.HealthChunksUnwritable:
		return "The chunk tree refuses writes: check its permissions and that its volume is mounted read-write."
	case store.HealthNoChunkDir:
		return "The chunk tree is gone: a volume that did not mount, most likely. Mount it and restart the server."
	case store.HealthBusy:
		return "Something holds the database's write lock: a long backup or verify. Run doctor again when it ends."
	case store.HealthClosing:
		return "The server is stopping. Run doctor again once it has restarted."
	}
	return "Read the server's log for the error, and run `trewd verify -deep` with the server stopped."
}

// liveHolder is who holds a lock exclusively, by the record it wrote, when
// that process is still alive. Read without taking the lock.
func liveHolder(dataDir, name string) (string, bool) {
	holder := dirlock.Holder(dataDir, name)
	if holder == "" {
		return "", false
	}
	_, pidText, ok := strings.Cut(holder, " pid ")
	if !ok {
		return holder, false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(pidText))
	if err != nil || pid <= 0 {
		return holder, false
	}
	// Signal 0 asks whether the process exists without touching it.
	err = syscall.Kill(pid, 0)
	return holder, err == nil || errors.Is(err, syscall.EPERM)
}

// restarts reads how the server has been starting: a restart loop, or a run
// that did not stop cleanly.
func (r *run) restarts() {
	var rec RuntimeRecord
	found, err := ReadRecord(r.opt.DataDir, RuntimeRecordFile, &rec)
	switch {
	case err != nil:
		r.bad(Warn, CheckRestarts, err.Error(), "Remove "+RuntimeRecordFile+" from the data directory; serve writes it again.")
		return
	case !found || len(rec.Starts) == 0:
		r.note(CheckRestarts, "no start of this server is recorded yet")
		return
	}
	last := time.UnixMilli(rec.Starts[len(rec.Starts)-1])
	if n := len(rec.Starts); n >= RestartLoopStarts {
		first := time.UnixMilli(rec.Starts[n-RestartLoopStarts])
		if last.Sub(first) <= RestartLoopWindow && r.now.Sub(last) <= RestartLoopRecent {
			r.bad(Fail, CheckRestarts, fmt.Sprintf("the server started %d times between %s and %s: a restart loop",
				RestartLoopStarts, first.UTC().Format(time.RFC3339), last.UTC().Format(time.RFC3339)),
				"Something stops it right after it starts. Read the log of one run (journalctl -u trew -n 100, or docker "+
					"compose logs trew): a refusal at startup says why, and its remedy, and restarting will not change it.")
			return
		}
	}
	if !rec.CleanStop && !r.rep.Running {
		r.bad(Warn, CheckRestarts, fmt.Sprintf("the last run (%s, started %s) did not stop cleanly", rec.Version,
			last.UTC().Format(time.RFC3339)),
			"It was killed or crashed. Nothing acknowledged is lost (rule 1), but read its log for why, and run "+
				"`trewd verify -deep` before starting it again.")
		return
	}
	r.ok(CheckRestarts, fmt.Sprintf("%d starts recorded, the last at %s", len(rec.Starts), last.UTC().Format(time.RFC3339)))
}

/* ---------------------------------------------------------------- *
 * The store
 * ---------------------------------------------------------------- */

// openStore opens the store for inspection under the shared data lock, as
// verify does, so a purge cannot sweep bodies while they are counted. The
// release is the caller's.
func (r *run) openStore() (func(), bool) {
	lock, err := dirlock.Shared(r.opt.DataDir, dirlock.Data)
	if err != nil {
		holder := dirlock.Holder(r.opt.DataDir, dirlock.Data)
		if holder == "" {
			holder = "another command"
		}
		r.bad(Warn, CheckStore, fmt.Sprintf("%s holds the data directory exclusively, so the store was not examined", holder),
			"A purge is running: its numbers are right when it finishes. Run doctor again then.")
		return nil, false
	}
	dbPath, chunkDir := store.DataDir(r.opt.DataDir)
	st, err := store.OpenForInspection(dbPath, chunkDir)
	if err != nil {
		lock.Release()
		r.bad(Fail, CheckStore, fmt.Sprintf("the store cannot be opened: %v", err),
			"If the schema is older, start `trewd serve` once to upgrade it. Otherwise keep the directory as it is, "+
				"restore from a backup into a fresh directory (docs/operations.md), and read notes out with `trewd cat`.")
		return nil, false
	}
	r.st = st
	if latest, err := st.LatestUID(r.opt.Vault); err == nil {
		r.latest = latest
	}
	return func() { lock.Release() }, true
}

// identity reports what the store says it is.
func (r *run) identity() {
	id := r.st.Identity()
	vaults, err := r.st.Vaults()
	if err != nil {
		r.bad(Fail, CheckIdentity, fmt.Sprintf("the vault list cannot be read: %v", err),
			"Run `trewd verify -deep`, and restore from a backup if it fails.")
		return
	}
	found := false
	for _, v := range vaults {
		found = found || v == r.opt.Vault
	}
	if !found {
		r.bad(Fail, CheckIdentity, fmt.Sprintf("the store holds no vault %q (it holds: %s)", r.opt.Vault, strings.Join(vaults, ", ")),
			"Run doctor with -vault naming the vault the server serves.")
		return
	}
	if id.SchemaVersion < store.SchemaVersion {
		r.bad(Warn, CheckIdentity, fmt.Sprintf("the store is at schema %d and this build writes %d", id.SchemaVersion, store.SchemaVersion),
			"Take a backup, then start this build's `trewd serve`, which upgrades the store when it opens it.")
		return
	}
	r.ok(CheckIdentity, fmt.Sprintf("product %s, schema %d, epoch %s, vault %q at uid %d", id.Product, id.SchemaVersion,
		id.Epoch, r.opt.Vault, r.latest))
}

// storeChecks runs verify's pass: every entry, every chunk reference present,
// the registry and the agents' log decoded. Deep also hashes every body.
func (r *run) storeChecks() {
	v, err := r.st.Verify(r.opt.Deep)
	if err != nil {
		r.bad(Fail, CheckStore, fmt.Sprintf("the store could not be walked: %v", err),
			"Stop the server, run `trewd verify -deep`, and restore from a backup if it fails.")
		return
	}
	pass := "shallow"
	if r.opt.Deep {
		pass = "deep"
	}
	if len(v.Faults) == 0 {
		if v.Entries == 0 {
			r.note(CheckStore, "the store holds no entries yet, so there was nothing to check")
			return
		}
		r.ok(CheckStore, fmt.Sprintf("a %s pass checked %d entries, %d chunk references and %d agent operations: no faults",
			pass, v.Entries, v.Chunks, v.Operations))
		return
	}
	reasons := map[string]int{}
	var detail []string
	for i, f := range v.Faults {
		reasons[f.Reason]++
		if i < 10 {
			detail = append(detail, f.String())
		}
	}
	if len(v.Faults) > 10 {
		detail = append(detail, fmt.Sprintf("and %d more; `trewd verify -deep` lists every one", len(v.Faults)-10))
	}
	r.bad(Fail, CheckStore, fmt.Sprintf("%d faults: %s", len(v.Faults), countsOf(reasons)), remedyForFaults(reasons), detail...)
}

// remedyForFaults says what to do about the reasons verify gives.
func remedyForFaults(reasons map[string]int) string {
	switch {
	case reasons["missing"]+reasons["corrupt"] > 0:
		return "A body is gone or damaged. Run `trew repair` (or \"Send back what the server has lost\" in the plugin) " +
			"on a device that still holds those notes; if none does, restore the versions from a backup. `trewd cat` " +
			"reads every note that is intact."
	case reasons["lostpin"] > 0:
		return "A version an agent's edit displaced is gone although pinned: restore it from a backup taken after " +
			"the operation."
	case reasons["livekeys"] > 0:
		return "The live-path index has drifted from the entries: restarting `trewd serve` rebuilds it, and says so in its log."
	}
	return "Keep the directory as it is, take a backup, and read docs/operations.md, \"Something is wrong with the store\"."
}

// countsOf is a map of counts as "missing 2, corrupt 1", by name.
func countsOf(m map[string]int) string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, len(keys))
	for i, k := range keys {
		parts[i] = fmt.Sprintf("%s %d", k, m[k])
	}
	return strings.Join(parts, ", ")
}

// chunks reads and hashes a random sample of chunk references, and counts the
// bodies already quarantined.
func (r *run) chunks() {
	c := r.st.Chunks()
	fp, err := c.Measure()
	if err != nil {
		r.bad(Fail, CheckChunks, fmt.Sprintf("the chunk tree cannot be walked: %v", err),
			"Check the chunk directory is mounted and readable by the server's account.")
		return
	}
	dbPath, _ := store.DataDir(r.opt.DataDir)
	r.rep.Sizes = &Sizes{
		Database: fileSize(dbPath), WAL: fileSize(dbPath + "-wal"),
		Index:  fileSize(filepath.Join(r.opt.DataDir, search.FileName)) + fileSize(filepath.Join(r.opt.DataDir, search.FileName+"-wal")),
		Bodies: fp.Bodies, BodyBytes: fp.Bytes, Quarantined: fp.Quarantined, QuarantinedBytes: fp.QuarantinedBytes,
		Temp: fp.Temp, TempBytes: fp.TempBytes,
	}

	var sample []struct{ vault, name string }
	seen := 0
	if !r.opt.Deep {
		if err := r.st.ChunkRefs(func(vault, name string) error {
			seen++
			if len(sample) < r.opt.Sample {
				sample = append(sample, struct{ vault, name string }{vault, name})
			} else if j := rand.IntN(seen); j < r.opt.Sample {
				sample[j] = struct{ vault, name string }{vault, name}
			}
			return nil
		}); err != nil {
			r.bad(Fail, CheckChunks, fmt.Sprintf("the chunk references cannot be read: %v", err),
				"Run `trewd verify -deep` with the server stopped.")
			return
		}
	}
	var missing, corrupt []string
	for _, s := range sample {
		if err := c.Check(s.vault, s.name); err != nil {
			if errors.Is(err, chunks.ErrNotFound) {
				missing = append(missing, s.name)
			} else {
				corrupt = append(corrupt, s.name)
			}
		}
	}
	checked := fmt.Sprintf("%d of %d chunk references read and hashed", len(sample), seen)
	if r.opt.Deep {
		checked = "every chunk reference read and hashed by the deep pass above"
	}
	switch {
	case len(missing)+len(corrupt) > 0:
		r.bad(Fail, CheckChunks, fmt.Sprintf("%s: %d missing, %d corrupt", checked, len(missing), len(corrupt)),
			"Run `trewd verify -deep` for the whole list, then `trew repair` on a device that holds those notes, or "+
				"restore the versions from a backup.")
	case fp.Quarantined > 0:
		r.bad(Warn, CheckChunks, fmt.Sprintf("%s, all sound; %d bodies (%d bytes) are quarantined for failing their own hash",
			checked, fp.Quarantined, fp.QuarantinedBytes),
			"Run `trew repair` on a device that holds those notes; each quarantined body is replaced when the real one "+
				"arrives. `trewd verify -deep` names the notes.")
	default:
		r.ok(CheckChunks, fmt.Sprintf("%s, all sound; %d bodies, none quarantined", checked, fp.Bodies))
	}
}

func fileSize(p string) int64 {
	info, err := os.Stat(p)
	if err != nil {
		return 0
	}
	return info.Size()
}

// space checks the free space and the write-ahead log.
func (r *run) space() {
	h := r.st.CheckHealth(context.Background())
	if r.health != nil && r.health.TotalBytes > 0 {
		h.FreeBytes, h.TotalBytes = r.health.FreeBytes, r.health.TotalBytes
	}
	if r.opt.Space != nil {
		h.FreeBytes, h.TotalBytes = r.opt.Space(r.opt.DataDir)
	}
	if r.rep.Sizes != nil {
		r.rep.Sizes.FreeBytes, r.rep.Sizes.TotalBytes = h.FreeBytes, h.TotalBytes
	}
	free := fmt.Sprintf("%s free of %s", human(h.FreeBytes), human(h.TotalBytes))
	switch {
	case h.TotalBytes == 0:
		r.bad(Warn, CheckSpace, "the free space on the data volume could not be read",
			"Check the chunk directory exists and its volume is mounted.")
	case h.FreeBytes < store.LowSpaceBytes():
		r.bad(Fail, CheckSpace, free+": the store refuses every write below "+human(store.LowSpaceBytes()),
			"Free space on the data volume or grow it now. `trewd stats` says whether a purge would help; a purge needs "+
				"a backup first, and the backup needs room elsewhere.")
	case h.FreeBytes < LowSpaceWarn || h.FreeBytes < h.TotalBytes/20:
		r.bad(Warn, CheckSpace, free+": little room left",
			"Grow the volume or free space before the store starts refusing writes at "+human(store.LowSpaceBytes())+".")
	case r.rep.Sizes != nil && r.rep.Sizes.WAL > WALWarn:
		r.bad(Warn, CheckSpace, fmt.Sprintf("%s, but the write-ahead log is %s, so checkpoints are not keeping up", free,
			human(r.rep.Sizes.WAL)),
			"Something holds a read open for a long time (a stuck backup or verify). Let it finish, or restart the server.")
	default:
		r.ok(CheckSpace, free)
	}
}

// index checks the search index: its generation, how far it trails the head,
// and whether it belongs to this store.
func (r *run) index() {
	if r.status != nil && len(r.status.Index) > 0 {
		var s search.Status
		if err := json.Unmarshal(r.status.Index, &s); err == nil {
			r.liveIndex(s)
			return
		}
	}
	in, found, err := search.Inspect(r.opt.DataDir)
	switch {
	case err != nil:
		r.bad(Warn, CheckIndex, fmt.Sprintf("the search index cannot be read: %v", err),
			"It is derived: stop the server, move "+search.FileName+" aside, and `trewd serve` builds a new one. "+
				"Search scans every note until then and misses nothing.")
		return
	case !found:
		r.note(CheckIndex, "there is no search index; `trewd serve` builds one, and search scans until it has")
		return
	case in.OwnerEpoch != "" && (in.OwnerEpoch != r.st.Epoch() || in.OwnerVault != r.opt.Vault):
		r.note(CheckIndex, "the search index was built for another store or vault (a restore, most likely); "+
			"`trewd serve` drops it and builds another")
		return
	case in.Generation == 0:
		r.note(CheckIndex, "the search index has not finished its first build; `trewd serve` goes on with it")
		return
	case in.Version != search.IndexVersion:
		r.note(CheckIndex, fmt.Sprintf("the search index is version %d and this build reads %d; it is rebuilt when "+
			"`trewd serve` starts", in.Version, search.IndexVersion))
		return
	}
	lag := r.latest - in.IndexedHead
	if lag > 0 {
		r.note(CheckIndex, fmt.Sprintf("generation %d has indexed up to uid %d, %d behind the head; it catches up when "+
			"`trewd serve` runs", in.Generation, in.IndexedHead, lag))
		return
	}
	r.indexCounters(fmt.Sprintf("generation %d is current at uid %d", in.Generation, in.IndexedHead),
		in.Unreadable, in.TagFailures, in.LinkFailures)
}

// liveIndex is the index as the running server reports it.
func (r *run) liveIndex(s search.Status) {
	lag := r.latest - s.IndexedHead
	switch {
	case s.Error != "":
		r.bad(Warn, CheckIndex, "the search index's worker failed: "+s.Error,
			"Search scans and misses nothing meanwhile. Read the server's log; if it persists, stop the server, move "+
				search.FileName+" aside, and start it again to rebuild.")
	case !s.Usable && !s.Rebuilding:
		r.bad(Warn, CheckIndex, "the search index is not trusted and no rebuild is running: "+s.Distrust,
			"Restart `trewd serve`, which checks the index and rebuilds it.")
	case !s.Usable:
		r.note(CheckIndex, "the search index is being rebuilt ("+s.Distrust+"); search scans until it is done")
	case lag > IndexLagUIDs:
		r.bad(Warn, CheckIndex, fmt.Sprintf("generation %d is %d uids behind the head", s.Generation, lag),
			"Search stays correct by scanning what the index has not reached, only slower. If the lag grows between "+
				"two runs of doctor, read the server's log for the worker's error.")
	default:
		r.indexCounters(fmt.Sprintf("generation %d, %d behind the head", s.Generation, max(lag, 0)),
			s.Unreadable, s.TagFailures, s.LinkFailures)
	}
}

// indexCounters reports notes the index could not read, which search scans.
func (r *run) indexCounters(summary string, unreadable, tags, links int64) {
	if unreadable+tags+links > 0 {
		r.note(CheckIndex, fmt.Sprintf("%s; %d notes it could not read, %d whose tags and %d whose links it could not parse, "+
			"each searched by scanning", summary, unreadable, tags, links))
		return
	}
	r.ok(CheckIndex, summary)
}

// tokens checks the MCP tokens: expired ones, and ones about to be.
func (r *run) tokens() {
	toks, err := r.st.MCPTokens(r.opt.Vault)
	if err != nil {
		r.bad(Fail, CheckTokens, fmt.Sprintf("the MCP tokens cannot be read: %v", err), "Run `trewd verify -deep`.")
		return
	}
	if len(toks) == 0 {
		r.note(CheckTokens, "no MCP token; `trewd mcp-token -label NAME` mints one when an agent needs it")
		return
	}
	now := r.now.UnixMilli()
	var expired, soon, never []string
	writes := 0
	for _, t := range toks {
		if t.Scope == store.ScopeWrite {
			writes++
		}
		switch {
		case t.Expired(now):
			expired = append(expired, fmt.Sprintf("%s %q expired %s", t.ID, t.Label, stampOf(*t.ExpiresAt)))
		case t.ExpiresAt == nil:
			never = append(never, fmt.Sprintf("%s %q (%s) never expires", t.ID, t.Label, t.Scope))
		case time.UnixMilli(*t.ExpiresAt).Sub(r.now) < TokenExpiresSoon:
			soon = append(soon, fmt.Sprintf("%s %q expires %s", t.ID, t.Label, stampOf(*t.ExpiresAt)))
		}
	}
	summary := fmt.Sprintf("%d MCP tokens, %d with write scope", len(toks), writes)
	switch {
	case len(expired) > 0:
		r.bad(Warn, CheckTokens, fmt.Sprintf("%s; %d expired", summary, len(expired)),
			"An agent holding an expired token is refused with 401. Mint a new one with `trewd mcp-token -label NAME`, "+
				"and remove the old with `trewd mcp-token -revoke ID`.", append(expired, soon...)...)
	case len(soon) > 0:
		r.bad(Warn, CheckTokens, fmt.Sprintf("%s; %d expire within %d days", summary, len(soon), int(TokenExpiresSoon.Hours()/24)),
			"Mint a replacement with `trewd mcp-token -label NAME` and give it to the agent before the old one stops.", soon...)
	case len(never) > 0:
		r.note(CheckTokens, fmt.Sprintf("%s; %d never expire", summary, len(never)), never...)
	default:
		r.ok(CheckTokens, summary)
	}
}

func stampOf(ms int64) string { return time.UnixMilli(ms).UTC().Format(time.RFC3339) }

// devices checks when each device was last seen and, with a server running,
// whether each connected device is keeping up.
func (r *run) devices() {
	ds, err := r.st.Devices(r.opt.Vault)
	if err != nil {
		r.bad(Fail, CheckDevices, fmt.Sprintf("the device list cannot be read: %v", err), "Run `trewd verify -deep`.")
		return
	}
	if len(ds) == 0 {
		r.note(CheckDevices, "no device is paired yet; `trewd invite` makes an invite for the first")
		return
	}
	var delivery []server.DeviceDelivery
	if r.status != nil {
		_ = json.Unmarshal(r.status.Devices, &delivery)
	}
	online := map[string]server.DeviceDelivery{}
	for _, d := range delivery {
		if d.Online {
			online[d.ID] = d
		}
	}
	var quiet, stuck, detail []string
	for _, d := range ds {
		line := fmt.Sprintf("%s %q: ", d.ID, d.Name)
		live, isOnline := online[d.ID]
		switch {
		case isOnline && live.Applied != nil:
			lag := r.latest - *live.Applied
			line += fmt.Sprintf("connected, applied uid %d, %d behind", *live.Applied, max(lag, 0))
			if lag > 0 && live.AppliedAt > 0 && r.now.Sub(time.UnixMilli(live.AppliedAt)) > AppliedStuckAfter {
				stuck = append(stuck, fmt.Sprintf("%q has applied nothing since %s and is %d behind", d.Name,
					stampOf(live.AppliedAt), lag))
			}
		case isOnline:
			line += "connected, nothing applied confirmed yet"
			if live.ConnectedAt > 0 && r.now.Sub(time.UnixMilli(live.ConnectedAt)) > AppliedStuckAfter && r.latest > 0 {
				stuck = append(stuck, fmt.Sprintf("%q connected at %s and has confirmed applying nothing", d.Name,
					stampOf(live.ConnectedAt)))
			}
		case d.LastSeen == 0:
			line += "has never connected"
		default:
			line += "last seen " + stampOf(d.LastSeen)
			if r.now.Sub(time.UnixMilli(d.LastSeen)) > DeviceQuietAfter {
				quiet = append(quiet, fmt.Sprintf("%q last seen %s", d.Name, stampOf(d.LastSeen)))
			}
		}
		detail = append(detail, line)
	}
	summary := fmt.Sprintf("%d devices, %d connected now", len(ds), len(online))
	if r.status == nil {
		summary = fmt.Sprintf("%d devices; with no server running, delivery is not known", len(ds))
	}
	switch {
	case len(stuck) > 0:
		r.bad(Warn, CheckDevices, summary+"; a device has stopped advancing: "+strings.Join(stuck, "; "),
			"Open the device: its panel (or `trew status`) says what it is stuck on, often a note it cannot write or a "+
				"refused path. Nothing is lost on the server; the device catches up once unstuck.", detail...)
	case len(quiet) > 0:
		r.bad(Warn, CheckDevices, summary+"; quiet for over a month: "+strings.Join(quiet, "; "),
			"If a device is lost or retired, `trewd revoke DEVICE_ID`. If it is only unused, it will catch up when it "+
				"next connects.", detail...)
	default:
		r.ok(CheckDevices, summary, detail...)
	}
}

/* ---------------------------------------------------------------- *
 * What the running server counted
 * ---------------------------------------------------------------- */

func (r *run) commits() {
	m := r.rep.Metrics
	if m == nil {
		r.note(CheckCommits, "no server is running, so there are no commit counts to read")
		return
	}
	switch {
	case m.ConsecutiveCommitFailures >= CommitFailuresFail:
		r.bad(Fail, CheckCommits, fmt.Sprintf("the last %d commits failed, the last at %s: the store is not taking notes",
			m.ConsecutiveCommitFailures, stampOf(m.LastCommitFailureAt)),
			"Devices keep what they could not send and retry, so nothing is lost yet. Read the server's log for the error "+
				"(\"commit failed\"), check free space and that the volume is writable, and restart the server.")
	case m.CommitFailures > 0:
		r.bad(Warn, CheckCommits, fmt.Sprintf("%d of %d commits failed since the server started, the last at %s",
			m.CommitFailures, m.Commits+m.CommitFailures, stampOf(m.LastCommitFailureAt)),
			"Read the server's log around that time (\"commit failed\"). The devices retried; if the failures stopped, "+
				"the cause did too.")
	default:
		r.ok(CheckCommits, fmt.Sprintf("%d commits, none failed; lock waited on at most %.0f ms, held at most %.0f ms; "+
			"%d stale refusals, %d refused credentials, %d told to slow down, %d slow peers dropped",
			m.Commits, m.LockWait.MaxMs, m.CommitHold.MaxMs, m.StaleRefusals, m.AuthFailures, m.RateLimited, m.EvictedPeers))
	}
}

/* ---------------------------------------------------------------- *
 * The records: backup, rehearsal
 * ---------------------------------------------------------------- */

func (r *run) backup() {
	var rec BackupRecord
	found, err := ReadRecord(r.opt.DataDir, BackupRecordFile, &rec)
	switch {
	case err != nil:
		r.bad(Warn, CheckBackup, err.Error(), "Take a backup: `trewd backup` writes the record again.")
		return
	case !found:
		r.bad(Warn, CheckBackup, "no backup of this data directory is recorded",
			"Take one: `trewd backup -to FILE -recipients-file KEY.pub`, encrypted to a key `trewd backup-key` "+
				"makes. docs/operations.md, \"Backups\", has the key and the nightly schedule.")
		return
	case !rec.OK:
		good := "no backup has succeeded"
		if rec.LastOK > 0 {
			good = "the last good one finished " + stampOf(rec.LastOK)
		}
		r.bad(Fail, CheckBackup, fmt.Sprintf("the last backup, to %s at %s, failed: %s; %s", rec.To, stampOf(rec.At), rec.Error, good),
			"Run the backup by hand and read its error. The previous snapshot at the destination is untouched by a "+
				"failed one.")
		return
	}
	age := r.now.Sub(time.UnixMilli(rec.At))
	summary := fmt.Sprintf("the last backup, to %s, finished %s (%s ago) holding up to uid %d, %d references verified",
		rec.To, stampOf(rec.At), age.Round(time.Minute), rec.LatestUID, rec.Verified)
	if age > BackupMaxAge {
		r.bad(Warn, CheckBackup, summary+": older than two days",
			"Check the scheduled backup is still running (systemctl list-timers, or the cron log), and take one now.")
		return
	}
	r.ok(CheckBackup, summary)
}

func (r *run) rehearsal() {
	var rec RehearsalRecord
	found, err := ReadRecord(r.opt.DataDir, RehearsalRecordFile, &rec)
	switch {
	case err != nil:
		r.bad(Warn, CheckRehearsal, err.Error(), "Rehearse a restore: `trewd rehearse -backup DIR` writes the record again.")
		return
	case !found:
		r.bad(Warn, CheckRehearsal, "no restore of a backup of this data directory has been rehearsed",
			"Rehearse one: `trewd rehearse -data "+r.opt.DataDir+" -backup DIR`, and the steps in docs/operations.md, "+
				"\"Rehearse a restore\". A recovery path tested only in docs is a rumour (rule 11).")
		return
	case !rec.OK:
		r.bad(Fail, CheckRehearsal, fmt.Sprintf("the last rehearsal, of %s at %s, failed: %s", rec.Backup, stampOf(rec.At), rec.Error),
			"The backup it rehearsed may not restore. Take a fresh backup and rehearse that; keep the old one until a "+
				"rehearsal passes.")
		return
	}
	age := r.now.Sub(time.UnixMilli(rec.At))
	summary := fmt.Sprintf("the last rehearsal, of %s, passed %s: %d versions and %d files served back in %s",
		rec.Backup, stampOf(rec.At), rec.Versions, rec.Files, time.Duration(rec.TookMs)*time.Millisecond)
	if age > RehearsalMaxAge {
		r.bad(Warn, CheckRehearsal, summary+": more than a quarter ago",
			"Rehearse again: the schema, the backup format and this machine have all had time to change.")
		return
	}
	r.ok(CheckRehearsal, summary)
}

/* ---------------------------------------------------------------- *
 * The origin devices reach
 * ---------------------------------------------------------------- */

func (r *run) origin(ctx context.Context) {
	targets := []string{}
	if r.opt.URL != "" {
		targets = append(targets, r.opt.URL)
	} else if r.status != nil {
		targets = append(targets, r.status.URLs...)
	}
	if len(targets) == 0 {
		r.note(CheckOrigin, "no address to check: pass -url wss://your-host:port, the one devices use")
		return
	}
	var failed, reached []string
	for _, t := range targets {
		if why := r.probe(ctx, t); why != "" {
			failed = append(failed, fmt.Sprintf("%s: %s", t, why))
		} else {
			reached = append(reached, t)
		}
	}
	switch {
	case len(failed) > 0 && len(reached) == 0:
		r.bad(Fail, CheckOrigin, "devices cannot reach the server: "+strings.Join(failed, "; "),
			"Check the tunnel in front of the server (tailscale serve status, or Caddy's log), that the server is "+
				"running, and that the address in the invites is the one the tunnel serves.")
	case len(failed) > 0:
		r.bad(Warn, CheckOrigin, fmt.Sprintf("%s answers; %s does not", strings.Join(reached, ", "), strings.Join(failed, "; ")),
			"A device paired from an invite naming the address that fails cannot connect. Mint invites with -url "+
				"naming the one that answers.")
	default:
		r.ok(CheckOrigin, strings.Join(reached, ", ")+" answers /health with ok")
	}
}

// probe asks one address's /health, and says why it failed or "".
func (r *run) probe(ctx context.Context, addr string) string {
	u, err := url.Parse(addr)
	if err != nil || u.Host == "" {
		return "not an address"
	}
	switch u.Scheme {
	case "ws":
		u.Scheme = "http"
	case "wss":
		u.Scheme = "https"
	case "http", "https":
	default:
		return "not a ws:// or wss:// address"
	}
	u.Path, u.RawQuery = "/health", ""
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return err.Error()
	}
	res, err := r.opt.HTTP.Do(req)
	if err != nil {
		return "no answer: " + err.Error()
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 256))
	if res.StatusCode != http.StatusOK {
		return fmt.Sprintf("answered %s %s", res.Status, strings.TrimSpace(string(body)))
	}
	return ""
}

// human is a byte count as a person reads it.
func human(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	v := float64(n)
	for _, u := range []string{"KiB", "MiB", "GiB", "TiB"} {
		v /= unit
		if v < unit {
			return fmt.Sprintf("%.1f %s", v, u)
		}
	}
	return fmt.Sprintf("%.1f PiB", v)
}
