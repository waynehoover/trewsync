package notes

import (
	"fmt"
	"strings"
	"testing"
)

// The cases of client/src/node/mcp-operations.test.ts and mcp-batch.test.ts
// that are about the plan: which notes an operation changes, how, and when a
// plan passed back is the plan computed now. Applying one is a single
// CommitOperation in the store, which carries those suites' atomicity,
// before-image and stale-base cases (docs/development.md, "The MCP write
// side's note functions").

// mapView is a View over a map, the test's stand-in for the store at one
// head.
type mapView struct {
	files []string
	notes map[string]Version
}

func (m mapView) Files() ([]string, error) { return m.files, nil }

func (m mapView) Read(path string) (Version, error) {
	v, ok := m.notes[path]
	if !ok {
		return Version{}, refuse("not_found", "no live note at this path")
	}
	return v, nil
}

// testVault is a View over path and content pairs, with uid i+1 for the i-th.
func testVault(pairs ...string) mapView {
	m := mapView{notes: map[string]Version{}}
	for i := 0; i+1 < len(pairs); i += 2 {
		m.files = append(m.files, pairs[i])
		m.notes[pairs[i]] = Version{UID: int64(i/2 + 1), Bytes: []byte(pairs[i+1])}
	}
	return m
}

// written is what each planned change writes, by path; a deletion is "".
func written(t *testing.T, p Plan) map[string]string {
	t.Helper()
	writes, err := p.Writes()
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]string{}
	for _, w := range writes {
		switch w.Change.Action {
		case "move":
			out[w.Change.To] = string(w.Content)
			out[w.Change.Path] = ""
		case "delete":
			out[w.Change.Path] = ""
		default:
			out[w.Change.Path] = string(w.Content)
		}
	}
	return out
}

func TestPortedTagPlanAndItsWrites(t *testing.T) {
	// "previews exact tag spans and applies them with every original
	// preserved": the plan's changes, their bases, and what applying them
	// writes. That each original stays readable is the pinned previous
	// version's.
	view := testVault(
		"a.md", "---\r\nkeep:  yes # comment\r\ntags: [old]\r\n---\r\nUNSENT A #old/child\r\n",
		"b.md", "UNSENT B #old\n`#old`\n",
	)
	change := TagChange{Operation: "rename", OldTag: "old", NewTag: "new", IncludeChildren: true}
	p, err := PlanTags(view, change, TagScope{})
	if err != nil || len(p.Changes) != 2 {
		t.Fatalf("got %+v %v", p.Changes, err)
	}
	if p.Changes[0].Path != "a.md" || p.Changes[0].Base != 1 || p.Changes[1].Base != 2 ||
		!strings.Contains(p.Changes[0].Edits[0].Old, "old") {
		t.Errorf("changes %+v", p.Changes)
	}
	got := written(t, p)
	if got["a.md"] != "---\r\nkeep:  yes # comment\r\ntags: [\"new\"]\r\n---\r\nUNSENT A #new/child\r\n" ||
		got["b.md"] != "UNSENT B #new\n`#old`\n" {
		t.Errorf("writes %q", got)
	}
}

func TestPortedChangedPlansAreRefused(t *testing.T) {
	// "refuses changed plans, new affected notes and stale bases before any
	// write": a note that arrives after the preview, or a base that moved,
	// makes the plan computed at apply another plan.
	change := TagChange{Operation: "rename", OldTag: "old", NewTag: "new"}
	preview, err := PlanTags(testVault("a.md", "#old UNSENT"), change, TagScope{})
	if err != nil {
		t.Fatal(err)
	}
	arrived, _ := PlanTags(testVault("a.md", "#old UNSENT", "b.md", "#old new arrival"), change, TagScope{})
	moved, _ := PlanTags(testVault("z.md", "", "a.md", "#old UNSENT"), change, TagScope{})
	same, _ := PlanTags(testVault("a.md", "#old UNSENT"), change, TagScope{})
	if SamePlan(preview.Changes, arrived.Changes) || SamePlan(preview.Changes, moved.Changes) {
		t.Error("a changed plan passed")
	}
	if !SamePlan(preview.Changes, same.Changes) || PlanDigest(preview.Changes) != PlanDigest(same.Changes) {
		t.Error("the same plan did not pass")
	}
}

