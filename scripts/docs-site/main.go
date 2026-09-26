// Command docs-site builds TrewSync's documentation into a small static site.
//
// The docs are Markdown in the repository, beside the code they describe, so
// they version with it; this renders them to HTML from the same checkout
// (PLAN.md M9, "A docs site, in-repo"). It uses goldmark, which the server
// already depends on, so the site adds no dependency.
//
//	go run ./scripts/docs-site -out DIR [-ref main]
//
// README.md becomes the front page. CHANGELOG.md, CONTRIBUTING.md,
// SECURITY.md, llm.md and every page under docs/ keep their paths with .html
// for .md, and docs/assets is copied beside them. A link to a published page
// is rewritten to its .html; a link to anything else in the repository goes
// to that file on GitHub at -ref; a relative link to a file that does not
// exist is an error, and the build fails naming each one.
package main

import (
	"bytes"
	"errors"
	"flag"
	"fmt"
	"html"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
	gmhtml "github.com/yuin/goldmark/renderer/html"
	"github.com/yuin/goldmark/text"
)

// repoURL is where a link to an unpublished file goes.
const repoURL = "https://github.com/waynehoover/trewsync"

// topPages are the Markdown files at the repository root that the site
// publishes. Everything under docs/ is published too.
var topPages = []string{"README.md", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md", "llm.md"}

// assetDirs are copied into the site as they are.
var assetDirs = []string{"docs/assets"}

func main() {
	out := flag.String("out", "", "directory to write the site into (required)")
	ref := flag.String("ref", "main", "the git ref links to unpublished files point at on GitHub")
	root := flag.String("root", ".", "the repository root")
	flag.Parse()
	if *out == "" {
		fmt.Fprintln(os.Stderr, "docs-site: -out is required")
		os.Exit(2)
	}
	site, err := build(*root, *out, *ref)
	if err != nil {
		fmt.Fprintln(os.Stderr, "docs-site:", err)
		os.Exit(1)
	}
	fmt.Printf("wrote %d pages to %s\n", len(site.pages), *out)
}

// site is what a build published.
type site struct {
	pages []string // source paths, slash-separated, relative to the root
}

// brokenLinks is every relative link that names a file which does not exist.
type brokenLinks []string

func (b brokenLinks) Error() string {
	return fmt.Sprintf("%d broken links:\n  %s", len(b), strings.Join(b, "\n  "))
}

// build renders every page under root into out.
func build(root, out, ref string) (*site, error) {
	pages, err := listPages(root)
	if err != nil {
		return nil, err
	}
	published := map[string]bool{}
	for _, p := range pages {
		published[p] = true
	}
	md := goldmark.New(
		goldmark.WithExtensions(extension.GFM),
		goldmark.WithParserOptions(parser.WithAutoHeadingID()),
		goldmark.WithRendererOptions(gmhtml.WithUnsafe()),
	)
	var broken brokenLinks
	for _, p := range pages {
		src, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(p)))
		if err != nil {
			return nil, err
		}
		var body bytes.Buffer
		if err := md.Convert(src, &body); err != nil {
			return nil, fmt.Errorf("%s: %w", p, err)
		}
		l := linker{root: root, ref: ref, page: p, published: published}
		rendered := l.rewrite(body.String())
		broken = append(broken, l.broken...)
		doc := page(title(md, src, p), relTo(outPath(p), "style.css"), relTo(outPath(p), "index.html"),
			relTo(outPath(p), "docs/index.html"), rendered)
		dst := filepath.Join(out, filepath.FromSlash(outPath(p)))
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return nil, err
		}
		if err := os.WriteFile(dst, []byte(doc), 0o644); err != nil {
			return nil, err
		}
	}
	if len(broken) > 0 {
		sort.Strings(broken)
		return nil, broken
	}
	if err := os.WriteFile(filepath.Join(out, "style.css"), []byte(stylesheet), 0o644); err != nil {
		return nil, err
	}
	for _, dir := range assetDirs {
		if err := copyTree(filepath.Join(root, filepath.FromSlash(dir)), filepath.Join(out, filepath.FromSlash(dir))); err != nil {
			return nil, err
		}
	}
	return &site{pages: pages}, nil
}

// listPages is every published Markdown file, slash-separated and sorted.
func listPages(root string) ([]string, error) {
	var pages []string
	for _, p := range topPages {
		if _, err := os.Stat(filepath.Join(root, p)); err != nil {
			return nil, err
		}
		pages = append(pages, p)
	}
	err := filepath.WalkDir(filepath.Join(root, "docs"), func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(p, ".md") {
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		pages = append(pages, filepath.ToSlash(rel))
		return nil
	})
	sort.Strings(pages)
	return pages, err
}

// outPath is where page p is written in the site.
func outPath(p string) string {
	if p == "README.md" {
		return "index.html"
	}
	return strings.TrimSuffix(p, ".md") + ".html"
}

