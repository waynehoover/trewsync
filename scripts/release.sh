#!/usr/bin/env bash
#
# Builds what the releases are made of, and keeps them apart.
#
# They are separate releases because they are separate things on separate
# clocks. The plugin follows Obsidian's API and the community directory's rule
# that a release tag is exactly the manifest version, bare and with no `v`. The
# server is a protocol and a store, it should sit still, and it has no such
# rule. Nothing forces them to move together: what decides whether a client and
# a server can talk is the protocol version they each carry, checked on connect
# and refused on mismatch, and that is not the release number.
#
#   plugin, tagged  X.Y.Z          release/plugin/
#   server, tagged  server/vX.Y.Z  release/server/
#   client, tagged  cli/vX.Y.Z     npm, and nothing here
#
# Each tag shape is whatever its own ecosystem demands: Obsidian requires the
# plugin's to be exactly the manifest version with no `v`, and npm requires
# nothing of the client, which matches the server for the sake of looking like
# it. The server's prefix is Basalt's, whose Go module lived in server/ and
# needed server/vX.Y.Z to resolve; this module is at the root, so `go install`
# does not resolve these tags, and the prefix now only keeps the lines apart
# (and names the packslip project, github.com/waynehoover/trewsync/server).
#
# The plugin release holds exactly the three files Obsidian downloads and
# nothing else. Anything extra is a file the installer will never fetch and one
# more thing for a reviewer to ask about.
#
# The headless client produces no files here. It goes to npm, published by
# .github/workflows/npm-publish.yml when a cli/v tag is pushed, and a copy
# attached to a release would be a second answer to "where do I get it".
#
# No uploading, no tagging, no publishing. It puts files in release/ and prints
# their checksums, then prints the two commands that would upload them. A script
# that makes decisions is one you cannot run to see what it would do.
set -euo pipefail

cd "$(dirname "$0")/.."
root=$(pwd)
out="$root/release"

# --prepare, which is the step that has to be committed before a release is
# built (I23). It writes manifest.json and versions.json and stops. Nothing else
# here runs, because the whole point is that its output is a commit rather than
# an asset.
#
#   scripts/release.sh --prepare 0.11.0   bump the plugin to 0.11.0
#   scripts/release.sh --prepare          record the version manifest.json has
#
# One step for both files, because they are one fact said twice: the version
# the plugin is, and the oldest Obsidian that runs it. Bumping one by hand and
# forgetting the other is how a release ships a manifest versions.json has
# never heard of.
#
# It refuses a version that is not greater than every version versions.json
# already names. Obsidian offers the newest entry an install can run, so an
# entry below the newest is one nobody is ever offered, and an entry equal to
# one already released is a second release under a version the directory has
# already served, which Obsidian will not notice and cannot tell apart.
# Re-running it for the version it has just prepared is the one exception,
# and changes nothing.
if [ "${1:-}" = --prepare ]; then
  python3 - "${2:-}" <<'PY'
import json, os, re, sys

asked = sys.argv[1]
manifest = json.load(open("manifest.json"))
minapp = manifest["minAppVersion"]
version = asked or manifest["version"]

def parse(v):
    # Obsidian compares plain X.Y.Z, and the community directory requires the
    # tag to be exactly this, so nothing else is a plugin version.
    if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", v):
        sys.exit("release: %r is not a plugin version (X.Y.Z, no v, no suffix)" % v)
    return tuple(int(p) for p in v.split("."))

path = "versions.json"
known = json.load(open(path)) if os.path.exists(path) else {}
new = parse(version)
newest = max(known, key=parse) if known else None

prepared = (version == manifest["version"] and known.get(version) == minapp
            and newest == version)
if not prepared and newest is not None and new <= parse(newest):
    sys.exit("release: %s is not greater than %s, the newest version versions.json names.\n"
             "  Obsidian offers the newest entry an install can run, so a lower one is never\n"
             "  offered, and an equal one is a second release under a version already served."
             % (version, newest))

