package notes

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"testing"
)

// The write side's oracle: what Basalt's prepareNote, changeTags,
// previewOperation and samePlan returned for a corpus (the "edits",
// "changeTags", "plans" and "samePlan" sections of mcp-fixtures.json), and
// the checks that hold EditNote, AppendNote, PrependNote, ChangeTags,
// PlanTags, PlanMove, PlanDelete, PlanSize and SamePlan to them.

// ---------------------------------------------------------------------------
// Exact edits.

type editVector struct {
	Note    fxText `json:"note"`
	Request struct {
		Kind  string `json:"kind"`
		Edits []struct {
			Old fxText `json:"old"`
			New fxText `json:"new"`
		} `json:"edits"`
		Text fxText `json:"text"`
	} `json:"request"`
	Want json.RawMessage `json:"want"`
}

func (v editVector) edits() []Edit {
	edits := []Edit{}
	for _, e := range v.Request.Edits {
		edits = append(edits, Edit{Old: string(e.Old), New: string(e.New)})
	}
	return edits
}

func checkEdit(v editVector) error {
	var want struct {
		Text bigText `json:"text"`
		Noop bool    `json:"noop"`
	}
	code, err := either(v.Want, &want)
	if err != nil {
		return err
	}
	var got Revision
	var gerr error
	switch v.Request.Kind {
	case "edit":
		got, gerr = EditNote([]byte(v.Note), v.edits())
	case "append":
		got, gerr = AppendNote([]byte(v.Note), string(v.Request.Text))
	case "prepend":
		got, gerr = PrependNote([]byte(v.Note), string(v.Request.Text))
	default:
		return fmt.Errorf("unknown kind %q", v.Request.Kind)
	}
	if code == "input_too_large" && codeOf(gerr) == "note_too_large" && v.editResultTooLarge() {
		return nil
	}
	if code != "" || gerr != nil {
		if codeOf(gerr) != code {
			return fmt.Errorf("error %q, want %q", codeOf(gerr), code)
		}
		return nil
	}
	if !want.Text.matches(string(got.Bytes)) || got.Noop != want.Noop {
		return fmt.Errorf("got %s noop %v, want %s noop %v", short(string(got.Bytes)), got.Noop, want.Text, want.Noop)
	}
	return nil
}

// editResultTooLarge reports whether an exact edit's one fault is its result:
// every Old and New within EditBytes and together within InputBytes, and
// the note they make over NoteBytes. For that Basalt said input_too_large
// and plan/mcp-tools.md says note_too_large, which is what EditNote says;
// the check accepts it for these vectors only.
func (v editVector) editResultTooLarge() bool {
	if v.Request.Kind != "edit" {
		return false
	}
	size, input := len(v.Note), 0
	for _, e := range v.edits() {
		if len(e.Old) > EditBytes || len(e.New) > EditBytes {
			return false
		}
		input += len(e.Old) + len(e.New)
		size += len(e.New) - len(e.Old)
	}
	return input <= InputBytes && size > NoteBytes
}

// ---------------------------------------------------------------------------
// Tag edits.

// tagChangeJSON is a TagChange as the fixture writes it.
type tagChangeJSON struct {
	Operation       string   `json:"operation"`
	Tags            []string `json:"tags"`
	Patterns        []string `json:"patterns"`
	OldTag          string   `json:"oldTag"`
	NewTag          string   `json:"newTag"`
	Location        string   `json:"location"`
	IncludeChildren bool     `json:"includeChildren"`
	Position        string   `json:"position"`
	Normalization   string   `json:"normalization"`
}

func (c tagChangeJSON) change() TagChange {
	return TagChange{
		Operation: c.Operation, Tags: c.Tags, Patterns: c.Patterns, OldTag: c.OldTag, NewTag: c.NewTag,
		Location: c.Location, IncludeChildren: c.IncludeChildren, Position: c.Position, Normalization: c.Normalization,
	}
}

// changeTagsNote is one note and what each change did to it: the note is
// written out, or named by its index in the "notes" section.
type changeTagsNote struct {
	Source  *fxText              `json:"source"`
	Note    *int                 `json:"note"`
	Results [][2]json.RawMessage `json:"results"`
}

