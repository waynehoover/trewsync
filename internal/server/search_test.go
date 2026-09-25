package server

import (
	"io"
	"log/slog"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/waynehoover/trew/internal/search"
	"github.com/waynehoover/trew/internal/wire"
)

// searchOf asks for one page of a search on this connection.
func (c *client) searchOf(in wire.In) wire.Searched {
	c.t.Helper()
	in.Op = "search"
	c.sendJSON(in)
	var s wire.Searched
	c.recvInto("searched", &s)
	return s
}

// searchAll follows nextAfter to the end and returns every page.
func (c *client) searchAll(in wire.In) []wire.Searched {
	c.t.Helper()
	var pages []wire.Searched
	for range 1000 {
		p := c.searchOf(in)
		pages = append(pages, p)
		if p.NextAfter == nil {
			return pages
		}
		if p.Complete {
			c.t.Fatalf("%s: a page with a continuation says it is complete", c.name)
		}
		in.After = *p.NextAfter
	}
	c.t.Fatalf("%s: the search never ended", c.name)
	return nil
}

// A paired device searches the vault it authenticated to: the literal is
// found in the notes that hold it, case-insensitively by default, with the
// version each match is in, its line and column, and the line it is on; the
// reply says the page is complete, and that no index narrowed it on a server
// that keeps none.
func TestADeviceSearchesItsVault(t *testing.T) {
	r := newRig(t)
	a := r.seed("Notes/a.md", "first line\nthe Harbour at dawn\n")
	r.seed("Notes/b.md", "nothing to see\n")
	c := r.seed("c.md", "harbour, harbour\n")
	r.seed("picture.png", "harbour in the bytes of an attachment")
	laptop := r.dial("laptop")
	laptop.hello(0)

	got := laptop.searchOf(wire.In{Query: "harbour"})
	if !got.Complete || got.NextAfter != nil || len(got.Skipped) != 0 {
		t.Fatalf("a small vault's search is not one complete page: %+v", got)
	}
	want := []wire.SearchMatch{
		{Path: "Notes/a.md", UID: a.UID, Line: 2, Column: 5, Text: "the Harbour at dawn", Before: []string{}, After: []string{}},
		{Path: "c.md", UID: c.UID, Line: 1, Column: 1, Text: "harbour, harbour", Before: []string{}, After: []string{}},
		{Path: "c.md", UID: c.UID, Line: 1, Column: 10, Text: "harbour, harbour", Before: []string{}, After: []string{}},
	}
	if len(got.Matches) != len(want) {
		t.Fatalf("matches %+v", got.Matches)
	}
	for i := range want {
		g, w := got.Matches[i], want[i]
		if g.Path != w.Path || g.UID != w.UID || g.Line != w.Line || g.Column != w.Column || g.Text != w.Text ||
			len(g.Before) != 0 || len(g.After) != 0 || g.Clipped || g.Kind != "" {
			t.Errorf("match %d: got %+v, want %+v", i, g, w)
		}
	}
	latest, _ := r.st.LatestUID(testVault)
	if got.Head != latest || got.Index.Usable || got.Index.Why == "" || got.Scanned == 0 {
		t.Fatalf("what the page says about itself: %+v", got)
	}

	// Case, context, folder and the other modes are the query's.
	if exact := laptop.searchOf(wire.In{Query: "Harbour", CaseSensitive: true}); len(exact.Matches) != 1 {
		t.Fatalf("a case-sensitive search: %+v", exact.Matches)
	}
	ctx := laptop.searchOf(wire.In{Query: "dawn", ContextLines: 1})
	if len(ctx.Matches) != 1 || strings.Join(ctx.Matches[0].Before, "|") != "first line" ||
		strings.Join(ctx.Matches[0].After, "|") != "" {
		t.Fatalf("context: %+v", ctx.Matches)
	}
	if in := laptop.searchOf(wire.In{Query: "harbour", Folder: "Notes"}); len(in.Matches) != 1 || in.Matches[0].Path != "Notes/a.md" {
		t.Fatalf("a folder's search: %+v", in.Matches)
	}
	names := laptop.searchOf(wire.In{Query: "b.md", Mode: "filename"})
	if len(names.Matches) != 1 || names.Matches[0].Kind != "filename" || names.Matches[0].Line != 0 ||
		names.Matches[0].Text != "Notes/b.md" {
		t.Fatalf("a file-name search: %+v", names.Matches)
	}
}

