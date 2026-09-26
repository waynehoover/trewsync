package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/waynehoover/trewsync/internal/fsync"
)

// The release feed `trewd update` reads, and what it trusts in it.
//
// The feed is GitHub's releases endpoint for this repository, and it is only a
// list of candidates. Nothing it says is believed until the release's packslip
// manifest has been verified against a signer pinned here: a workflow of this
// repository, through GitHub's OIDC issuer. That is why -feed can point
// anywhere, a mirror included, without being a way in: a mirror can withhold a
// release but cannot make this install one this repository did not sign.
const (
	updateRepo     = "waynehoover/trewsync"
	updateFeed     = "https://api.github.com"
	updateTagLine  = "server/v"
	updateProject  = "github.com/waynehoover/trewsync/server"
	updateBundle   = "packslip.server.sigstore.json"
	updateSums     = "SHA256SUMS"
	updateStatType = "https://in-toto.io/Statement/v1"
	updatePredType = "https://packslip.dev/release/v1"
	updatePayload  = "application/vnd.in-toto+json"

	// Far above any trewd so far (about 15 MB), and far below what a
	// misbehaving server could otherwise stream into the binary's directory.
	updateMaxBinary = 256 << 20
	updateMaxSmall  = 4 << 20
	updateMaxPages  = 10
)

// updatePolicy is who a release must be signed by, as packslip verify is told
// it and as its report must then say it.
//
// A variable rather than constants only so the tests can sign a feed of their
// own with a local key: see update_testpin.go, which exists only in a build
// with the updatetest tag, and the unit tests, which set it directly. Nothing a
// release build reads can change it.
type updatePolicy struct {
	args   []string // the trust pin, as packslip verify flags
	scheme string   // the scheme the verified report must name
	// signer is what the verified signer must be, followed by the version
	// offered: the whole identity, not a prefix of it. "" only for a pinned key.
	signer string
	issuer string // the issuer the verified report must name; "" only for a pinned key
}

const (
	updateWorkflow = "https://github.com/" + updateRepo + "/.github/workflows/attest.yml@"
	updateIssuer   = "https://token.actions.githubusercontent.com"
)

var releasePolicy = updatePolicy{
	// The workflow, and the ref it ran from. attest.yml is the one workflow
	// that signs a server release, so a bundle signed by any other workflow of
	// this repository (a pull request's CI, say) is not a release. It is started
	// by a dispatch that names the tag as an input, so the ref it ran from is
	// whatever branch the dispatcher chose, and that branch's attest.yml is the
	// one that runs: pinned to the workflow alone, anyone who can push a branch
	// could sign an installable bundle. So the release is dispatched from its
	// own tag (release.sh prints it so), and the identity must end in exactly
	// that tag: refs/tags/server/v followed by the version being installed.
	args: []string{
		"--identity-prefix", updateWorkflow + "refs/tags/" + updateTagLine,
		"--issuer", updateIssuer,
	},
	scheme: "sigstore-oidc",
	signer: updateWorkflow + "refs/tags/" + updateTagLine,
	issuer: updateIssuer,
}