type editWant struct {
	Start int    `json:"start"`
	End   int    `json:"end"`
	Old   string `json:"old"`
	Text  string `json:"text"`
}

func sameEdits(got []SourceEdit, want []editWant) error {
	if len(got) != len(want) {
		return fmt.Errorf("got %d edits %+v, want %d %+v", len(got), got, len(want), want)
	}
	for i, g := range got {
		if w := want[i]; g.Start != w.Start || g.End != w.End || g.Old != w.Old || g.Text != w.Text {
			return fmt.Errorf("edit %d: got %+v, want %+v", i, g, w)
		}
	}
	return nil
}

func checkChangeTags(source string, input TagChange, raw json.RawMessage) error {
	var want struct {
		Edits   []editWant `json:"edits"`
		Changed []string   `json:"changed"`
	}
	code, err := either(raw, &want)
	if err != nil {
		return err
	}
	got, gerr := ChangeTags(source, input)
	if code != "" || gerr != nil {
		if codeOf(gerr) != code {
			return fmt.Errorf("error %q, want %q (got %+v)", codeOf(gerr), code, got)
		}
		return nil
	}
	if err := sameEdits(got.Edits, want.Edits); err != nil {
		return err
	}
	if fmt.Sprint(nonNil(got.Changed)) != fmt.Sprint(nonNil(want.Changed)) {
		return fmt.Errorf("changed %q, want %q", got.Changed, want.Changed)
	}
	return nil
}