if not prepared:
    # manifest.json keeps its own layout (tabs), with only the version changed,
    # so the diff is the one line that means something.
    text = open("manifest.json").read()
    text, n = re.subn(r'("version"\s*:\s*")[^"]*(")', r"\g<1>%s\g<2>" % version, text, count=1)
    if n != 1:
        sys.exit("release: could not find the version in manifest.json")
    open("manifest.json", "w").write(text)
    # In place, keeping every older entry: Obsidian looks up the newest version
    # an install can run, and a file rewritten with only the current one tells
    # an older install that nothing it can run exists.
    known[version] = minapp
    with open(path, "w") as f:
        json.dump(known, f, indent=2)
        f.write("\n")
print("plugin %s needs Obsidian %s" % (version, minapp))
PY
  echo
  if git diff --quiet -- versions.json manifest.json; then
    echo "Already said so. Nothing to commit; run scripts/release.sh next."
  else
    git --no-pager diff -- manifest.json versions.json
    echo
    echo "Commit this, then run scripts/release.sh. Obsidian reads versions.json at"
    echo "the tag, so it has to be in the commit the tag points at."
  fi
  exit 0
fi

# --runbook prints only the commands, building nothing.
#
# The runbook is the part of this that has been wrong most often, and it was
# also the part that could not be looked at without committing first: the
# guard below refuses a dirty tree, correctly, because a release is built from
# a commit. That made every fix to a sentence a commit to see the sentence, and
# it is why a test could not run this at all. Printing is not building, so this
# mode skips the guards and the build and goes straight to the end.
runbookonly=false
if [ "${1:-}" = --runbook ]; then runbookonly=true; shift; fi

# What the *server* is being released as, when that is being said at all.
#
# Empty means it was not given, and the runbook below then declines to print
# server commands rather than building them out of the fallback. It used to
# build them out of `$version`, which without an argument is a `git describe`
# string, so it printed `git tag -a server/vcli/v0.5.0-2-g0def89f` and a
# `verify-release.sh --server cli/v0.5.0`. Both are nonsense and both look
# exactly like something to paste.
serverversion=${1:-}
version=${serverversion:-$(git describe --tags --always --dirty 2>/dev/null || echo dev)}
commit=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)

# Read here rather than in the plugin section below, because --runbook needs
# them and does not run it.
minapp=$(python3 -c 'import json;print(json.load(open("manifest.json"))["minAppVersion"])')
pluginversion=$(python3 -c 'import json;print(json.load(open("manifest.json"))["version"])')

# A release is built from a committed state or it is not built.
#
# Passing a version explicitly, which is the normal way to call this, threw away
# the only signal that the tree was dirty: `--dirty` above appears in the
# version string and only when $1 is absent. Go stamps the commit and a
# "modified" flag into the binary itself, so a release built over an unfinished
# edit is a different binary that nobody would think to look at.
if ! $runbookonly && { ! git diff --quiet || ! git diff --cached --quiet; }; then
  echo "release: the tree has uncommitted changes, and a release is built from a commit" >&2
  git status --short >&2
  exit 1
fi

# And nothing untracked in what the build reads.
#
# `git diff` only ever compares files git has heard of, so a new .ts under
# client/src is invisible to it and entirely visible to esbuild: it is bundled
# into main.js like any other module, and the release ships a plugin containing
# a file that exists on one machine. The same goes for a .go file the server
# build picks up. Ignored files are excluded, which is what --exclude-standard
# does, so release/ and dist/ do not count.
#
# The server's paths are the ones this repository has: cmd/, internal/ and the
# module files. This list named `server` for as long as it was Basalt's, whose
# Go code lived in server/, and after the fork there was no server/ to look in:
# an untracked .go file under cmd/trewd was compiled into every release binary
# while this said nothing (scripts/release-prepare.test.sh).
untracked=$(git ls-files --others --exclude-standard -- \
  cmd internal go.mod go.sum .goreleaser.yml client manifest.json versions.json)
if ! $runbookonly && [ -n "$untracked" ]; then
  echo "release: these are not in git, and the build reads them anyway:" >&2
  echo "$untracked" | sed 's/^/  /' >&2
  echo "Commit them, delete them, or ignore them. A release is built from a commit." >&2
  exit 1
fi