// cmdUpdate replaces this binary with the newest server release, verified.
//
// In order, and each step refuses rather than guesses:
//
//  1. Work out what is being replaced and what it is. A development build, or
//     one a package manager owns, is refused: the first cannot say whether a
//     release is newer, and the second would be overwritten behind the manager
//     that will overwrite it back.
//  2. Read the feed and pick the newest server release, or the one -version
//     names. Older than what is running is refused (no downgrade); the same is
//     a no-op.
//  3. Download this platform's binary, SHA256SUMS and the packslip manifest
//     into a directory beside the binary, so the final step is a rename on one
//     filesystem.
//  4. Verify: packslip checks the manifest's signature against the pinned
//     workflow identity and the binary against the signed digest and size.
//     Then this checks, itself, that the signed statement is for this project
//     and this version, that it names this file with the digest just computed,
//     and that SHA256SUMS agrees. Only then is the new binary run, to see it
//     starts on this machine and says it is the version it was sold as.
//  5. Rename it over the old one and flush the directory. The rename is the
//     whole update: before it the old binary is untouched, after it the new
//     one is complete.
//
// -dry-run does steps 1 to 4 in a temporary directory and stops, so it answers
// "would this work" with everything but the rename.
//
// It does not restart the server. The running process keeps the old binary's
// code until it is restarted, and when to restart a sync server is the
// operator's call, not an updater's.
func cmdUpdate(args []string, out io.Writer) error {
	fs := flag.NewFlagSet("update", flag.ContinueOnError)
	dryRun := fs.Bool("dry-run", false, "download and verify, then stop without replacing anything")
	want := fs.String("version", "", "install this server version rather than the newest (never an older one)")
	feed := fs.String("feed", updateFeed, "base URL of the GitHub API serving this repository's releases")
	packslip := fs.String("packslip", "", "the packslip executable that verifies the release (default: packslip on PATH)")
	binary := fs.String("binary", "", "the trewd binary to replace (default: this one)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("update takes no arguments, only flags (got %q)", fs.Arg(0))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	u := updater{
		out:      out,
		feed:     strings.TrimRight(*feed, "/"),
		want:     strings.TrimPrefix(strings.TrimPrefix(*want, updateTagLine), "v"),
		dryRun:   *dryRun,
		packslip: *packslip,
		binary:   *binary,
		policy:   releasePolicy,
		client:   &http.Client{Timeout: 10 * time.Minute},
		goos:     runtime.GOOS,
		goarch:   runtime.GOARCH,
	}
	return u.run(ctx)
}

type updater struct {
	out      io.Writer
	feed     string
	want     string
	dryRun   bool
	packslip string
	binary   string
	policy   updatePolicy
	client   *http.Client
	goos     string
	goarch   string
	// container names the container engine this runs under, or ""; nil is
	// probeContainer, the tests' seam being the only other value.
	container func() string
}

func (u *updater) run(ctx context.Context) error {
	target, current, err := u.current(ctx)
	if err != nil {
		return err
	}
	cur, err := parseSemver(current)
	if err != nil {
		return fmt.Errorf("%s calls itself %q, which is not a release version, so there is no saying "+
			"whether a release is newer. A development build is replaced by installing a release, "+
			"not by updating it", target, current)
	}
	fmt.Fprintf(u.out, "this is trewd %s at %s\n", current, target)

	// The verifier first, before anything is downloaded, so a machine without
	// one finds out in a second rather than after fifteen megabytes.
	verifier, err := u.verifier()
	if err != nil {
		return err
	}

	rel, err := u.pick(ctx)
	if err != nil {
		return err
	}
	next, _ := parseSemver(rel.version)
	switch c := next.compare(cur); {
	case c == 0:
		fmt.Fprintf(u.out, "already the newest server release, %s; nothing to do\n", current)
		return nil
	case c < 0:
		return fmt.Errorf("the release asked for, %s, is older than the %s running here, and update does "+
			"not downgrade: a newer server may have changed the store in ways an older one cannot "+
			"read. To go back anyway, install the older release's binary by hand after reading its notes",
			rel.version, current)
	}
	fmt.Fprintf(u.out, "server release %s (%s) is newer\n", rel.version, rel.tag)

	asset := "trewd-" + u.goos + "-" + u.goarch
	binURL, ok := rel.assets[asset]
	if !ok {
		return fmt.Errorf("release %s has no %s, so there is no build for this machine in it", rel.tag, asset)
	}
	bundleURL, ok := rel.assets[updateBundle]
	if !ok {
		return fmt.Errorf("release %s has no %s, so nothing in it says who built it; not installing it",
			rel.tag, updateBundle)
	}
	sumsURL, ok := rel.assets[updateSums]
	if !ok {
		return fmt.Errorf("release %s has no %s; not installing it", rel.tag, updateSums)
	}

	// Beside the binary, so the rename at the end stays on one filesystem and
	// is atomic. A dry run changes nothing there, so it stages elsewhere.
	stageIn := filepath.Dir(target)
	if u.dryRun {
		stageIn = ""
	}
	stage, err := os.MkdirTemp(stageIn, ".trewd-update-")
	if err != nil {
		return fmt.Errorf("cannot stage the new binary beside %s: %w (run this as the user who "+
			"owns that directory, or use -dry-run to only check)", target, err)
	}
	defer os.RemoveAll(stage)

	staged := filepath.Join(stage, asset)
	digest, size, err := u.download(ctx, binURL, staged, updateMaxBinary, 0o700)
	if err != nil {
		return fmt.Errorf("downloading %s: %w", asset, err)
	}
	fmt.Fprintf(u.out, "downloaded %s, %d bytes, sha256 %s\n", asset, size, digest)
	bundle := filepath.Join(stage, updateBundle)
	if _, _, err := u.download(ctx, bundleURL, bundle, updateMaxSmall, 0o600); err != nil {
		return fmt.Errorf("downloading %s: %w", updateBundle, err)
	}
	sums := filepath.Join(stage, updateSums)
	if _, _, err := u.download(ctx, sumsURL, sums, updateMaxSmall, 0o600); err != nil {
		return fmt.Errorf("downloading %s: %w", updateSums, err)
	}

	signer, err := u.verify(ctx, verifier, bundle, staged, asset, rel.version, digest, size, sums)
	if err != nil {
		return fmt.Errorf("release %s did not verify, and nothing was replaced: %w", rel.tag, err)
	}
	fmt.Fprintf(u.out, "verified: signed by %s; %s matches the signed manifest and %s\n", signer, asset, updateSums)

	said, err := u.runsHere(ctx, staged, rel.version)
	if err != nil {
		return fmt.Errorf("release %s verified but will not run here, and nothing was replaced: %w", rel.tag, err)
	}
	fmt.Fprintf(u.out, "it runs here: %s\n", said)

	if u.dryRun {
		fmt.Fprintf(u.out, "dry run: %s was not changed. Without -dry-run it would become %s.\n", target, rel.version)
		return nil
	}
	if err := u.install(staged, target); err != nil {
		return err
	}
	fmt.Fprintf(u.out, "replaced %s: %s -> %s\n", target, current, rel.version)
	fmt.Fprintf(u.out, "A running server is still %s until it restarts, for instance:\n  systemctl restart trew\n", current)
	return nil
}

