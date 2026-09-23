package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/waynehoover/telimus/internal/paths"
)

// collisionScenario is one case of the `collisions` section of
// protocol-fixtures.json: a live set, one create or move, and the verdict.
type collisionScenario struct {
	Name string `json:"name"`
	Live []struct {
		Path   string `json:"path"`
		Folder bool   `json:"folder"`
	} `json:"live"`
	Op struct {
		Type   string `json:"type"`
		Path   string `json:"path"`
		Prev   string `json:"prev"`
		Folder bool   `json:"folder"`
	} `json:"op"`
	Expect string `json:"expect"`
}

func collisionScenarios(t *testing.T) []collisionScenario {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "protocol-fixtures.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Collisions struct {
			Scenarios []collisionScenario `json:"scenarios"`
		} `json:"collisions"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Collisions.Scenarios) < 15 {
		t.Fatalf("only %d collision scenarios", len(f.Collisions.Scenarios))
	}
	return f.Collisions.Scenarios
}

// liveNow is the live set the entries say, as the reference takes it.
func liveNow(t *testing.T, h *harness) []paths.Live {
	t.Helper()
	live, _, err := liveFromEntries(h.db, "v1")
	if err != nil {
		t.Fatal(err)
	}
	out := make([]paths.Live, 0, len(live))
	for p, folder := range live {
		out = append(out, paths.Live{Path: p, Folder: folder})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

// writeAt sends one create or move through AppendCurrent with the bases a
// correct client would send, so the only refusal it can meet is the one under
// test.
func (h *harness) writeAt(t *testing.T, path, prev string, folder bool) error {
	t.Helper()
	base, err := h.CurrentUID("v1", path)
	if err != nil {
		t.Fatal(err)
	}
	var prevBase int64
	if prev != "" {
		if prevBase, err = h.CurrentUID("v1", prev); err != nil {
			t.Fatal(err)
		}
	}
	_, err = h.AppendCurrent("v1", Entry{Path: path, Prev: prev, Folder: folder, MTime: 1}, base, prevBase)
	return err
}

// buildLive reaches a live set through the real append path.
//
// Some of the fixtures' live sets cannot be made by creating each path in
// turn, because they are the middle of a case-only folder rename: Notes/a.md
// beside notes/b.md is refused as a create. They are reached the way a client
// reaches them, by creating the path under a spelling the live set already
// has and then renaming it case-only, which rule 1 always allows.
func (h *harness) buildLive(t *testing.T, live []paths.Live) {
	t.Helper()
	for _, l := range live {
		if err := h.writeAt(t, l.Path, "", l.Folder); err == nil {
			continue
		} else if !errors.Is(err, ErrCollision) {
			t.Fatalf("building the live set, %q: %v", l.Path, err)
		}
		respelled := h.respell(t, l.Path)
		if err := h.writeAt(t, respelled, "", l.Folder); err != nil {
			t.Fatalf("building the live set, %q as %q: %v", l.Path, respelled, err)
		}
		if err := h.writeAt(t, l.Path, respelled, l.Folder); err != nil {
			t.Fatalf("building the live set, renaming %q to %q: %v", respelled, l.Path, err)
		}
	}
}

// respell is path with each folder spelled the way the live set already
// spells a folder of the same key.
func (h *harness) respell(t *testing.T, path string) string {
	t.Helper()
	segs := strings.Split(path, "/")
	for k := 1; k < len(segs); k++ {
		dir := strings.Join(segs[:k], "/")
		rows, err := h.db.Query(`SELECT path FROM live_dirs WHERE vault_id = 'v1' AND fold = ? ORDER BY path LIMIT 1`,
			paths.Fold(dir))
		if err != nil {
			t.Fatal(err)
		}
		if rows.Next() {
			var spelled string
			if err := rows.Scan(&spelled); err != nil {
				t.Fatal(err)
			}
			copy(segs, strings.Split(spelled, "/"))
		}
		rows.Close()
	}
	return strings.Join(segs, "/")
}

// Every scenario the fixtures carry, through the store's real append path,
// single and batched: the verdict is the fixture's, and an accepted op leaves
// exactly the live set the reference says it should.
//
// The fixtures come from scripts/protocol-vectors.py, and the TypeScript
// client consumes the same ones; internal/paths.Collides, the quadratic
// reference, is held to them separately. This is the store's indexed check
// held to the same verdicts, which is the one a device's write actually
// meets.
func TestTheFixtureCollisionsThroughTheAppendPath(t *testing.T) {
	for _, sc := range collisionScenarios(t) {
		t.Run(sc.Name, func(t *testing.T) {
			var live []paths.Live
			for _, l := range sc.Live {
				live = append(live, paths.Live{Path: l.Path, Folder: l.Folder})
			}
			sort.Slice(live, func(i, j int) bool { return live[i].Path < live[j].Path })
			op := paths.Op{Path: sc.Op.Path, Prev: sc.Op.Prev, Move: sc.Op.Type == "move", Folder: sc.Op.Folder}
			if want := sc.Expect == "collision"; paths.Collides(live, op) != want {
				t.Fatalf("the reference disagrees with the fixture, so the fixture or the reference moved")
			}

			for _, batched := range []bool{false, true} {
				h := newTestStore(t)
				h.buildLive(t, live)
				if got := liveNow(t, h); fmt.Sprint(got) != fmt.Sprint(live) {
					t.Fatalf("built %v, the scenario's live set is %v", got, live)
				}
				var err error
				if !batched {
					err = h.writeAt(t, op.Path, op.Prev, op.Folder)
				} else {
					base, _ := h.CurrentUID("v1", op.Path)
					var prevBase int64
					if op.Prev != "" {
						prevBase, _ = h.CurrentUID("v1", op.Prev)
					}
					res, berr := h.AppendMany("v1", []Entry{{Path: op.Path, Prev: op.Prev, Folder: op.Folder,
						MTime: 1}}, []int64{base}, []int64{prevBase})
					if berr != nil {
						t.Fatal(berr)
					}
					err = res[0].Err
				}
				switch sc.Expect {
				case "collision":
					if !errors.Is(err, ErrCollision) {
						t.Fatalf("batched=%v: %v, want ErrCollision", batched, err)
					}
					if got := liveNow(t, h); fmt.Sprint(got) != fmt.Sprint(live) {
						t.Fatalf("batched=%v: a refused op changed the live set to %v", batched, got)
					}
				case "ok":
					if err != nil {
						t.Fatalf("batched=%v: %v, want it accepted", batched, err)
					}
				default:
					t.Fatalf("an expectation the test does not know: %q", sc.Expect)
				}
				if diff, err := liveDifference(h.db, "v1"); err != nil || diff != "" {
					t.Fatalf("batched=%v: the live tables disagree with the entries: %s %v", batched, diff, err)
				}
			}
		})
	}
}

// The store against the reference, on live sets nobody wrote down: random
// creates, folders, deletions and moves over names that fold into each other
// in every way the fixtures name (case, sharp s, dotted capital I, final
// sigma), each one checked by paths.Collides against the live set the
// entries say, and then sent through the real append path. They must agree
// on every operation. The seeds are fixed, so a failure is a seed to rerun.
func TestTheStoreAgreesWithTheReferenceOnRandomHistories(t *testing.T) {
	names := []string{"a", "A", "b", "B", "ß", "SS", "ss", "İ", "i̇", "ΟΔΟΣ", "οδος", "ǅ", "ǆ", "x.md", "X.md"}
	randomPath := func(rng *rand.Rand) string {
		depth := 1 + rng.Intn(3)
		segs := make([]string, depth)
		for i := range segs {
			segs[i] = names[rng.Intn(len(names))]
		}
		return strings.Join(segs, "/")
	}
	for seed := int64(1); seed <= 12; seed++ {
		seed := seed
		t.Run(fmt.Sprintf("seed %d", seed), func(t *testing.T) {
			t.Parallel()
			agreeOnRandomHistory(t, seed, randomPath)
		})
	}
}

// agreeOnRandomHistory is one seed of the comparison above.
func agreeOnRandomHistory(t *testing.T, seed int64, randomPath func(*rand.Rand) string) {
	rng := rand.New(rand.NewSource(seed))
	h := newTestStore(t)
	agreed, refused := 0, 0
	for step := 0; step < 250; step++ {
		live := liveNow(t, h)
		var op paths.Op
		kind := rng.Intn(10)
		switch {
		case kind < 5:
			op = paths.Op{Path: randomPath(rng), Folder: rng.Intn(4) == 0}
		case kind < 8 && len(live) > 0:
			src := live[rng.Intn(len(live))]
			op = paths.Op{Path: randomPath(rng), Prev: src.Path, Move: true, Folder: src.Folder}
			if op.Path == op.Prev {
				continue
			}
		case len(live) > 0:
			victim := live[rng.Intn(len(live))]
			base, _ := h.CurrentUID("v1", victim.Path)
			if _, err := h.AppendCurrent("v1", Entry{Path: victim.Path, Deleted: true, MTime: 1},
				base, 0); err != nil {
				t.Fatalf("seed %d step %d: deleting %q: %v", seed, step, victim.Path, err)
			}
			continue
		default:
			continue
		}
		want := paths.Collides(live, op)
		err := h.writeAt(t, op.Path, op.Prev, op.Folder)
		switch {
		case want && errors.Is(err, ErrCollision):
			refused++
		case !want && err == nil:
			agreed++
		default:
			t.Fatalf("seed %d step %d: %+v against %v: the reference says collides=%v and the store said %v",
				seed, step, op, live, want, err)
		}
	}
	if diff, err := liveDifference(h.db, "v1"); err != nil || diff != "" {
		t.Fatalf("seed %d: the live tables drifted from the entries: %s %v", seed, diff, err)
	}
	if agreed == 0 || refused == 0 {
		t.Fatalf("seed %d exercised one verdict only: %d accepted, %d refused", seed, agreed, refused)
	}
}

// The live tables are exactly what the entries say after every kind of write
// there is, and after a purge, which must not move them: creates, updates,
// a path changing kind, deletions, recreations, renames onto a new path and
// onto a live one, a chain of renames, and folder entries with and without
// files beneath them. Compared with a recomputation from the entries alone
// after each write, which is the check verify makes.
func TestTheLiveSetIsExactlyWhatTheEntriesSay(t *testing.T) {
	h := newTestStore(t)
	check := func(what string) {
		t.Helper()
		if diff, err := liveDifference(h.db, "v1"); err != nil || diff != "" {
			t.Fatalf("after %s: %s %v", what, diff, err)
		}
	}
	steps := []struct {
		what, path, prev string
		folder, deleted  bool
	}{
		{what: "a create", path: "notes/a.md"},
		{what: "a second file in the folder", path: "notes/b.md"},
		{what: "an update", path: "notes/a.md"},
		{what: "a folder entry above files", path: "notes", folder: true},
		{what: "a folder entry of its own", path: "empty", folder: true},
		{what: "a path becoming a folder", path: "notes/b.md", folder: true},
		{what: "and a file again", path: "notes/b.md"},
		{what: "a deletion", path: "notes/a.md", deleted: true},
		{what: "a recreation", path: "notes/a.md"},
		{what: "a rename to a new path", path: "moved/a.md", prev: "notes/a.md"},
		{what: "a rename onto a live path", path: "notes/b.md", prev: "moved/a.md"},
		{what: "a chain of renames", path: "c/one.md", prev: "notes/b.md"},
		{what: "and another link", path: "c/two.md", prev: "c/one.md"},
		{what: "a case-only rename", path: "C/two.md", prev: "c/two.md"},
		{what: "a folder entry deleted", path: "notes", deleted: true},
		{what: "a folder renamed", path: "gone", prev: "empty", folder: true},
	}
	for _, s := range steps {
		base, _ := h.CurrentUID("v1", s.path)
		var prevBase int64
		if s.prev != "" {
			prevBase, _ = h.CurrentUID("v1", s.prev)
		}
		if _, err := h.AppendCurrent("v1", Entry{Path: s.path, Prev: s.prev, Folder: s.folder, Deleted: s.deleted,
			MTime: 1}, base, prevBase); err != nil {
			t.Fatalf("%s: %v", s.what, err)
		}
		check(s.what)
	}
	before := liveNow(t, h)
	if _, err := h.Purge("v1", 0); err != nil {
		t.Fatalf("purge: %v", err)
	}
	check("a purge")
	if after := liveNow(t, h); fmt.Sprint(after) != fmt.Sprint(before) {
		t.Fatalf("a purge moved the live set from %v to %v", before, after)
	}
}

// A live set that has drifted from the entries is reported by verify, and a
// write that meets the drift rebuilds it from the entries rather than
// refusing: the tables are derived, and the entries are the truth.
func TestADriftedLiveSetIsReportedAndHealed(t *testing.T) {
	h := newTestStore(t)
	for _, p := range []string{"notes/a.md", "notes/b.md"} {
		if err := h.writeAt(t, p, "", false); err != nil {
			t.Fatal(err)
		}
	}
	if err := h.ExecForTest(`DELETE FROM live_dirs WHERE vault_id = 'v1' AND path = 'notes'`); err != nil {
		t.Fatal(err)
	}
	v, err := h.Verify(false)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, f := range v.Faults {
		found = found || f.Reason == "livekeys"
	}
	if !found {
		t.Fatalf("verify did not report the drift: %v", v.Faults)
	}
	// Deleting a file under the folder takes a count away that is not there,
	// which is the drift being met: the write succeeds and the set is whole.
	base, _ := h.CurrentUID("v1", "notes/a.md")
	if _, err := h.AppendCurrent("v1", Entry{Path: "notes/a.md", Deleted: true, MTime: 2}, base, 0); err != nil {
		t.Fatalf("a write that met the drift was refused: %v", err)
	}
	if diff, err := liveDifference(h.db, "v1"); err != nil || diff != "" {
		t.Fatalf("the drift was not healed: %s %v", diff, err)
	}
	// And the rule is right again: notes/ is spelled one way.
	if err := h.writeAt(t, "Notes/c.md", "", false); !errors.Is(err, ErrCollision) {
		t.Fatalf("after healing, a new spelling of a live folder was answered %v", err)
	}
}

// Drift a write never meets is repaired at the next start: RepairLive, which
// serve runs, finds the disagreement and rebuilds the vault's live set, and
// leaves a vault that agrees alone.
func TestRepairLiveRebuildsWhatDriftedAndNothingElse(t *testing.T) {
	h := newTestStore(t)
	if err := h.writeAt(t, "notes/a.md", "", false); err != nil {
		t.Fatal(err)
	}
	if got, err := h.RepairLive(); err != nil || len(got) != 0 {
		t.Fatalf("a vault that agrees was repaired: %v %v", got, err)
	}
	if err := h.ExecForTest(`DELETE FROM live_paths WHERE vault_id = 'v1'`); err != nil {
		t.Fatal(err)
	}
	got, err := h.RepairLive()
	if err != nil || got["v1"] == "" {
		t.Fatalf("drift was not repaired: %v %v", got, err)
	}
	if diff, err := liveDifference(h.db, "v1"); err != nil || diff != "" {
		t.Fatalf("after repair: %s %v", diff, err)
	}
	if err := h.writeAt(t, "Notes/b.md", "", false); !errors.Is(err, ErrCollision) {
		t.Fatalf("after repair the rule answered %v", err)
	}
}
