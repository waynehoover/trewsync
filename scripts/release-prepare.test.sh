#!/usr/bin/env bash
#
# The plugin's version step, and the guard in front of a release build.
#
# `scripts/release.sh --prepare X.Y.Z` is the one step that sets the plugin's
# version: manifest.json and versions.json together, committed before the tag.
# It must refuse a version that is not greater than every version versions.json
# already names (plan/research/README.md, Packaging (M9), from Obsyncian and
# Pumice), because Obsidian offers the newest entry an install can run, so an
# entry below the newest is never offered and an equal one is a second release
# under a version the directory has already served.
#
# And the build must refuse untracked source it would compile. Its list named
# server/, Basalt's Go directory, which this repository does not have.
#
# Run in a throwaway repository, because every case writes the two files.
set -uo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fails=0
ok() { printf '  ok   %s\n' "$1"; }
bad() { printf '  FAIL %s\n' "$1" >&2; fails=$((fails + 1)); }

mkdir -p "$work/scripts" "$work/cmd/trewd"
cp "$root/scripts/release.sh" "$work/scripts/"
printf '{\n\t"id": "trew-sync",\n\t"version": "0.10.0",\n\t"minAppVersion": "1.7.2",\n\t"isDesktopOnly": false\n}\n' \
  > "$work/manifest.json"
printf '{\n  "0.9.0": "1.7.2",\n  "0.9.9": "1.7.2",\n  "0.10.0": "1.7.2"\n}\n' > "$work/versions.json"
printf 'package main\n\nfunc main() {}\n' > "$work/cmd/trewd/main.go"
printf 'release/\n' > "$work/.gitignore"
git -C "$work" init -q
git -C "$work" -c user.email=t@example.test -c user.name=test -c commit.gpgsign=false \
  -c core.hooksPath=/dev/null add -A
git -C "$work" -c user.email=t@example.test -c user.name=test -c commit.gpgsign=false \
  -c core.hooksPath=/dev/null commit -qm fixture

prepare() { # prepare <expect ok|refuse> <what> [version]
  local expect=$1 what=$2 rc=0
  shift 2
  ( cd "$work" && bash scripts/release.sh --prepare "$@" ) > "$work/out" 2>&1 || rc=$?
  if { [ "$expect" = ok ] && [ $rc -ne 0 ]; } || { [ "$expect" = refuse ] && [ $rc -eq 0 ]; }; then
    bad "$what (exit $rc)"
    sed 's/^/       /' "$work/out" >&2
  else
    ok "$what"
  fi
}
files() { cat "$work/manifest.json" "$work/versions.json"; }
unchanged() { # unchanged <before>
  [ "$(files)" = "$1" ] && ok "  and neither file changed" || bad "  a refusal changed the files"
}
version_is() { # version_is <want>
  local m v
  m=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$work/manifest.json")
  v=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2], ""))' "$work/versions.json" "$1")
  if [ "$m" = "$1" ] && [ "$v" = 1.7.2 ]; then
    ok "  manifest.json says $1 and versions.json says it needs 1.7.2"
  else
    bad "  manifest.json says $m and versions.json says $1 needs \"$v\""
  fi
}

before=$(files)
prepare ok "the version already prepared is a no-op" 0.10.0
grep -q "Already said so" "$work/out" || bad "  and it did not say so"
unchanged "$before"
prepare ok "so is no version, when the manifest's is the newest"
unchanged "$before"
prepare refuse "an older version is refused" 0.9.9
unchanged "$before"
prepare refuse "a version between two released ones is refused" 0.9.5
unchanged "$before"
for malformed in v0.11.0 0.11 0.11.0-rc.1 0.11.0.1 011.0.0; do
  prepare refuse "$malformed is not a plugin version" "$malformed"
done
unchanged "$before"