// current is the binary this replaces and the version it says it is.
//
// For this binary the stamped version is known without asking. For -binary it
// is whatever that binary says, run with `version`, because a path is not a
// version and guessing one from the file would be comparing against a number
// nothing checked.
func (u *updater) current(ctx context.Context) (string, string, error) {
	target := u.binary
	if target == "" {
		exe, err := os.Executable()
		if err != nil {
			return "", "", fmt.Errorf("working out where this binary is: %w", err)
		}
		target = exe
	}
	if resolved, err := filepath.EvalSymlinks(target); err == nil {
		target = resolved
	}
	abs, err := filepath.Abs(target)
	if err != nil {
		return "", "", err
	}
	target = abs
	if who := managedBy(target); who != "" {
		return "", "", fmt.Errorf("%s was installed by %s, which will replace it back on its next "+
			"upgrade and keeps its own record of what is installed. Upgrade it there instead", target, who)
	}
	probe := u.container
	if probe == nil {
		probe = probeContainer
	}
	if engine := probe(); engine != "" && u.binary == "" {
		return "", "", fmt.Errorf("this is running in a container (%s), whose image is the thing to update: "+
			"pull the new image and recreate the container", engine)
	}
	info, err := os.Stat(target)
	if err != nil {
		return "", "", err
	}
	if !info.Mode().IsRegular() {
		return "", "", fmt.Errorf("%s is not a regular file", target)
	}
	if u.binary == "" {
		return target, resolveVersion(version, moduleVersion()), nil
	}
	said, err := sayVersion(ctx, target)
	if err != nil {
		return "", "", fmt.Errorf("asking %s what it is: %w", target, err)
	}
	return target, said.version, nil
}

// probeContainer names the container engine this process runs under, or "".
func probeContainer() string {
	return containerOf(func(p string) bool {
		_, err := os.Stat(p)
		return err == nil
	}, os.Getenv)
}

