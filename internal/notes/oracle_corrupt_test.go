package notes

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

// TestOracleDetectsCorruption proves that every check in oracle_test.go can
// fail: for each section it takes a real vector, damages the recorded answer
// in one place, and requires the check to reject it. A check that passed a
// damaged vector would pass anything, and TestOracle would prove nothing.
func TestOracleDetectsCorruption(t *testing.T) {
	tagOps := section[tagChangeJSON](t, "changeTags", "ops")
	cases := []struct {
		name  string
		path  []string // the fixture section
		find  func(v any) bool
		spoil func(v any)
		check func(raw []byte) error
	}{
		{"page", []string{"page"}, wantHas("content"), setIn("want", "endLine", 99),
			decodeAnd(func(v pageVector) error { return checkPage(v) })},
		{"page error", []string{"page"}, wantHas("error"), setIn("want", "error", "spoiled"),
			decodeAnd(func(v pageVector) error { return checkPage(v) })},
		{"fingerprint", []string{"cursor", "fingerprints"}, any1, set("want", strings.Repeat("0", 64)),
			decodeAnd(func(v fingerprintVector) error { return checkFingerprint(v) })},
		{"token", []string{"cursor", "tokens"}, any1, set("want", "e30"),
			decodeAnd(func(v tokenVector) error { return checkToken(v) })},
		{"position", []string{"cursor", "positions"}, func(v any) bool { return field(v, "note") == "valid" },
			set("want", map[string]any{"error": "invalid_cursor"}),
			decodeAnd(func(v positionVector) error { return checkPosition(v) })},
		{"search", []string{"search"}, any1, spoilSearch,
			func(raw []byte) error {
				var vault searchVault
				if err := json.Unmarshal(raw, &vault); err != nil {
					return fmt.Errorf("%w: %v", errUndecodable, err)
				}
				return checkSearch(vault, vault.Queries[0])
			}},
		{"compare", []string{"compare"}, func(v any) bool { return len(listIn(v, "want", "changes")) > 0 },
			func(v any) { first(listIn(v, "want", "changes"))["toLine"] = 99 },
			decodeAnd(func(v compareVector) error { return checkCompare(v) })},
		{"compare page", []string{"compare"}, func(v any) bool { return len(listIn(v, "want", "changes")) > 0 },
			func(v any) { first(v.(map[string]any)["pages"].([]any))["want"].(map[string]any)["complete"] = false },
			decodeAnd(func(v compareVector) error { return checkCompare(v) })},
		{"frontmatter", []string{"notes"}, func(v any) bool { return field(field(v, "frontmatter"), "present") == true },
			setIn("frontmatter", "body", 0),
			decodeAnd(func(v noteVector) error { return checkFrontmatter(tagsVector{v.Source, v.Frontmatter}) })},
		{"tags", []string{"notes"}, func(v any) bool { l, _ := field(v, "tags").([]any); return len(l) > 0 },
			func(v any) { first(field(v, "tags").([]any))["start"] = 999 },
			decodeAnd(func(v noteVector) error { return checkTags(tagsVector{v.Source, v.Tags}) })},
		{"hidden", []string{"notes"}, hasHidden, spoilHidden,
			decodeAnd(func(v noteVector) error { return checkNoteHidden(v) })},
		{"links", []string{"notes"}, func(v any) bool { l, _ := field(v, "links").([]any); return len(l) > 0 },
			func(v any) { first(field(v, "links").([]any))["url"] = "spoiled" },
			decodeAnd(func(v noteVector) error { return checkSpans(tagsVector{v.Source, v.Links}) })},
		{"inline", []string{"inline"}, func(v any) bool { l, _ := field(v, "want").([]any); return len(l) > 0 },
			func(v any) { first(field(v, "want").([]any))["tag"] = "spoiled" },
			decodeAnd(func(v inlineVector) error { return checkInline(v) })},
		{"validateTag", []string{"validateTag"}, func(v any) bool { _, ok := field(v, "want").(string); return ok },
			set("want", map[string]any{"error": "invalid_tag"}),
			decodeAnd(func(v validateVector) error { return checkValidate(v) })},
		{"matchesTag", []string{"matchesTag"}, any1, func(v any) { m := v.(map[string]any); m["want"] = m["want"] != true },
			decodeAnd(func(v matchesVector) error { return checkMatches(v) })},
		{"tagPattern", []string{"tagPattern"}, func(v any) bool { _, ok := field(v, "want").(bool); return ok },
			func(v any) { m := v.(map[string]any); m["want"] = m["want"] != true },
			decodeAnd(func(v patternVector) error { return checkPattern(v) })},
		{"resolve", []string{"resolve"}, any1,
			func(v any) {
				for _, q := range v.(map[string]any)["queries"].([]any) {
					if w, _ := field(q, "want").([]any); len(w) > 0 {
						q.(map[string]any)["want"] = []any{"Elsewhere.md"}
						return
					}
				}
			},
			decodeAnd(func(v resolveVector) error { return checkResolve(v) })},
		{"changeLinks", []string{"changeLinks"}, func(v any) bool { l, _ := field(field(v, "want"), "edits").([]any); return len(l) > 0 },
			func(v any) { first(field(field(v, "want"), "edits").([]any))["text"] = "spoiled" },
			decodeAnd(func(v changeLinksVector) error { return checkChangeLinks(v) })},
		{"decodeString", []string{"decodeString"}, any1, set("want", "spoiled"),
			decodeAnd(func(v decodeVector) error { return checkDecode(v) })},
		{"edits", []string{"edits"}, wantHas("text"), setIn("want", "text", "spoiled"),
			decodeAnd(func(v editVector) error { return checkEdit(v) })},
		{"edits error", []string{"edits"}, wantHas("error"), setIn("want", "error", "spoiled"),
			decodeAnd(func(v editVector) error { return checkEdit(v) })},
		{"edits noop", []string{"edits"}, func(v any) bool { return field(field(v, "want"), "noop") == true },
			setIn("want", "noop", false),
			decodeAnd(func(v editVector) error { return checkEdit(v) })},
		{"changeTags", []string{"changeTags", "notes"}, tagResultHas("edits"),
			spoilTagResult("edits", func(want map[string]any) { first(want["edits"].([]any))["text"] = "spoiled" }),
			decodeAnd(func(v changeTagsNote) error { return tagNoteCheck(string(*v.Source), v.Results, tagOps) })},
		{"changeTags changed", []string{"changeTags", "notes"}, tagResultHas("changed"),
			spoilTagResult("changed", func(want map[string]any) { want["changed"] = []any{"spoiled"} }),
			decodeAnd(func(v changeTagsNote) error { return tagNoteCheck(string(*v.Source), v.Results, tagOps) })},
		{"changeTags error", []string{"changeTags", "notes"}, tagResultHas("error"),
			spoilTagResult("error", func(want map[string]any) { want["error"] = "spoiled" }),
			decodeAnd(func(v changeTagsNote) error { return tagNoteCheck(string(*v.Source), v.Results, tagOps) })},
		{"plans", []string{"plans"}, planHas(hasChanges),
			spoilPlan(hasChanges, func(w map[string]any) { first(w["changes"].([]any))["path"] = "spoiled.md" }), checkPlans},
		{"plans base", []string{"plans"}, planHas(hasChanges),
			spoilPlan(hasChanges, func(w map[string]any) { first(w["changes"].([]any))["base"] = strings.Repeat("0", 64) }),
			checkPlans},
		{"plans edits", []string{"plans"}, planHas(hasEdits),
			spoilPlan(hasEdits, func(w map[string]any) {
				for _, c := range listIn(w, "changes") {
					if e := listIn(c, "edits"); len(e) > 0 {
						first(e)["end"] = 999999
						return
					}
				}
			}), checkPlans},
		{"plans ambiguous", []string{"plans"}, planHas(hasKey("ambiguousLinks")),
			spoilPlan(hasKey("ambiguousLinks"), func(w map[string]any) { w["ambiguousLinks"] = 99 }), checkPlans},
		{"plans size", []string{"plans"}, planHas(hasKey("size")),
			spoilPlan(hasKey("size"), func(w map[string]any) { w["size"] = 1 }), checkPlans},
		{"plans error", []string{"plans"}, planHas(hasKey("error")),
			spoilPlan(hasKey("error"), func(w map[string]any) { w["error"] = "spoiled" }), checkPlans},
		{"samePlan", []string{"samePlan"}, any1, func(v any) { m := v.(map[string]any); m["want"] = m["want"] != true },
			decodeAnd(func(v samePlanVector) error { return checkSamePlan(v) })},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			vectors := section[json.RawMessage](t, c.path...)
			for _, raw := range vectors {
				var v any
				if err := json.Unmarshal(raw, &v); err != nil {
					t.Fatal(err)
				}
				if !c.find(v) || knownBug(v) {
					continue
				}
				if err := c.check(raw); err != nil {
					t.Fatalf("the unspoiled vector already fails: %v", err)
				}
				c.spoil(v)
				spoiled, _ := json.Marshal(v)
				err := c.check(spoiled)
				if err == nil {
					t.Fatalf("a spoiled vector passed: %s", spoiled)
				}
				if errors.Is(err, errUndecodable) {
					t.Fatalf("the spoiled vector no longer decodes, which proves nothing: %v", err)
				}
				t.Logf("rejected: %v", err)
				return
			}
			t.Fatal("no vector to spoil")
		})
	}
	t.Run("sweeps", func(t *testing.T) {
		var sweeps map[string]json.RawMessage
		if err := json.Unmarshal(loadFixture(t)["sweeps"], &sweeps); err != nil {
			t.Fatal(err)
		}
		var ranges [][2]rune
		_ = json.Unmarshal(sweeps["tagChar"], &ranges)
		ranges[0][1]++ // one more code point in the class than Go has
		if checkSweep(sweepVector{Name: "tagChar", Want: ranges}) == nil {
			t.Fatal("a spoiled class sweep passed")
		}
		var lower [][2]json.RawMessage
		_ = json.Unmarshal(sweeps["lower"], &lower)
		lower[0][1] = json.RawMessage(`"spoiled"`)
		if checkLower(lower) == nil {
			t.Fatal("a spoiled lowercase sweep passed")
		}
		var classes [][]rune
		_ = json.Unmarshal(sweeps["caseClasses"], &classes)
		classes[0] = classes[0][1:]
		if checkCaseClasses(classes) == nil {
			t.Fatal("a spoiled case class passed")
		}
		var entities [][2]string
		_ = json.Unmarshal(sweeps["entities"], &entities)
		entities[0][1] = "spoiled"
		if checkEntities(entities) == nil {
			t.Fatal("a spoiled entity passed")
		}
	})
}

