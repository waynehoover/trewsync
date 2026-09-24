// Command trewd is the whole server: one static binary, one vault.
//
// TLS is terminated in front of this by `tailscale serve` or a tunnel, so no key
// material lives here and there is no certificate to configure.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"
	"syscall"
	"time"

	"github.com/waynehoover/trew/internal/chunks"
	"github.com/waynehoover/trew/internal/control"
	"github.com/waynehoover/trew/internal/dirlock"
	"github.com/waynehoover/trew/internal/server"
	"github.com/waynehoover/trew/internal/store"
	"github.com/waynehoover/trew/internal/wire"
)

// version is stamped at build time with -X main.version=...
//
// A deployed server that cannot say what it is running is one you reason about
// from memory. It is printed at startup and by `trewd version`, so the answer
// is in the journal of every machine this is on.
var version = "dev"

// resolveVersion picks what to print, preferring the stamped value.
//
// `go install github.com/.../cmd/trewd@v0.1.3` reaches no ldflags, so a
// binary installed that way called itself "dev" and could not say what it was:
// exactly the thing the stamp exists to prevent. Go records the module version
// in the build info instead, which is the same number under a different name.
//
// "(devel)" is what that field says for a build from a working tree, which is
// no more informative than "dev" and is left alone.
func resolveVersion(stamped, fromModule string) string {
	if stamped != "dev" {
		return stamped
	}
	if fromModule == "" || fromModule == "(devel)" {
		return stamped
	}
	// Printed without the v, so `trewd version` reads the same however it was
	// installed. The v belongs to the tag, because Go requires it there.
	return strings.TrimPrefix(fromModule, "v")
}

// moduleVersion is the version Go recorded, or "" when there is none.
func moduleVersion() string {
	bi, ok := debug.ReadBuildInfo()
	if !ok {
		return ""
	}
	return bi.Main.Version
}

func main() {
	if err := run(context.Background(), os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "trewd:", err)
		os.Exit(1)
	}
}

// run is main with somewhere to write to, so that what these commands report
// can be read by a test rather than only by a person.
//
// What they report is not decoration. Rule 5 is that an operation which makes a
// list smaller prints its arithmetic, and backup and purge both do; an
// untestable print is an untestable promise.
func run(ctx context.Context, args []string, out io.Writer) error {
	// Subcommands come before flag parsing so `trewd verify -deep` reads the
	// way it looks.
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		cmd, rest := args[0], args[1:]
		switch cmd {
		case "verify":
			return cmdVerify(rest, out)
		case "purge":
			return cmdPurge(rest, out)
		case "serve":
			return cmdServe(ctx, rest, out)
		case "backup":
			return cmdBackup(rest, out)
		case "service":
			return cmdService(rest, out)
		case "health":
			return cmdHealth(rest, out)
		case "update":
			return cmdUpdate(rest, out)
		case "stats":
			return cmdStats(rest, out)
		case "invite":
			return cmdInvite(rest, out)
		case "devices":
			return cmdDevices(rest, out)
		case "revoke":
			return cmdRevoke(rest, out)
		case "uninvite":
			return cmdUninvite(rest, out)
		case "mcp-token":
			return cmdMCPToken(rest, out)
		case "audit":
			return cmdAudit(rest, out)
		case "undo":
			return cmdUndo(rest, out)
		case "cat":
			return cmdCat(rest, out)
		case "export":
			return cmdExport(rest, out)
		case "version":
			fmt.Fprintf(out, "trewd %s %s/%s %s\n", resolveVersion(version, moduleVersion()), runtime.GOOS, runtime.GOARCH, runtime.Version())
			return nil
		default:
			return fmt.Errorf("unknown command %q (try serve, invite, devices, revoke, uninvite, mcp-token, audit, "+
				"undo, cat, export, backup, verify, purge, stats, service, health, update, version)", cmd)
		}
	}
	return cmdServe(ctx, args, out)
}

// dataFlags are shared by every subcommand, because every one of them opens the
// same store and opening a second copy of it is how two processes disagree
// about what is stored.
func dataFlags(fs *flag.FlagSet) *string {
	return fs.String("data", defaultDataDir(), "directory holding the database and the chunk bodies")
}

func defaultDataDir() string {
	if d := os.Getenv("TREW_DATA"); d != "" {
		return d
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "trew-data"
	}
	return filepath.Join(home, ".trew")
}

func openStore(dataDir string) (*store.Store, error) {
	// One definition of what a data directory looks like, shared with the
	// backup, so a backup cannot write a layout the server does not read.
	dbPath, chunkDir := store.DataDir(dataDir)
	return store.Open(dbPath, chunkDir)
}

// openExisting is openStore for the commands that must not create one.
//
// Only `serve` has any business making a data directory: on first run there is
// nothing there yet and that is the normal case. For the other three it means
// somebody mistyped `-data`, and creating an empty one turns a typo into a
// successful backup of nothing, a clean verify of nothing, and a purge that
// reports it removed nothing. The backup is the dangerous one: a person who
// rotates on the strength of a success message has now thrown away the copy
// that had their notes in it.
func openExisting(dataDir, verb string) (*store.Store, error) {
	if err := requireDataDir(dataDir, verb); err != nil {
		return nil, err
	}
	return openStore(dataDir)
}

// openForInspection is openExisting for the commands that only ask questions
// (I15).
//
// `verify` and `stats` read and report, and used the same opening path as
// `serve`: it migrates, and it writes the schema. So inspecting a store written
// by an older build changed it, which is a diagnostic modifying the thing it
// was asked to look at, and the person running it had no way to know.
//
// Not every read-only-sounding command belongs here. `backup` reads the source
// and issues `VACUUM INTO`, which is a statement SQLite refuses on a read-only
// connection however harmless its effect on the source; `purge` writes by
// definition. Both keep the writable path, and this comment is why.
func openForInspection(dataDir, verb string) (*store.Store, error) {
	if err := requireDataDir(dataDir, verb); err != nil {
		return nil, err
	}
	dbPath, chunkDir := store.DataDir(dataDir)
	return store.OpenForInspection(dbPath, chunkDir)
}

// requireDataDir refuses a path that is not already a data directory.
//
// Called before the lock rather than after, because taking a lock creates the
// directory to put the lock file in. Checked afterwards, a mistyped -data was
// still refused and still left an empty directory with a lock file in it,
// which is litter in whatever place the typo pointed at.
//
// The store's identity is checked here too, for the same reason (PLAN.md
// section 2.8): a directory holding another product's database, a Basalt one
// renamed for instance, is refused before its lock files are touched, and the
// directory is left exactly as it was.
func requireDataDir(dataDir, verb string) error {
	dbPath, _ := store.DataDir(dataDir)
	if _, err := os.Stat(dbPath); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf(
				"there is no trewd data directory at %s, so there is nothing to %s.\n"+
					"Check the -data path. Only `trewd serve` creates one.", dataDir, verb)
		}
		return err
	}
	return store.CheckDataDir(dataDir)
}

// locked turns a lock refusal into something a person can act on.
//
// A shared holder records nothing in its own lock file, so a refusal on the data
// lock has nothing to name. The server lock next to it does have a name, and
// that is nearly always the answer, so it is read for the message.
func locked(err error, dataDir, action, hint string) error {
	if !errors.Is(err, dirlock.ErrHeld) {
		return err
	}
	// Only look elsewhere when the refusal itself has no name, which means the
	// lock was held shared. Appending one regardless would print it twice.
	who := ""
	var held *dirlock.HeldError
	if errors.As(err, &held) && held.Holder == "" {
		if holder := dirlock.Holder(dataDir, dirlock.Server); holder != "" {
			who = fmt.Sprintf(" (%s)", holder)
		}
	}
	return fmt.Errorf("%s cannot run: %w%s\n%s", action, err, who, hint)
}

