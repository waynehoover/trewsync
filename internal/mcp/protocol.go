package mcp

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
)

// The protocol versions this endpoint speaks (PLAN.md M4 task 1).
//
// Two eras. 2025-06-18 and 2025-11-25 open with an initialize handshake, and
// every later request names the negotiated version in the MCP-Protocol-Version
// header. 2026-07-28 has no handshake at all (SEP-2575): each request carries
// its version, and the client's capabilities, in params._meta, mirrored in the
// header, and server/discover answers what initialize used to. Sessions are
// gone from both as this endpoint speaks them: every POST stands alone, so no
// Mcp-Session-Id is minted and GET and DELETE are 405.
//
// An initialize is answered with the version it asks for when that is one of
// the two handshake versions, and otherwise with the newest of them,
// 2025-11-25. Answering an initialize with 2026-07-28 would announce, through
// the handshake, a revision that removed the handshake; the Go SDK's own
// server caps initialize the same way. 2026-07-28 is reached the way that
// revision says: a request carrying it.
const (
	Version20250618 = "2025-06-18"
	Version20251125 = "2025-11-25"
	Version20260728 = "2026-07-28"
)

// Versions are the versions this endpoint speaks, newest first.
var Versions = []string{Version20260728, Version20251125, Version20250618}

var handshakeVersions = []string{Version20251125, Version20250618}

// The _meta keys protocol 2026-07-28 puts on every request and result.
const (
	metaProtocolVersion    = "io.modelcontextprotocol/protocolVersion"
	metaClientCapabilities = "io.modelcontextprotocol/clientCapabilities"
	metaServerInfo         = "io.modelcontextprotocol/serverInfo"
)

// The HTTP headers the versions define.
const (
	headerProtocolVersion = "Mcp-Protocol-Version"
	headerMethod          = "Mcp-Method"
	headerName            = "Mcp-Name"
)

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// negotiateInitialize is the version an initialize asking for requested is
// answered with.
func negotiateInitialize(requested string) string {
	if contains(handshakeVersions, requested) {
		return requested
	}
	return handshakeVersions[0]
}