// errUndecodable marks a vector the check could not read, so that a spoil
// which breaks the vector's shape is not mistaken for a caught corruption.
var errUndecodable = errors.New("the vector does not decode")

func decodeAnd[V any](check func(V) error) func([]byte) error {
	return func(raw []byte) error {
		var v V
		if err := json.Unmarshal(raw, &v); err != nil {
			return fmt.Errorf("%w: %v", errUndecodable, err)
		}
		return check(v)
	}
}

func any1(any) bool { return true }

// knownBug reports whether a vector records one of Basalt's wrong answers,
// which TestOracle checks through oracleBugs instead.
func knownBug(v any) bool {
	source, _ := field(v, "source").(string)
	for _, b := range oracleBugs {
		if b.source == source {
			return true
		}
	}
	return false
}

func field(v any, key string) any {
	if m, ok := v.(map[string]any); ok {
		return m[key]
	}
	return nil
}

func wantHas(key string) func(any) bool {
	return func(v any) bool { return field(field(v, "want"), key) != nil }
}

func set(key string, value any) func(any) {
	return func(v any) { v.(map[string]any)[key] = value }
}

func setIn(outer, key string, value any) func(any) {
	return func(v any) { v.(map[string]any)[outer].(map[string]any)[key] = value }
}

func listIn(v any, keys ...string) []any {
	for _, k := range keys {
		v = field(v, k)
	}
	l, _ := v.([]any)
	return l
}