const stopFirst = "Stop the running trewd process and try again."

// requireVault refuses a vault name the store does not hold, before any
// destructive command mutates on the strength of it (S13).
//
// It lists the names that are there, because the reason someone reaches this is
// a typo and the useful next thing is the spelling they meant. An empty store
// says so plainly rather than offering an empty list.
func requireVault(st *store.Store, vault string) error {
	vaults, err := st.Vaults()
	if err != nil {
		return err
	}
	for _, v := range vaults {
		if v == vault {
			return nil
		}
	}
	if len(vaults) == 0 {
		return fmt.Errorf("there is no vault %q here, and in fact no vaults at all", vault)
	}
	return fmt.Errorf("there is no vault %q here; this server holds: %s",
		vault, strings.Join(vaults, ", "))
}

/* ---------------------------------------------------------------- *
 * serve
 * ---------------------------------------------------------------- */

var afterListening func(addr string)

// cmdServe blocks until the context is cancelled or a signal arrives.
//
// The context is how a test stops it. Before it existed, serving could only be
// ended by signalling the process, which in a test means signalling the test
// runner, so nothing here could be exercised at all.
// afterListening is called with the bound address once the port is open and
// Serve is running, and before the startup summary walks the store.
//
// A seam for one test, and it is here rather than in the test because the thing
// under test is an ordering inside this function: that the socket answers while
// the summary is still to come. Nil everywhere but that test.
func cmdServe(ctx context.Context, args []string, out io.Writer) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	dataDir := dataFlags(fs)
	addr := fs.String("addr", ":3003", "listen address")
	var allowOrigin stringList
	fs.Var(&allowOrigin, "allow-origin",
		"additional browser origin allowed to connect, repeatable (see the log line a refused client produces)")
	vault := fs.String("vault", defaultVault, "the one vault this server serves")
	maxFile := fs.Int64("max-file", store.DefaultPerFileMax,
		"largest file to accept, in bytes, up to 256 MiB; the cost is the plugin's memory, about 210 MB plus 2.7 MB per MiB of file")
	maxBatch := fs.Int64("max-batch-bytes", wire.MaxBatchBytes,
		"most bytes one putmany may carry, frame and summed budget, in bytes; can be lowered, not raised")
	maxFetch := fs.Int64("max-fetch-bytes", wire.MaxFetchBytes,
		"most body bytes one fetch may ask for, in bytes, up to the 256 MiB file ceiling")
	local := fs.Bool("localhost", false,
		"bind to 127.0.0.1 and put a ws:// address in invites, for trying this out on one machine")
	publicURL := fs.String("url", "",
		"the address devices reach this server at, ws:// or wss://, which invites carry (default: this machine's addresses)")
	inviteOut := fs.String("invite-out", "",
		"where to write the first device's invite when the vault has none (default: first-invite in the data directory)")
	serveMCP := fs.Bool("mcp", false,
		"also serve the MCP endpoint at /mcp, for agents holding a token from `trewd mcp-token`")
	verbose := fs.Bool("v", false, "verbose logging")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *local {
		// Both halves of what a local trial needs. Binding to loopback is the
		// obvious half; the other is that an invite's address is otherwise
		// wss://, which is right for the tunnel this is normally reached
		// through and wrong for a server with no TLS in front of it. Writing
		// the invite a device can actually use is the point of the flag.
		_, port, err := net.SplitHostPort(*addr)
		if err != nil {
			return fmt.Errorf("-addr %q is not host:port: %w", *addr, err)
		}
		*addr = net.JoinHostPort("127.0.0.1", port)
	}

	level := slog.LevelInfo
	if *verbose {
		level = slog.LevelDebug
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))

	// What this directory is, before anything is written to it (PLAN.md
	// section 2.8). Before the locks, because taking a lock writes a lock file
	// and a Basalt directory has lock files of the same names: a refusal after
	// them would already have changed the directory it refuses. The store
	// checks again when it opens, under the locks.
	if err := store.CheckDataDir(*dataDir); err != nil {
		return err
	}

	// One server per data directory. Two would each have their own fan-out and
	// their own commit ordering, so neither would see the other's live changes
	// and a client could be handed uids out of order.
	serverLock, err := dirlock.Exclusive(*dataDir, dirlock.Server, "serve")
	if err != nil {
		return locked(err, *dataDir, "serve",
			"A server is already running on this data directory. Two would each keep their own\n"+
				"list of connected devices, so neither would relay the other's changes.")
	}
	defer serverLock.Release()

	// Shared, so a backup or a verify can run without stopping the server.
	// Purge needs this exclusively, which is what keeps it from sweeping chunk
	// bodies out from under a commit in this process.
	dataLock, err := dirlock.Shared(*dataDir, dirlock.Data)
	if err != nil {
		return locked(err, *dataDir, "serve", stopFirst)
	}
	defer dataLock.Release()

	st, err := openStore(*dataDir)
	if err != nil {
		return err
	}
	defer st.Close()

	// The live set the collision rule reads is derived from the entries, and
	// is rebuilt here if it has drifted from them, which is the remedy for a
	// `livekeys` fault in verify. Said in the log, because drift is a bug
	// somewhere and somebody should hear about it.
	repaired, err := st.RepairLive()
	if err != nil {
		return err
	}
	for vault, why := range repaired {
		log.Warn("rebuilt the live set from the entries", "vault", vault, "why", why)
	}

	// An -url that no invite could carry is refused now, before the port
	// opens, rather than when the first invite is written.
	if *publicURL != "" {
		if err := checkInviteURL(*publicURL); err != nil {
			return fmt.Errorf("-url %q: %w", *publicURL, err)
		}
	}
	firstInvitePath := *inviteOut
	if firstInvitePath == "" {
		firstInvitePath = filepath.Join(*dataDir, firstInviteFile)
	}

	// The served vault exists from the first start, so the first device's
	// invite has a vault to be an invite to.
	if err := st.EnsureVault(*vault, time.Now().UnixMilli()); err != nil {
		return err
	}

	// Exactly one vault is served, on every hello route (F19). A typo in the
	// vault name then fails authentication instead of quietly creating a
	// second, empty vault that reports itself as fully synced.
	srv := server.New(st, log)
	srv.Serves(*vault)
	srv.SetVersion(resolveVersion(version, moduleVersion()))
	srv.SetPerFileMax(*maxFile)
	if srv.PerFileMax() != *maxFile {
		log.Warn("the file limit was clamped to what the store can hold",
			"asked", *maxFile, "using", srv.PerFileMax())
	}
	// The two caps get the same treatment: advertised is enforced, and a value
	// outside what the read limit or the store can carry is clamped and said.
	srv.SetMaxBatchBytes(*maxBatch)
	if srv.MaxBatchBytes() != *maxBatch {
		log.Warn("the batch cap was clamped to between one chunk and half the read limit",
			"asked", *maxBatch, "using", srv.MaxBatchBytes())
	}
	srv.SetMaxFetchBytes(*maxFetch)
	if srv.MaxFetchBytes() != *maxFetch {
		log.Warn("the fetch cap was clamped to between one chunk and the file ceiling",
			"asked", *maxFetch, "using", srv.MaxFetchBytes())
	}
	// The ceiling that will be advertised, checked against what the served
	// vault already holds, before the port opens.
	if err := refuseCeilingBelowContent(st, *vault, srv.PerFileMax()); err != nil {
		return err
	}

	// Built in internal/server so that it can be tested. What is in there
	// and not here is the list of browser origins allowed to connect, which
	// nothing caught until the plugin was loaded into a real vault.
	handler := server.HTTPHandler(srv, log, allowOrigin...)
	var agents *mcpEndpoint
	if *serveMCP {
		// The index and the endpoint stop after the listener and before the
		// store, by the order of the defers: the endpoint writes the use
		// counts it holds, and the index finishes the batch it is in.
		agents = startMCP(*dataDir, srv, *vault, allowOrigin, log)
		defer agents.close()
		handler = withMCP(handler, agents)
		logMCP(log, st, *vault, *addr)
	}
	hs := &http.Server{
		Addr:              *addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		// No WriteTimeout: these are long-lived websockets. An MCP request
		// bounds its own body and its tool's work.
	}

	ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Bound here rather than inside ListenAndServe, so that the port is open
	// before the summary below walks the chunk tree (I10).
	//
	// The walk is measured at 56 ms over ten thousand bodies, which is nothing,
	// and it is proportional to how many bodies a vault holds. A vault with a
	// few hundred thousand of them, which is a few years of attachments, spends
	// seconds in it. Every one of those seconds used to be before the socket
	// existed, so a device that reconnected during a restart got "connection
	// refused" and reported the server as down, and the log said "starting" and
	// then nothing. Binding first means the kernel queues those connections
	// instead of refusing them, and they are answered as soon as Serve picks
	// them up, which is immediately.
	ln, err := net.Listen("tcp", hs.Addr)
	if err != nil {
		return fmt.Errorf("listening on %s: %w", hs.Addr, err)
	}

	// After the bind, because it says "listening on" and may mint an invite.
	//
	// It used to come earlier. Under systemd both streams land in one
	// journal, so the line an operator greps said the server was up, with a
	// setup string to paste, for a server that then exited 1 with "address
	// already in use", and Basalt had by then written a fresh credential for a
	// server that never started. Rule 4: report the outcome, not the intent.
	// The same argument as the bind-before-the-walk above.
	urls, err := inviteURLs(*publicURL, boundAddr(*addr, ln.Addr()), *local)
	if err != nil {
		ln.Close()
		return err
	}
	first, err := mintFirstInvite(st, *vault, urls, firstInvitePath, time.Now())
	if err != nil {
		ln.Close()
		return err
	}
	// The operator's socket, before "listening on" is printed, so `trewd
	// invite` and the rest work from the moment anybody is told the server is
	// up. Closed before the store is, by the order of the defers.
	op := &operator{srv: srv, vault: *vault, urls: urls}
	if agents != nil {
		op.mcp = agents.handler
	}
	ctl, err := control.Listen(*dataDir, op, log)
	if err != nil {
		ln.Close()
		return err
	}
	defer ctl.Close()
	// The path and the expiry, never the string: a container log is not a
	// private place, and the string adds a device to the vault.
	switch {
	case first.Written:
		log.Info("wrote an invite for the first device", "path", first.Path,
			"expiresAt", first.ExpiresAt.UTC().Format(time.RFC3339))
	case first.NoAddress:
		log.Warn("no device is paired and no address is known to put in an invite",
			"hint", "start with -url wss://your-host:port")
	}
	printPairing(out, *addr, *vault, first)

	errc := make(chan error, 1)
	go func() {
		err := hs.Serve(ln)
		if errors.Is(err, http.ErrServerClosed) {
			err = nil
		}
		errc <- err
	}()

	// After the port is open, and after Serve is running. An operator greps for
	// this line after a restart; nothing waits on it, so nothing should wait
	// behind it.
	if afterListening != nil {
		afterListening(ln.Addr().String())
	}
	if err := logStartup(log, st, *vault, srv.Version()); err != nil {
		log.Warn("could not summarise the store at startup", "err", err)
	}

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
		log.Info("shutting down")
		// Two steps, because http.Server.Shutdown only does the first. It
		// closes the listener and waits for ordinary requests, but a hijacked
		// WebSocket is not its connection any more, so it returned while every
		// session was still open and the store was then closed under them
		// (S16). srv.Shutdown owns the sessions: it stops admitting, closes
		// idle peers with a reason, lets a request already in flight finish so
		// a put that stored its bodies gets its commit and its ack, and kills
		// whatever is still running at the deadline. A put cut off there has
		// not been acked, so the client retries; nothing is lost either way.
		// The store is closed by the defer above, after this returns.
		listenerErr, sessionsErr := gracefulStop(hs.Shutdown, srv.Shutdown, shutdownTimeout)
		if listenerErr != nil {
			log.Warn("closing the listener", "err", listenerErr)
		}
		if sessionsErr != nil {
			// Loud, not fatal: the clients that were cut off retry, and a
			// non-zero exit here would only make systemd mark a clean stop as
			// a failure.
			log.Warn("not every session finished before the deadline", "err", sessionsErr)
		}
		return nil
	}
}

