package notes

import (
	"strings"
	"testing"
)

// The cases of client/src/cli/mcp-links.test.ts, through ChangeLinks and
// ApplySourceEdits.

// moved is the TypeScript suite's helper: Old.md, linked from Index.md, moved
// to Folder/New.md, unless the case says otherwise.
func moved(t *testing.T, source string, edit func(*LinkChange)) (string, int) {
	t.Helper()
	change := LinkChange{
		Path: "Index.md", From: "Old.md", To: "Folder/New.md",
		Inventory: []string{"Index.md", "Old.md"}, Canonical: testCanonical,
	}
	if edit != nil {
		edit(&change)
	}
	edits, ambiguous, err := ChangeLinks(source, change)
	if err != nil {
		t.Fatalf("%q: %v", source, err)
	}
	out, err := ApplySourceEdits(source, edits)
	if err != nil {
		t.Fatalf("%q: %v", source, err)
	}
	return out, ambiguous
}

func TestPortedLinksChangeOnlyDestinations(t *testing.T) {
	// "changes only destination spans, leaving labels, titles, aliases and
	// anchors exact"
	source := "\ufeff[Old.md](Old.md \"Old.md\")\r\n![[Old#Section|Old]] [[Old.md#^block]]\r\nUNSENT body\r\n"
	want := "\ufeff[Old.md](Folder/New.md \"Old.md\")\r\n![[Folder/New#Section|Old]] [[Folder/New.md#^block]]\r\nUNSENT body\r\n"
	if got, _ := moved(t, source, nil); got != want {
		t.Errorf("got %q", got)
	}
}

func TestPortedLinksLeaveCodeCommentsAndFrontmatter(t *testing.T) {
	// "keeps code, comments, frontmatter and escaped wikilinks byte exact"
	source := "---\nproperty: \"[[Old]]\"\n---\n`[[Old]]`\n```md\n[Old](Old.md)\n```\n<!-- [[Old]] -->\n%% [[Old]] %%\n\\[[Old]] [[Old]]"
	if got, _ := moved(t, source, nil); got != source[:len(source)-7]+"[[Folder/New]]" {
		t.Errorf("got %q", got)
	}
}

func TestPortedLinksResolveEscapedDestinations(t *testing.T) {
	// "resolves escaped and encoded Markdown destinations without changing
	// syntax"
	for _, c := range []struct{ from, raw string }{
		{"Old(Note).md", `Old\(Note\).md`},
		{"Old Note.md", "Old&#32;Note.md"},
		{"Old Note.md", "<Old Note.md>"},
		{"Old Note.md", "Old%20Note.md"},
	} {
		got, _ := moved(t, "[label [nested]]("+c.raw+" 'title')", func(l *LinkChange) {
			l.From, l.Inventory = c.from, []string{c.from}
		})
		dest := "Folder/New.md"
		if strings.HasPrefix(c.raw, "<") {
			dest = "<Folder/New.md>"
		}
		if want := "[label [nested]](" + dest + " 'title')"; got != want {
			t.Errorf("%s: got %q, want %q", c.raw, got, want)
		}
	}
}

func TestPortedLinksUpdateDefinitions(t *testing.T) {
	// "updates reference definitions and images, preserving reference names
	// and titles"
	got, _ := moved(t, "[Old][old]\n![Old][old]\n\n[old]: Old.md \"Old.md\"\n", nil)
	if want := "[Old][old]\n![Old][old]\n\n[old]: Folder/New.md \"Old.md\"\n"; got != want {
		t.Errorf("got %q", got)
	}
}

func TestPortedLinksReportAmbiguity(t *testing.T) {
	// "reports ambiguous short links instead of choosing a note"
	got, ambiguous := moved(t, "[[Old]] [[One/Old]]", func(l *LinkChange) {
		l.From, l.Inventory = "One/Old.md", []string{"One/Old.md", "Two/Old.md"}
	})
	if got != "[[Old]] [[Folder/New]]" || ambiguous != 1 {
		t.Errorf("got %q with %d ambiguous", got, ambiguous)
	}
}