// containerOf names the container engine the markers point to, or "".
func containerOf(exists func(string) bool, getenv func(string) string) string {
	switch {
	case exists("/.dockerenv"):
		return "Docker"
	case exists("/run/.containerenv"):
		return "Podman"
	case getenv("KUBERNETES_SERVICE_HOST") != "" || exists("/var/run/secrets/kubernetes.io"):
		return "Kubernetes"
	}
	return ""
}

// managedBy names the package manager that owns path, or "".
//
// By where they install, which is how each one is recognised by the others
// too. Homebrew keeps every version under a Cellar, Nix under the store, which
// is read-only anyway, and mise under its installs directory.
func managedBy(path string) string {
	slashed := filepath.ToSlash(path)
	switch {
	case strings.Contains(slashed, "/Cellar/"):
		return "Homebrew (brew upgrade trewd)"
	case strings.HasPrefix(slashed, "/nix/store/"):
		return "Nix (update the flake input)"
	case strings.Contains(slashed, "/mise/installs/"):
		return "mise (mise upgrade)"
	}
	return ""
}

// verifier is the packslip executable to verify with.
func (u *updater) verifier() (string, error) {
	if u.packslip != "" {
		return u.packslip, nil
	}
	found, err := exec.LookPath("packslip")
	if err != nil {
		return "", errors.New("verifying a release needs the packslip CLI, and there is none on PATH. " +
			"It is how this checks who built a release before running it, and nothing is installed " +
			"without that check. Install it (mise use -g github:jdx/packslip, or a release from " +
			"https://github.com/jdx/packslip/releases), or point -packslip at one")
	}
	return found, nil
}

type feedRelease struct {
	tag     string
	version string
	assets  map[string]string // name -> download URL
}

// pick reads the feed and chooses the release to install.
//
// Only server releases count: the plugin's releases share the repository and
// carry bare version tags, and a plugin at 0.10.0 is not a server at 0.10.0.
// Drafts never count. Prereleases count only when -version names one exactly,
// because nobody running a sync server for years meant to be moved onto a
// release candidate by a routine update.
func (u *updater) pick(ctx context.Context) (feedRelease, error) {
	url := u.feed + "/repos/" + updateRepo + "/releases?per_page=100"
	var best *feedRelease
	var bestV semver
	seen := 0
	for page := 0; url != "" && page < updateMaxPages; page++ {
		var list []struct {
			TagName    string `json:"tag_name"`
			Draft      bool   `json:"draft"`
			Prerelease bool   `json:"prerelease"`
			Assets     []struct {
				Name string `json:"name"`
				URL  string `json:"browser_download_url"`
			} `json:"assets"`
		}
		next, err := u.getJSON(ctx, url, &list)
		if err != nil {
			return feedRelease{}, fmt.Errorf("reading the release feed: %w", err)
		}
		url = next
		for _, r := range list {
			if r.Draft || !strings.HasPrefix(r.TagName, updateTagLine) {
				continue
			}
			ver := strings.TrimPrefix(r.TagName, updateTagLine)
			v, err := parseSemver(ver)
			if err != nil {
				continue
			}
			seen++
			if u.want != "" {
				if ver != u.want {
					continue
				}
			} else if r.Prerelease || v.pre != "" {
				continue
			}
			if best != nil && v.compare(bestV) <= 0 {
				continue
			}
			assets := map[string]string{}
			for _, a := range r.Assets {
				assets[a.Name] = a.URL
			}
			best = &feedRelease{tag: r.TagName, version: ver, assets: assets}
			bestV = v
		}
	}
	if best == nil {
		if u.want != "" {
			return feedRelease{}, fmt.Errorf("the feed has no server release %s", u.want)
		}
		return feedRelease{}, fmt.Errorf("the feed at %s lists no published server release (%d server tags seen, "+
			"none a stable release)", u.feed, seen)
	}
	return *best, nil
}

// getJSON fetches one page of the feed and returns the next page's URL, if
// GitHub's Link header names one.
func (u *updater) getJSON(ctx context.Context, url string, into any) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "trewd-update")
	res, err := u.client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		why, _ := io.ReadAll(io.LimitReader(res.Body, 512))
		return "", fmt.Errorf("%s answered %s: %s", url, res.Status, strings.TrimSpace(string(why)))
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, updateMaxSmall+1))
	if err != nil {
		return "", err
	}
	if len(body) > updateMaxSmall {
		return "", fmt.Errorf("%s answered with more than %d bytes", url, updateMaxSmall)
	}
	if err := json.Unmarshal(body, into); err != nil {
		return "", fmt.Errorf("%s did not answer with a release list: %w", url, err)
	}
	return nextLink(res.Header.Get("Link")), nil
}