// shutdownTimeout is how long each half of a stop may take: the listener and
// its ordinary requests, then the sessions. The systemd unit allows 30 s, so
// two of these fit inside it with room for the store to close.
const shutdownTimeout = 5 * time.Second

// refuseCeilingBelowContent refuses to serve a vault holding a live file
// larger than the ceiling this server is about to advertise.
//
// `ready` tells every device the largest file the server stores, and the client
// believes it: a version over that size is refused on download, recorded as a
// failure, and the sync moves on. So a vault that took a 100 MiB attachment
// under `-max-file 134217728` and was restarted without the flag served every
// device that already had the file and quietly starved every device paired
// after. The docs said so, under Reference, and documented is not fixed.
//
// Refuse, rather than warn in the startup line, on the first rule. A warning is
// read by whoever reads the journal, some time after a phone has reported the
// vault synced with an attachment missing and nothing else has said a word,
// which is the silent kind of failure this project is arranged against. A
// refusal is read by whoever typed the flag, at the moment they typed it, and
// costs nothing that can be lost: raising the flag again is always available
// and loses nothing, because the file is already here.
//
// Nobody need have typed a flag to arrive here, which is why the message says
// so. Upload a file above the ceiling, back up, delete it on a device so its
// newest version is a deletion and it stops counting, lower the flag, and the
// server starts. Restore that backup the documented way and the file is live
// again under a ceiling below it, with no flag changed and no way for a device
// to help: a device deletes by pushing an entry, and there is no server to push
// to. purge cannot help either, because it keeps MAX(uid) per path by
// construction. So the only remedy the message may offer as a standalone fix is
// the one that works from a stopped server, which is the flag; the order that
// brings the ceiling back down is spelled out rather than implied.
// TestTheRefusalOffersOnlyRemediesAStoppedServerHas.
//
// Only the newest version of each live path counts; see store.FilesOver for why
// history and deletions over the ceiling do not. Each is named by its path, its
// uid and its size. TestServeRefusesACeilingBelowAFileTheVaultHolds.
func refuseCeilingBelowContent(st *store.Store, vault string, ceiling int64) error {
	over, err := st.FilesOver(vault, ceiling)
	if err != nil {
		return fmt.Errorf("checking the file ceiling against vault %q: %w", vault, err)
	}
	if len(over) == 0 {
		return nil
	}
	const listed = 10
	var b strings.Builder
	noun, pronoun, isare, waswere := "files", "them", "are", "were"
	if len(over) == 1 {
		noun, pronoun, isare, waswere = "file", "it", "is", "was"
	}
	fmt.Fprintf(&b, "-max-file %d is below %d %s vault %q already holds:", ceiling, len(over), noun, vault)
	for i, f := range over {
		if i == listed {
			fmt.Fprintf(&b, "\n  and %d more", len(over)-listed)
			break
		}
		fmt.Fprintf(&b, "\n  %s (uid %d) is %d bytes", f.Path, f.UID, f.Size)
	}
	fmt.Fprintf(&b, "\nA device paired from now on could never download %s, and would report the vault synced without %s.\n"+
		"Start with -max-file %d or more and this server runs as it did. Nothing is lost by doing that: the %s\n"+
		"%s already here. `trewd service -max-file %d` writes the systemd unit with the flag in it, and under\n"+
		"Docker it goes in the command.\n"+
		"Deleting on a device is not a way out from here, because a device deletes by pushing an entry and there\n"+
		"is no server to push to. To bring the ceiling down: raise, start, delete or shrink %s on a device, wait\n"+
		"for that to reach this server, stop, lower.\n"+
		"This can happen with no flag changed, by restoring a backup taken before the %s %s deleted.",
		pronoun, pronoun, over[0].Size, noun, isare, over[0].Size, pronoun, noun, waswere)
	return errors.New(b.String())
}

