package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// The tests below run `trewd update` end to end against a release feed served
// from memory, with a fake packslip standing in for the signature check. What
// they establish is everything update decides for itself: which release it
// picks, what it refuses, and that a refusal at any step leaves the installed
// binary byte-identical with nothing left beside it. That packslip's own
// signature check is wired up correctly, against a bundle the real CLI signed,
// is scripts/packslip-check.sh's to show.

const updateAsset = "trewd-" + runtime.GOOS + "-" + runtime.GOARCH

// fakeTrewd is a shell script that answers `version` the way trewd does.
func fakeTrewd(ver string) []byte {
	return []byte(fmt.Sprintf("#!/bin/sh\necho 'trewd %s %s/%s go-test'\n", ver, runtime.GOOS, runtime.GOARCH))
}

type fakeRelease struct {
	tag        string
	draft      bool
	prerelease bool
	files      map[string][]byte // asset name -> bytes
}

// serverRelease is a complete, consistent server release of ver.
func serverRelease(ver string) fakeRelease {
	bin := fakeTrewd(ver)
	r := fakeRelease{tag: "server/v" + ver, files: map[string][]byte{updateAsset: bin}}
	r.files[updateSums] = []byte(fmt.Sprintf("%s  %s\n%s  trewd-plan9-mips\n", sha(bin), updateAsset, sha([]byte("x"))))
	r.files[updateBundle] = bundleFor(updateProject, ver, updateAsset, sha(bin), int64(len(bin)))
	return r
}

func sha(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// bundleFor is a packslip bundle carrying a statement, unsigned: the fake
// packslip is what says whether it verifies.
func bundleFor(project, ver, asset, digest string, size int64) []byte {
	st := map[string]any{
		"_type":         updateStatType,
		"predicateType": updatePredType,
		"subject":       []any{map[string]any{"name": asset, "digest": map[string]string{"sha256": digest}}},
		"predicate": map[string]any{
			"project":   project,
			"version":   ver,
			"artifacts": []any{map[string]any{"name": asset, "size": size, "format": "raw"}},
		},
	}
	payload, _ := json.Marshal(st)
	b, _ := json.Marshal(map[string]any{
		"mediaType": "application/vnd.dev.sigstore.bundle.v0.3+json",
		"dsseEnvelope": map[string]any{
			"payloadType": updatePayload,
			"payload":     base64.StdEncoding.EncodeToString(payload),
		},
	})
	return b
}

// feedServer serves releases the way GitHub's API does, pages and all, with
// each asset downloadable from /dl/<tag>/<name>.
func feedServer(t *testing.T, pages ...[]fakeRelease) *httptest.Server {
	t.Helper()
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/repos/"+updateRepo+"/releases" {
			page := 0
			fmt.Sscanf(r.URL.Query().Get("page"), "%d", &page)
			if page >= len(pages) {
				w.Write([]byte("[]"))
				return
			}
			if page+1 < len(pages) {
				w.Header().Set("Link", fmt.Sprintf(`<%s/repos/%s/releases?per_page=100&page=%d>; rel="next"`,
					srv.URL, updateRepo, page+1))
			}
			var list []map[string]any
			for _, rel := range pages[page] {
				var assets []map[string]any
				for name := range rel.files {
					assets = append(assets, map[string]any{
						"name": name, "browser_download_url": srv.URL + "/dl/" + rel.tag + "/" + name,
					})
				}
				list = append(list, map[string]any{
					"tag_name": rel.tag, "draft": rel.draft, "prerelease": rel.prerelease, "assets": assets,
				})
			}
			json.NewEncoder(w).Encode(list)
			return
		}
		for _, page := range pages {
			for _, rel := range page {
				for name, body := range rel.files {
					if r.URL.Path == "/dl/"+rel.tag+"/"+name {
						w.Write(body)
						return
					}
				}
			}
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// fakePackslip is a packslip that records how it was called and answers with
// whatever report the test wrote, or refuses.
type fakePackslip struct {
	path, dir string
}

func newFakePackslip(t *testing.T) fakePackslip {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "packslip")
	script := fmt.Sprintf(`#!/bin/sh
dir=%q
printf '%%s\n' "$@" > "$dir/args"
if [ -f "$dir/refuse" ]; then echo "the signature does not verify" >&2; exit 1; fi
cat "$dir/report.json"
`, dir)
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return fakePackslip{path: path, dir: dir}
}

func (p fakePackslip) report(t *testing.T, project, ver, scheme, keyID string, checked ...string) {
	t.Helper()
	b, _ := json.Marshal(map[string]any{
		"project": project, "version": ver, "scheme": scheme, "key_id": keyID,
		"issuer": "https://token.actions.githubusercontent.com", "checked_artifacts": checked,
	})
	if err := os.WriteFile(filepath.Join(p.dir, "report.json"), b, 0o644); err != nil {
		t.Fatal(err)
	}
}

// goodReport is what packslip says of a release attest.yml signed, run from
// the release's own tag as release.sh dispatches it.
func (p fakePackslip) goodReport(t *testing.T, ver string) {
	p.report(t, updateProject, ver, "sigstore-oidc",
		"https://github.com/"+updateRepo+"/.github/workflows/attest.yml@refs/tags/server/v"+ver, updateAsset)
}

// issuer rewrites the issuer of the report the test wrote.
func (p fakePackslip) issuer(t *testing.T, iss string) {
	t.Helper()
	path := filepath.Join(p.dir, "report.json")
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var r map[string]any
	if err := json.Unmarshal(b, &r); err != nil {
		t.Fatal(err)
	}
	r["issuer"] = iss
	b, _ = json.Marshal(r)
	if err := os.WriteFile(path, b, 0o644); err != nil {
		t.Fatal(err)
	}
}

func (p fakePackslip) args(t *testing.T) []string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(p.dir, "args"))
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSpace(string(b)), "\n")
}

