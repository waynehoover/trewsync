package store

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

// schemaTwoLog is the operation log as schema 2 made it, before undo: an
// agent's kind only, no undoes, and no before_state.
const schemaTwoLog = `
CREATE TABLE operations (
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,
  id                TEXT    NOT NULL UNIQUE,
  vault_id          TEXT    NOT NULL,
  actor_id          TEXT    NOT NULL,
  actor_kind        TEXT    NOT NULL CHECK (actor_kind IN ('mcp')),
  actor_label       TEXT    NOT NULL,
  tool              TEXT    NOT NULL,
  request_digest    TEXT    NOT NULL,
  idempotency_key   TEXT,
  epoch             TEXT    NOT NULL,
  committed_at      INTEGER NOT NULL,
  outcome           TEXT    NOT NULL CHECK (outcome IN ('committed', 'noop')),
  snapshot_head     INTEGER,
  client_name       TEXT    NOT NULL DEFAULT '',
  client_version    TEXT    NOT NULL DEFAULT '',
  result            BLOB,
  result_expires_at INTEGER NOT NULL
);
CREATE INDEX operations_by_time ON operations(vault_id, committed_at);
CREATE TABLE op_entries (
  op_id      TEXT    NOT NULL REFERENCES operations(id),
  ord        INTEGER NOT NULL,
  role       TEXT    NOT NULL CHECK (role IN ('write', 'source')),
  path       TEXT    NOT NULL,
  before_uid INTEGER,
  after_uid  INTEGER NOT NULL,
  PRIMARY KEY (op_id, ord)
);
CREATE TABLE op_pins (
  op_id      TEXT    NOT NULL REFERENCES operations(id),
  vault_id   TEXT    NOT NULL,
  uid        INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (op_id, uid)
);
CREATE INDEX op_pins_by_vault ON op_pins(vault_id, expires_at, uid);
CREATE TABLE op_keys (
  actor_id        TEXT    NOT NULL,
  idempotency_key TEXT    NOT NULL,
  vault_id        TEXT    NOT NULL,
  op_id           TEXT    NOT NULL REFERENCES operations(id),
  expires_at      INTEGER NOT NULL,
  PRIMARY KEY (actor_id, idempotency_key)
);
`

