package main

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/waynehoover/trew/internal/chunks"
	"github.com/waynehoover/trew/internal/control"
	"github.com/waynehoover/trew/internal/store"
)

// `trewd undo` with no server running opens the store itself, and through a
// running server goes over its control socket; either way it says exactly
// what it put back, the log records the operator as the actor, and undoing
// the same operation again is refused, naming the undo that did it.
func TestUndoWithoutAServerAndThroughTheControlSocket(t *testing.T) {
	dir := t.TempDir()
	stop := serveInBackground(t, dir)
	stop()
	_, ops := agentWrote(t, dir)

	out := mustRun(t, "undo", "-data", dir, ops[0])
	for _, want := range []string{
		"Undid operation " + ops[0] + ` (edit_note by "Claude on Mac" (token `,
		`restored "notes/plan.md" as uid 1 had it, now uid 4`,
		"`trewd undo ",
	} {
		if !strings.Contains(out, want) {
			t.Fatalf("undo without a server does not say %q:\n%s", want, out)
		}
	}
	if got := mustRun(t, "cat", "-data", dir, "-path", "notes/plan.md"); got != "the plan, before the agent" {
		t.Fatalf("after the undo the note reads %q", got)
	}

	stop = serveInBackground(t, dir)
	defer stop()
	// The flags after the id, as the command is written in the docs.
	out = mustRun(t, "undo", "-data", dir, ops[1], "-json")
	var u control.Undo
	if err := json.Unmarshal([]byte(out), &u); err != nil {
		t.Fatalf("undo -json is not JSON: %v\n%s", err, out)
	}
	var steps []store.UndoStep
	if err := json.Unmarshal(u.Steps, &steps); err != nil || !u.Committed || u.Undoes != ops[1] || u.ToCopy ||
		len(steps) != 1 || steps[0].Action != store.UndoRemove || steps[0].Path != "notes/new.md" {
		t.Fatalf("undo -json through the socket: %+v %v", u, err)
	}

	out, err := trew(t, "undo", "-data", dir, ops[0])
	if err == nil || !strings.Contains(out, "Did not undo operation "+ops[0]) || !strings.Contains(out, "already_undone") ||
		!strings.Contains(out, "Nothing was written.") {
		t.Fatalf("a second undo: %v\n%s", err, out)
	}

	audit := mustRun(t, "audit", "-data", dir)
	for _, want := range []string{"undo  committed  by the operator", "undoes op " + ops[0], "undone by op "} {
		if !strings.Contains(audit, want) {
			t.Fatalf("the audit does not say %q:\n%s", want, audit)
		}
	}
	// The operator is not a device.
	if devices := mustRun(t, "devices", "-data", dir); strings.Contains(devices, store.OperatorLabel) {
		t.Fatalf("the operator is in the device list:\n%s", devices)
	}
}

// A note a device changed after the agent refuses the undo, and the refusal
// says which, by whom, and that nothing was written; -to-copy then writes the
// version the agent replaced beside the note and says where.
func TestUndoRefusesAChangedNoteAndTheCopySaysWhereItWent(t *testing.T) {
	dir := t.TempDir()
	stop := serveInBackground(t, dir)
	stop()
	_, ops := agentWrote(t, dir)
	func() {
		dbPath, chunkDir := store.DataDir(dir)
		st, err := store.Open(dbPath, chunkDir)
		if err != nil {
			t.Fatal(err)
		}
		defer st.Close()
		body := []byte("the laptop's edit after the agent")
		n := chunks.Name(body)
		if err := st.Chunks().Put("default", n, body); err != nil {
			t.Fatal(err)
		}
		if _, err := st.AppendEntry("default", store.Entry{Path: "notes/plan.md", Size: int64(len(body)), MTime: 20,
			Device: "laptop", Chunks: []string{n}}); err != nil {
			t.Fatal(err)
		}
	}()

	stop = serveInBackground(t, dir)
	defer stop()
	out, err := trew(t, "undo", "-data", dir, ops[0])
	for _, want := range []string{"Did not undo operation " + ops[0], "stale", `"notes/plan.md" is at uid 4`,
		`written by "laptop"`, "Nothing was written.", "trewd undo -to-copy " + ops[0]} {
		if err == nil || !strings.Contains(out, want) {
			t.Fatalf("the refusal (%v) does not say %q:\n%s", err, want, out)
		}
	}

	out = mustRun(t, "undo", "-data", dir, "-to-copy", ops[0])
	if !strings.Contains(out, `copied uid 1 of "notes/plan.md" to "notes/plan (restored 1).md", now uid 5`) {
		t.Fatalf("the copy does not say where it went:\n%s", out)
	}
	if got := mustRun(t, "cat", "-data", dir, "-path", "notes/plan (restored 1).md"); got != "the plan, before the agent" {
		t.Fatalf("the copy reads %q", got)
	}
	if got := mustRun(t, "cat", "-data", dir, "-path", "notes/plan.md"); got != "the laptop's edit after the agent" {
		t.Fatalf("the note reads %q after the copy", got)
	}
}

// What the command refuses before it asks anything.
func TestUndoTakesOneOperationID(t *testing.T) {
	dir := t.TempDir()
	stop := serveInBackground(t, dir)
	stop()
	for _, args := range [][]string{
		{"undo", "-data", dir},
		{"undo", "-data", dir, "AAAAAAAAAAAAAAAAAAAAAA", "AAAAAAAAAAAAAAAAAAAAAA"},
		{"undo", "-data", dir, "not-an-operation"},
	} {
		if _, err := trew(t, args...); err == nil {
			t.Fatalf("%q was accepted", args)
		}
	}
	out, err := trew(t, "undo", "-data", dir, "AAAAAAAAAAAAAAAAAAAAAA")
	if err == nil || !strings.Contains(out, "not_found") {
		t.Fatalf("an operation the vault never had: %v\n%s", err, out)
	}
}