// gracefulStop stops the listener and then the sessions, each with its own
// fresh deadline (S28).
//
// They used to share one context. A listener whose ordinary requests took the
// whole budget handed the sessions a context that had already expired, so
// every session was cut off at once, mid-request, with nothing acknowledged
// and nothing said, when each had been promised time to finish. Two deadlines
// cost a few seconds more at the worst and mean what the comment on
// Server.Shutdown says.
func gracefulStop(stopListener, stopSessions func(context.Context) error, timeout time.Duration) (listenerErr, sessionsErr error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	listenerErr = stopListener(ctx)
	cancel()
	ctx, cancel = context.WithTimeout(context.Background(), timeout)
	sessionsErr = stopSessions(ctx)
	cancel()
	return listenerErr, sessionsErr
}

// vaultSummary is what the startup line says about one vault: the latest uid,
// which is the cursor every device compares itself against, and how many
// devices are paired with it. Neither is a secret and both are the first thing
// to look at when a device says it is behind and nothing arrives (I11).
type vaultSummary struct {
	Name    string
	Latest  int64
	Devices int
}

func vaultSummaries(st *store.Store) ([]vaultSummary, error) {
	names, err := st.Vaults()
	if err != nil {
		return nil, err
	}
	out := make([]vaultSummary, 0, len(names))
	for _, name := range names {
		latest, err := st.LatestUID(name)
		if err != nil {
			return nil, err
		}
		devices, err := st.Devices(name)
		if err != nil {
			return nil, err
		}
		out = append(out, vaultSummary{Name: name, Latest: latest, Devices: len(devices)})
	}
	return out, nil
}

// logStartup writes the one line an operator greps for after a restart: the
// version, and for the served vault its latest uid and how many devices it has.
// A vault in the store that this server is not serving gets its own line, so
// a -vault typo is visible in the journal rather than only as refused hellos.
func logStartup(log *slog.Logger, st *store.Store, served, version string) error {
	vaults, err := vaultSummaries(st)
	if err != nil {
		return err
	}
	// What a purge would give back, on the one line an operator already reads.
	//
	// An unpurged server grows until `nospace` refuses uploads, and the answer
	// is the heaviest ceremony there is: stop, back up, purge, start. Nothing
	// said when it was worth doing, so it was learned from a refused upload on
	// somebody's phone. Now the restart says it, which is the moment an
	// operator is looking. Only the served vault: the figure needs a walk of
	// that vault's chunk tree, measured at 56 ms over ten thousand bodies
	// against 11,307 for the real-vault corpus in compared.md, and doing it
	// per vault would multiply that for vaults nobody is serving.
	//
	// A walk that stopped early prints no figure at all, only that it stopped
	// (rule 7), for the same reason the purge report does.
	reclaimable := "unknown"
	if rec, err := st.Reclaimable(served, chunks.DefaultGrace); err != nil {
		log.Warn("could not tell how much a purge would reclaim", "vault", served, "err", err)
	} else if !rec.Complete {
		reclaimable = "the chunk walk stopped early; run trewd verify"
	} else {
		reclaimable = humanBytes(rec.Bytes)
	}
	found := false
	for _, v := range vaults {
		if v.Name == served {
			found = true
			log.Info("starting", "version", version, "vault", v.Name, "latest", v.Latest,
				"devices", v.Devices, "reclaimable", reclaimable)
		}
	}
	if !found {
		log.Info("starting", "version", version, "vault", served, "latest", 0, "devices", 0,
			"reclaimable", reclaimable)
	}
	for _, v := range vaults {
		if v.Name != served {
			log.Warn("vault present but not served", "vault", v.Name, "latest", v.Latest, "devices", v.Devices,
				"hint", "start with -vault "+v.Name+" if this is the one your devices use")
		}
	}
	return nil
}

// pairingHosts turns a listen address into addresses a device could dial.
//
// A wildcard bind is the normal way to run this, because a phone cannot reach a
// server bound to loopback. But the bind address is not an address: pasting
// "0.0.0.0:3003" into a device asks it to connect to 0.0.0.0, which is nothing
// at all, and the failure looks like a server that is down. So the interfaces
// are named instead, and if none can be found the placeholder says plainly that
// a hostname is needed.
func pairingHosts(addr string) []string {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return []string{addr}
	}
	if host != "" && host != "0.0.0.0" && host != "::" {
		return []string{addr}
	}

	var out []string
	ifaces, err := net.InterfaceAddrs()
	if err == nil {
		for _, a := range ifaces {
			ipnet, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipnet.IP
			// Loopback is not reachable from another device, and a link-local
			// address is not reachable without its zone, which is not something
			// to paste into a phone.
			if ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.To4() == nil {
				continue
			}
			out = append(out, net.JoinHostPort(ip.String(), port))
		}
	}
	if len(out) == 0 {
		out = []string{placeholderHost + ":" + port}
	}
	return out
}

// defaultVault is the name every client assumes when a setup line, an invite or
// a pairing string does not carry one.
const defaultVault = "default"

/* ---------------------------------------------------------------- *
 * verify
 * ---------------------------------------------------------------- */