// installed is a trewd of ver where an operator would have put it, alone in
// its directory so anything left beside it shows.
func installed(t *testing.T, ver string) string {
	t.Helper()
	// Resolved, because update reports the path it resolved (macOS's temp
	// directory is under a symlink) and the tests compare against its output.
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "trewd")
	if err := os.WriteFile(path, fakeTrewd(ver), 0o751); err != nil {
		t.Fatal(err)
	}
	return path
}

func runUpdate(t *testing.T, target string, srv *httptest.Server, p fakePackslip, extra ...string) (string, error) {
	t.Helper()
	args := append([]string{"update", "-binary", target, "-feed", srv.URL, "-packslip", p.path}, extra...)
	var out bytes.Buffer
	err := run(context.Background(), args, &out)
	return out.String(), err
}

// untouched fails unless target still holds exactly before and nothing else
// is in its directory.
func untouched(t *testing.T, target string, before []byte) {
	t.Helper()
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, before) {
		t.Fatalf("%s was changed:\n%s", target, got)
	}
	leftovers(t, target)
}

func leftovers(t *testing.T, target string) {
	t.Helper()
	entries, err := os.ReadDir(filepath.Dir(target))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if e.Name() != filepath.Base(target) {
			t.Errorf("left %s beside %s", e.Name(), target)
		}
	}
}