# And no server release the plugin does not outrank.
#
# BRAT, which is how the plugin is installed until the community directory
# lists it, does not ask GitHub which release is latest. It ranks every release
# in the repository by the version it reads out of the tag name, server/v0.12.0
# as 0.12.0, takes the later tag on a tie, and installs from the first. A server
# release has no manifest.json, so one at the top fails every BRAT install and
# update, as server/v0.12.0 did, tagged two days after plugin 0.12.0 (BRAT
# 2.2.0, grabReleaseFromRepository in src/features/githubUtils.ts).
#
# So the server has to sit below the newest plugin tag, or at most at the
# version this builds the plugin at, provided that plugin is not tagged yet and
# is tagged after the server. verify-release.sh asks the same of what was
# published. Both go when BRAT picks the newest release that has a
# manifest.json (docs/open-work.md).
if ! $runbookonly && [ -n "$serverversion" ]; then
  byversion() { sort -t. -k1,1n -k2,2n -k3,3n; }
  # The lower of two versions, or nothing when they are the same.
  lower() { [ "$1" = "$2" ] || printf '%s\n%s\n' "$1" "$2" | byversion | head -1; }
  # awk rather than grep, which fails on no match, and pipefail would end the
  # script there in silence on a repository with no plugin tag yet.
  newestplugin=$(git tag -l | awk '/^[0-9]+\.[0-9]+\.[0-9]+$/' | byversion | tail -1)
  if [ -n "$newestplugin" ] && [ "$(lower "$serverversion" "$newestplugin")" = "$serverversion" ]; then
    :
  elif ! git rev-parse -q --verify "refs/tags/$pluginversion" >/dev/null \
       && [ "$(lower "$serverversion" "$pluginversion")" != "$pluginversion" ]; then
    :
  else
    echo "release: BRAT would install the plugin from server/v$serverversion, which has no manifest.json." >&2
    echo "  It ranks every release by the version in its tag and takes the later tag on a tie." >&2
    echo "  The newest plugin tag is ${newestplugin:-none}, and manifest.json says $pluginversion." >&2
    echo "  Release the plugin with it, at $serverversion or later and newer than ${newestplugin:-none}:" >&2
    echo "  scripts/release.sh --prepare X.Y.Z, commit, then tag the server first." >&2
    exit 1
  fi
fi

if ! $runbookonly; then

rm -rf "$out"
mkdir -p "$out/plugin" "$out/server"

echo "TrewSync $version ($commit)"
echo

# ---- the server ----------------------------------------------------------
# Static, because the point of a single binary is that the machine it lands on
# needs nothing else. Pure-Go SQLite is what makes CGO_ENABLED=0 possible.
#
# Every platform in .goreleaser.yml, by scripts/build-server.sh, which is what
# the attest workflow rebuilds them with. Only when a version is given: the
# version is stamped into the binary and printed in every journal, and a
# `git describe` string is not one anybody meant to ship.
if [ -n "$serverversion" ]; then
  echo "server  ->  release/server/"
  "$root/scripts/build-server.sh" "$serverversion" "$out/server" > /dev/null
  for f in "$out/server"/trewd-*; do
    printf '  %-24s %s\n' "$(basename "$f")" "$(du -h "$f" | cut -f1)"
  done
else
  rmdir "$out/server"
  echo "server  not built: give the version to build it, scripts/release.sh 0.5.1"
fi

# ---- the plugin ----------------------------------------------------------
echo
echo "plugin  ->  release/plugin/"
( cd client && bun run build >/dev/null )

# Everything the build emits, rather than a list kept here by hand. That list
# said main.js and manifest.json, and styles.css was added to the plugin without
# it being updated, so a release would have installed a plugin whose history
# rows sit on top of one another and whose status bar has no colour. Nothing
# would have errored.
cp -R client/dist/plugin/. "$out/plugin/"

# And the ones it cannot do without, named so that a build which quietly stops
# emitting one fails here instead of shipping.
for required in main.js manifest.json styles.css; do
  [ -f "$out/plugin/$required" ] || { echo "release: the plugin build produced no $required" >&2; exit 1; }
done

