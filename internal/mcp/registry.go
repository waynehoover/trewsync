package mcp

import (
	"context"
	"sort"
	"time"

	"github.com/waynehoover/trew/internal/store"
)

// The tool registry. Every tool declares the scope it needs, and the
// dispatcher, not the tool, enforces it: at discovery a token is shown only
// the tools its scope allows, at dispatch a call to one it does not allow is
// refused whatever the client sent, and a write re-checks the credential under
// the commit lock before it commits (PLAN.md section 2.3). Hiding a tool from
// the list is presentation; the refusal at dispatch is the enforcement, and a
// hand-written request meets it (TestAReadTokenCannotCallAWriteTool).

// Tool is one tool.
type Tool struct {
	Name  string
	Title string
	// Description is what the tool does, without Warning, which Describe adds
	// when the tool is listed.
	Description string
	// Scope is what a token needs to see and call it.
	Scope store.MCPScope
	// Input is the JSON Schema of the arguments. The schema is what a client
	// is shown; the tool's own reads of its arguments are what is enforced.
	Input schema
	// Run does the call. It reads its arguments from a, and returns the
	// envelope, marked as an error when it failed.
	Run func(c *call, a *args) outcome
}

// ReadOnly reports whether the tool changes nothing.
func (t *Tool) ReadOnly() bool { return t.Scope == store.ScopeRead }

// errRevokedAtCommit is a write whose credential was revoked, or lost its
// write scope, between dispatch and the commit boundary.
var errRevokedAtCommit = &ToolError{Code: "read_only", Message: "this token was revoked or cannot write; nothing was changed"}

// commit runs fn, a tool's mutation, under the commit lock every device commit
// and every credential change takes, after checking the credential as it
// stands there: present, not expired, and with write scope (PLAN.md sections
// 2.3 and 4.3, step 4). A token revoked after its call was dispatched loses
// here, and fn never runs. It is the only way a tool reaches a mutation, so a
// write tool cannot commit without this check; M5's CommitOperation runs
// inside it. TestOnlyTheCommitBoundaryReachesAMutation holds the package to
// that: it fails on any store, server or chunk store method reached outside
// a commit callback that is not on its list of reads.
func (c *call) commit(fn func() error) error {
	return c.h.srv.UnderCommitLock(func() error {
		tok, err := c.h.current(c.cred, c.h.now())
		if err != nil {
			return err
		}
		if tok == nil || !tok.Scope.Allows(store.ScopeWrite) {
			return errRevokedAtCommit
		}
		return fn()
	})
}

// call is one tool call in progress.
type call struct {
	ctx  context.Context
	h    *Handler
	cred *credential
	tool *Tool
	now  time.Time
}

// outcome is what a tool returns: its envelope, and whether it is an error.
type outcome struct {
	env     Result
	isError bool
}

// schema is a JSON Schema object as a tool's input is described.
type schema map[string]any

// object is an input schema of these properties, the named ones required, and
// no others.
func object(required []string, props map[string]schema) schema {
	s := schema{"type": "object", "properties": props, "additionalProperties": false}
	if len(required) > 0 {
		s["required"] = required
	}
	return s
}

func textProp(max int, description string) schema {
	return schema{"type": "string", "maxLength": max, "description": description}
}

func intProp(min, max int64, description string) schema {
	return schema{"type": "integer", "minimum": min, "maximum": max, "description": description}
}

func boolProp(description string) schema {
	return schema{"type": "boolean", "description": description}
}

func enumProp(description string, values ...string) schema {
	return schema{"type": "string", "enum": values, "description": description}
}

// listedTool is a tool as tools/list describes it.
type listedTool struct {
	Name        string      `json:"name"`
	Title       string      `json:"title,omitempty"`
	Description string      `json:"description"`
	InputSchema schema      `json:"inputSchema"`
	Annotations annotations `json:"annotations"`
}

// annotations are the hints plan/mcp-tools.md gives each tool: a read tool is
// read-only and idempotent, and none of them reaches outside the vault.
type annotations struct {
	Title           string `json:"title,omitempty"`
	ReadOnlyHint    bool   `json:"readOnlyHint"`
	DestructiveHint bool   `json:"destructiveHint"`
	IdempotentHint  bool   `json:"idempotentHint"`
	OpenWorldHint   bool   `json:"openWorldHint"`
}

// listed is the tools a token of scope may see, sorted by name, which is the
// deterministic order protocol 2026-07-28 asks for.
func (h *Handler) listed(scope store.MCPScope) []listedTool {
	var out []listedTool
	for _, t := range h.tools {
		if !scope.Allows(t.Scope) {
			continue
		}
		out = append(out, listedTool{
			Name: t.Name, Title: t.Title, Description: Describe(t.Description), InputSchema: t.Input,
			Annotations: annotations{
				Title: t.Title, ReadOnlyHint: t.ReadOnly(), DestructiveHint: !t.ReadOnly(),
				IdempotentHint: t.ReadOnly(), OpenWorldHint: false,
			},
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	if out == nil {
		out = []listedTool{}
	}
	return out
}

// lookup is the tool named name, or nil.
func (h *Handler) lookup(name string) *Tool {
	for _, t := range h.tools {
		if t.Name == name {
			return t
		}
	}
	return nil
}