func TestUpdateInstallsTheNewestVerifiedServerRelease(t *testing.T) {
	target := installed(t, "0.1.0")
	rc := serverRelease("0.3.0-rc.1")
	rc.prerelease = true
	draft := serverRelease("0.9.0")
	draft.draft = true
	plugin := fakeRelease{tag: "0.10.0", files: map[string][]byte{"main.js": []byte("x")}}
	srv := feedServer(t, []fakeRelease{plugin, rc, draft, serverRelease("0.2.0"), serverRelease("0.1.5")})
	p := newFakePackslip(t)
	p.goodReport(t, "0.2.0")

	out, err := runUpdate(t, target, srv, p)
	if err != nil {
		t.Fatalf("update: %v\n%s", err, out)
	}
	got, _ := os.ReadFile(target)
	if !bytes.Equal(got, fakeTrewd("0.2.0")) {
		t.Fatalf("installed %q, want the 0.2.0 release: the plugin's 0.10.0, the draft and the release "+
			"candidate are not server releases to move to", got)
	}
	info, _ := os.Stat(target)
	if info.Mode().Perm() != 0o751 {
		t.Errorf("mode %v, want the installed binary's 0751 kept", info.Mode().Perm())
	}
	leftovers(t, target)
	if !strings.Contains(out, "replaced "+target+": 0.1.0 -> 0.2.0") {
		t.Errorf("output does not say what it replaced:\n%s", out)
	}

	// The pin packslip was given is the release workflow's, and nothing
	// looser: another workflow of this repository is not a release.
	args := strings.Join(p.args(t), " ")
	for _, want := range []string{
		"verify ",
		"--identity-prefix https://github.com/waynehoover/trewsync/.github/workflows/attest.yml@refs/tags/server/v ",
		"--issuer https://token.actions.githubusercontent.com",
		"--artifact ",
		"--json",
	} {
		if !strings.Contains(args, want) {
			t.Errorf("packslip was not given %q: %s", want, args)
		}
	}
	if strings.Contains(args, "--allow-unlogged") || strings.Contains(args, "--pubkey") {
		t.Errorf("a release build must not accept a key or an unlogged bundle: %s", args)
	}
}

func TestUpdateRefusesADowngrade(t *testing.T) {
	for _, c := range []struct {
		why, running string
		extra        []string
	}{
		{"the feed's newest is older than what runs", "0.3.0", nil},
		{"and when an older version is asked for by name", "0.3.0", []string{"-version", "0.2.0"}},
		{"a release is older than a release candidate after it", "0.2.1-rc.1", []string{"-version", "0.2.0"}},
	} {
		t.Run(c.why, func(t *testing.T) {
			target := installed(t, c.running)
			before, _ := os.ReadFile(target)
			srv := feedServer(t, []fakeRelease{serverRelease("0.2.0")})
			p := newFakePackslip(t)
			p.goodReport(t, "0.2.0")
			out, err := runUpdate(t, target, srv, p, c.extra...)
			if err == nil || !strings.Contains(err.Error(), "does not downgrade") {
				t.Fatalf("got %v, want a refusal to downgrade\n%s", err, out)
			}
			untouched(t, target, before)
		})
	}
}

func TestUpdateToTheVersionAlreadyRunningDoesNothing(t *testing.T) {
	target := installed(t, "0.2.0")
	before, _ := os.ReadFile(target)
	srv := feedServer(t, []fakeRelease{serverRelease("0.2.0")})
	p := newFakePackslip(t)
	out, err := runUpdate(t, target, srv, p)
	if err != nil || !strings.Contains(out, "nothing to do") {
		t.Fatalf("got %v, want a no-op\n%s", err, out)
	}
	untouched(t, target, before)
}

func TestUpdateDryRunVerifiesAndChangesNothing(t *testing.T) {
	target := installed(t, "0.1.0")
	before, _ := os.ReadFile(target)
	srv := feedServer(t, []fakeRelease{serverRelease("0.2.0")})
	p := newFakePackslip(t)
	p.goodReport(t, "0.2.0")
	out, err := runUpdate(t, target, srv, p, "-dry-run")
	if err != nil {
		t.Fatalf("dry run: %v\n%s", err, out)
	}
	for _, want := range []string{"verified: signed by", "it runs here: trewd 0.2.0", "dry run: " + target + " was not changed"} {
		if !strings.Contains(out, want) {
			t.Errorf("dry run output lacks %q:\n%s", want, out)
		}
	}
	untouched(t, target, before)
}