// relTo is the relative URL from the page written at from to the site file to.
func relTo(from, to string) string {
	r, err := filepath.Rel(filepath.FromSlash(path.Dir(from)), filepath.FromSlash(to))
	if err != nil {
		return to
	}
	return filepath.ToSlash(r)
}

// linker rewrites the URLs of one page.
type linker struct {
	root, ref, page string
	published       map[string]bool
	broken          []string
}

// attrURL matches the attributes that carry a URL in the rendered HTML, from
// Markdown links and images and from the raw HTML the pages embed.
var attrURL = regexp.MustCompile(`\b(href|src|srcset)="([^"]*)"`)

// scheme matches a URL that is not relative.
var scheme = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9+.-]*:`)

func (l *linker) rewrite(body string) string {
	return attrURL.ReplaceAllStringFunc(body, func(m string) string {
		sub := attrURL.FindStringSubmatch(m)
		return sub[1] + `="` + html.EscapeString(l.url(html.UnescapeString(sub[2]))) + `"`
	})
}

// url is where u, as written on this page, points in the site.
func (l *linker) url(u string) string {
	if u == "" || strings.HasPrefix(u, "#") || strings.HasPrefix(u, "/") || scheme.MatchString(u) {
		return u
	}
	target, rest := u, ""
	if i := strings.IndexAny(u, "?#"); i >= 0 {
		target, rest = u[:i], u[i:]
	}
	resolved := path.Clean(path.Join(path.Dir(l.page), target))
	if resolved == ".." || strings.HasPrefix(resolved, "../") {
		l.broken = append(l.broken, fmt.Sprintf("%s: %s leaves the repository", l.page, u))
		return u
	}
	info, err := os.Stat(filepath.Join(l.root, filepath.FromSlash(resolved)))
	if err != nil {
		l.broken = append(l.broken, fmt.Sprintf("%s: %s (no %s)", l.page, u, resolved))
		return u
	}
	switch {
	case l.published[resolved]:
		return relTo(outPath(l.page), outPath(resolved)) + rest
	case l.copied(resolved):
		return relTo(outPath(l.page), resolved) + rest
	case info.IsDir():
		return repoURL + "/tree/" + l.ref + "/" + resolved + rest
	default:
		return repoURL + "/blob/" + l.ref + "/" + resolved + rest
	}
}

// copied reports whether p is inside a directory the site copies.
func (l *linker) copied(p string) bool {
	for _, dir := range assetDirs {
		if p == dir || strings.HasPrefix(p, dir+"/") {
			return true
		}
	}
	return false
}

// title is the text of the page's first heading, or its file name.
func title(md goldmark.Markdown, src []byte, p string) string {
	doc := md.Parser().Parse(text.NewReader(src))
	var found string
	_ = ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		h, ok := n.(*ast.Heading)
		if !entering || !ok {
			return ast.WalkContinue, nil
		}
		var b strings.Builder
		_ = ast.Walk(h, func(c ast.Node, entering bool) (ast.WalkStatus, error) {
			if t, ok := c.(*ast.Text); ok && entering {
				b.Write(t.Value(src))
			}
			return ast.WalkContinue, nil
		})
		found = strings.TrimSpace(b.String())
		return ast.WalkStop, nil
	})
	if found == "" {
		return path.Base(p)
	}
	return found
}

// page is one HTML document around a rendered body.
func page(title, style, home, docs, body string) string {
	name := "TrewSync"
	full := title
	if title != name {
		full = title + " · " + name
	}
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>` + html.EscapeString(full) + `</title>
<link rel="stylesheet" href="` + style + `">
</head>
<body>
<header><a href="` + home + `">TrewSync</a> <a href="` + docs + `">Documentation</a></header>
<main>
` + body + `</main>
</body>
</html>
`
}

// copyTree copies the regular files under src to dst.
func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		to := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(to, 0o755)
		}
		if !d.Type().IsRegular() {
			return errors.New(p + " is not a regular file")
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(to, b, 0o644)
	})
}

// stylesheet is the site's one stylesheet: readable type, tables, code, and
// the system's light or dark setting.
const stylesheet = `:root {
  --bg: #ffffff; --fg: #1f2328; --muted: #59636e; --line: #d1d9e0;
  --code: #f6f8fa; --link: #0969da;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --line: #3d444d;
    --code: #151b23; --link: #4493f8;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
}
header { border-bottom: 1px solid var(--line); padding: 12px 16px; }
header a { margin-right: 16px; font-weight: 600; }
main { max-width: 860px; margin: 0 auto; padding: 16px; overflow-wrap: anywhere; }
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
img { max-width: 100%; height: auto; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; }
code { background: var(--code); padding: 0.1em 0.3em; border-radius: 4px; }
pre { background: var(--code); padding: 12px; border-radius: 6px; overflow-x: auto; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--line); padding: 6px 12px; vertical-align: top; }
blockquote { margin: 0; padding: 0 16px; color: var(--muted); border-left: 4px solid var(--line); }
h1, h2 { border-bottom: 1px solid var(--line); padding-bottom: 0.3em; }
`