// nextLink reads rel="next" out of a Link header, or "".
func nextLink(h string) string {
	for _, part := range strings.Split(h, ",") {
		fields := strings.Split(part, ";")
		if len(fields) < 2 {
			continue
		}
		for _, f := range fields[1:] {
			if strings.TrimSpace(f) == `rel="next"` {
				return strings.Trim(strings.TrimSpace(fields[0]), "<>")
			}
		}
	}
	return ""
}

// download writes url to path, at most limit bytes, and returns its sha256 and
// size. The file is flushed before it is closed, because the one that matters
// is renamed into place and a rename of unflushed bytes is not durable.
func (u *updater) download(ctx context.Context, url, path string, limit int64, mode os.FileMode) (string, int64, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", 0, err
	}
	req.Header.Set("User-Agent", "trewd-update")
	res, err := u.client.Do(req)
	if err != nil {
		return "", 0, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", 0, fmt.Errorf("%s answered %s", url, res.Status)
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return "", 0, err
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(res.Body, limit+1))
	if err == nil && n > limit {
		err = fmt.Errorf("more than %d bytes", limit)
	}
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

// verify establishes that the staged binary is the one this repository's
// release workflow signed for this version, and returns who signed it.
//
// The signature is packslip's to check: Sigstore's certificate chain, the
// transparency log entry and the DSSE envelope, done by the reference
// implementation rather than reimplemented here. What packslip cannot know is
// what was asked for, so the rest is checked here from the same bundle file:
// the project, the version, this file's name, digest and size, and the
// checksum file beside it.
func (u *updater) verify(ctx context.Context, packslip, bundle, staged, asset, version, digest string,
	size int64, sums string) (string, error) {
	args := append([]string{"verify", bundle}, u.policy.args...)
	args = append(args, "--artifact", staged, "--json")
	cmd := exec.CommandContext(ctx, packslip, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		why := strings.TrimSpace(stderr.String())
		if why == "" {
			why = strings.TrimSpace(stdout.String())
		}
		return "", fmt.Errorf("packslip refused it (%v): %s", err, why)
	}
	var report struct {
		Project string   `json:"project"`
		Version string   `json:"version"`
		Scheme  string   `json:"scheme"`
		KeyID   string   `json:"key_id"`
		Issuer  string   `json:"issuer"`
		Checked []string `json:"checked_artifacts"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
		return "", fmt.Errorf("packslip said yes but its report is unreadable: %w", err)
	}
	if report.Scheme != u.policy.scheme {
		return "", fmt.Errorf("signed with %q, and a server release is signed with %q", report.Scheme, u.policy.scheme)
	}
	// packslip was given the pin already; this is the same question asked of
	// its answer, and asked more narrowly than a prefix can: the tag the
	// workflow ran from is this release's own.
	if u.policy.signer != "" && report.KeyID != u.policy.signer+version {
		return "", fmt.Errorf("signed by %q, which is not %s", report.KeyID, u.policy.signer+version)
	}
	if u.policy.issuer != "" && report.Issuer != u.policy.issuer {
		return "", fmt.Errorf("signed by %q issued by %q, and a server release is issued by %s",
			report.KeyID, report.Issuer, u.policy.issuer)
	}
	checked := false
	for _, c := range report.Checked {
		checked = checked || c == asset
	}
	if !checked {
		return "", fmt.Errorf("packslip did not report checking %s against the manifest", asset)
	}

	st, err := readStatement(bundle)
	if err != nil {
		return "", err
	}
	if st.Predicate.Project != updateProject || report.Project != updateProject {
		return "", fmt.Errorf("the manifest is for %q, not %s", st.Predicate.Project, updateProject)
	}
	if st.Predicate.Version != version || report.Version != version {
		return "", fmt.Errorf("the manifest is for version %q, and the feed offered %s", st.Predicate.Version, version)
	}
	signed := ""
	for _, s := range st.Subject {
		if s.Name == asset {
			signed = s.Digest["sha256"]
		}
	}
	if signed != digest {
		return "", fmt.Errorf("the manifest signs %s as sha256 %q, and the download is %s", asset, signed, digest)
	}
	var signedSize int64 = -1
	for _, a := range st.Predicate.Artifacts {
		if a.Name == asset {
			signedSize = a.Size
		}
	}
	if signedSize != size {
		return "", fmt.Errorf("the manifest signs %s as %d bytes, and the download is %d", asset, signedSize, size)
	}
	listed, err := sumFor(sums, asset)
	if err != nil {
		return "", err
	}
	if listed != digest {
		return "", fmt.Errorf("%s lists %s as %s, and the signed manifest and the download say %s",
			updateSums, asset, listed, digest)
	}
	return report.KeyID + " (" + report.Scheme + ")", nil
}

type statement struct {
	Type          string `json:"_type"`
	PredicateType string `json:"predicateType"`
	Subject       []struct {
		Name   string            `json:"name"`
		Digest map[string]string `json:"digest"`
	} `json:"subject"`
	Predicate struct {
		Project   string `json:"project"`
		Version   string `json:"version"`
		Artifacts []struct {
			Name string `json:"name"`
			Size int64  `json:"size"`
		} `json:"artifacts"`
	} `json:"predicate"`
}

// readStatement decodes the release statement out of a packslip bundle. It
// does not verify anything: it is called only after packslip has verified this
// same file, and it reads what was signed so it can be compared to what was
// asked for.
func readStatement(bundle string) (statement, error) {
	var st statement
	raw, err := os.ReadFile(bundle)
	if err != nil {
		return st, err
	}
	var b struct {
		Envelope struct {
			PayloadType string `json:"payloadType"`
			Payload     string `json:"payload"`
		} `json:"dsseEnvelope"`
	}
	if err := json.Unmarshal(raw, &b); err != nil {
		return st, fmt.Errorf("the manifest is not a sigstore bundle: %w", err)
	}
	if b.Envelope.PayloadType != updatePayload {
		return st, fmt.Errorf("the manifest carries %q, not an in-toto statement", b.Envelope.PayloadType)
	}
	payload, err := base64.StdEncoding.DecodeString(b.Envelope.Payload)
	if err != nil {
		return st, fmt.Errorf("the manifest's payload is not base64: %w", err)
	}
	if err := json.Unmarshal(payload, &st); err != nil {
		return st, fmt.Errorf("the manifest's statement is not JSON: %w", err)
	}
	if st.Type != updateStatType || st.PredicateType != updatePredType {
		return st, fmt.Errorf("the manifest is a %q about %q, not a packslip release", st.Type, st.PredicateType)
	}
	return st, nil
}

// sumFor is the sha256 SHA256SUMS lists for name.
func sumFor(path, name string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	found := ""
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) == 2 && strings.TrimPrefix(fields[1], "*") == name {
			if found != "" {
				return "", fmt.Errorf("%s lists %s twice", updateSums, name)
			}
			found = fields[0]
		}
	}
	if err := sc.Err(); err != nil {
		return "", err
	}
	if found == "" {
		return "", fmt.Errorf("%s does not list %s", updateSums, name)
	}
	return found, nil
}

type saidVersion struct {
	line    string
	version string
	target  string
}

// sayVersion runs a trewd with `version` and reads its first line, which is
// "trewd <version> <os>/<arch> <go>".
func sayVersion(ctx context.Context, path string) (saidVersion, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, path, "version")
	cmd.Stdin = nil
	outb, err := cmd.Output()
	if err != nil {
		return saidVersion{}, err
	}
	line := strings.TrimSpace(strings.SplitN(string(outb), "\n", 2)[0])
	f := strings.Fields(line)
	if len(f) < 3 || f[0] != "trewd" {
		return saidVersion{}, fmt.Errorf("it answered %q, which is not a trewd saying its version", line)
	}
	return saidVersion{line: line, version: f[1], target: f[2]}, nil
}

// runsHere runs the verified binary once, to see it starts on this machine and
// says it is the version the manifest signed. A build for the wrong
// architecture fails here rather than as the service's next start.
func (u *updater) runsHere(ctx context.Context, staged, want string) (string, error) {
	said, err := sayVersion(ctx, staged)
	if err != nil {
		return "", err
	}
	if said.version != want {
		return "", fmt.Errorf("it says it is %s, and the release is %s", said.version, want)
	}
	if said.target != u.goos+"/"+u.goarch {
		return "", fmt.Errorf("it says it is built for %s, and this is %s/%s", said.target, u.goos, u.goarch)
	}
	return said.line, nil
}

// install renames the staged binary over target, keeping target's mode and,
// when this is root, its owner, then flushes the directory so the new name
// survives a power cut.
func (u *updater) install(staged, target string) error {
	info, err := os.Stat(target)
	if err != nil {
		return err
	}
	if err := os.Chmod(staged, info.Mode().Perm()|0o100); err != nil {
		return err
	}
	if st, ok := info.Sys().(*syscall.Stat_t); ok && os.Geteuid() == 0 {
		if err := os.Lchown(staged, int(st.Uid), int(st.Gid)); err != nil {
			return err
		}
	}
	if err := os.Rename(staged, target); err != nil {
		return fmt.Errorf("replacing %s: %w", target, err)
	}
	if err := fsync.Dir(filepath.Dir(target)); err != nil {
		return fmt.Errorf("replaced %s, but flushing its directory failed, so the new name may not "+
			"survive a power cut: %w", target, err)
	}
	return nil
}

// semver is a parsed MAJOR.MINOR.PATCH[-PRERELEASE], compared by semver 2.0.0
// precedence. Build metadata is refused rather than ignored: no release of
// this project has carried it, and two versions differing only in it would
// compare equal.
type semver struct {
	nums [3]uint64
	pre  string
}

func parseSemver(s string) (semver, error) {
	var v semver
	core, pre, hasPre := strings.Cut(s, "-")
	if hasPre {
		if pre == "" {
			return v, fmt.Errorf("%q has an empty prerelease", s)
		}
		for _, id := range strings.Split(pre, ".") {
			if id == "" || strings.Trim(id, "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-") != "" {
				return v, fmt.Errorf("%q has a malformed prerelease", s)
			}
			if isNumeric(id) && len(id) > 1 && id[0] == '0' {
				return v, fmt.Errorf("%q has a leading zero in its prerelease", s)
			}
		}
		v.pre = pre
	}
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return v, fmt.Errorf("%q is not MAJOR.MINOR.PATCH", s)
	}
	for i, p := range parts {
		if !isNumeric(p) || (len(p) > 1 && p[0] == '0') {
			return v, fmt.Errorf("%q is not MAJOR.MINOR.PATCH", s)
		}
		n, err := strconv.ParseUint(p, 10, 64)
		if err != nil {
			return v, err
		}
		v.nums[i] = n
	}
	return v, nil
}

func isNumeric(s string) bool {
	return s != "" && strings.Trim(s, "0123456789") == ""
}

func (a semver) compare(b semver) int {
	for i := range a.nums {
		if a.nums[i] != b.nums[i] {
			if a.nums[i] < b.nums[i] {
				return -1
			}
			return 1
		}
	}
	switch {
	case a.pre == b.pre:
		return 0
	case a.pre == "":
		return 1
	case b.pre == "":
		return -1
	}
	x, y := strings.Split(a.pre, "."), strings.Split(b.pre, ".")
	for i := 0; i < len(x) && i < len(y); i++ {
		if x[i] == y[i] {
			continue
		}
		xn, yn := isNumeric(x[i]), isNumeric(y[i])
		switch {
		case xn && yn:
			xi, _ := strconv.ParseUint(x[i], 10, 64)
			yi, _ := strconv.ParseUint(y[i], 10, 64)
			if xi < yi {
				return -1
			}
			return 1
		case xn:
			return -1
		case yn:
			return 1
		case x[i] < y[i]:
			return -1
		default:
			return 1
		}
	}
	switch {
	case len(x) < len(y):
		return -1
	case len(x) > len(y):
		return 1
	}
	return 0
}