// Every step that can say no, each leaving the installed binary as it was.
func TestUpdateRefusesAReleaseThatDoesNotVerify(t *testing.T) {
	good := serverRelease("0.2.0")
	bin := good.files[updateAsset]
	for _, c := range []struct {
		why    string
		edit   func(r *fakeRelease, p fakePackslip, t *testing.T)
		reason string
	}{
		{"packslip refuses the signature", func(r *fakeRelease, p fakePackslip, t *testing.T) {
			os.WriteFile(filepath.Join(p.dir, "refuse"), nil, 0o644)
		}, "packslip refused it"},
		{"the manifest signs other bytes", func(r *fakeRelease, p fakePackslip, t *testing.T) {
			r.files[updateBundle] = bundleFor(updateProject, "0.2.0", updateAsset, sha([]byte("other")), int64(len(bin)))
		}, "the manifest signs"},
		{"the manifest signs another size", func(r *fakeRelease, p fakePackslip, t *testing.T) {
			r.files[updateBundle] = bundleFor(updateProject, "0.2.0", updateAsset, sha(bin), int64(len(bin))+1)
		}, "bytes, and the download is"},
		{"the manifest is another project's", func(r *fakeRelease, p fakePackslip, t *testing.T) {
			r.files[updateBundle] = bundleFor("github.com/waynehoover/trewsync", "0.2.0", updateAsset, sha(bin), int64(len(bin)))
		}, "the manifest is for"},
		{"the manifest is another version's", func(r *fakeRelease, p fakePackslip, t *testing.T) {
			r.files[updateBundle] = bundleFor(updateProject, "0.1.9", updateAsset, sha(bin), int64(len(bin)))
		}, "the manifest is for version"},
		{"the manifest is not a bundle", func(r *fakeRelease, p fakePackslip, t *testing.T) {
			r.files[updateBundle] = []byte("not json")
		}, "not a sigstore bundle"},
		{"SHA256SUMS disagrees", func(r *fakeRelease, p fakePackslip, t *testing.T) {
			r.files[updateSums] = []byte(sha([]byte("other")) + "  " + updateAsset + "\n")
		}, updateSums + " lists"},
		{"SHA256SUMS does not list it", func(r *fakeRelease, p fakePackslip, t *testing.T) {
			r.files[updateSums] = []byte(sha(bin) + "  trewd-plan9-mips\n")
		}, "does not list"},
		{"the release has no manifest", func(r *fakeRelease, p fakePackslip, t *testing.T) {
			delete(r.files, updateBundle)
		}, "nothing in it says who built it"},
		{"the release has no build for this machine", func(r *fakeRelease, p fakePackslip, t *testing.T) {
			delete(r.files, updateAsset)
		}, "no build for this machine"},
		{"it was signed with a key, not by the workflow", func(r *fakeRelease, p fakePackslip, t *testing.T) {
			p.report(t, updateProject, "0.2.0", "sigstore-key", "E2DCFCB070706692", updateAsset)
		}, `signed with "sigstore-key"`},
		{"it was signed by another workflow of the repository", func(r *fakeRelease, p fakePackslip, t *testing.T) {
			p.report(t, updateProject, "0.2.0", "sigstore-oidc",
				"https://github.com/"+updateRepo+"/.github/workflows/ci.yml@refs/pull/7/merge", updateAsset)
		}, "which is not"},
		// attest.yml takes the tag as an input, so a dispatch from any branch
		// used to sign an installable bundle: whoever could push a branch with
		// an edited workflow could sign a release of their own.
		{"it was signed by attest.yml dispatched from a branch", func(r *fakeRelease, p fakePackslip, t *testing.T) {
			p.report(t, updateProject, "0.2.0", "sigstore-oidc",
				"https://github.com/"+updateRepo+"/.github/workflows/attest.yml@refs/heads/main", updateAsset)
		}, "which is not"},
		{"it was signed by attest.yml run from another release's tag", func(r *fakeRelease, p fakePackslip, t *testing.T) {
			p.report(t, updateProject, "0.2.0", "sigstore-oidc",
				"https://github.com/"+updateRepo+"/.github/workflows/attest.yml@refs/tags/server/v0.1.9", updateAsset)
		}, "which is not"},
		{"it was signed by attest.yml run from a plugin tag", func(r *fakeRelease, p fakePackslip, t *testing.T) {
			p.report(t, updateProject, "0.2.0", "sigstore-oidc",
				"https://github.com/"+updateRepo+"/.github/workflows/attest.yml@refs/tags/0.2.0", updateAsset)
		}, "which is not"},
		{"the report names another issuer", func(r *fakeRelease, p fakePackslip, t *testing.T) {
			p.issuer(t, "https://issuer.example")
		}, "issued by"},
		{"packslip did not check the file", func(r *fakeRelease, p fakePackslip, t *testing.T) {
			p.report(t, updateProject, "0.2.0", "sigstore-oidc",
				"https://github.com/"+updateRepo+"/.github/workflows/attest.yml@refs/tags/server/v0.2.0")
		}, "did not report checking"},
		{"the new binary says it is another version", func(r *fakeRelease, p fakePackslip, t *testing.T) {
			liar := fakeTrewd("0.2.1")
			r.files[updateAsset] = liar
			r.files[updateSums] = []byte(sha(liar) + "  " + updateAsset + "\n")
			r.files[updateBundle] = bundleFor(updateProject, "0.2.0", updateAsset, sha(liar), int64(len(liar)))
		}, "it says it is 0.2.1"},
	} {
		t.Run(c.why, func(t *testing.T) {
			target := installed(t, "0.1.0")
			before, _ := os.ReadFile(target)
			rel := fakeRelease{tag: good.tag, files: map[string][]byte{}}
			for k, v := range good.files {
				rel.files[k] = v
			}
			p := newFakePackslip(t)
			p.goodReport(t, "0.2.0")
			c.edit(&rel, p, t)
			srv := feedServer(t, []fakeRelease{rel})
			out, err := runUpdate(t, target, srv, p)
			if err == nil || !strings.Contains(err.Error(), c.reason) {
				t.Fatalf("got %v, want a refusal saying %q\n%s", err, c.reason, out)
			}
			untouched(t, target, before)
		})
	}
}

