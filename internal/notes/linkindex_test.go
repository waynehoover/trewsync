package notes

import (
	"fmt"
	"math/rand"
	"sort"
	"strings"
	"testing"

	"github.com/waynehoover/trew/internal/paths"
)

// The link keys (LinkKeys, TargetKeys) and a View that narrows by them
// (LinkIndex). What matters is one property: a plan made with the narrowing
// is the plan made without it, for every note that could be moved or deleted,
// whenever the scan without it completes. A key that missed a backlink would
// show up here as a plan with one change fewer.

// indexedView is a mapView that narrows as the search index does, by the keys
// LinkKeys gives each note. A note whose text or links could not be read has
// no keys and is always read, as the index records it: a note that is not
// UTF-8 has to be read so that the plan refuses it as the full scan does.
type indexedView struct {
	mapView
	keys map[string]map[string]bool
	// asked counts the notes MayLinkTo was asked about, and ruled those it
	// ruled out, so a test can tell the narrowing did something.
	asked, ruled *int
}

func narrowed(m mapView) indexedView {
	v := indexedView{mapView: m, keys: map[string]map[string]bool{}, asked: new(int), ruled: new(int)}
	for path, version := range m.notes {
		source, err := DecodeNote(version.Bytes)
		if err != nil {
			continue
		}
		keys, err := LinkKeys(source, path)
		if err != nil {
			continue
		}
		set := map[string]bool{}
		for _, k := range keys {
			set[k] = true
		}
		v.keys[path] = set
	}
	return v
}

func (v indexedView) MayLinkTo(path, target string) bool {
	*v.asked++
	keys, ok := v.keys[path]
	if !ok {
		return true
	}
	for _, k := range TargetKeys(target) {
		if keys[k] {
			return true
		}
	}
	*v.ruled++
	return false
}

// samePlans reports how two attempts at one plan differ, or "". A scan the
// narrowing let finish where the full one gave up is not a difference.
func samePlans(full Plan, ferr error, narrow Plan, nerr error) string {
	switch {
	case codeOf(ferr) == "scan_incomplete":
		return ""
	case ferr != nil || nerr != nil:
		if codeOf(ferr) != codeOf(nerr) {
			return fmt.Sprintf("the full scan refused %q and the narrowed one %q", codeOf(ferr), codeOf(nerr))
		}
		if r, ok := ferr.(*Refusal); ok {
			if n, _ := nerr.(*Refusal); n == nil || n.Path != r.Path {
				return fmt.Sprintf("the refusals name %q and %v", r.Path, nerr)
			}
		}
		return ""
	case !SamePlan(full.Changes, narrow.Changes):
		return fmt.Sprintf("the plans differ:\n full %+v\n narrowed %+v", full.Changes, narrow.Changes)
	case full.AmbiguousLinks != narrow.AmbiguousLinks:
		return fmt.Sprintf("ambiguous links %d and %d", full.AmbiguousLinks, narrow.AmbiguousLinks)
	}
	return ""
}

// Every move and every struck-through deletion of the oracle's plan vaults
// comes out the same through the narrowing.
func TestTheLinkKeysNarrowTheOraclePlansWithoutChangingThem(t *testing.T) {
	checked := 0
	for i, vault := range section[planVault](t, "plans") {
		for j, o := range vault.Operations {
			if o.Operation.Kind == "tags" {
				continue
			}
			full := vault.view()
			fp, ferr := o.plan(full)
			nv := narrowed(vault.view())
			np, nerr := o.plan(nv)
			if why := samePlans(fp, ferr, np, nerr); why != "" {
				t.Errorf("plans/%d/%d %s %s: %s", i, j, o.Operation.Kind, o.Operation.Path, why)
			}
			checked++
		}
	}
	if checked < 10 {
		t.Fatalf("only %d move and delete vectors were checked", checked)
	}
}