// tagNoteCheck checks every change recorded for one note, and says which
// failed first.
func tagNoteCheck(source string, results [][2]json.RawMessage, inputs []tagChangeJSON) error {
	for _, r := range results {
		var i int
		if err := json.Unmarshal(r[0], &i); err != nil || i < 0 || i >= len(inputs) {
			return fmt.Errorf("%w: bad input index %s", errUndecodable, r[0])
		}
		if err := checkChangeTags(source, inputs[i].change(), r[1]); err != nil {
			return fmt.Errorf("change %d %+v: %w", i, inputs[i], err)
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Plans.

type planVault struct {
	Notes []struct {
		Path string `json:"path"`
		Text fxText `json:"text"`
	} `json:"notes"`
	Operations []planOperation `json:"operations"`
}

type planOperation struct {
	Operation struct {
		Kind        string        `json:"kind"`
		Change      tagChangeJSON `json:"change"`
		Paths       []string      `json:"paths"`
		Folder      *string       `json:"folder"`
		Path        string        `json:"path"`
		To          string        `json:"to"`
		UpdateLinks *bool         `json:"updateLinks"`
		MarkBroken  bool          `json:"markBroken"`
	} `json:"operation"`
	Want json.RawMessage `json:"want"`
}

// view is the vault with uid i+1 for its i-th note, as the generator
// numbered them for the plan's size.
func (v planVault) view() mapView {
	m := mapView{notes: map[string]Version{}}
	for i, n := range v.Notes {
		m.files = append(m.files, n.Path)
		m.notes[n.Path] = Version{UID: int64(i + 1), Bytes: []byte(n.Text)}
	}
	return m
}

func (o planOperation) plan(view View) (Plan, error) {
	op := o.Operation
	switch op.Kind {
	case "tags":
		scope := TagScope{Paths: op.Paths}
		if op.Folder != nil {
			scope.Folder = *op.Folder
		}
		return PlanTags(view, op.Change.change(), scope)
	case "move":
		return PlanMove(view, op.Path, op.To, op.UpdateLinks == nil || *op.UpdateLinks)
	case "delete":
		return PlanDelete(view, op.Path, op.MarkBroken)
	}
	return Plan{}, fmt.Errorf("unknown kind %q", op.Kind)
}

func checkPlan(vault planVault, o planOperation) error {
	var want struct {
		Changes []struct {
			Path   string     `json:"path"`
			Base   string     `json:"base"`
			Action string     `json:"action"`
			To     string     `json:"to"`
			Edits  []editWant `json:"edits"`
		} `json:"changes"`
		AmbiguousLinks int `json:"ambiguousLinks"`
		Size           int `json:"size"`
	}
	code, err := either(o.Want, &want)
	if err != nil {
		return err
	}
	view := vault.view()
	got, gerr := o.plan(view)
	if code != "" || gerr != nil {
		if codeOf(gerr) != code {
			return fmt.Errorf("error %q, want %q", codeOf(gerr), code)
		}
		return nil
	}
	if len(got.Changes) != len(want.Changes) {
		return fmt.Errorf("got %d changes %+v, want %d", len(got.Changes), got.Changes, len(want.Changes))
	}
	for i, g := range got.Changes {
		w := want.Changes[i]
		if g.Path != w.Path || g.Action != w.Action || g.To != w.To {
			return fmt.Errorf("change %d: got %s %s %q, want %s %s %q", i, g.Action, g.Path, g.To, w.Action, w.Path, w.To)
		}
		sum := sha256.Sum256(view.notes[w.Path].Bytes)
		if w.Base != hex.EncodeToString(sum[:]) || g.Base != view.notes[g.Path].UID {
			return fmt.Errorf("change %d: base %d for digest %s", i, g.Base, w.Base)
		}
		if err := sameEdits(g.Edits, w.Edits); err != nil {
			return fmt.Errorf("change %d %s: %w", i, g.Path, err)
		}
	}
	if got.AmbiguousLinks != want.AmbiguousLinks {
		return fmt.Errorf("ambiguous links %d, want %d", got.AmbiguousLinks, want.AmbiguousLinks)
	}
	if size := PlanSize(got.Changes); size != want.Size {
		return fmt.Errorf("plan size %d, want %d", size, want.Size)
	}
	return nil
}

type samePlanVector struct {
	Expected []PlannedChange `json:"expected"`
	Actual   []PlannedChange `json:"actual"`
	Want     bool            `json:"want"`
}

func checkSamePlan(v samePlanVector) error {
	if got := SamePlan(v.Actual, v.Expected); got != v.Want {
		return fmt.Errorf("SamePlan %v, want %v", got, v.Want)
	}
	if got := PlanDigest(v.Actual) == PlanDigest(v.Expected); got != v.Want {
		return fmt.Errorf("equal digests %v, want %v", got, v.Want)
	}
	return nil
}

// writeOracleCases adds the write side's vectors to TestOracle.
func writeOracleCases(t testing.TB, add func(string, func() error)) {
	for i, v := range section[editVector](t, "edits") {
		add(fmt.Sprintf("edits/%d %s", i, short(string(v.Note))), func() error { return checkEdit(v) })
	}
	ops := section[tagChangeJSON](t, "changeTags", "ops")
	notes := section[noteVector](t, "notes")
	for i, n := range section[changeTagsNote](t, "changeTags", "notes") {
		var source string
		switch {
		case n.Source != nil:
			source = string(*n.Source)
		case n.Note != nil && *n.Note < len(notes):
			source = string(notes[*n.Note].Source)
		default:
			t.Fatalf("changeTags/notes/%d names no note", i)
		}
		add(fmt.Sprintf("changeTags/%d %s", i, short(source)), func() error { return tagNoteCheck(source, n.Results, ops) })
	}
	inputs := section[tagChangeJSON](t, "changeTags", "inputs")
	for i, n := range section[changeTagsNote](t, "changeTags", "inputNotes") {
		source := string(*n.Source)
		add(fmt.Sprintf("changeTags/inputs/%d", i), func() error { return tagNoteCheck(source, n.Results, inputs) })
	}
	for i, vault := range section[planVault](t, "plans") {
		for j, o := range vault.Operations {
			add(fmt.Sprintf("plans/%d/%d %s", i, j, o.Operation.Kind), func() error { return checkPlan(vault, o) })
		}
	}
	for i, v := range section[samePlanVector](t, "samePlan") {
		add(fmt.Sprintf("samePlan/%d", i), func() error { return checkSamePlan(v) })
	}
}
