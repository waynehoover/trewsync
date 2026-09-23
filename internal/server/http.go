package server

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
)

// AllowedOrigins lists the browser origins permitted to open a session.
//
// A Go client sends no Origin header and is always allowed. A browser client
// always sends one, and the websocket library refuses a cross-origin handshake
// by default. Every test in this package used a Go client, so the whole suite
// passed while no Obsidian plugin could connect at all; the server said
//
//	request Origin "obsidian.md" is not authorized for Host "127.0.0.1:18500"
//
// and only loading the plugin into a real vault showed it.
//
// The desktop entry is verified: `location.origin` inside a running Obsidian is
// exactly "app://obsidian.md". The two mobile entries are Capacitor's documented
// defaults, iOS and Android in that order, and have not been checked against a
// device.
//
// Everything else is still refused. A page in somebody's browser could not
// authenticate anyway, because the token travels in `hello` rather than being
// attached automatically the way a cookie would be, but refusing at the
// handshake is cheaper than relying on that, and this project refuses by
// default. Patterns carry their scheme so that "app://obsidian.md" does not also
// admit "https://obsidian.md".
var AllowedOrigins = []string{
	"app://obsidian.md",
	"capacitor://localhost",
	"http://localhost",
}

const healthTimeout = 5 * time.Second

// HTTPHandler is everything the server exposes: a health check and the
// websocket endpoint.
//
// It lives here rather than in main so that it can be tested. The origin list
// above is the reason that matters: it is the kind of thing that is invisible
// until somebody runs the real client, and it should not be invisible twice.
// healthTimeout bounds one health probe.
//
// A store on a disk that has stopped responding does not return an error, it
// stops returning. Without a bound the probe hangs, the checker times out, and
// what it reports is a network fault rather than the disk. Five seconds is long
// enough that an ordinary busy moment answers and short enough to be inside any
// probe interval worth setting.
func HTTPHandler(srv *Server, log *slog.Logger, extraOrigins ...string) http.Handler {
	origins := append(append([]string{}, AllowedOrigins...), extraOrigins...)
	mux := http.NewServeMux()

	// Whether this server could take a note, not whether the process answered
	// (I17).
	//
	// It used to write "ok" without touching anything, so a full disk, a
	// database gone read-only, or a chunk directory whose volume had unmounted
	// were all indistinguishable from health until somebody tried to save
	// something. That is rule 7 at the operational layer: a status must
	// distinguish the cases it collapses, and this one collapsed "the process
	// is running" into "your notes are safe".
	//
	// What it says and does not say. The reason is one word from a fixed list
	// in the store package, and the body carries nothing else: no version, no
	// vault name, no byte counts, no path. This endpoint needs no credential
	// and behind a tunnel the port is on the internet, so it is held to the
	// same rule as every other pre-auth surface, which
	// TestNoPreAuthSurfaceNamesTheServerVersion enforces. The numbers behind
	// the word are in `trew stats`, which is run on the machine.
	//
	// 503 rather than 200 with a body somebody has to parse: the common case is
	// a container runtime or an uptime checker that reads the status code and
	// nothing else, and telling those "ok" while notes are being refused is the
	// failure this replaces.
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		// Bounded, because a disk that has stopped answering hangs rather than
		// failing, and a probe that hangs reads as a network problem. Shorter
		// than any sensible probe timeout so the answer is this server's.
		ctx, cancel := context.WithTimeout(r.Context(), healthTimeout)
		defer cancel()

		h := srv.Health(ctx)
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		// So a proxy does not serve a cached "ok" from before the disk filled.
		w.Header().Set("Cache-Control", "no-store")
		if h.CanPersist {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("ok\n"))
			return
		}
		// Logged as well as answered. A probe's 503 is a number on somebody
		// else's dashboard; the log is where the operator looks, and a health
		// check that fails silently in the server's own log is one more thing
		// to correlate by hand.
		log.Warn("health check failed", "reason", string(h.Why), "took", h.Took)
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte(string(h.Why) + "\n"))
	})

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			http.Error(w, "trew speaks websocket only", http.StatusUpgradeRequired)
			return
		}
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			// Compression off: bodies are ciphertext and do not compress, so
			// the CPU would buy nothing.
			CompressionMode: websocket.CompressionDisabled,
			OriginPatterns:  origins,
		})
		if err != nil {
			// The origin is named, and so is the flag that would allow it. This
			// is how a client that cannot connect says why: the desktop plugin's
			// origin was missing once and the only evidence was this line, and
			// the mobile ones here have never been checked against a device.
			if origin := r.Header.Get("Origin"); origin != "" {
				log.Warn("websocket accept refused",
					"remote", r.RemoteAddr, "origin", origin, "err", err,
					"hint", "if this is your own client, restart with -allow-origin "+origin)
			} else {
				log.Warn("websocket accept", "remote", r.RemoteAddr, "err", err)
			}
			return
		}
		srv.Handle(r.Context(), conn, r.RemoteAddr)
	})

	return mux
}