// A generated vault of notes linking to each other every way the link parser
// reads a link, in folders, with names that fold alike, differ in case, in
// normalisation, in extension, and repeat in several folders so short wiki
// links are ambiguous; then every note of it moved and deleted, with and
// without the narrowing. The seeds are fixed so a failure repeats.
func TestTheLinkKeysNeverOmitABacklink(t *testing.T) {
	folders := []string{"", "a/", "a/b/", "B/", "x y/"}
	names := []string{"note", "Note", "ÉTÉ", "été", "Straße", "STRASSE", "İstanbul", "ΣΊΣΥΦΟΣ", "σίσυφος",
		"x y", "x%y", "two.md", "hash#tag", "ſtar", "Kelvin\u212a"}
	exts := []string{".md", ".txt", ".MD"}
	nfd := func(s string) string {
		return strings.NewReplacer("É", "E\u0301", "é", "e\u0301").Replace(s)
	}
	ruledOut, asked := 0, 0
	for seed := int64(1); seed <= 40; seed++ {
		rng := rand.New(rand.NewSource(seed))
		pick := func(list []string) string { return list[rng.Intn(len(list))] }
		m := mapView{notes: map[string]Version{}}
		taken := map[string]bool{}
		for len(m.files) < 14 {
			p := pick(folders) + pick(names) + pick(exts)
			if taken[paths.Fold(p)] || paths.Check(p) != "" {
				continue
			}
			taken[paths.Fold(p)] = true
			m.files = append(m.files, p)
		}
		m.files = append(m.files, "a/img.png")
		sort.Strings(m.files)
		for i, p := range m.files {
			if !strings.HasSuffix(asciiLowerString(p), ".md") && !strings.HasSuffix(asciiLowerString(p), ".txt") {
				continue
			}
			var b strings.Builder
			b.WriteString("# " + p + "\n\n")
			for k := 0; k < 6; k++ {
				target := pick(m.files)
				stem := trimNoteExtension(target)
				base := posixBasename(target)
				rel := posixRelative(posixDirname(p), target)
				variants := []string{
					"[[" + stem + "]]", "[[" + target + "]]", "[[" + posixBasename(stem) + "]]",
					"[[" + posixBasename(stem) + "#Heading|alias]]", "![[" + base + "]]",
					"[[" + strings.ToUpper(posixBasename(stem)) + "]]", "[[" + nfd(posixBasename(stem)) + "]]",
					"[t](" + percentEncode(rel, "-_.~/") + ")", "[t](<" + rel + ">)", "[t](/" + percentEncode(target, "-_.~/") + ")",
					"[t](" + percentEncode(rel, "-_.~/") + "#frag)", "[t](./" + percentEncode(rel, "-_.~/") + ")",
					"[ref]: " + percentEncode(rel, "-_.~/"), "![i](" + percentEncode(rel, "-_.~/") + ")",
					"[t](" + percentEncode(trimNoteExtension(rel), "-_.~/") + ")", "[t](../" + percentEncode(base, "-_.~") + ")",
					"`[[" + stem + "]]`", "[[missing/" + base + "]]", "[t](https://example.com/" + base + ")",
				}
				b.WriteString(pick(variants))
				b.WriteString(pick([]string{" ", "\n", "\n\n"}))
			}
			m.notes[p] = Version{UID: int64(i + 1), Bytes: []byte(b.String())}
		}
		for _, p := range m.files {
			if _, ok := m.notes[p]; !ok {
				m.notes[p] = Version{UID: 1000, Bytes: []byte("\x89PNG")}
			}
		}
		for _, p := range m.files {
			if !editableFormat(p) {
				continue
			}
			to := "moved/" + posixBasename(p)
			fp, ferr := PlanMove(m, p, to, true)
			nv := narrowed(m)
			np, nerr := PlanMove(nv, p, to, true)
			if why := samePlans(fp, ferr, np, nerr); why != "" {
				t.Fatalf("seed %d, moving %q: %s", seed, p, why)
			}
			ruledOut += *nv.ruled
			asked += *nv.asked
			fp, ferr = PlanDelete(m, p, true)
			nv = narrowed(m)
			np, nerr = PlanDelete(nv, p, true)
			if why := samePlans(fp, ferr, np, nerr); why != "" {
				t.Fatalf("seed %d, deleting %q: %s", seed, p, why)
			}
			ruledOut += *nv.ruled
			asked += *nv.asked
		}
	}
	// Not vacuous: the narrowing ruled most notes out, and still missed
	// nothing the full scan found.
	if asked == 0 || ruledOut*2 < asked {
		t.Fatalf("the narrowing ruled out %d of the %d notes it was asked about", ruledOut, asked)
	}
	t.Logf("the narrowing ruled out %d of the %d notes it was asked about", ruledOut, asked)
}

// A link the resolver resolves to the target always shares a key with it,
// checked note by note against ChangeLinks itself: any note that ChangeLinks
// would edit, count as ambiguous, or refuse for a move of the target has a
// key of the target among its link keys.
func TestEveryNoteChangeLinksWouldTouchHasATargetKey(t *testing.T) {
	inventory := []string{"a/Note.md", "b/note.md", "Straße.md", "c/ÉTÉ.txt", "d/two.md.md", "e/x y.md", "a/b.md"}
	sources := []string{
		"[[Note]] and [[note]] and [[NOTE]]",
		"[[a/Note]] [[../a/Note.md]] [t](../a/Note.md) [t](/a/Note.md)",
		"[[STRASSE]] [[straße.md]] [t](../Stra%C3%9Fe.md)",
		"[[E\u0301TE\u0301]] [[c/été]] [t](../c/%C3%89T%C3%89.txt#x)",
		"[[two.md]] [[two]] [[d/two.md]] [t](../d/two.md.md)",
		"[t](<../e/x y.md>) [[x y]] [[e/x y|alias]]",
		"[t](../a/.%2e/a/Note.md) [t](c/../../a/Note.md)",
		// Names that climb out of their own last segment, whose keys are only
		// right if they are taken from the lookup after it is joined to the
		// owner's folder: from a/b/n.md both of these are a/b.md.
		"[[c/..]]", "[t](c/..)",
	}
	for _, owner := range []string{"n.md", "z/n.md", "a/b/n.md"} {
		for _, source := range sources {
			keys, err := LinkKeys(source, owner)
			if err != nil {
				t.Fatal(err)
			}
			have := map[string]bool{}
			for _, k := range keys {
				have[k] = true
			}
			for _, target := range inventory {
				for _, deletion := range []bool{false, true} {
					change := LinkChange{Path: owner, From: target, To: "moved.md", Delete: deletion,
						Inventory: append([]string{owner}, inventory...), Canonical: paths.Fold}
					edits, ambiguous, err := ChangeLinks(source, change)
					if len(edits) == 0 && ambiguous == 0 && err == nil {
						continue
					}
					shared := false
					for _, k := range TargetKeys(target) {
						shared = shared || have[k]
					}
					if !shared {
						t.Errorf("%q in %s touches links to %s (%d edits, %d ambiguous, %v), and shares no key: %q against %q",
							source, owner, target, len(edits), ambiguous, err, keys, TargetKeys(target))
					}
				}
			}
		}
	}
}