func first(l []any) map[string]any { return l[0].(map[string]any) }

// hasHidden finds a note with a hidden range that covers a character that is
// not whitespace, so that removing it must be noticed.
func hasHidden(v any) bool {
	for _, h := range field(v, "hidden").([]any) {
		if r, _ := h.([]any)[2].([]any); len(r) > 0 {
			s, _ := field(v, "source").(string)
			a := int(r[0].([]any)[0].(float64))
			return a < len(s) && strings.TrimSpace(s[a:a+1]) != ""
		}
	}
	return false
}

func spoilHidden(v any) {
	for _, h := range field(v, "hidden").([]any) {
		if r, _ := h.([]any)[2].([]any); len(r) > 0 {
			h.([]any)[2] = []any{}
			return
		}
	}
}

func spoilSearch(v any) {
	pages := field(field(v, "queries").([]any)[0], "pages").([]any)
	for _, p := range pages {
		if m, _ := field(p, "matches").([]any); len(m) > 0 {
			first(m)["column"] = 999
			return
		}
	}
	panic(fmt.Sprintf("no match to spoil in %v", pages))
}

// tagResultHas finds a changeTags vector that writes out its source, one of
// whose results has key: an error, or a list that is not empty; and
// spoilTagResult spoils the first such result.
func tagResultHas(key string) func(any) bool {
	return func(v any) bool { return tagResult(v, key) != nil }
}