func cmdVerify(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("verify", flag.ContinueOnError)
	dataDir := dataFlags(fs)
	deep := fs.Bool("deep", false, "read every chunk and check it against its name")
	if err := fs.Parse(args); err != nil {
		return err
	}

	// Read-only, so shared: this runs happily against a live server.
	if err := requireDataDir(*dataDir, "verify"); err != nil {
		return err
	}

	lock, err := dirlock.Shared(*dataDir, dirlock.Data)
	if err != nil {
		return locked(err, *dataDir, "verify", stopFirst)
	}
	defer lock.Release()

	st, err := openForInspection(*dataDir, "verify")
	if err != nil {
		return err
	}
	defer st.Close()

	checked, err := st.Verify(*deep)
	if err != nil {
		return err
	}
	// Every number, always. Zero faults out of zero checks is not a healthy
	// vault, and reporting only the faults makes those two look identical. The
	// registry rows appear only under -deep, because that is the only pass
	// that opens them and a "0 registry rows" on a shallow one would read as a
	// registry that was looked at and found empty (rule 7).
	// The agents' operations are decoded on both passes, so they are counted
	// on both.
	if *deep {
		fmt.Fprintf(out, "checked %d entries and %d chunk references and %d registry rows and %d agent operations, %d faults\n",
			checked.Entries, checked.Chunks, checked.Rows, checked.Operations, len(checked.Faults))
	} else {
		fmt.Fprintf(out, "checked %d entries and %d chunk references and %d agent operations, %d faults\n",
			checked.Entries, checked.Chunks, checked.Operations, len(checked.Faults))
	}
	for _, f := range checked.Faults {
		fmt.Fprintln(out, " ", f)
	}
	if len(checked.Faults) > 0 {
		return fmt.Errorf("%d entries and registry rows cannot be served", len(checked.Faults))
	}
	// Nothing checked is not a clean bill of health, and the exit code has to
	// say so because that is what reads it.
	//
	// The line above already distinguished the two and the status did not, so
	// `trewd verify -deep -data DIR && rm -rf OLD` -- which is the retention
	// step docs/server.md documents, and the natural way to write it -- passed
	// over an empty store: a restore that copied the database before it was
	// populated, a `VACUUM INTO` that produced a fresh file, a typo that
	// `serve` created a store at. Rule 3 wants a *verified* copy before the
	// last one goes, and this is the verification.
	if checked.Entries == 0 {
		return fmt.Errorf(
			"%s holds no entries at all, so this verified nothing. That is a fault in "+
				"anything that has ever been synced: check the path, and do not treat this "+
				"as a copy worth keeping", *dataDir)
	}
	return nil
}

/* ---------------------------------------------------------------- *
 * purge
 * ---------------------------------------------------------------- */

func cmdPurge(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("purge", flag.ContinueOnError)
	dataDir := dataFlags(fs)
	vault := fs.String("vault", defaultVault, "vault to purge")
	// Friction proportional to what is lost (I18). Purge is the one command
	// that destroys something no device holds, so it wants the vault's name
	// typed a second time, and proof of a backup newer than the newest entry,
	// or the words that say there is none.
	confirm := fs.String("confirm", "", "the vault's name again, exactly; purge refuses without it")
	backup := fs.String("backup", "", "a backup directory that must already hold everything this vault does")
	noBackupCheck := fs.Bool("no-backup-check", false, "purge without checking a backup; typed in full, because it is the whole safety net")
	// The grace window spares bodies uploaded so recently that the entry
	// referencing them may not have been committed yet. Purge holds the data
	// directory exclusively, so no server can be running while it works and
	// nothing can be in flight; the window is for the debris of a server killed
	// mid-push, whose bodies are indistinguishable from those of a push about
	// to complete.
	//
	// It is a flag because the default reclaims nothing at all on a server
	// stopped a moment ago, which is exactly when somebody purges to free
	// space. They would see everything spared and have no way to say otherwise.
	grace := fs.Duration("grace", chunks.DefaultGrace,
		"spare unreferenced bodies written within this long, in case a push was interrupted mid-upload")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *grace < 0 {
		return fmt.Errorf("-grace cannot be negative, and %s is", *grace)
	}
	if *confirm == "" {
		return fmt.Errorf("purge needs -confirm %s: the vault's name typed again, because this deletes history no device holds", *vault)
	}
	if *confirm != *vault {
		return fmt.Errorf("-confirm %q does not match -vault %q; nothing was purged", *confirm, *vault)
	}
	if *backup == "" && !*noBackupCheck {
		return errors.New("purge needs -backup DIR, a backup taken since the last change, or -no-backup-check typed in full; nothing was purged")
	}
	if *backup != "" && *noBackupCheck {
		return errors.New("-backup and -no-backup-check contradict each other; nothing was purged")
	}

	// Exclusive: purge is the only thing that deletes chunk bodies, and the
	// store's mutex only serialises that against commits in the *same* process.
	// Taking this exclusively is what stops it racing a running server.
	if err := requireDataDir(*dataDir, "purge"); err != nil {
		return err
	}

	lock, err := dirlock.Exclusive(*dataDir, dirlock.Data, "purge")
	if err != nil {
		return locked(err, *dataDir, "purge",
			"Purge deletes chunk bodies, so it needs the data directory to itself.\n"+stopFirst)
	}
	defer lock.Release()

	st, err := openExisting(*dataDir, "purge")
	if err != nil {
		return err
	}
	defer st.Close()

	// Confirm the vault exists before anything is deleted (S13). A typo used to
	// purge a vault that was not there, which deletes nothing and then verifies
	// the *other* vaults and reports success, so a mistyped destructive command
	// looked completed. The refusal lists what is actually there, because the
	// next thing anyone does is check which name they meant.
	if err := requireVault(st, *vault); err != nil {
		return err
	}

	// The backup has to cover everything this vault holds. It is compared by
	// the newest uid, which is what a device compares itself against too: a
	// backup at a lower uid is missing versions this purge is about to drop
	// for good. The check reads the backup's own database rather than its
	// timestamp, because a backup that ran and failed leaves the old file
	// with a new date.
	var covered int64
	if !*noBackupCheck {
		// The backup is held for the whole of the purge, not just the check
		// (R23).
		//
		// The lock used to be taken and released inside the helper, so it was
		// gone by the time the helper returned and the deletion had not
		// started. Everything the check established was true of a directory
		// nothing was protecting any more: another backup could replace it, or
		// a purge could run against it, in the gap. A verification that does
		// not outlive itself authorises nothing.
		var release func()
		if covered, release, err = backupCovers(*backup, *vault, *dataDir, st); err != nil {
			return err
		}
		defer release()
	}
	// The pause a test uses to prove the lock is still held here, between the
	// verification and the deletion it authorises.
	beforePurge()

	rep, err := st.Purge(*vault, *grace)
	// Print the versions before returning any error. They were deleted before
	// the sweep ran, in a transaction that either committed or rolled back
	// whole, so a sweep that fails still leaves work done and swallowing the
	// numbers would hide what went. Rule 8: trust the numbers. A failure inside
	// the transaction is the other case, and Purge zeroes the report there, so
	// what is printed is what committed rather than rows that were rolled back.
	fmt.Fprintf(out, "versions %d -> %d (removed %d)\n",
		rep.VersionsBefore, rep.VersionsAfter, rep.VersionsRemoved)
	// The history this purge kept because an agent displaced it, as its own
	// line: without it a purge that removed less than `stats` led somebody to
	// expect would not say why (rule 8, and PLAN.md section 4.5).
	if rep.VersionsPinned > 0 {
		fmt.Fprintf(out, "kept %d versions agents' edits displaced, which are pinned until their windows end\n",
			rep.VersionsPinned)
	}
	if rep.PinsExpired+rep.RepliesExpired+rep.KeysExpired > 0 {
		fmt.Fprintf(out, "let go of %d expired pins, %d recorded replies and %d idempotency keys; "+
			"`trewd audit` still lists their operations\n", rep.PinsExpired, rep.RepliesExpired, rep.KeysExpired)
	}

	// The chunk figures are a different kind of number and get a different
	// rule. The sweep is a walk, and a walk that stopped counted what it
	// reached rather than what the vault holds. One stray file in the first
	// shard used to print the whole report in full, "0 spared as too recent to
	// collect (0 B)" and all, with every collectible orphan in the tree
	// unexamined, and then advised re-running with -grace 0, which aborts at
	// the same file. Rule 7: a status describes the vault, not how far the
	// filter got. So an unfinished sweep prints no figures at all, only that it
	// stopped, and the error underneath says where.
	// TestPurgeDoesNotPrintAReportTheSweepDidNotFinish.
	if !rep.SweepComplete {
		fmt.Fprintln(out, "the chunk sweep stopped before it reached the end of the store, so there are no")
		fmt.Fprintln(out, "chunk figures here: what it had counted describes how far the walk got, not what")
		fmt.Fprintln(out, "this vault holds. The error below says where it stopped.")
		return err
	}
	fmt.Fprintf(out, "chunks %d live, %d deleted (%s reclaimed), %d spared as too recent to collect (%s)\n",
		rep.ChunksLive, rep.ChunksDeleted, humanBytes(rep.BytesDeleted), rep.ChunksSpared, humanBytes(rep.BytesSpared))
	if rep.ChunksSpared > 0 {
		// What the purge did not do, as its own lines with its own numbers.
		// The default window is right: it is what keeps a purge from starving
		// a push mid-upload. It is also why the whole ceremony, stop, back up,
		// purge, on a server stopped a moment ago reclaims nothing, because
		// every body it would take was written within the hour. That used to
		// be one figure in the middle of the line above, and an operator who
		// came for disk space got none back and no hint why. Rule 8: the
		// number that says what did not happen is a number too, so it gets the
		// bytes, and the line that carries it says how to get them.
		//
		// The advice is safe because of where purge runs: it holds the data
		// directory exclusively, so no server is up and nothing is in flight.
		// A body left by a push that was cut off has no entry and its device
		// was never acked, so it sends the body again. See chunks.DefaultGrace
		// for the livelock the window prevents on a *running* server, and
		// TestPurgeSaysWhatTheGraceWindowSparedAndHowToReclaimIt.
		lead := "spared"
		if rep.ChunksDeleted == 0 {
			lead = "reclaimed nothing: spared"
		}
		fmt.Fprintf(out, "%s %d bodies (%s) written within the last %s, in case a push was interrupted mid-upload.\n"+
			"Nothing is in flight on a stopped server, and purge only runs on one, so re-run with -grace 0 to reclaim them.\n",
			lead, rep.ChunksSpared, humanBytes(rep.BytesSpared), *grace)
	}
	// The two other kinds of file a sweep walks past, both with their bytes.
	// Both are space this purge did not reclaim, which is the figure somebody
	// purging for space came for, and a count with no bytes beside it does not
	// answer that (rule 8).
	if rep.ChunksQuarantined > 0 {
		// Naming the command, because for a long time this line asked for
		// something no device could do (I14). A device whose copy of the note
		// has not changed is right to consider it synced and has no reason to
		// send anything, so "waiting for a device to resend them" was a wait
		// with nothing at the end of it.
		fmt.Fprintf(out, "%d quarantined bodies (%s) left in place. Run `trew repair` on a device "+
			"that still has those notes; they are replaced when the real body arrives\n",
			rep.ChunksQuarantined, humanBytes(rep.BytesQuarantined))
	}
	if rep.ChunksTemp > 0 {
		// Nothing collects these, at any grace. They are the debris of a push
		// that was killed between uploading a body and renaming it into place,
		// and deleting them is not this command's job: a body under a temporary
		// name has no name to check it against, so removing one is deleting a
		// file on the strength of where it sits. Named, with its bytes, so it
		// is somebody's decision rather than a slow leak nothing mentions.
		fmt.Fprintf(out, "%d unfinished uploads (%s) left in place; no grace collects these, and they are\n"+
			"the debris of a push that was killed mid-upload. Nothing on a device is waiting for them.\n",
			rep.ChunksTemp, humanBytes(rep.BytesTemp))
	}
	if err != nil {
		return err
	}

	// Purging is the one operation that deletes data, so it verifies what it
	// left behind rather than reporting success on the strength of no error.
	checked, err := st.Verify(false)
	if err != nil {
		return err
	}
	if len(checked.Faults) > 0 {
		for _, f := range checked.Faults {
			fmt.Fprintln(out, " ", f)
		}
		return fmt.Errorf("purge left %d unserveable entries out of %d references",
			len(checked.Faults), checked.Chunks)
	}
	fmt.Fprintf(out, "verified %d chunk references, all present\n", checked.Chunks)
	// Purge is the one command that destroys something no device holds a copy
	// of: old versions, and the deletion records that make a deleted note
	// recoverable. The last line says so, and says where the only copy is, or
	// that nobody checked (I18).
	switch {
	case rep.VersionsRemoved > 0 && *noBackupCheck:
		fmt.Fprintf(out, "\n%d versions are gone for good. No backup was checked (-no-backup-check), "+
			"so only a backup taken before now has them.\n", rep.VersionsRemoved)
	case rep.VersionsRemoved > 0:
		fmt.Fprintf(out, "\n%d versions are gone for good. The backup at %s holds them, up to uid %d.\n",
			rep.VersionsRemoved, *backup, covered)
	case *noBackupCheck:
		fmt.Fprintln(out, "nothing was removed, and no backup was checked (-no-backup-check)")
	default:
		fmt.Fprintf(out, "nothing was removed; the backup at %s holds %q up to uid %d\n", *backup, *vault, covered)
	}
	return nil
}