func TestPortedLinksRetargetFromTheMovedNote(t *testing.T) {
	// "retargets outgoing relative notes and attachments from the moved
	// location"
	got, _ := moved(t, "[B](B.md#Heading) ![](images/x.png) [[B]]", func(l *LinkChange) {
		l.Path, l.From, l.To = "Project/A.md", "Project/A.md", "Archive/A.md"
		l.Inventory = []string{"Project/A.md", "Project/B.md", "Project/images/x.png"}
	})
	if want := "[B](../Project/B.md#Heading) ![](../Project/images/x.png) [[Project/B]]"; got != want {
		t.Errorf("got %q", got)
	}
}

func TestPortedLinksEncodeNewDestinations(t *testing.T) {
	// "encodes syntax characters in new destinations and preserves
	// fragment-only self links"
	got, _ := moved(t, "[note](Old.md#Heading) [[Old]] [self](#Section)", func(l *LinkChange) { l.To = "New (copy)#name.md" })
	if want := "[note](New%20%28copy%29%23name.md#Heading) [[New (copy)%23name]] [self](#Section)"; got != want {
		t.Errorf("got %q", got)
	}
}

func TestPortedLinksMarkADeletedTarget(t *testing.T) {
	// "can mark a deleted backlink broken using exact destination edits"
	got, _ := moved(t, "[[Old|label]] [text](Old.md)", func(l *LinkChange) { l.To, l.Delete = "", true })
	if want := "~~[[Old|label]]~~ ~~[text](Old.md)~~"; got != want {
		t.Errorf("got %q", got)
	}
}

func TestPortedLinksWithCodeOrImageLabels(t *testing.T) {
	// "retains link syntax when a label contains code or an image"
	for _, source := range []string{"[see `Old`](Old.md)", "[a `[`](Old.md)", "[![Old](Old.md)](Other.md)"} {
		if got, _ := moved(t, source, nil); got != strings.Replace(source, "(Old.md)", "(Folder/New.md)", 1) {
			t.Errorf("%q: got %q", source, got)
		}
	}
}

func TestPortedLinksKeepTheRawFragment(t *testing.T) {
	// "preserves the raw fragment after character references"
	for _, url := range []string{"Old&#32;Note.md#A&#32;B", "Old&#32;Note.md&#35;A&#32;B"} {
		got, _ := moved(t, "[x]("+url+")", func(l *LinkChange) { l.From, l.Inventory = "Old Note.md", []string{"Old Note.md"} })
		hash := "#"
		if strings.Contains(url, "&#35;") {
			hash = "&#35;"
		}
		if want := "[x](Folder/New.md" + hash + "A&#32;B)"; got != want {
			t.Errorf("%s: got %q, want %q", url, got, want)
		}
	}
}

func TestPortedLinksKeepAnExtensionThatDisambiguates(t *testing.T) {
	// "keeps the destination extension when dropping it would identify two
	// notes"
	got, _ := moved(t, "[[Old]] [old](Old)", func(l *LinkChange) { l.To, l.Inventory = "New.txt", []string{"Old.md", "New.md"} })
	if want := "[[New.txt]] [old](New.txt)"; got != want {
		t.Errorf("got %q", got)
	}
}

func TestPortedLinksKeepMissingRelativeTargets(t *testing.T) {
	// "keeps missing relative Markdown targets pointing at their original
	// locations"
	got, _ := moved(t, "[planned](Future.md) ![](images/future.png)", func(l *LinkChange) {
		l.Path, l.From, l.To, l.Inventory = "Project/A.md", "Project/A.md", "Archive/A.md", []string{"Project/A.md"}
	})
	if want := "[planned](../Project/Future.md) ![](../Project/images/future.png)"; got != want {
		t.Errorf("got %q", got)
	}
}
