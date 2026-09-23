package main

import (
	"log/slog"
	"net"
	"net/http"

	"github.com/waynehoover/trew/internal/mcp"
	"github.com/waynehoover/trew/internal/search"
	"github.com/waynehoover/trew/internal/server"
	"github.com/waynehoover/trew/internal/store"
)

// The MCP endpoint `serve --mcp` adds (PLAN.md section 3.2): /mcp on the same
// listener as the devices, answered by internal/mcp from the server's own
// store, with the search index worker beside it. Without the flag nothing is
// registered at /mcp, and it is answered as any other path is.

// mcpEndpoint is what serving MCP needs to keep, to stop it in order.
type mcpEndpoint struct {
	handler *mcp.Handler
	index   *search.Index
}

// startMCP opens the search index, starts its worker, and builds the
// endpoint.
func startMCP(dataDir string, srv *server.Server, vault string, origins []string, log *slog.Logger) (*mcpEndpoint, error) {
	idx, err := search.Open(dataDir, srv.Store(), vault, log)
	if err != nil {
		return nil, err
	}
	idx.Start()
	h := mcp.New(mcp.Config{
		Server: srv, Vault: vault, Index: idx, AllowOrigins: origins, Log: log, Version: srv.Version(),
	})
	return &mcpEndpoint{handler: h, index: idx}, nil
}

// close writes the held token counts and stops the index. Call it after the
// listener has stopped and before the store closes.
func (m *mcpEndpoint) close() {
	m.handler.Close()
	_ = m.index.Close()
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
			"hint", "`trew mcp-token -label NAME` mints one, read scope by default")
		return
	}
	log.Info("serving MCP at /mcp", "tokens", len(tokens))
}