prepare ok "a newer version is prepared" 0.11.0
version_is 0.11.0
if python3 - "$work/versions.json" <<'PY'
import json, sys
known = json.load(open(sys.argv[1]))
sys.exit(0 if list(known) == ["0.9.0", "0.9.9", "0.10.0", "0.11.0"] else 1)
PY
then ok "  every older entry is kept, and the new one is last"
else bad "  versions.json lost or reordered an entry: $(cat "$work/versions.json")"
fi
[ "$(git -C "$work" diff --numstat -- manifest.json | awk '{print $1 "+" $2 "-"}')" = "1+1-" ] \
  && grep -q $'^\t"version": "0.11.0",$' "$work/manifest.json" \
  && ok "  manifest.json changed on its version line only, tabs kept" \
  || bad "  manifest.json was rewritten beyond its version: $(git -C "$work" diff -- manifest.json)"

after=$(files)
prepare ok "preparing it again changes nothing" 0.11.0
unchanged "$after"
prepare refuse "the version before it is refused now" 0.10.0
unchanged "$after"
prepare refuse "and so is a patch of an older minor" 0.10.1
unchanged "$after"
prepare ok "versions compare as numbers, not text: 0.100.0 is after 0.11.0" 0.100.0
version_is 0.100.0

# A hand edit that moved the manifest behind the newest entry.
python3 - "$work/manifest.json" <<'PY'
import sys
p = sys.argv[1]
open(p, "w").write(open(p).read().replace('"0.100.0"', '"0.9.0"'))
PY
prepare refuse "no version, with the manifest behind versions.json, is refused"

# ---- the build's guard against untracked source ------------------------------
git -C "$work" checkout -q -- manifest.json versions.json
printf 'package main\n\nvar injected = 1\n' > "$work/cmd/trewd/extra.go"
rc=0
( cd "$work" && bash scripts/release.sh 0.5.1 ) > "$work/out" 2>&1 || rc=$?
if [ $rc -ne 0 ] && grep -q "cmd/trewd/extra.go" "$work/out" && grep -q "not in git" "$work/out"; then
  ok "a release build refuses an untracked .go file under cmd/, naming it"
else
  bad "a release build did not refuse cmd/trewd/extra.go as untracked (exit $rc)"
  sed 's/^/       /' "$work/out" >&2
fi

# ---- the build's guard against a server release BRAT would install from ------
#
# BRAT installs the plugin from the release with the highest version in its
# tag, a tie going to the later tag, and a server release has no manifest.json.
# A build the guard lets through starts, says so, and fails here for want of
# the server build script, which is fine: what counts is that it started. Only
# not being refused is not enough, because the first version of this guard
# ended the script in silence when there was no plugin tag, and passed.
rm "$work/cmd/trewd/extra.go"
server() { # server <expect ok|refuse> <what> <version>
  local expect=$1 what=$2 rc=0 refused=no started=no
  ( cd "$work" && bash scripts/release.sh "$3" ) > "$work/out" 2>&1 || rc=$?
  grep -q "BRAT would install" "$work/out" && refused=yes
  grep -q "^TrewSync $3 " "$work/out" && started=yes
  if { [ "$expect" = refuse ] && [ $refused = yes ] && [ $rc -ne 0 ]; } \
     || { [ "$expect" = ok ] && [ $refused = no ] && [ $started = yes ]; }; then
    ok "$what"
  else
    bad "$what (exit $rc)"
    sed 's/^/       /' "$work/out" >&2
  fi
}
server ok     "a server at the version of the plugin about to be tagged after it" 0.10.0
server refuse "a server above the plugin about to be tagged" 0.11.0
git -C "$work" tag 0.10.0
server refuse "a server at the plugin's version once the plugin is tagged, which BRAT ties to the server" 0.10.0
server refuse "a server above the newest plugin tag" 0.10.1
server ok     "a server below the newest plugin tag, compared as numbers: 0.9.10 is before 0.10.0" 0.9.10

if [ "$fails" -ne 0 ]; then
  echo "$fails check(s) failed" >&2
  exit 1
fi
echo "the release version step refuses what it should"