func TestPortedMovePlanRewritesLinks(t *testing.T) {
	// "moves after updating exact backlinks and outbound relative
	// destinations"
	view := testVault(
		"Project/A.md", "UNSENT A [B](B.md)\n",
		"Project/B.md", "B\n",
		"Index.md", "[[Project/A|label]] [A](Project/A.md \"title\")\n",
	)
	p, err := PlanMove(view, "Project/A.md", "Archive/A.md", true)
	if err != nil || len(p.Changes) != 2 {
		t.Fatalf("got %+v %v", p.Changes, err)
	}
	got := written(t, p)
	want := map[string]string{
		"Project/A.md": "",
		"Archive/A.md": "UNSENT A [B](../Project/B.md)\n",
		"Index.md":     "[[Archive/A|label]] [A](Archive/A.md \"title\")\n",
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestPortedPlansOfferOnlyEditableNotes(t *testing.T) {
	// "does not offer immutable recovery copies in a vault-wide tag plan":
	// there are no recovery copies on the server, and the same rule holds
	// for what is not an editable note: a drawing, an attachment.
	view := testVault("a.md", "#old", "drawing.excalidraw.md", "#old drawn", "image.png", "#old", "c.txt", "#old")
	p, err := PlanTags(view, TagChange{Operation: "rename", OldTag: "old", NewTag: "new"}, TagScope{})
	if err != nil || len(p.Changes) != 2 || p.Changes[0].Path != "a.md" || p.Changes[1].Path != "c.txt" {
		t.Errorf("got %+v %v", p.Changes, err)
	}
}

func TestPortedSuppliedEditsMustBeThePlan(t *testing.T) {
	// "rejects supplied edits that would remove prose outside the semantic
	// operation"
	view := testVault("a.md", "#old UNSENT prose")
	change := TagChange{Operation: "remove", Tags: []string{"old"}}
	p, err := PlanTags(view, change, TagScope{Paths: []string{"a.md"}})
	if err != nil {
		t.Fatal(err)
	}
	spoiled := append([]PlannedChange(nil), p.Changes...)
	spoiled[0].Edits = []SourceEdit{{Start: 0, End: 17, Old: "#old UNSENT prose", Text: ""}}
	if SamePlan(spoiled, p.Changes) {
		t.Error("edits that remove the prose passed")
	}
}

func TestPortedOccupiedDestination(t *testing.T) {
	// "does not overwrite a move destination occupied during exclusive
	// creation": at the plan, an occupied destination is refused, spelled as
	// it is or as a case-folding disk would hold it. One occupied after the
	// plan is the store's to refuse at the commit.
	view := testVault("a.md", "UNSENT A", "Index.md", "[[a]]", "b.md", "independent destination")
	for _, to := range []string{"b.md", "B.md", "index.md"} {
		if _, err := PlanMove(view, "a.md", to, true); codeOf(err) != "exists" {
			t.Errorf("%s: got %v", to, err)
		}
	}
}

func TestPortedUndecodableNoteRefusesTheOperation(t *testing.T) {
	// "refuses a global operation if a note cannot be decoded instead of
	// silently skipping it"
	view := testVault("a.md", "#old", "b.md", "\xff")
	_, err := PlanTags(view, TagChange{Operation: "rename", OldTag: "old", NewTag: "new"}, TagScope{})
	if r, ok := err.(*Refusal); !ok || r.Code != "invalid_utf8" || r.Path != "b.md" {
		t.Errorf("got %#v", err)
	}
}

func TestPortedNamespaceRefusals(t *testing.T) {
	// "refuses namespace mutations of %s": a destination the path rules
	// refuse. The recovery-copy name Basalt reserved is gone with the copies;
	// the names the server reserves are the tool's to refuse, as create_note
	// does.
	view := testVault("a.md", "original")
	for _, to := range []string{".trew/secret.md", "../outside.md"} {
		if _, err := PlanMove(view, "a.md", to, true); codeOf(err) != "badpath" {
			t.Errorf("%s: got %v", to, err)
		}
	}
}

func TestPortedPathBoundsBeforeReading(t *testing.T) {
	// "bounds encoded paths before any batch writes, including control
	// character expansion": refused before any note is read.
	var list []string
	for i := range 32 {
		list = append(list, fmt.Sprintf("%d%s.md", i, strings.Repeat("\x01", 100)))
	}
	_, err := PlanTags(unreadable{}, TagChange{Operation: "add", Tags: []string{"tag"}}, TagScope{Paths: list})
	if codeOf(err) != "batch_too_large" {
		t.Errorf("got %v", err)
	}
}

// unreadable is a View no plan may read.
type unreadable struct{}

func (unreadable) Files() ([]string, error)     { panic("the plan listed the vault") }
func (unreadable) Read(string) (Version, error) { panic("the plan read a note") }

func TestPortedUnchangedNamedNotesStayInThePlan(t *testing.T) {
	// "rechecks a no-op base while the rest of its batch is being
	// preserved": a note named for a tag operation is in the plan with no
	// edits, so that the commit rechecks its base with the others.
	view := testVault("a.md", "A", "b.md", "#present")
	p, err := PlanTags(view, TagChange{Operation: "add", Tags: []string{"present"}, Location: "content"},
		TagScope{Paths: []string{"a.md", "b.md"}})
	if err != nil || len(p.Changes) != 2 || len(p.Changes[1].Edits) != 0 || p.Changes[1].Base != 2 {
		t.Errorf("got %+v %v", p.Changes, err)
	}
}

func TestMoveDestinations(t *testing.T) {
	view := testVault("Old.md", "x", "Index.md", "[[Old]] [o](Old.md)")
	// The same path is same_destination; a case-only rename is a move, as
	// the store allows, and its links follow it.
	if _, err := PlanMove(view, "Old.md", "Old.md", true); codeOf(err) != "same_destination" {
		t.Errorf("same path: got %v", err)
	}
	p, err := PlanMove(view, "Old.md", "old.md", true)
	if err != nil {
		t.Fatal(err)
	}
	if got := written(t, p); got["Index.md"] != "[[old]] [o](old.md)" || got["old.md"] != "x" {
		t.Errorf("case-only rename: got %q", got)
	}
	for to, code := range map[string]string{"Old.json": "unsupported_format", "a.excalidraw.md": "unsupported_format", "a/.b.md": "badpath"} {
		if _, err := PlanMove(view, "Old.md", to, true); codeOf(err) != code {
			t.Errorf("%s: got %v, want %s", to, err, code)
		}
	}
	if _, err := PlanMove(view, "Missing.md", "New.md", true); codeOf(err) != "not_found" {
		t.Errorf("a missing source: got %v", err)
	}
}

func TestDeletePlans(t *testing.T) {
	view := testVault("Old.md", "x", "Index.md", "[[Old]] [o](Old.md)", "Other.md", "no links")
	p, err := PlanDelete(view, "Old.md", false)
	if err != nil || len(p.Changes) != 1 || p.Changes[0].Action != "delete" || len(p.Changes[0].Edits) != 0 {
		t.Fatalf("without markBroken: got %+v %v", p.Changes, err)
	}
	p, err = PlanDelete(view, "Old.md", true)
	if err != nil {
		t.Fatal(err)
	}
	if got := written(t, p); len(got) != 2 || got["Index.md"] != "~~[[Old]]~~ ~~[o](Old.md)~~" || got["Old.md"] != "" {
		t.Errorf("with markBroken: got %q", got)
	}
}

func TestScanBounds(t *testing.T) {
	// ScanNotes notes are read; one more is scan_incomplete.
	var pairs []string
	for i := range ScanNotes {
		pairs = append(pairs, fmt.Sprintf("n%03d.md", i), "text")
	}
	change := TagChange{Operation: "rename", OldTag: "t", NewTag: "u"}
	if _, err := PlanTags(testVault(pairs...), change, TagScope{}); err != nil {
		t.Errorf("%d notes: %v", ScanNotes, err)
	}
	if _, err := PlanTags(testVault(append(pairs, "z.md", "text")...), change, TagScope{}); codeOf(err) != "scan_incomplete" {
		t.Errorf("%d notes: got %v", ScanNotes+1, err)
	}
}

// A move or a struck-through deletion whose backlinks cannot fit one batch is
// refused as soon as they cannot, not after every note that links is read: a
// note three hundred notes link to took a move's preview eight seconds in a
// vault of ten thousand, only to answer batch_too_large (T50).
func TestAPlanStopsReadingOnceItCannotFitABatch(t *testing.T) {
	pairs := []string{"hub.md", "# hub\n"}
	for i := range 100 {
		pairs = append(pairs, fmt.Sprintf("n%03d.md", i), "see [[hub]]\n")
	}
	for _, c := range []struct {
		name string
		plan func(View) (Plan, error)
	}{
		{"move", func(v View) (Plan, error) { return PlanMove(v, "hub.md", "moved.md", true) }},
		{"delete", func(v View) (Plan, error) { return PlanDelete(v, "hub.md", true) }},
	} {
		v := &countingView{mapView: testVault(pairs...)}
		if _, err := c.plan(v); codeOf(err) != "batch_too_large" {
			t.Fatalf("%s: %v", c.name, err)
		}
		// The note itself and BatchFiles backlinks, which with the note's own
		// change are one more than a batch holds.
		if v.reads != BatchFiles+1 {
			t.Errorf("%s read %d notes, where %d decide it", c.name, v.reads, BatchFiles+1)
		}
	}
}

// countingView is a mapView that counts the notes read from it.
type countingView struct {
	mapView
	reads int
}

func (v *countingView) Read(path string) (Version, error) {
	v.reads++
	return v.mapView.Read(path)
}

func TestSuppliedPlanBounds(t *testing.T) {
	edit := SourceEdit{Start: 0, End: 1, Old: "a", Text: "b"}
	change := func(path string, edits int) PlannedChange {
		c := PlannedChange{Path: path, Base: 1, Action: "edit", Edits: []SourceEdit{}}
		for range edits {
			c.Edits = append(c.Edits, edit)
		}
		return c
	}
	var many []PlannedChange
	for i := range BatchFiles + 1 {
		many = append(many, change(fmt.Sprintf("%d.md", i), 0))
	}
	move := PlannedChange{Path: "a.md", Base: 1, Action: "move", To: "b.md", Edits: []SourceEdit{}}
	var paths []PlannedChange
	for i := range BatchFiles - 1 {
		paths = append(paths, change(fmt.Sprintf("%d.md", i), 0))
	}
	for _, c := range []struct {
		name    string
		changes []PlannedChange
		code    string
	}{
		{"32 changes", many[:BatchFiles], ""},
		{"33 changes", many, "batch_too_large"},
		{"a move and 30 others, 32 paths", append(paths[:BatchFiles-2:BatchFiles-2], move), ""},
		{"a move and 31 others: its destination is the 33rd path", append(paths, move), "batch_too_large"},
		{"4096 edits, over PlanBytes by their size", []PlannedChange{change("a.md", PlanEdits)}, "plan_too_large"},
		{"4097 edits, over PlanEdits", []PlannedChange{change("a.md", PlanEdits+1)}, "plan_too_large"},
		{"a few edits", []PlannedChange{change("a.md", 10)}, ""},
	} {
		if err := PlanTooLarge(c.changes); codeOf(err) != c.code {
			t.Errorf("%s: got %v, want %q", c.name, err, c.code)
		}
	}
	// The size is JSON.stringify's, with the base written as the number it is.
	if size := PlanSize([]PlannedChange{change("a.md", 1)}); size != len(`[{"path":"a.md","base":1,"action":"edit","edits":[{"start":0,"end":1,"old":"a","text":"b"}]}]`) {
		t.Errorf("size %d", size)
	}
}

func TestSamePlanNormalises(t *testing.T) {
	a := PlannedChange{Path: "a.md", Base: 1, Action: "edit", Edits: []SourceEdit{{0, 1, "a", "b"}, {2, 3, "c", "d"}}}
	b := PlannedChange{Path: "b.md", Base: 2, Action: "move", To: "c.md", Edits: []SourceEdit{}}
	reordered := a
	reordered.Edits = []SourceEdit{a.Edits[1], a.Edits[0]}
	for _, c := range []struct {
		name         string
		supplied     []PlannedChange
		same, digest bool
	}{
		{"the plan", []PlannedChange{a, b}, true, true},
		{"in another order", []PlannedChange{b, a}, true, true},
		{"edits in another order", []PlannedChange{reordered, b}, false, false},
		{"a change missing", []PlannedChange{a}, false, false},
		{"nil edits for none", []PlannedChange{a, {Path: "b.md", Base: 2, Action: "move", To: "c.md"}}, true, true},
	} {
		current := []PlannedChange{a, b}
		if SamePlan(c.supplied, current) != c.same || (PlanDigest(c.supplied) == PlanDigest(current)) != c.digest {
			t.Errorf("%s: SamePlan %v", c.name, SamePlan(c.supplied, current))
		}
	}
}