# versions.json maps a plugin version to the oldest Obsidian it runs on, and
# it must already say so before this runs (I23).
#
# This used to write the file, which meant the release refused to build over a
# dirty tree and then made one, and the tag went on a commit where the entry
# did not exist yet. Obsidian reads versions.json from the repository at the
# tag: an installer on an older Obsidian looks up the version it is offered,
# finds nothing, and the entry arrives in a follow-up commit that the tag does
# not point at. The git history has that follow-up commit after every release,
# which is the shape of a step in the wrong place.
#
# So preparing it is its own step, run and committed first:
#
#   scripts/release.sh --prepare
#
# and this one only checks. An older entry is the whole point of the file, so
# --prepare updates it in place rather than generating it fresh: rewriting it
# with only the current version tells every older install that nothing it can
# run exists.
have=$(python3 - "$pluginversion" <<'PY'
import json, os, sys
path = "versions.json"
known = json.load(open(path)) if os.path.exists(path) else {}
print(known.get(sys.argv[1], ""))
PY
)
if [ "$have" != "$minapp" ]; then
  echo "release: versions.json does not say plugin $pluginversion needs Obsidian $minapp" >&2
  [ -z "$have" ] && echo "  it has no entry for $pluginversion" >&2 \
                 || echo "  it says $have" >&2
  echo >&2
  echo "  scripts/release.sh --prepare" >&2
  echo >&2
  echo "writes it. Commit that, then run this again: Obsidian reads the file at" >&2
  echo "the tag, so the entry has to be in the commit the tag points at." >&2
  exit 1
fi
rm -f "$out/plugin/versions.json"

printf '  %-24s %s\n' "main.js" "$(du -h "$out/plugin/main.js" | cut -f1)"
printf '  %-24s %s\n' "styles.css" "$(du -h "$out/plugin/styles.css" | cut -f1)"
printf '  %-24s %s\n' "manifest.json" "version $pluginversion, needs Obsidian $minapp"

# ---- checksums -----------------------------------------------------------
#
# One file per release, with names that match what somebody downloads (I23).
#
# There was a single SHA256SUMS covering both, written from `find .` so its
# lines read ./plugin/main.js and ./server/trew-linux-amd64. It was attached
# to the server release only. Neither half worked: `shasum -c SHA256SUMS` in a
# directory of downloaded files looks for a plugin/ and a server/ that are not
# there and reports every file missing, and the plugin release had no checksums
# at all while its sums were published against a release they did not belong to.
#
# Written from inside each directory so the paths are bare names, which is what
# the files are called once downloaded, which is the only spelling under which
# `shasum -c` is a check rather than a puzzle.
#
# The server's is goreleaser's, written over the binaries it built, and is only
# checked here; the plugin's is written here.
parts=plugin
[ -n "$serverversion" ] && parts="server plugin"
echo
( cd "$out/plugin" && find . -type f -not -name SHA256SUMS -print0 \
    | sort -z | xargs -0 -n1 basename | tr '\n' '\0' | xargs -0 shasum -a 256 > SHA256SUMS )
for part in $parts; do
  echo "release/$part/SHA256SUMS"
  sed 's/^/  /' "$out/$part/SHA256SUMS"
done

# And that they verify here, so nobody finds out they do not from a download.
for part in $parts; do
  ( cd "$out/$part" && shasum -a 256 -c --status SHA256SUMS ) \
    || { echo "release: release/$part/SHA256SUMS does not check out here" >&2; exit 1; }
done

# ---- for the release notes -----------------------------------------------
# What a reader can run to check what they downloaded came from this repository
# at that commit. Printed here because this is the one place that knows every
# asset name, and the sums first because it is the check that needs no tools.
echo
echo "For the release notes, so anyone can check what they downloaded:"
echo
echo '  ```bash'
echo "  shasum -a 256 -c SHA256SUMS"
for asset in main.js manifest.json styles.css; do
  echo "  gh attestation verify $asset --repo waynehoover/trewsync"
done
echo '  ```'
echo
if [ -n "$serverversion" ]; then
  # The names were trew-<os>-<arch>, from before the command was renamed, so
  # every one of these told a reader to verify a file the release did not have.
  echo "and for the server release, where the manifest is the one attest.yml signs:"
  echo
  echo '  ```bash'
  echo "  shasum -a 256 -c SHA256SUMS"
  for f in "$out/server"/trewd-*; do
    echo "  gh attestation verify $(basename "$f") --repo waynehoover/trewsync"
  done
  echo "  packslip verify packslip.server.sigstore.json \\"
  echo "    --identity-prefix https://github.com/waynehoover/trewsync/.github/workflows/attest.yml@refs/tags/server/v$serverversion \\"
  echo "    --issuer https://token.actions.githubusercontent.com --artifact trewd-linux-amd64"
  echo '  ```'
