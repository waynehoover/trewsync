package main

import (
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"

	"github.com/waynehoover/trewsync/internal/mcp"
	"github.com/waynehoover/trewsync/internal/search"
	"github.com/waynehoover/trewsync/internal/server"
	"github.com/waynehoover/trewsync/internal/store"
)

// The MCP endpoint `serve -mcp` adds (PLAN.md section 3.2): /mcp on the same
// listener as the devices, answered by internal/mcp from the server's own
// store. Without the flag nothing is registered at /mcp, and it is answered as
// any other path is. The search index it asks is not the flag's: every serve
// builds it (startIndex), because devices search too.

// testSeam is the endpoint's Config.Seam: nil here, and set only by
// testseam.go, which is compiled into a trewd built with the crashmatrix tag
// and into no other. It is how the crash matrix (PLAN.md M5 task 9) holds a
// real server at a point of a write and kills it there. Nothing a request
// carries reaches it, and a production build holds no code that reads the
// variable that arms it (TestAProductionBuildHasNoTestSeam).
var testSeam func(point string)

// mcpEndpoint is what serving MCP needs to keep, to stop it in order.
type mcpEndpoint struct {
	handler *mcp.Handler
}

// startIndex opens the search index and starts its worker, for every serve:
// device searches (`trew search`) and search_notes ask the same one. It does
// not fail: the index is derived, so an index that cannot be opened is set
// aside and made again, and if even that fails the server runs without one
// and search scans. A damaged derived file must never be why the server that
// holds the notes does not start (PLAN.md section 2.5). Nil means no index;
// the caller stops a non-nil one after the listener and before the store.
func startIndex(dataDir string, st *store.Store, vault string, log *slog.Logger) *search.Index {
	idx, err := search.Open(dataDir, st, vault, log)
	if err != nil {
		log.Warn("the search index could not be opened; setting it aside and building a new one", "err", err)
		if err := setAsideIndex(dataDir); err != nil {
			log.Warn("the search index could not be set aside", "err", err)
		}
		idx, err = search.Open(dataDir, st, vault, log)
		if err != nil {
			log.Error("the search index could not be made; search scans every note", "err", err)
			return nil
		}
	}
	idx.Start()
	return idx
}

// startMCP builds the endpoint over idx, which may be nil.
func startMCP(srv *server.Server, vault string, origins []string, idx *search.Index, conv mcp.Conventions,
	log *slog.Logger) *mcpEndpoint {
	cfg := mcp.Config{Server: srv, Vault: vault, AllowOrigins: origins, Log: log, Version: srv.Version(), Seam: testSeam,
		Conventions: conv}
	if idx != nil {
		// Only a real index goes in the interface: a typed nil there would be
		// an index that is not nil and panics.
		cfg.Index = idx
	}
	return &mcpEndpoint{handler: mcp.New(cfg)}
}

// setAsideIndex renames the index's files to a .broken name, replacing an
// older one, so the next open starts fresh and the damaged copy is still
// there to look at.
func setAsideIndex(dataDir string) error {
	var first error
	for _, suffix := range []string{"", "-wal", "-shm"} {
		from := filepath.Join(dataDir, search.FileName+suffix)
		if _, err := os.Stat(from); errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err := os.Rename(from, filepath.Join(dataDir, search.FileName+".broken"+suffix)); err != nil && first == nil {
			first = err
		}
	}
	return first
}

// close writes the held token counts. Call it after the listener has stopped
// and before the index and the store close.
func (m *mcpEndpoint) close() {
	m.handler.Close()
}

// withMCP mounts the endpoint at /mcp in front of the devices' handler.
func withMCP(devices http.Handler, m *mcpEndpoint) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/mcp", m.handler)
	mux.Handle("/", devices)
	return mux
}

// wildcardAddr reports whether addr listens on every interface: no host, or
// an unspecified address.
func wildcardAddr(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	if host == "" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsUnspecified()
}

// logMCP says what the operator of a new MCP endpoint needs to hear: that a
// wildcard address exposes it on every interface, which Basalt's HTTP MCP
// refused outright and this server allows because a container needs it
// (PLAN.md section 3.5); and that with no token it answers 401 to everyone.
func logMCP(log *slog.Logger, st *store.Store, vault, addr string) {
	if wildcardAddr(addr) {
		log.Warn("the MCP endpoint listens on every interface, and a token for it reads the whole vault",
			"addr", addr, "hint", "bind one interface with -addr, or keep /mcp behind Tailscale or an identity-aware proxy")
	}
	tokens, err := st.MCPTokens(vault)
	if err != nil {
		log.Warn("could not count the MCP tokens", "err", err)
		return
	}
	if len(tokens) == 0 {
		log.Info("serving MCP at /mcp with no token yet, so every request is refused",
			"hint", "`trewd mcp-token -label NAME` mints one, read scope by default")
		return
	}
	log.Info("serving MCP at /mcp", "tokens", len(tokens))
}
