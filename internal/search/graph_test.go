package search

import (
	"context"
	"strings"
	"testing"

	"github.com/waynehoover/trewsync/internal/notes"
	"github.com/waynehoover/trewsync/internal/store"
)

// The whole link graph, for the vault-health tools: it speaks only for the
// versions it indexed at exactly the head asked about, and then says which
// notes have links at all and which may link to a target, never ruling out a
// note that does.
func TestTheLinkGraphSpeaksOnlyForTheHeadItIndexed(t *testing.T) {
	r := newRig(t)
	r.write("target.md", "# Target\n")
	r.write("links.md", "see [[target]] and [x](other.md)\n")
	r.write("plain.md", "no links here\n")
	r.write("bad.md", "---\nnever: closed\n[[target]]\n")
	r.caughtUp()
	head, _ := r.st.LatestUID(vault)
	g, err := r.x.LinkGraph(context.Background(), head)
	if err != nil || !g.Current {
		t.Fatalf("a caught-up index: %+v %v", g, err)
	}
	uids := map[string]int64{}
	if err := r.st.EachAsOf(vault, 0, store.AsOfRange{}, func(e store.Entry) (bool, error) {
		uids[e.Path] = e.UID
		return true, nil
	}); err != nil {
		t.Fatal(err)
	}
	keys := notes.TargetKeys("target.md")
	switch {
	case !g.Proven("links.md", uids["links.md"]) || !g.HasLinks("links.md", uids["links.md"]):
		t.Fatal("links.md")
	case !g.MayLinkTo("links.md", uids["links.md"], keys):
		t.Fatal("links.md was ruled out of linking to its target")
	case g.HasLinks("plain.md", uids["plain.md"]) || g.MayLinkTo("plain.md", uids["plain.md"], keys):
		t.Fatal("plain.md was not ruled out")
	case g.Proven("bad.md", uids["bad.md"]) || !g.MayLinkTo("bad.md", uids["bad.md"], keys):
		t.Fatal("a note whose links could not be read was ruled out")
	case g.Proven("links.md", uids["links.md"]-1):
		t.Fatal("the graph spoke for another version")
	case !g.Sharing(keys)["links.md"] || g.Sharing(keys)["plain.md"]:
		t.Fatalf("sharing: %v", g.Sharing(keys))
	}
	behind, err := r.x.LinkGraph(context.Background(), head+1)
	if err != nil || behind.Current || !strings.Contains(behind.Why, "indexed through") ||
		behind.Proven("links.md", uids["links.md"]) || !behind.HasLinks("plain.md", uids["plain.md"]) {
		t.Fatalf("an index behind the head narrowed: %+v %v", behind, err)
	}
}