fi

fi  # ! $runbookonly

# ---- what to do with them ------------------------------------------------
#
# Printed rather than done. The tag is the decision and this is only what
# follows from it.
#
# Every heredoc below is quoted, and the values are put in afterwards by
# python3. An unquoted heredoc hands the whole runbook to the shell first, and a
# runbook is made of exactly what a shell eats: this one lost `created` to a
# subshell once and then lost both halves of "Bare versions, not tag names:
# `--server 0.5.0`, not `--server server/v0.5.0`" to another, printing "Bare
# versions, not tag names: , not ." The failure is silent by construction,
# because the characters that would show you something went wrong are the ones
# that got eaten. Escaping them works and has to be done again by whoever writes
# the next sentence, which is how it came back twice.
#
# python3 rather than ${var//@NAME@/value}, which is what this was written with
# first and which is not literal on every bash. Since 5.2 an unescaped `&` in
# the replacement stands for the text that was matched, and one of the values
# below is a command line joined by `&&`, so on the runner every `&&` in it came
# back as `@SERVERBLOCK@` and the guard at the end refused to print any of it.
# macOS ships bash 3.2, which has never had the feature, so it was right here
# and wrong in CI: the fourth time that has happened and the reason check.sh no
# longer claims a green run means a green build. Escaping the `&` would work and
# would be one more thing to remember. python3's str.replace has no
# metacharacters at all, and this script already needs python3 to read the
# manifest.

# The client's version is its own, from the file npm publishes it from.
cliversion=$(python3 -c 'import json;print(json.load(open("client/package.json"))["version"])')