func TestUpdateNeedsAVerifier(t *testing.T) {
	target := installed(t, "0.1.0")
	before, _ := os.ReadFile(target)
	srv := feedServer(t, []fakeRelease{serverRelease("0.2.0")})
	t.Setenv("PATH", t.TempDir())
	var out bytes.Buffer
	err := run(context.Background(), []string{"update", "-binary", target, "-feed", srv.URL}, &out)
	if err == nil || !strings.Contains(err.Error(), "mise use -g github:jdx/packslip") {
		t.Fatalf("got %v, want a refusal naming how to get packslip", err)
	}
	untouched(t, target, before)
}

func TestUpdateRefusesADevelopmentBuild(t *testing.T) {
	target := installed(t, "dev")
	before, _ := os.ReadFile(target)
	srv := feedServer(t, []fakeRelease{serverRelease("0.2.0")})
	_, err := runUpdate(t, target, srv, newFakePackslip(t))
	if err == nil || !strings.Contains(err.Error(), "not a release version") {
		t.Fatalf("got %v, want a refusal of a dev build", err)
	}
	untouched(t, target, before)
}

func TestUpdateReadsEveryPageOfTheFeed(t *testing.T) {
	target := installed(t, "0.1.0")
	var plugins []fakeRelease
	for i := 0; i < 3; i++ {
		plugins = append(plugins, fakeRelease{tag: fmt.Sprintf("0.%d.0", 20+i), files: map[string][]byte{}})
	}
	srv := feedServer(t, plugins, []fakeRelease{serverRelease("0.1.9")}, []fakeRelease{serverRelease("0.2.0")})
	p := newFakePackslip(t)
	p.goodReport(t, "0.2.0")
	if out, err := runUpdate(t, target, srv, p); err != nil {
		t.Fatalf("update: %v\n%s", err, out)
	}
	if got, _ := os.ReadFile(target); !bytes.Equal(got, fakeTrewd("0.2.0")) {
		t.Fatalf("installed %q, want 0.2.0 from the third page", got)
	}
}