// Tags are matched as tags, nested ones included unless the device says
// otherwise.
func TestADeviceSearchesForATag(t *testing.T) {
	r := newRig(t)
	r.seed("a.md", "a #project note\n")
	r.seed("b.md", "a #project/child note\n")
	laptop := r.dial("laptop")
	laptop.hello(0)
	if all := laptop.searchOf(wire.In{Query: "project", Mode: "tag"}); len(all.Matches) != 2 || all.Matches[0].Kind != "tag" {
		t.Fatalf("a tag and its children: %+v", all.Matches)
	}
	no := false
	if own := laptop.searchOf(wire.In{Query: "project", Mode: "tag", IncludeChildren: &no}); len(own.Matches) != 1 ||
		own.Matches[0].Path != "a.md" {
		t.Fatalf("a tag without its children: %+v", own.Matches)
	}
}

// Pages: a limit bounds the matches on one, nextAfter continues from where
// it stopped, every match is returned exactly once across the pages, and
// only the last says complete. Every page is read at the head the first one
// saw, so a note written between pages changes nothing a continuation
// returns.
func TestADevicesSearchPagesWithACursor(t *testing.T) {
	r := newRig(t)
	r.seed("a.md", "hit\nhit\n")
	r.seed("b.md", "hit\n")
	r.seed("c.md", "hit hit\n")
	laptop := r.dial("laptop")
	laptop.hello(0)

	first := laptop.searchOf(wire.In{Query: "hit", Limit: 2})
	if len(first.Matches) != 2 || first.NextAfter == nil || first.Complete {
		t.Fatalf("the first page: %+v", first)
	}
	r.seed("d.md", "hit written after the first page\n")
	pages := []wire.Searched{first}
	in := wire.In{Query: "hit", Limit: 2, After: *first.NextAfter}
	pages = append(pages, laptop.searchAll(in)...)
	var seen []string
	for _, p := range pages {
		if p.Head != first.Head {
			t.Fatalf("a continuation read at %d, the first page at %d", p.Head, first.Head)
		}
		for _, m := range p.Matches {
			seen = append(seen, m.Path+":"+strconv.Itoa(m.Line)+":"+strconv.Itoa(m.Column))
		}
	}
	if got := strings.Join(seen, " "); got != "a.md:1:1 a.md:2:1 b.md:1:1 c.md:1:1 c.md:1:5" {
		t.Fatalf("the pages between them: %s", got)
	}
	if last := pages[len(pages)-1]; !last.Complete {
		t.Fatalf("the last page is not complete: %+v", last)
	}
}

// A page's rows are bounded as MCP's are, at 64 KiB, whatever the limit: a
// note of long matching lines fills a page long before 200 matches, and the
// cursor carries the rest.
func TestADevicesSearchPageIsBoundedInBytes(t *testing.T) {
	r := newRig(t)
	line := "match " + strings.Repeat("x", 900)
	r.seed("long.md", strings.Repeat(line+"\n", 200))
	laptop := r.dial("laptop")
	laptop.hello(0)
	p := laptop.searchOf(wire.In{Query: "match", Limit: 200})
	if len(p.Matches) == 0 || len(p.Matches) >= 200 || p.NextAfter == nil || p.Complete {
		t.Fatalf("a page of %d long matches, next %v", len(p.Matches), p.NextAfter)
	}
	size := 0
	for _, m := range p.Matches {
		size += len(m.Path) + len(m.Text) + 60
	}
	if size > 80<<10 {
		t.Fatalf("a page's rows are about %d bytes", size)
	}
	total := 0
	for _, page := range laptop.searchAll(wire.In{Query: "match", Limit: 200}) {
		total += len(page.Matches)
	}
	if total != 200 {
		t.Fatalf("%d matches across the pages, the note holds 200", total)
	}
}

