package mcp

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
)

// JSON-RPC over MCP's streamable HTTP, written out by hand (PLAN.md M4 task
// 1, decided 2026-09-22): one POST carries one message, and its answer goes
// back on that POST's own response, so a reply is never routed by id. Two
// requests that share an id, which Basalt's session transport had to refuse
// before the SDK rerouted the first reply, cannot be confused here: each is
// answered on its own connection (TestDuplicateIDsAreAnsweredEachOnItsOwn).

// The JSON-RPC and MCP error codes this endpoint answers with.
const (
	codeParseError     = -32700
	codeInvalidRequest = -32600
	codeMethodNotFound = -32601
	codeInvalidParams  = -32602
	codeInternalError  = -32603
	// codeHeaderMismatch and codeUnsupportedVersion are the codes protocol
	// version 2026-07-28 allocates (SEP-2575, SEP-2243).
	codeHeaderMismatch     = -32020
	codeUnsupportedVersion = -32022
)

// MaxIDBytes bounds a request id as it was written in the request. The reply
// has to repeat it, and an id of megabytes, which Basalt's HTTP transport was
// tested with, would make every reply exceed its bound; refusing it as an
// invalid request costs a legitimate client nothing, because ids are small
// numbers or short strings.
const MaxIDBytes = 256

// frame is one parsed message: a request when id is set, a notification when
// it is not.
type frame struct {
	id     json.RawMessage
	method string
	params json.RawMessage // nil, or a JSON object
}

func (f frame) isRequest() bool { return f.id != nil }

// rpcError is a refusal the transport answers with a JSON-RPC error, and the
// HTTP status it goes with.
type rpcError struct {
	status  int
	code    int
	message string
	data    any
}

func (e *rpcError) Error() string { return e.message }

func invalidRequest(message string) *rpcError {
	return &rpcError{status: http.StatusBadRequest, code: codeInvalidRequest, message: message}
}

// integerID is how an integer id may be written: JSON-RPC allows any number
// and MCP narrows it to integers, and an id written as 1.0 or 1e0 would be
// repeated back in a spelling the client might not match against its own.
var integerID = regexp.MustCompile(`^-?(0|[1-9][0-9]*)$`)

// parseFrame reads one message, strictly: a JSON object whose keys are exactly
// JSON-RPC's (jsonrpc, method, and optionally id and params), none repeated,
// jsonrpc "2.0", a method that is a string, an id that is a string or an
// integer, and params that are an object.
//
// A body that is not an object, a batch included (MCP dropped batches in
// 2025-06-18), is an invalid request; that is the Basalt lesson of the
// non-object frame, which its HTTP transport refused before its SDK saw it. A
// response sent to the server, or any other key, is refused as well: a frame
// two readers could take two ways is one a proxy and this server might act on
// differently. Duplicate keys are refused for the same reason, since Go keeps
// the last and other decoders the first.
func parseFrame(body []byte) (frame, *rpcError) {
	body = bytes.TrimSpace(body)
	if len(body) == 0 || !json.Valid(body) {
		return frame{}, &rpcError{status: http.StatusBadRequest, code: codeParseError, message: "the body is not JSON"}
	}
	if body[0] != '{' {
		return frame{}, invalidRequest("a message is one JSON object; batches and other values are not accepted")
	}
	fields, err := objectFields(body)
	if err != nil {
		return frame{}, invalidRequest(err.Error())
	}
	var f frame
	var version string
	for key, raw := range fields {
		switch key {
		case "jsonrpc":
			if json.Unmarshal(raw, &version) != nil || version != "2.0" {
				return frame{}, invalidRequest(`jsonrpc must be "2.0"`)
			}
		case "method":
			if raw[0] != '"' || json.Unmarshal(raw, &f.method) != nil || f.method == "" {
				return frame{}, invalidRequest("method must be a non-empty string")
			}
		case "id":
			switch {
			case len(raw) > MaxIDBytes:
				return frame{}, invalidRequest("the request id is longer than any id this server answers")
			case raw[0] == '"':
				var s string
				if json.Unmarshal(raw, &s) != nil {
					return frame{}, invalidRequest("the request id is not a valid string")
				}
			case integerID.Match(raw):
			default:
				return frame{}, invalidRequest("the request id must be a string or an integer")
			}
			f.id = append(json.RawMessage(nil), raw...)
		case "params":
			if raw[0] != '{' {
				return frame{}, &rpcError{status: http.StatusBadRequest, code: codeInvalidParams, message: "params must be an object"}
			}
			f.params = raw
		case "result", "error":
			return frame{}, invalidRequest("the server does not accept JSON-RPC responses")
		default:
			return frame{}, invalidRequest("a message has only jsonrpc, id, method and params")
		}
	}
	if version == "" {
		return frame{}, invalidRequest(`jsonrpc must be "2.0"`)
	}
	if f.method == "" {
		return frame{}, invalidRequest("method must be a non-empty string")
	}
	return f, nil
}

// objectFields splits a JSON object into its members, refusing a key that
// appears twice.
func objectFields(raw []byte) (map[string]json.RawMessage, error) {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	if t, err := d.Token(); err != nil || t != json.Delim('{') {
		return nil, errors.New("not a JSON object")
	}
	out := map[string]json.RawMessage{}
	for d.More() {
		t, err := d.Token()
		if err != nil {
			return nil, err
		}
		key, ok := t.(string)
		if !ok {
			return nil, errors.New("not a JSON object")
		}
		var value json.RawMessage
		if err := d.Decode(&value); err != nil {
			return nil, err
		}
		if _, dup := out[key]; dup {
			return nil, errors.New("the key " + quoteKey(key) + " appears twice")
		}
		out[key] = value
	}
	if t, err := d.Token(); err != nil || t != json.Delim('}') {
		return nil, errors.New("not a JSON object")
	}
	if _, err := d.Token(); err != io.EOF {
		return nil, errors.New("something follows the object")
	}
	return out, nil
}

// quoteKey is a key for an error message: short, and quoted, so a key made of
// control characters or a sentence reaches nobody as anything but a key.
func quoteKey(key string) string {
	if len(key) > 64 {
		key = key[:64] + "..."
	}
	b, _ := json.Marshal(key)
	return string(b)
}

// rpcResponse is a JSON-RPC response as it is written.
type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcErrorBody   `json:"error,omitempty"`
}

type rpcErrorBody struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

// encode writes v as JSON, leaving HTML characters as themselves as the
// envelope's Marshal does.
func encode(v any) ([]byte, error) {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	if err := e.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n")), nil
}

func errorResponse(id json.RawMessage, e *rpcError) []byte {
	b, err := encode(rpcResponse{JSONRPC: "2.0", ID: id, Error: &rpcErrorBody{Code: e.code, Message: e.message, Data: e.data}})
	if err != nil {
		// Unreachable: every field is a number or a string this package wrote,
		// and data is a struct of strings.
		b = []byte(`{"jsonrpc":"2.0","error":{"code":-32603,"message":"internal error"}}`)
	}
	return b
}