func TestUpdateTakesAReleaseCandidateOnlyByName(t *testing.T) {
	rc := serverRelease("0.3.0-rc.1")
	rc.prerelease = true
	srv := feedServer(t, []fakeRelease{serverRelease("0.2.0"), rc})
	p := newFakePackslip(t)
	p.goodReport(t, "0.3.0-rc.1")
	target := installed(t, "0.2.0")
	out, err := runUpdate(t, target, srv, p)
	if err != nil || !strings.Contains(out, "nothing to do") {
		t.Fatalf("without -version a release candidate is not newer: %v\n%s", err, out)
	}
	if out, err := runUpdate(t, target, srv, p, "-version", "server/v0.3.0-rc.1"); err != nil {
		t.Fatalf("named: %v\n%s", err, out)
	}
	if got, _ := os.ReadFile(target); !bytes.Equal(got, fakeTrewd("0.3.0-rc.1")) {
		t.Fatalf("installed %q, want the named release candidate", got)
	}
}

// A container's binary is its image's: replacing it in place is undone by the
// next recreate, and hides the version from whoever pulls. /.dockerenv is
// Docker's alone, so Podman and Kubernetes used to pass as a plain host.
func TestUpdateRecognisesEveryContainer(t *testing.T) {
	for _, c := range []struct {
		why   string
		files []string
		env   map[string]string
		want  string
	}{
		{"a plain host", nil, nil, ""},
		{"Docker", []string{"/.dockerenv"}, nil, "Docker"},
		{"Podman", []string{"/run/.containerenv"}, nil, "Podman"},
		{"Kubernetes, by its service variable", nil, map[string]string{"KUBERNETES_SERVICE_HOST": "10.0.0.1"}, "Kubernetes"},
		{"Kubernetes, by its mounted secrets", []string{"/var/run/secrets/kubernetes.io"}, nil, "Kubernetes"},
	} {
		t.Run(c.why, func(t *testing.T) {
			exists := func(p string) bool {
				for _, f := range c.files {
					if f == p {
						return true
					}
				}
				return false
			}
			getenv := func(k string) string { return c.env[k] }
			if got := containerOf(exists, getenv); got != c.want {
				t.Errorf("containerOf = %q, want %q", got, c.want)
			}
		})
	}
}

func TestUpdateRefusesToReplaceAContainersBinary(t *testing.T) {
	for _, engine := range []string{"Docker", "Podman", "Kubernetes"} {
		u := updater{out: io.Discard, container: func() string { return engine }}
		_, _, err := u.current(context.Background())
		if err == nil || !strings.Contains(err.Error(), "running in a container ("+engine+")") {
			t.Errorf("%s: got %v, want a refusal naming the container", engine, err)
		}
	}
}

func TestUpdateLeavesPackageManagersTheirBinaries(t *testing.T) {
	for path, who := range map[string]string{
		"/opt/homebrew/Cellar/trewd/0.2.0/bin/trewd":                "Homebrew",
		"/nix/store/abc-trewd-0.2.0/bin/trewd":                      "Nix",
		"/home/me/.local/share/mise/installs/trewd/0.2.0/bin/trewd": "mise",
		"/usr/local/bin/trewd":                                      "",
	} {
		if got := managedBy(path); (who == "" && got != "") || !strings.HasPrefix(got, who) {
			t.Errorf("managedBy(%q) = %q, want %q", path, got, who)
		}
	}
}

func TestSemverPrecedence(t *testing.T) {
	// Ascending, from semver 2.0.0's own example list and then some.
	order := []string{
		"0.9.9", "0.10.0", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta",
		"1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.10.0", "2.0.0",
	}
	for i := range order {
		for j := range order {
			a, err := parseSemver(order[i])
			if err != nil {
				t.Fatal(err)
			}
			b, _ := parseSemver(order[j])
			want := 0
			if i < j {
				want = -1
			} else if i > j {
				want = 1
			}
			if got := a.compare(b); got != want {
				t.Errorf("compare(%s, %s) = %d, want %d", order[i], order[j], got, want)
			}
		}
	}
	for _, bad := range []string{"", "dev", "1.2", "1.2.3.4", "v1.2.3", "01.2.3", "1.2.3-", "1.2.3-01", "1.2.3+build", "1.2.x"} {
		if _, err := parseSemver(bad); err == nil {
			t.Errorf("parseSemver(%q) accepted it", bad)
		}
	}
}
