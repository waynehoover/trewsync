package search

import (
	"context"
	"testing"

	"github.com/waynehoover/trewsync/internal/notes"
	"github.com/waynehoover/trewsync/internal/store"
)

// The whole link graph, for the vault-health tools: it speaks only for the
// versions it indexed, whatever head a page reads (T51), and then says which
// notes have links at all and which may link to a target, never ruling out a
// note that does.
func TestTheLinkGraphSpeaksOnlyForTheVersionsItIndexed(t *testing.T) {
	r := newRig(t)
	r.write("target.md", "# Target\n")
	r.write("links.md", "see [[target]] and [x](other.md)\n")
	r.write("plain.md", "no links here\n")
	r.write("bad.md", "---\nnever: closed\n[[target]]\n")
	r.caughtUp()
	g, err := r.x.LinkGraph(context.Background())
	if err != nil || !g.Usable {
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
	// The worker is held while plain.md gains a link and links.md loses its
	// own: the graph read now answers for the versions it holds, which a
	// page pinned before the writes reads, and for neither new one.
	release := make(chan struct{})
	defer close(release)
	r.x.mu.Lock()
	r.x.beforeBatch = func(string) error {
		<-release
		return nil
	}
	r.x.mu.Unlock()
	plain := r.write("plain.md", "now [[target]]\n")
	links := r.write("links.md", "no links any more\n")
	later, err := r.x.LinkGraph(context.Background())
	switch {
	case err != nil || !later.Usable:
		t.Fatalf("an index behind the head did not answer: %+v %v", later, err)
	case later.Proven("plain.md", plain) || !later.HasLinks("plain.md", plain) || !later.MayLinkTo("plain.md", plain, keys):
		t.Fatal("plain.md's new version, which the index has not read, was spoken for")
	case later.Proven("links.md", links) || !later.MayLinkTo("links.md", links, keys):
		t.Fatal("links.md's new version, which the index has not read, was spoken for")
	case !later.Proven("links.md", uids["links.md"]) || later.HasLinks("plain.md", uids["plain.md"]):
		t.Fatal("the versions the index holds are no longer spoken for")
	}
}
