package mcp

import (
	"encoding/json"
	"errors"

	"github.com/waynehoover/trewsync/internal/notes"
)

// ToolError is a tool's failure, reported under trusted.error with isError
// set: a code from plan/mcp-tools.md's vocabulary, a message for a person,
// and, for a stale base, the path it was about and the version it now has;
// an outcome_unknown may also say its cause.
// Every field is the server's own or the caller's own validated input, never
// text from a note, which is what lets it sit under trusted.
type ToolError struct {
	Code       string `json:"code"`
	Message    string `json:"message"`
	Path       string `json:"path,omitempty"`
	CurrentUID *int64 `json:"currentUid,omitempty"`
	// Cause is what lies under an outcome_unknown, when the server knows it:
	// `nospace` for a full disk, which is its operator's to clear.
	Cause string `json:"cause,omitempty"`
}

func (e *ToolError) Error() string { return e.Code + ": " + e.Message }

// toolError is err as a tool reports it: a ToolError as it is, a refusal from
// internal/notes under its own code, and anything else as internal, with the
// detail kept for the log and out of the result.
func toolError(err error) *ToolError {
	var te *ToolError
	if errors.As(err, &te) {
		return te
	}
	var r *notes.Refusal
	if errors.As(err, &r) {
		return &ToolError{Code: r.Code, Message: r.Message}
	}
	return &ToolError{Code: "internal", Message: "the server could not complete this call; its log says why"}
}

// Observed is what every read result says about when and where it was read
// (plan/mcp-tools.md, "Result envelope"): the vault's head at the time, the
// store's epoch, and the server's clock.
type Observed struct {
	Head       int64  `json:"head"`
	Epoch      string `json:"epoch"`
	ObservedAt int64  `json:"observedAt"`
}

// fail is a failed call's outcome.
func (c *call) fail(e *ToolError) outcome { return failure(c.tool.Name, e) }

func failure(tool string, e *ToolError) outcome {
	r, err := NewResult(tool, struct {
		Error *ToolError `json:"error"`
	}{e}, nil)
	if err != nil {
		panic(err) // unreachable: a ToolError holds no Text
	}
	return outcome{env: r, isError: true}
}

// failErr is fail for an error of any kind, logging the detail of one that
// is not a refusal. The log line names the tool and the error, never an
// argument: a path or a query is the vault's metadata (PLAN.md section 2.2).
func (c *call) failErr(err error) outcome {
	te := toolError(err)
	if te.Code == "internal" {
		c.h.log.Error("MCP tool failed", "tool", c.tool.Name, "err", err)
	}
	return c.fail(te)
}

// ok is a successful call's outcome. A result that breaks the separation is a
// bug in the tool, and is reported as internal rather than sent.
func (c *call) ok(trusted, untrusted any) outcome {
	r, err := NewResult(c.tool.Name, trusted, untrusted)
	if err != nil {
		c.h.log.Error("an MCP tool built a result that breaks the envelope", "tool", c.tool.Name, "err", err)
		return c.fail(&ToolError{Code: "internal", Message: "the server built a result it refuses to send; its log says why"})
	}
	return outcome{env: r}
}

// toolContent is a tool result as tools/call carries it: the envelope as
// text, and the same object as structured content (plan/mcp-tools.md,
// "Result envelope").
type toolContent struct {
	Content    []textContent   `json:"content"`
	Structured json.RawMessage `json:"structuredContent"`
	IsError    bool            `json:"isError,omitempty"`
	// The two fields protocol 2026-07-28 adds to every result.
	ResultType string `json:"resultType,omitempty"`
	Meta       any    `json:"_meta,omitempty"`
}

type textContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

func contentOf(o outcome) (toolContent, error) {
	b := o.raw
	if b == nil {
		var err error
		if b, err = Marshal(o.env); err != nil {
			return toolContent{}, err
		}
	}
	return toolContent{
		Content:    []textContent{{Type: "text", Text: string(b)}},
		Structured: b,
		IsError:    o.isError,
	}, nil
}