// The third schema arrives tested too: a store schema 2 wrote, with an
// agent's operations in its log, is upgraded when it is opened. Every row is
// kept with its sequence number, the tables arrive exactly as a new store has
// them, before_state is worked out from what schema 2 kept (a pinned version
// was live, an unpinned one present is what it says, one neither pinned nor
// present cannot be told and is left unknown), and the edit schema 2 recorded
// can be undone at once.
//
// The build before, at schema 2, refuses the upgraded store as a newer
// schema, which TestADatabaseFromTheFutureIsRefused holds for every mode.
func TestASchemaTwoStoreKeepsItsLogWhenUndoArrives(t *testing.T) {
	fresh := t.TempDir()
	want := func() string {
		st := openAt(t, fresh)
		defer st.Close()
		return schemaOf(t, st.db)
	}()

	dir := t.TempDir()
	h := openAt(t, dir)
	if err := h.EnsureVault("v1", 1000); err != nil {
		t.Fatal(err)
	}
	a := h.writer(t, "agent")
	note := h.file(t, "note.md", "before the agent")
	edited, err := h.AppendEntry("v1", Entry{Path: "note.md", Size: 5, Device: "agent", Chunks: h.put(t, "v1", "after")})
	if err != nil {
		t.Fatal(err)
	}
	h.file(t, "gone.md", "deleted")
	tomb := h.remove(t, "gone.md")
	created, err := h.AppendEntry("v1", Entry{Path: "gone.md", Size: 3, Device: "agent", Chunks: h.put(t, "v1", "new")})
	if err != nil {
		t.Fatal(err)
	}
	made, err := h.AppendEntry("v1", Entry{Path: "fresh.md", Size: 5, Device: "agent", Chunks: h.put(t, "v1", "fresh")})
	if err != nil {
		t.Fatal(err)
	}
	const lost = 999
	epoch := h.Epoch()
	edit, create := "AAAAAAAAAAAAAAAAAAAAAA", "BBBBBBBBBBBBBBBBBBBBBA"
	digest := strings.Repeat("0", 64)
	for _, stmt := range []string{
		`DROP TABLE op_keys`, `DROP TABLE op_pins`, `DROP TABLE op_entries`, `DROP TABLE operations`,
		schemaTwoLog,
		fmt.Sprintf(`INSERT INTO operations (seq, id, vault_id, actor_id, actor_kind, actor_label, tool, request_digest,
		   epoch, committed_at, outcome, result_expires_at)
		 VALUES (7, '%s', 'v1', '%s', 'mcp', 'agent', 'edit_note', '%s', '%s', 2000, 'committed', 3000),
		        (9, '%s', 'v1', '%s', 'mcp', 'agent', 'create_note', '%s', '%s', 2001, 'committed', 3001)`,
			edit, a.id, digest, epoch, create, a.id, digest, epoch),
		fmt.Sprintf(`INSERT INTO op_entries (op_id, ord, role, path, before_uid, after_uid) VALUES
		   ('%s', 0, 'write', 'note.md', %d, %d),
		   ('%s', 0, 'write', 'gone.md', %d, %d),
		   ('%s', 1, 'write', 'fresh.md', NULL, %d),
		   ('%s', 2, 'write', 'lost.md', %d, %d)`,
			edit, note.UID, edited, create, tomb.UID, created, create, made, create, lost, made),
		fmt.Sprintf(`INSERT INTO op_pins (op_id, vault_id, uid, expires_at) VALUES ('%s', 'v1', %d, 9999999999999)`,
			edit, note.UID),
		`UPDATE store_identity SET schema_version = 2`, `PRAGMA user_version = 2`,
	} {
		if err := h.ExecForTest(stmt); err != nil {
			t.Fatalf("%s: %v", stmt, err)
		}
	}
	if err := h.Close(); err != nil {
		t.Fatal(err)
	}

	up := openAt(t, dir)
	if got := up.Identity(); got.SchemaVersion != SchemaVersion || got.Epoch != epoch {
		t.Fatalf("after the upgrade the identity is %+v", got)
	}
	if got := schemaOf(t, up.db); got != want {
		t.Fatalf("an upgraded store's schema is not a new store's:\nupgraded:\n%s\nnew:\n%s", got, want)
	}
	ops, _, err := up.Operations("v1", 0, 0, 10)
	if err != nil || len(ops) != 2 || ops[0].Seq != 7 || ops[0].ID != edit || ops[1].Seq != 9 || ops[1].ID != create {
		t.Fatalf("the log after the upgrade: %+v %v", ops, err)
	}
	states := map[string]string{}
	for _, o := range ops {
		for _, p := range o.Paths {
			states[p.Path] = p.BeforeState
		}
	}
	wantStates := map[string]string{"note.md": BeforeLive, "gone.md": BeforeGone, "fresh.md": BeforeNone, "lost.md": ""}
	if fmt.Sprint(states) != fmt.Sprint(wantStates) {
		t.Fatalf("before_state after the upgrade is %v, want %v", states, wantStates)
	}
	if len(ops[0].Pins) != 1 || ops[0].Pins[0].UID != note.UID {
		t.Fatalf("the pins after the upgrade: %+v", ops[0].Pins)
	}
	var fk int
	if err := up.db.QueryRow(`PRAGMA foreign_keys`).Scan(&fk); err != nil || fk != 1 {
		t.Fatalf("foreign keys are %d after the upgrade (%v)", fk, err)
	}

	// The upgraded log is used: schema 2's edit is undone, and the undo's
	// sequence number follows the rows carried over.
	plan, err := up.PlanUndo(UndoRequest{Vault: "v1", OpID: edit, Label: OperatorLabel, Now: 5000})
	if err != nil {
		t.Fatalf("planning the undo of schema 2's edit: %v", err)
	}
	res := up.commitUndo(t, plan)
	if got, _ := up.headBytes(t, "note.md"); got != "before the agent" {
		t.Fatalf("note.md reads %q after the undo", got)
	}
	if rec, _, _ := up.LookupOperation("v1", res.OpID); rec.Seq <= 9 {
		t.Fatalf("the undo was given sequence number %d, after 9", rec.Seq)
	}
	// And the path nothing can say anything about refuses rather than guess.
	if _, err := up.PlanUndo(UndoRequest{Vault: "v1", OpID: create, Label: OperatorLabel, Now: 5000}); err == nil ||
		!errors.Is(err, ErrBeforeImageGone) {
		t.Fatalf("the create with a lost before-image: %v", err)
	}
}