var beforePurge = func() {}

// backupCovers checks the backup and hands back the exclusion it took.
//
// The release is the caller's to run, after the purge, which is the whole
// correction: a lock released when this returns protects the check and not the
// thing the check authorises.
// backupCovers checks that the backup at dir independently holds every version
// of the vault this purge could destroy, and returns the backup's latest uid.
//
// This authorises an irreversible deletion, so what it used to check was not
// enough by a wide margin: it compared two maximum uids. A store satisfies that
// by being the source itself, by being an unrelated vault of the same name that
// happens to have counted higher, or by holding every entry and none of the
// bodies. All three were reproduced, and the first one printed that the history
// it had just destroyed was safely held by the directory it destroyed it in.
//
// Four questions now, in the order that fails cheapest first:
//
//  1. Is it somewhere else? A directory that is, contains, or is contained by
//     the data directory is not a backup of it, aliases and symlinks included.
//  2. Is it this vault? Compared by walking entries rather than by name: names
//     are chosen by whoever ran the server, and uids restart with the store.
//  3. Does it hold every version this store holds? Every uid, identical in
//     every field the store keeps, which a coincidence does not reproduce.
//  4. Can it actually give them back? Every chunk of every entry with a body
//     has to be a file in the backup's own chunk tree. A database with no
//     bodies restores to a history of empty notes.
//
// It walks the whole history, which is O(versions) on a rare administrative
// command that is about to delete data for good. That is the right trade.
// beforePurge runs between a successful backup check and the deletion it
// authorises, and does nothing outside the test that proves the backup is
// still locked at that moment (R23).
func backupCovers(
	dir, vault, dataDir string,
	source *store.Store,
) (latest int64, release func(), err error) {
	if err := store.RefuseSamePlace(dir, dataDir); err != nil {
		return 0, nil, err
	}
	bkDB, bkChunks := store.DataDir(dir)
	if _, err := os.Stat(bkDB); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return 0, nil, fmt.Errorf("there is no backup at %s: no %s in it; nothing was purged",
				dir, filepath.Base(bkDB))
		}
		return 0, nil, err
	}
	// What the backup is, before its lock is taken, as every other command
	// asks of its data directory.
	if err := store.CheckDataDir(dir); err != nil {
		return 0, nil, fmt.Errorf("the backup at %s: %w; nothing was purged", dir, err)
	}
	sourceLatest, err := source.LatestUID(vault)
	if err != nil {
		return 0, nil, err
	}
	// Held for the whole of this check, and released by the caller's defer
	// chain only after the purge has run (R04). Without it the directory being
	// examined can be replaced by another backup between the verification and
	// the deletion, and everything below would be a true statement about a
	// directory that no longer exists.
	//
	// Shared, not exclusive: a second reader is harmless and `trewd backup`
	// takes the destination exclusively, so a backup writing into this
	// directory is refused while a purge is relying on it.
	bkLock, err := dirlock.Shared(dir, dirlock.Data)
	if err != nil {
		return 0, nil, fmt.Errorf(
			"the backup at %s is in use, so it cannot be relied on while it changes: %w", dir, err)
	}
	// Released by the caller, after the purge. Everything below is a statement
	// about this directory, and a statement whose subject can be replaced
	// before it is acted on is not one (R23).
	released := false
	done := func() {
		if released {
			return
		}
		released = true
		bkLock.Release()
	}
	// On every path out of here that is not success, because a check that
	// refused has authorised nothing and must not hold the directory.
	defer func() {
		if err != nil {
			done()
		}
	}()

	// Read-only (I15, R04). This inspects a backup and must not migrate it,
	// write its schema, or create anything: a diagnostic that modifies what it
	// was asked to look at is one nobody can trust about the day it matters.
	bk, err := store.OpenForInspection(bkDB, bkChunks)
	if err != nil {
		return 0, nil, fmt.Errorf("opening the backup at %s: %w", dir, err)
	}
	defer bk.Close()
	backupLatest, err := bk.LatestUID(vault)
	if err != nil {
		return 0, nil, fmt.Errorf("reading the backup at %s: %w", dir, err)
	}
	if backupLatest < sourceLatest {
		return 0, nil, fmt.Errorf(
			"the backup at %s holds %q up to uid %d and this store is at uid %d, so it is missing "+
				"versions this purge would drop for good; nothing was purged.\n"+
				"Take a fresh one first: trewd backup -to %s", dir, vault, backupLatest, sourceLatest, dir)
	}

	// Every version this store holds, present in the backup, identical, and
	// readable.
	//
	// Basalt once compared the MAC alone, on the reasoning that a client's
	// authenticator over an entry identifies its content. That was true of
	// what the *client* signed and said nothing about what the database stored
	// beside it: a row whose path, size or chunk list differed while carrying
	// the same MAC string passed such a check, and so did a chunk file of the
	// right name holding the wrong bytes (R04). Purge is the one command that
	// destroys something no device holds, so what it accepts as proof has to be
	// the thing it is proof of: every field, and every body read and hashed.
	seen := 0
	bodies := 0
	if err := source.EachEntry(vault, func(e store.Entry) error {
		held, ok, err := bk.EntryByUID(vault, e.UID)
		if err != nil {
			return fmt.Errorf("reading the backup at %s: %w", dir, err)
		}
		if !ok {
			return fmt.Errorf(
				"the backup at %s is missing version %d of %q, which this purge could drop for "+
					"good; nothing was purged.\nTake a fresh one first: trewd backup -to %s",
				dir, e.UID, vault, dir)
		}
		if why := sameVersion(e, held); why != "" {
			return fmt.Errorf(
				"the backup at %s holds a different version %d of %q than this store does (%s), so it "+
					"is a backup of some other vault that reused the name, or of this one before it "+
					"changed; nothing was purged", dir, e.UID, vault, why)
		}
		seen++
		if !e.HasBody() {
			return nil
		}
		for _, name := range e.Chunks {
			// Read and hashed, not stat'ed. A file of the right name holding
			// the wrong bytes is exactly what a backup on a failing disk looks
			// like, and it is indistinguishable from a good one until somebody
			// restores it. This is the moment to find out, because it is the
			// moment before the only other copy is deleted.
			//
			// It costs a full read of every body the vault currently
			// references, which is what `trewd backup -deep` costs and is
			// the same order as taking the backup was. Purge already means
			// stop, back up, purge, start.
			if err := bk.Chunks().Check(vault, name); err != nil {
				// Two different states, and they read differently to whoever
				// is holding the only other copy of this history (rule 2). A
				// body that is absent is a copy that did not finish, or a
				// retention policy that swept it; a body that is there and
				// hashes wrong is a disk going bad.
				missing := "the record of version %d of %q but not its contents (chunk %s is not " +
					"in its chunk tree), so restoring from it would give back an empty note"
				what := fmt.Sprintf(missing, e.UID, vault, name)
				if !errors.Is(err, chunks.ErrNotFound) {
					what = fmt.Sprintf(
						"version %d of %q and cannot serve it: chunk %s %v, so restoring from it "+
							"would give back a note with the wrong contents", e.UID, vault, name, err)
				}
				return fmt.Errorf(
					"the backup at %s has %s; nothing was purged.\nTake a fresh one first: "+
						"trewd backup -to %s", dir, what, dir)
			}
			bodies++
		}
		return nil
	}); err != nil {
		return 0, nil, err
	}
	if seen == 0 && sourceLatest > 0 {
		return 0, nil, fmt.Errorf(
			"the backup at %s holds no versions of %q at all; nothing was purged", dir, vault)
	}
	return backupLatest, done, nil
}