# The server block, and the verify flag, only where a version was given.
if [ -n "$serverversion" ]; then
  serverblock=$(cat <<'BLOCK'
  git tag -a server/v@SERVER@ -m "trewd @SERVER@" && git push origin server/v@SERVER@
  gh release create server/v@SERVER@ --draft --title "trewd @SERVER@" \
    --notes-file /tmp/trew-server-@SERVER@-notes.md \
    release/server/*

A draft here too, and finished the same way:

  gh workflow run attest.yml --ref server/v@SERVER@ -f tag=server/v@SERVER@

which rebuilds the binaries with goreleaser, attests and checksums them, signs
packslip.server.sigstore.json (the manifest trewd update and mise install
from, signed with the identity of that workflow) and then publishes it. A
release without that manifest is one no trewd update will install. The
--ref is not optional: trewd update accepts only a manifest signed by
attest.yml run from the tag of that very release, so a dispatch from main signs
a manifest nothing installs.

Pushing that tag is also what builds and pushes the container image. Once it is
published, pin it:

  scripts/pin-compose.sh && git add -A && git commit -m 'compose: pin the @SERVER@ server image' && git push

Nothing is waiting on that. pin-check excuses the commit the server tag points
at, because the image is built by the tag being pushed and the digest does not
exist while that commit is being written, so main stays green and the plugin
and client tags can go on the same commit without waiting for the image. It
excuses that one commit only: the next thing to land has to carry the pin.

Then render the Homebrew formula from the sums that were published, not the
ones built here, and copy it into the tap (docs/development.md says where):

  gh release download server/v@SERVER@ --repo waynehoover/trewsync --pattern SHA256SUMS --dir /tmp/trewd-@SERVER@
  scripts/homebrew-formula.sh @SERVER@ /tmp/trewd-@SERVER@/SHA256SUMS > packaging/homebrew/trewd.rb
BLOCK
  )
  verifyserver=" --server @SERVER@"
  # Before the plugin's commands, because it changes the order they run in.
  order=$'\n\n'$(cat <<'BLOCK'
With the server going out as well, tag and draft the server first and the
plugin second, then run the plugin's attest, and the server's only once the
plugin's has published. BRAT installs from the release whose tag has the
highest version, takes the later tag on a tie, and cannot install from a server
release, so the plugin must be the later tag and the first one published.
BLOCK
  )
else
  serverblock=$(cat <<'BLOCK'
  Re-run with the version to print these:  scripts/release.sh 0.5.1

  Without it there is nothing to build a tag name out of but `git describe`,
  and a tag called server/v@DESCRIBE@ is not what anybody meant.
BLOCK
  )
  verifyserver=""
  order=""
fi

template=$(mktemp); trap 'rm -f "$template"' EXIT
cat > "$template" <<'RUNBOOK'

Before publishing, draft user-facing notes in /tmp/trew-plugin-@PLUGIN@-notes.md
and, when shipping a server, /tmp/trew-server-X.Y.Z-notes.md with its version.
Summarize additions, fixes, upgrade steps and known issues since the previous
component release. Include CLI changes in the plugin notes when they ship
together. Publish the notes on GitHub; do not commit duplicate changelog docs.

The plugin's version is set, with its versions.json entry, by one committed
step before any of this, and it refuses a version that is not newer than every
one versions.json already names:

  scripts/release.sh --prepare X.Y.Z@ORDER@

To publish the plugin, tagged and titled bare because the community directory
requires the tag, and asks the release name, to be exactly the manifest version:

  git tag -a @PLUGIN@ -m "TrewSync @PLUGIN@" && git push origin @PLUGIN@
  gh release create @PLUGIN@ --draft --title "@PLUGIN@" \
    --notes-file /tmp/trew-plugin-@PLUGIN@-notes.md \
    release/plugin/main.js release/plugin/manifest.json release/plugin/styles.css \
    release/plugin/SHA256SUMS

Then start the workflow that finishes it:

  gh workflow run attest.yml --ref @PLUGIN@ -f tag=@PLUGIN@

A draft, and that is not a detail: it checks that CI passed on that commit,
rebuilds these three files, signs them, writes the checksums for what it built,
and publishes the release as its last step. Nothing is downloadable until all
of that has passed, and a run that fails leaves a draft you can delete.

The dispatch is a second command because GitHub does not fire a release event
for a draft: `created` is documented as excluding them, so a workflow listening
for it would leave the draft sitting there with nothing running and no sign
that anything was wrong.

To publish the server, on its own tag because it moves on its own clock:

@SERVERBLOCK@

The headless client builds nothing here, because npm is where it goes. Bump
client/package.json on its own clock, then:

  git tag -a cli/v@CLI@ -m "trew CLI @CLI@" && git push origin cli/v@CLI@

That tag publishes it over OIDC, with no token and no 2FA code.

After publication, read each GitHub release body back and check that its
changelog and upgrade instructions are present:

  gh release view @PLUGIN@ --json body,url

Use the server tag for the server release. To correct published notes, prepare
a temporary body file and use `gh release edit TAG --notes-file FILE`.

Then check the release from the outside, which is the only place several of
these can be wrong: the attestations are rebuilt and re-uploaded after the
release is created, `latest` moves during it, and an npm version cannot be
replaced once it is there.

  scripts/verify-release.sh --plugin @PLUGIN@ --cli @CLI@@VERIFYSERVER@

Bare versions, not tag names: `--server 0.5.1`, not `--server server/v0.5.1`.

It fetches the assets, checks the sums under the names somebody downloads them
as, verifies the attestations on the bytes that are there now, runs the image on
both architectures, and installs the package from npm.
RUNBOOK

# The ones carrying placeholders of their own go in first, or the pass that
# would have resolved them has already gone by. @VERIFYSERVER@ was last here and
# put an unresolved @SERVER@ into the verify command; the guard below is what
# said so, on its first run.
runbook=$(python3 - "$template" \
  "$serverblock" "$verifyserver" "$order" "$serverversion" "$version" "$pluginversion" "$cliversion" <<'PY'
import sys

names = ("@SERVERBLOCK@", "@VERIFYSERVER@", "@ORDER@", "@SERVER@", "@DESCRIBE@", "@PLUGIN@", "@CLI@")
text = open(sys.argv[1]).read()
for name, value in zip(names, sys.argv[2:]):
    text = text.replace(name, value)
sys.stdout.write(text)
PY
)

# Nothing may reach the terminal with a placeholder still in it. A name added to
# the prose and not to the list above would otherwise print @THING@ in the
# middle of a command that somebody pastes.
if grep -q '@[A-Z][A-Z]*@' <<< "$runbook"; then
  echo "release: the runbook still has a placeholder in it:" >&2
  printf '%s' "$runbook" | grep -o '@[A-Z][A-Z]*@' | sort -u | sed 's/^/  /' >&2
  exit 1
fi

printf '%s\n' "$runbook"
