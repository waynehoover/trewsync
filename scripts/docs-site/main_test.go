package main

import (
	"errors"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// descriptor is a srcset width or density descriptor, such as 2x, which is
// not a URL.
var descriptor = regexp.MustCompile(`^[0-9.]+[wx],?$`)

// The docs as they stand build into a site with no broken link: every
// relative link and image in every published page names a file that exists,
// the screenshots included. A moved screenshot or a renamed page fails here,
// in the gate, rather than as a broken image on GitHub.
func TestTheDocsBuildWithNoBrokenLink(t *testing.T) {
	out := t.TempDir()
	s, err := build("../..", out, "main")
	var broken brokenLinks
	if errors.As(err, &broken) {
		t.Fatal(broken.Error())
	}
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"index.html", "docs/index.html", "docs/agent.html", "docs/client.html", "style.css"} {
		if _, err := os.Stat(filepath.Join(out, want)); err != nil {
			t.Errorf("the site has no %s: %v", want, err)
		}
	}
	if len(s.pages) < 10 {
		t.Errorf("published %d pages, which is not the docs", len(s.pages))
	}

	// And the built site agrees: every relative URL in every page resolves to
	// a file the site holds. This is what catches a rewrite that is wrong
	// even though the Markdown was right.
	err = filepath.WalkDir(out, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".html") {
			return err
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(out, p)
		for _, m := range attrURL.FindAllStringSubmatch(string(b), -1) {
			for _, u := range strings.Fields(m[2]) {
				if u == "" || strings.HasPrefix(u, "#") || scheme.MatchString(u) || descriptor.MatchString(u) {
					continue
				}
				target := u
				if i := strings.IndexAny(target, "?#"); i >= 0 {
					target = target[:i]
				}
				resolved := path.Join(path.Dir(filepath.ToSlash(rel)), target)
				if _, err := os.Stat(filepath.Join(out, filepath.FromSlash(resolved))); err != nil {
					t.Errorf("%s links to %s, which the site does not hold", rel, u)
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// A link is rewritten by what it points at: a published page to its .html, a
// copied asset as it is, anything else in the repository to GitHub, and a
// file that does not exist is reported.
func TestLinksAreRewrittenByWhatTheyPointAt(t *testing.T) {
	l := linker{root: "../..", ref: "v1", page: "docs/agent.md",
		published: map[string]bool{"README.md": true, "docs/plugin.md": true, "docs/agent.md": true}}
	cases := map[string]string{
		"plugin.md#version-history":      "plugin.html#version-history",
		"../README.md#privacy":           "../index.html#privacy",
		"assets/screenshots/panel.png":   "assets/screenshots/panel.png",
		"../compose.yaml":                repoURL + "/blob/v1/compose.yaml",
		"../plan/":                       repoURL + "/tree/v1/plan",
		"https://tailscale.com":          "https://tailscale.com",
		"#limits":                        "#limits",
		"../internal/mcp/envelope.go#L1": repoURL + "/blob/v1/internal/mcp/envelope.go#L1",
	}
	for in, want := range cases {
		if got := l.url(in); got != want {
			t.Errorf("%s: got %s, want %s", in, got, want)
		}
	}
	if len(l.broken) != 0 {
		t.Fatalf("reported broken: %v", l.broken)
	}
	l.url("no-such-page.md")
	l.url("../../outside.md")
	if len(l.broken) != 2 {
		t.Fatalf("a missing file and a link out of the repository are both broken, got %v", l.broken)
	}
}