// sameVersion says why two records of one uid differ, or "" when they do not.
//
// Every field the store persists, because the question being answered is "can
// this backup give me back exactly what I am about to delete", and any field
// that differs is a field the restore would give back wrongly. Named
// explicitly rather than compared with reflect.DeepEqual so that a field added
// to Entry fails to compile here rather than silently dropping out of the one
// check that stands between a purge and somebody's history.
func sameVersion(want, got store.Entry) string {
	switch {
	case got.Path != want.Path:
		return "a different path"
	case got.Size != want.Size:
		return fmt.Sprintf("size %d rather than %d", got.Size, want.Size)
	case got.CTime != want.CTime || got.MTime != want.MTime:
		return "different timestamps"
	case got.Folder != want.Folder:
		return "one is a folder and the other is not"
	case got.Deleted != want.Deleted:
		return "one is a deletion and the other is not"
	case got.Device != want.Device:
		return "a different device wrote it"
	case got.Prev != want.Prev:
		return "a different previous path"
	case len(got.Chunks) != len(want.Chunks):
		return fmt.Sprintf("%d chunks rather than %d", len(got.Chunks), len(want.Chunks))
	}
	for i, name := range want.Chunks {
		if got.Chunks[i] != name {
			return fmt.Sprintf("chunk %d of %d is a different body", i+1, len(want.Chunks))
		}
	}
	return ""
}

/* ---------------------------------------------------------------- *
 * backup
 * ---------------------------------------------------------------- */