// Every refusal a query can meet is a refusal of that request, with the
// reason before the colon, and the session goes on: an empty query, a limit
// or context out of range, a mode or tag that is not one, a folder the path
// rules refuse, and a cursor that is not this search's.
func TestADevicesBadSearchIsRefusedAndTheSessionContinues(t *testing.T) {
	r := newRig(t)
	r.seed("a.md", "text\n")
	laptop := r.dial("laptop")
	laptop.hello(0)
	cases := []struct {
		in     wire.In
		code   string
		reason string
	}{
		{wire.In{Query: ""}, wire.CodeBadEntry, "invalid_query"},
		{wire.In{Query: "a", Limit: 201}, wire.CodeBadEntry, "invalid_limit"},
		{wire.In{Query: "a", Limit: -1}, wire.CodeBadEntry, "invalid_limit"},
		{wire.In{Query: "a", ContextLines: 4}, wire.CodeBadEntry, "invalid_limit"},
		{wire.In{Query: "a", Mode: "regex"}, wire.CodeBadEntry, "invalid_query"},
		{wire.In{Query: "not a tag!", Mode: "tag"}, wire.CodeBadEntry, "invalid_tag"},
		{wire.In{Query: strings.Repeat("a", 1025)}, wire.CodeBadEntry, "input_too_large"},
		{wire.In{Query: "a", Folder: ".hidden"}, wire.CodeBadPath, "dotprefix"},
		{wire.In{Query: "a", After: "not-a-cursor"}, wire.CodeStale, "expired"},
	}
	for _, tc := range cases {
		tc.in.Op = "search"
		laptop.sendJSON(tc.in)
		msg := laptop.expectErr(tc.code)
		if !strings.HasPrefix(msg, tc.reason+": ") {
			t.Errorf("%+v: refused %q, want the reason %s first", tc.in, msg, tc.reason)
		}
	}
	// A cursor from another query is not this one's either.
	first := laptop.searchOf(wire.In{Query: "t", Limit: 1})
	if first.NextAfter == nil {
		t.Fatal("no continuation to misuse")
	}
	laptop.sendJSON(wire.In{Op: "search", Query: "e", Limit: 1, After: *first.NextAfter})
	laptop.expectErr(wire.CodeStale)
	laptop.sendJSON(wire.In{Op: "ping"})
	laptop.recvInto("pong", nil)
}

// Search is protocol 2's: a session of protocol 1 is told it is an unknown
// op, and keeps its session.
func TestSearchIsUnknownAtProtocolOne(t *testing.T) {
	r := newRig(t)
	r.seed("a.md", "text\n")
	old := r.dial("old-plugin")
	hello := old.deviceHello(0)
	hello.Proto = 1
	old.sendJSON(hello)
	old.recvInto("ready", nil)
	old.nextBatch()
	old.recvInto("caught-up", nil)
	old.sendJSON(wire.In{Op: "search", Query: "text"})
	if msg := old.expectErr(wire.CodeProtoState); !strings.Contains(msg, `unknown op "search"`) {
		t.Fatalf("search at protocol 1: %q", msg)
	}
	old.sendJSON(wire.In{Op: "ping"})
	old.recvInto("pong", nil)
}

// A device revoked while its session is still open is refused before
// anything is read, and the session ends: the same recheck of the credential
// every mutation makes.
func TestARevokedDeviceCannotSearch(t *testing.T) {
	r := newRig(t)
	r.seed("secret.md", "the secret\n")
	laptop := r.dial("laptop")
	laptop.hello(0)
	id, _ := r.device("laptop")
	// Straight through the store, so the session is not evicted first: the
	// moment between a revoke and its eviction.
	if _, err := r.st.RevokeDevice(testVault, id, 2); err != nil {
		t.Fatal(err)
	}
	laptop.sendJSON(wire.In{Op: "search", Query: "secret"})
	laptop.expectErr(wire.CodeAuth)
	if !laptop.closed() {
		t.Fatal("a revoked device's session stayed open after its search was refused")
	}
}

// And a device revoked through the protocol is evicted, and cannot connect
// again to search.
func TestARevokedDevicesSearchesEndWithIt(t *testing.T) {
	r := newRig(t)
	r.seed("secret.md", "the secret\n")
	laptop, phone := r.dial("laptop"), r.dial("phone")
	laptop.hello(0)
	phone.hello(0)
	if got := phone.searchOf(wire.In{Query: "secret"}); len(got.Matches) != 1 {
		t.Fatalf("before the revoke: %+v", got)
	}
	phoneID, _ := r.device("phone")
	laptop.sendJSON(wire.In{Op: "revoke", DeviceID: phoneID})
	laptop.recvInto("revoked", nil)
	phone.expectErr(wire.CodeAuth)
	again := r.dial("phone")
	again.sendJSON(again.deviceHello(0))
	again.expectErr(wire.CodeAuth)
}