// dateVersion is a version's shape, a date, which is what lets two of them be
// compared as strings.
var dateVersion = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}$`)

// era is which of the two ways of speaking a request uses.
type era int

const (
	handshake era = iota
	stateless
)

// negotiated is the outcome of reading a request's version: which era, and
// which version within it.
type negotiated struct {
	era     era
	version string
}

func unsupportedVersion(requested string) *rpcError {
	return &rpcError{
		status: http.StatusBadRequest, code: codeUnsupportedVersion,
		message: "this server does not speak protocol version " + quoteKey(requested),
		data: struct {
			Supported []string `json:"supported"`
			Requested string   `json:"requested"`
		}{Versions, requested},
	}
}

func headerMismatch(message string) *rpcError {
	return &rpcError{status: http.StatusBadRequest, code: codeHeaderMismatch, message: message}
}

// negotiate reads which version a request speaks, from its header and its
// _meta, and applies the header rules of that version.
//
// A request is in the stateless era when its _meta names a version, or its
// header names 2026-07-28 or later. Then the header must be there and equal
// the _meta's version (a mismatch is a request two readers would route two
// ways), the version must be one this server speaks, the request must declare
// its client capabilities, and Mcp-Method, and for tools/call Mcp-Name, must
// mirror the body (SEP-2243). A notification in that era is accepted with
// none of this: the revision defines no header rules for one.
//
// Otherwise it is in the handshake era. An initialize negotiates from its
// params and needs no header; anything else must name one of the handshake
// versions in the header, which is what the client was told at initialize.
// This server does not speak the versions before 2025-06-18, which had no such
// header, so a request without one is refused rather than guessed at
// (2026-07-28 basic/transports, "Protocol Version Header").
func negotiate(r *http.Request, f frame) (negotiated, *rpcError) {
	header, err := singleHeader(r, headerProtocolVersion)
	if err != nil {
		return negotiated{}, err
	}
	meta, metaVersion, hasMeta := requestMeta(f.params)
	modern := hasMeta || (dateVersion.MatchString(header) && header >= Version20260728)
	if modern {
		if !f.isRequest() {
			return negotiated{era: stateless, version: metaVersion}, nil
		}
		switch {
		case header == "":
			return negotiated{}, headerMismatch("the MCP-Protocol-Version header is required and must equal the request's _meta protocolVersion")
		case !hasMeta:
			return negotiated{}, &rpcError{status: http.StatusBadRequest, code: codeInvalidParams,
				message: "a request at protocol version " + quoteKey(header) + " carries _meta." + metaProtocolVersion}
		case header != metaVersion:
			return negotiated{}, headerMismatch("the MCP-Protocol-Version header does not match the request's _meta protocolVersion")
		case !contains(Versions, metaVersion) || metaVersion < Version20260728:
			return negotiated{}, unsupportedVersion(metaVersion)
		}
		if caps, ok := meta[metaClientCapabilities]; !ok || len(caps) == 0 || caps[0] != '{' {
			return negotiated{}, &rpcError{status: http.StatusBadRequest, code: codeInvalidParams,
				message: "a request at protocol version " + metaVersion + " declares _meta." + metaClientCapabilities}
		}
		method, err := singleHeader(r, headerMethod)
		if err != nil {
			return negotiated{}, err
		}
		if method == "" {
			return negotiated{}, headerMismatch("the Mcp-Method header is required")
		}
		if method != f.method {
			return negotiated{}, headerMismatch("the Mcp-Method header does not match the request's method")
		}
		return negotiated{era: stateless, version: metaVersion}, nil
	}
	if f.method == "initialize" || !f.isRequest() {
		return negotiated{era: handshake}, nil
	}
	switch {
	case header == "":
		return negotiated{}, &rpcError{status: http.StatusBadRequest, code: codeInvalidRequest,
			message: "the MCP-Protocol-Version header is required on every request after initialize"}
	case !contains(handshakeVersions, header):
		return negotiated{}, unsupportedVersion(header)
	}
	return negotiated{era: handshake, version: header}, nil
}

// checkName applies Mcp-Name to a stateless tools/call: required, decoded from
// the base64 form when it is written in it, and equal to params.name.
func checkName(r *http.Request, name string) *rpcError {
	value, err := singleHeader(r, headerName)
	if err != nil {
		return err
	}
	if value == "" {
		return headerMismatch("the Mcp-Name header is required on tools/call")
	}
	if inner, ok := strings.CutPrefix(value, "=?base64?"); ok {
		if inner, ok = strings.CutSuffix(inner, "?="); ok {
			decoded, err := base64.StdEncoding.DecodeString(inner)
			if err != nil {
				return headerMismatch("the Mcp-Name header is not valid base64")
			}
			value = string(decoded)
		}
	}
	if value != name {
		return headerMismatch("the Mcp-Name header does not match the tool the request names")
	}
	return nil
}

// singleHeader is a header that may appear at most once, or two values that
// could each be believed by a different reader are refused.
func singleHeader(r *http.Request, name string) (string, *rpcError) {
	values := r.Header.Values(name)
	switch len(values) {
	case 0:
		return "", nil
	case 1:
		return strings.TrimSpace(values[0]), nil
	}
	return "", headerMismatch("the " + name + " header appears more than once")
}

// metaClientInfo is the _meta key under which a 2026-07-28 request may say
// which client sent it; the handshake era says it once, in initialize, which a
// stateless endpoint does not keep.
const metaClientInfo = "io.modelcontextprotocol/clientInfo"

// clientInfo is the client a stateless request says it is, or nothing.
// Untrusted and never used for a decision: an operation stores it capped and
// stripped of control characters, for the audit (plan/research/README.md
// section 5, Syncidian).
func clientInfo(params json.RawMessage) implementation {
	meta, _, _ := requestMeta(params)
	var info implementation
	if raw, ok := meta[metaClientInfo]; ok {
		_ = json.Unmarshal(raw, &info)
	}
	return info
}

// requestMeta is a request's params._meta, and the protocol version it names
// when it names one as a string.
func requestMeta(params json.RawMessage) (map[string]json.RawMessage, string, bool) {
	if params == nil {
		return nil, "", false
	}
	var p struct {
		Meta map[string]json.RawMessage `json:"_meta"`
	}
	if json.Unmarshal(params, &p) != nil || p.Meta == nil {
		return nil, "", false
	}
	raw, ok := p.Meta[metaProtocolVersion]
	if !ok {
		return p.Meta, "", false
	}
	var v string
	if json.Unmarshal(raw, &v) != nil {
		// A version that is not a string is still a claim to the stateless
		// era, and an unsupported one.
		return p.Meta, string(raw), true
	}
	return p.Meta, v, true
}