func cmdBackup(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("backup", flag.ContinueOnError)
	dataDir := dataFlags(fs)
	to := fs.String("to", "", "directory to back up into (required)")
	deep := fs.Bool("deep", false,
		"re-read every body already in the backup, to catch bit rot in an old one")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *to == "" {
		return errors.New("backup needs -to <directory>")
	}

	// Shared: a backup only reads, so it does not need the server stopped. It
	// does need purge held off, which the shared lock does.
	if err := requireDataDir(*dataDir, "back up"); err != nil {
		return err
	}

	lock, err := dirlock.Shared(*dataDir, dirlock.Data)
	if err != nil {
		return locked(err, *dataDir, "backup",
			"A purge is running, and it deletes the bodies a backup is trying to read.")
	}
	defer lock.Release()

	st, err := openExisting(*dataDir, "back up")
	if err != nil {
		return err
	}
	defer st.Close()

	// The destination is locked too (F06).
	//
	// Only the source was, so a backup would happily replace the database of a
	// directory another server was serving from, or of a vault that had
	// nothing to do with this one: it was reproduced by holding both of a
	// destination's locks and watching the backup overwrite it anyway. Two
	// backups into one directory could also remove each other's staging file.
	//
	// Exclusive on the data lock, which is what `serve` holds shared and
	// `purge` holds exclusive, so a served destination, a purging destination
	// and a second backup are each refused by the same primitive rather than
	// by three checks. Taken after `refuseOverlap` has had its say inside
	// `Backup`, so the source's own directory is refused as a destination with
	// the message that explains it, and taken on the resolved path so a
	// symlinked destination cannot be locked under one name and written under
	// another.
	destDir, err := store.ResolveForLock(*to)
	if err != nil {
		return err
	}
	if err := store.RefuseSamePlace(destDir, *dataDir); err != nil {
		return err
	}
	// A destination holding another product's database is refused before it
	// is locked or written: a snapshot published beside a Basalt database
	// would adopt its chunk tree, and a purge of the result would sweep every
	// body in it.
	if err := store.CheckBackupDestination(destDir); err != nil {
		return err
	}
	if err := os.MkdirAll(destDir, 0o700); err != nil {
		return err
	}
	destLock, err := dirlock.Exclusive(destDir, dirlock.Data, "backup")
	if err != nil {
		return locked(err, destDir, "backup",
			"Something is using that directory as a live store: a server serving from it, a "+
				"purge, or another backup. Backing up over it would replace its database.")
	}
	defer destLock.Release()

	rep, err := st.Backup(*to, *deep)
	if err != nil {
		// The numbers so far are still worth printing: they say how far it got.
		fmt.Fprintln(out, rep)
		return err
	}

	fmt.Fprintf(out, "backed up to %s\n", rep.Dir)
	fmt.Fprintf(out, "  %d vaults, %d chunk references, %d bodies copied (%s)\n",
		rep.Vaults, rep.Refs, rep.Copied, humanBytes(rep.Bytes))
	fmt.Fprintf(out, "  %d bodies at source, %d in the backup\n", rep.SourceBodies, rep.DestBodies)
	fmt.Fprintf(out, "  verified %d chunk references in the backup, all present\n", rep.Verified)
	// Faults the copy has because the store it came from has them. They do not
	// stop a backup, because no backup can mend them and refusing would leave
	// the last good copy unrefreshed for ever, but they are the operator's to
	// know about and they are in the *source*: this says so rather than
	// sending somebody to inspect the disk that is fine.
	if len(rep.Inherited) > 0 {
		fmt.Fprintf(out, "  %d fault(s) copied faithfully from %s, which is where they are:\n",
			len(rep.Inherited), *dataDir)
		for _, f := range rep.Inherited {
			fmt.Fprintln(out, "   ", f)
		}
	}
	// Either side can be the larger, and the difference means something
	// different each way, so it is subtracted in the direction that is
	// actually positive. Printing source minus destination unconditionally
	// went negative as soon as the backup held retained history, and a
	// negative count of bodies "not copied" reads as a fault in the one
	// command whose numbers are all anybody has to go on.
	switch {
	case rep.SourceBodies > rep.DestBodies:
		// Expected, and explained rather than left as a discrepancy: the backup
		// holds what committed entries reference, and the source may also hold
		// bodies from a push that never committed.
		fmt.Fprintf(out, "  (%d source bodies are referenced by no entry and were not copied)\n",
			rep.SourceBodies-rep.DestBodies)
	case rep.DestBodies > rep.SourceBodies:
		// The other direction, and it is the backup working: a purge dropped
		// old versions at the source, and their bodies stay here.
		fmt.Fprintf(out, "  (the backup holds %d bodies the source no longer has, which is history it kept)\n",
			rep.DestBodies-rep.SourceBodies)
	}
	if rep.Retained > 0 {
		// The backup holds history the newest snapshot no longer references,
		// because the source purged it. This is a backup doing its job, not a
		// discrepancy, so it is named rather than left to look like one.
		fmt.Fprintf(out, "  (%d bodies are retained history the source has since purged)\n",
			rep.Retained)
	}

	// Which devices may connect is in the database, so a restore needs no
	// re-pairing. Outstanding invites are not, and the count says so, because
	// this made a list smaller (rule 5).
	if rep.InvitesLeftOut > 0 {
		fmt.Fprintf(out, "  (%d outstanding invites were left out: a restore must not bring back an invite\n"+
			"  that has been used or cancelled since; make a new one after restoring)\n", rep.InvitesLeftOut)
	}
	// What agents did travels with the notes, and the pins with it, which is
	// what keeps a restored store's purge off the before-images (PLAN.md
	// section 4.5). Only when there is any, so a vault no agent has written
	// to reads as it did.
	if o := rep.Oplog; o.Operations > 0 {
		fmt.Fprintf(out, "  %d agent operations carried, with %d before-image pins and %d idempotency keys\n",
			o.Operations, o.Pins, o.Keys)
	}

	// What the backup covers, read back from the file just written rather than
	// from the report (rule 4), so what is printed is what a script will find.
	meta, err := store.ReadBackupMeta(*to)
	if err != nil {
		return fmt.Errorf("reading back %s: %w", store.BackupMetaFile, err)
	}
	for _, v := range meta.Vaults {
		fmt.Fprintf(out, "  %s: vault %q holds uids %d to %d (%d versions), purge generation %d\n",
			store.BackupMetaFile, v.Vault, v.OldestUID, v.LatestUID, v.Versions, v.Purges)
	}

	// The copy is the notes themselves, readable by anybody who can read the
	// directory. Saying so every time is the point: Basalt's backups were
	// ciphertext, and a person who learned to leave those anywhere has to hear
	// that these are not.
	fmt.Fprintln(out)
	fmt.Fprintln(out, "This backup holds every note in the clear, as the server does. Keep it")
	fmt.Fprintln(out, "somewhere only you can read, as you would the notes themselves.")
	fmt.Fprintf(out, "\nTo restore: point the server at it, or copy it back.\n")
	fmt.Fprintf(out, "  trewd verify -deep -data %s\n", rep.Dir)
	return nil
}

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	units := []string{"KiB", "MiB", "GiB", "TiB"}
	v := float64(n)
	for _, u := range units {
		v /= unit
		if v < unit {
			return fmt.Sprintf("%.1f %s", v, u)
		}
	}
	return fmt.Sprintf("%.1f PiB", v)
}

// stringList is a repeatable string flag.
//
// Used for -allow-origin, because a browser client that is not on the built-in
// list cannot connect and the only thing that knows its origin is the client.
// Obsidian's mobile origins are in that list and have never been checked
// against a device, so somebody is going to need this before I do.
type stringList []string

func (l *stringList) String() string { return strings.Join(*l, ",") }

func (l *stringList) Set(v string) error {
	if v == "" {
		return errors.New("an origin cannot be empty")
	}
	*l = append(*l, v)
	return nil
}