// The budget: past a device's burst its searches are refused toomany, with a
// wait and retryable, and the session goes on, syncing as before. Another
// device's budget is its own.
func TestADevicesSearchesHaveABudgetThatSparesSync(t *testing.T) {
	r := newRig(t)
	r.srv.SetSearchLimits(SearchLimits{Burst: 2, Rate: 0.001})
	r.seed("a.md", "text\n")
	laptop, phone := r.dial("laptop"), r.dial("phone")
	laptop.hello(0)
	phone.hello(0)
	laptop.searchOf(wire.In{Query: "text"})
	laptop.searchOf(wire.In{Query: "text"})
	laptop.sendJSON(wire.In{Op: "search", Query: "text"})
	m := laptop.recv()
	if m["res"] != "err" || m["code"] != wire.CodeTooMany || m["retryable"] != true {
		t.Fatalf("the third search: %v", m)
	}
	if after, _ := m["retryAfterMs"].(float64); after <= 0 {
		t.Fatalf("a toomany with no wait: %v", m)
	}
	if msg, _ := m["msg"].(string); !strings.HasPrefix(msg, "toomany: ") {
		t.Fatalf("the refusal's message: %q", msg)
	}
	// Sync is untouched: the same session still writes.
	if uid := laptop.put("b.md", "written after the refusal"); uid == 0 {
		t.Fatal("the put after a refused search was not acknowledged")
	}
	if got := phone.searchOf(wire.In{Query: "text"}); len(got.Matches) != 1 {
		t.Fatalf("another device's search: %+v", got)
	}
}

// The server's and a device's searches at once are bounded too, and a slot
// is given back when its search ends.
func TestSearchBudgetsBoundSearchesAtOnce(t *testing.T) {
	now := time.Unix(1000, 0)
	b := newSearchBudgets(SearchLimits{InFlight: 2, DeviceInFlight: 1})
	first, _, why := b.admit("v\x00laptop", now)
	if first == nil {
		t.Fatalf("the first search: %s", why)
	}
	if again, wait, why := b.admit("v\x00laptop", now); again != nil || wait <= 0 || why == "" {
		t.Fatal("a device ran two searches at once")
	}
	second, _, _ := b.admit("v\x00phone", now)
	if second == nil {
		t.Fatal("another device was refused")
	}
	if third, _, why := b.admit("v\x00tablet", now); third != nil || !strings.Contains(why, "server") {
		t.Fatal("the server ran more searches at once than it runs")
	}
	first()
	first() // twice is once
	if next, _, why := b.admit("v\x00laptop", now); next == nil {
		t.Fatalf("a slot was not given back: %s", why)
	}
	// Reply bytes: a device in debt waits.
	b = newSearchBudgets(SearchLimits{BytesBurst: 100, BytesRate: 10})
	rel, _, _ := b.admit("k", now)
	rel()
	b.sent("k", 1000, now)
	if rel, wait, _ := b.admit("k", now); rel != nil || wait < 50*time.Second {
		t.Fatalf("a device over its byte budget was admitted, or told to wait %s", wait)
	}
	b.forget("k")
	if rel, _, _ := b.admit("k", now); rel == nil {
		t.Fatal("a forgotten device's debt outlived it")
	}
}

// With the index, a device's search is narrowed by it and says so, with how
// far it has indexed, and finds exactly what a scan finds.
func TestADevicesSearchUsesTheIndex(t *testing.T) {
	r := newRig(t)
	for i := range 20 {
		body := "ordinary text\n"
		if i%5 == 0 {
			body = "the lighthouse keeper\n"
		}
		r.seed("n"+strconv.Itoa(i)+".md", body)
	}
	idx, err := search.Open(r.dir, r.st, testVault, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	idx.Start()
	t.Cleanup(func() { idx.Close() })
	latest, _ := r.st.LatestUID(testVault)
	deadline := time.Now().Add(30 * time.Second)
	for s := idx.Status(); !(s.Usable && !s.Rebuilding && s.IndexedHead == latest); s = idx.Status() {
		if time.Now().After(deadline) {
			t.Fatalf("the index did not reach %d: %+v", latest, s)
		}
		time.Sleep(5 * time.Millisecond)
	}
	laptop := r.dial("laptop")
	laptop.hello(0)
	scanned := laptop.searchOf(wire.In{Query: "lighthouse"})
	r.srv.SetSearchIndex(testVault, idx)
	indexed := laptop.searchOf(wire.In{Query: "lighthouse"})
	if !indexed.Index.Usable || indexed.IndexedHead != latest || !indexed.Complete {
		t.Fatalf("with the index: %+v", indexed)
	}
	if indexed.Scanned >= scanned.Scanned || len(indexed.Matches) != 4 || len(scanned.Matches) != 4 {
		t.Fatalf("the index read %d notes for %d matches, the scan %d for %d",
			indexed.Scanned, len(indexed.Matches), scanned.Scanned, len(scanned.Matches))
	}
	// Another vault's index is not this vault's.
	r.srv.SetSearchIndex("another vault", idx)
	if other := laptop.searchOf(wire.In{Query: "lighthouse"}); other.Index.Usable {
		t.Fatal("a search used the index of another vault")
	}
}