func spoilTagResult(key string, spoil func(map[string]any)) func(any) {
	return func(v any) { spoil(tagResult(v, key)) }
}

func tagResult(v any, key string) map[string]any {
	if field(v, "source") == nil {
		return nil
	}
	for _, r := range listIn(v, "results") {
		w, ok := r.([]any)[1].(map[string]any)
		if !ok || w[key] == nil {
			continue
		}
		if l, list := w[key].([]any); !list || len(l) > 0 {
			return w
		}
	}
	return nil
}

func hasChanges(w map[string]any) bool { return len(listIn(w, "changes")) > 0 }

func hasEdits(w map[string]any) bool {
	for _, c := range listIn(w, "changes") {
		if len(listIn(c, "edits")) > 0 {
			return true
		}
	}
	return false
}

func hasKey(key string) func(map[string]any) bool {
	return func(w map[string]any) bool { return w[key] != nil }
}

// planHas finds a plan vault with an operation whose answer pred accepts, and
// spoilPlan spoils the first such answer.
func planHas(pred func(map[string]any) bool) func(any) bool {
	return func(v any) bool { return planWant(v, pred) != nil }
}

func spoilPlan(pred func(map[string]any) bool, spoil func(map[string]any)) func(any) {
	return func(v any) { spoil(planWant(v, pred)) }
}

func planWant(v any, pred func(map[string]any) bool) map[string]any {
	for _, o := range listIn(v, "operations") {
		if w, ok := field(o, "want").(map[string]any); ok && pred(w) {
			return w
		}
	}
	return nil
}

func checkPlans(raw []byte) error {
	var vault planVault
	if err := json.Unmarshal(raw, &vault); err != nil {
		return fmt.Errorf("%w: %v", errUndecodable, err)
	}
	for _, o := range vault.Operations {
		if err := checkPlan(vault, o); err != nil {
			return err
		}
	}
	return nil
}
