#!/usr/bin/env bash
#
# The release manifest, signed and checked the way a release does it, and
# `trewd update` run against a feed signed that way.
#
# A server release carries packslip.server.sigstore.json: a signed statement of
# every trewd binary's digest, size and platform, which mise installs from and
# `trewd update` refuses to install without (docs/development.md, "Releases").
# The real one is signed by the release workflow's GitHub identity, which
# nothing on a laptop can produce, so this signs a goreleaser snapshot with a
# key made for the purpose instead, unlogged, and checks:
#
#   1. the manifest names every binary, on the platform its name says, with
#      the digest SHA256SUMS gives it and no shared libraries;
#   2. packslip verifies each binary against it, and refuses a tampered
#      binary, another key, and an unlogged bundle nobody allowed;
#   3. `trewd update`, built with the one test hook that swaps its trust pin
#      for that key (cmd/trewd/update_testpin.go), refuses a tampered feed, a
#      feed signed by another key and a downgrade, leaving the installed binary
#      byte-identical every time, and otherwise installs the signed binary,
#      which then runs as the new version;
#   4. a release build, with the real pin, refuses the key-signed feed
#      outright, because a key is not the release workflow.
#
# Nothing is published. The feed is a directory served on 127.0.0.1.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work=$(mktemp -d)
server_pid=""
cleanup() {
  [ -z "$server_pid" ] || kill "$server_pid" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT
fails=0
fail() { printf '  FAIL %s\n' "$1" >&2; fails=$((fails + 1)); }
ok() { printf '  ok   %s\n' "$1"; }

packslip=$("$root/scripts/release-tools.sh" packslip)
project=github.com/waynehoover/trewsync/server
bundle_name=packslip.server.sigstore.json
new=0.2.0
goos=$(cd "$root" && go env GOOS)
goarch=$(cd "$root" && go env GOARCH)
host=trewd-$goos-$goarch

port=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
base=http://127.0.0.1:$port

echo "the release manifest:"
"$root/scripts/build-server.sh" "$new" "$work/dist" > /dev/null 2>"$work/build.log" || {
  cat "$work/build.log" >&2
  echo "the snapshot build failed" >&2
  exit 1
}
binaries=()
while IFS= read -r name; do binaries+=("$work/dist/$name"); done < <(cd "$work/dist" && ls trewd-* | sort)

"$packslip" keygen --out "$work/release.key" > /dev/null
"$packslip" keygen --out "$work/other.key" > /dev/null
"$packslip" create --project "$project" --version "$new" \
  --key "$work/release.key" --no-log --out "$work/dist" \
  --url-base "$base/good/dl/server/v$new" --bin trewd \
  --tag "server/v$new" --source-repo https://github.com/waynehoover/trewsync \
  --commit "$(git -C "$root" rev-parse HEAD)" \
  "${binaries[@]}" > "$work/create.log" 2>&1 || {
  cat "$work/create.log" >&2
  echo "packslip create failed" >&2
  exit 1
}
bundle=$work/dist/$bundle_name
[ -s "$bundle" ] && ok "packslip names the monorepo tool's bundle $bundle_name" \
  || { fail "packslip wrote no $bundle_name"; ls "$work/dist" >&2; exit 1; }

"$packslip" show "$bundle" > "$work/statement.json"
if python3 - "$work/statement.json" "$work/dist/SHA256SUMS" "$project" "$new" <<'PY'
import json, sys

st = json.load(open(sys.argv[1]))
sums = {}
for line in open(sys.argv[2]):
    digest, name = line.split()
    sums[name] = digest
project, version = sys.argv[3], sys.argv[4]
os_names = {"linux": "linux", "darwin": "darwin", "freebsd": "freebsd"}
arch_names = {"amd64": "x86_64", "arm64": "aarch64", "riscv64": "riscv64"}
bad = []
p = st["predicate"]
if st["predicateType"] != "https://packslip.dev/release/v1":
    bad.append("predicateType is %s" % st["predicateType"])
if p["project"] != project or p["version"] != version:
    bad.append("it is %s %s" % (p["project"], p["version"]))
subjects = {s["name"]: s["digest"]["sha256"] for s in st["subject"]}
if set(subjects) != set(sums):
    bad.append("it signs %s and SHA256SUMS lists %s" % (sorted(subjects), sorted(sums)))
for a in p["artifacts"]:
    _, goos, goarch = a["name"].split("-")
    if a.get("os") != os_names[goos] or a.get("arch") != arch_names[goarch]:
        bad.append("%s is described as %s/%s" % (a["name"], a.get("os"), a.get("arch")))
    if a.get("format") != "raw":
        bad.append("%s is format %s, not a bare executable" % (a["name"], a.get("format")))
    if [b.get("name") for b in a.get("bin", [])] != ["trewd"]:
        bad.append("%s installs as %s" % (a["name"], a.get("bin")))
    if a.get("requires", {}).get("libs") != []:
        bad.append("%s needs shared libraries %s, and a release build is static" % (a["name"], a.get("requires")))
    if subjects.get(a["name"]) != sums.get(a["name"]):
        bad.append("%s is signed as %s and summed as %s" % (a["name"], subjects.get(a["name"]), sums.get(a["name"])))
for b in bad:
    print(b, file=sys.stderr)
sys.exit(1 if bad else 0)
PY
then
  ok "it describes every binary on its platform, raw, static, with the digest SHA256SUMS gives"
else
  fail "the statement does not describe the release"
fi

verified=0
for b in "${binaries[@]}"; do
  if "$packslip" verify "$bundle" --pubkey "$work/release.pub" --allow-unlogged --artifact "$b" > /dev/null 2>&1; then
    verified=$((verified + 1))
  else
    fail "packslip does not verify $(basename "$b") against the manifest"
  fi
done
[ "$verified" = "${#binaries[@]}" ] && ok "packslip verifies all $verified binaries against it"

mkdir -p "$work/tampered"
cp "$work/dist/$host" "$work/tampered/$host"
printf 'x' >> "$work/tampered/$host"
"$packslip" verify "$bundle" --pubkey "$work/release.pub" --allow-unlogged --artifact "$work/tampered/$host" \
  > /dev/null 2>&1 && fail "packslip accepted a binary with a byte added" || ok "and refuses a binary with a byte added"
"$packslip" verify "$bundle" --pubkey "$work/other.pub" --allow-unlogged --artifact "$work/dist/$host" \
  > /dev/null 2>&1 && fail "packslip accepted another key's pin" || ok "and a pin on another key"
"$packslip" verify "$bundle" --pubkey "$work/release.pub" --artifact "$work/dist/$host" \
  > /dev/null 2>&1 && fail "packslip accepted an unlogged bundle nobody allowed" || ok "and an unlogged bundle nobody allowed"

echo "trewd update against a feed signed that way:"

# The feed: GitHub's releases endpoint as files. `good` is the release as
# built; `tampered` has this machine's binary altered after signing and its
# SHA256SUMS line rewritten to match, so only the signature can catch it.
feed() { # feed <name> <assets dir>
  local dir=$work/feed/$1
  mkdir -p "$dir/repos/waynehoover/trewsync" "$dir/dl/server/v$new" "$dir/dl/0.10.0"
  cp "$2"/trewd-* "$2/SHA256SUMS" "$2/$bundle_name" "$dir/dl/server/v$new/"
  printf 'module.exports = {};\n' > "$dir/dl/0.10.0/main.js"
  python3 - "$dir" "$base/$1" "$new" > "$dir/repos/waynehoover/trewsync/releases" <<'PY'
import json, os, sys
dir, base, new = sys.argv[1], sys.argv[2], sys.argv[3]
def release(tag, **kw):
    names = sorted(os.listdir(os.path.join(dir, "dl", tag)))
    return dict(tag_name=tag, draft=False, prerelease=False,
                assets=[dict(name=n, browser_download_url="%s/dl/%s/%s" % (base, tag, n)) for n in names], **kw)
print(json.dumps([release("0.10.0"), release("server/v" + new)]))
PY
}
feed good "$work/dist"
mkdir -p "$work/bad"
cp "$work/dist"/trewd-* "$work/dist/$bundle_name" "$work/bad/"
printf 'x' >> "$work/bad/$host"
( cd "$work/bad" && shasum -a 256 trewd-* > SHA256SUMS )
feed tampered "$work/bad"

python3 -m http.server "$port" --bind 127.0.0.1 --directory "$work/feed" > "$work/http.log" 2>&1 &
server_pid=$!
# So bash does not report the kill in cleanup as though something had failed.
disown "$server_pid" 2>/dev/null || true
for _ in $(seq 1 50); do
  curl -fsS "$base/good/repos/waynehoover/trewsync/releases" > /dev/null 2>&1 && break
  sleep 0.1
done

# The binary being updated, built with the test hook. Everything but its trust
# pin is the release's code.
mkdir -p "$work/install"
( cd "$root" && CGO_ENABLED=0 go build -tags updatetest -trimpath \
    -ldflags "-s -w -X main.version=0.1.0" -o "$work/install/trewd" ./cmd/trewd )
( cd "$root" && CGO_ENABLED=0 go build -tags updatetest -trimpath \
    -ldflags "-s -w -X main.version=0.3.0" -o "$work/newer" ./cmd/trewd )
grep -q $'\tbuild\t-tags=updatetest' <<< "$(cd "$root" && go version -m "$work/install/trewd")" \
  || fail "the hooked binary does not record its build tag, so goreleaser-check could not see one either"
installed=$(shasum -a 256 "$work/install/trewd" | awk '{print $1}')

update() { # update <expect ok|refuse> <what> <feed> <pubkey or ""> [binary] [flags...]
  local expect=$1 what=$2 name=$3 key=$4 bin=${5:-$work/install/trewd} rc=0
  shift 5 || shift $#
  TREWD_UPDATE_TEST_PUBKEY=$key "$bin" update -feed "$base/$name" -packslip "$packslip" "$@" \
    > "$work/update.log" 2>&1 || rc=$?
  if { [ "$expect" = ok ] && [ $rc -ne 0 ]; } || { [ "$expect" = refuse ] && [ $rc -eq 0 ]; }; then
    fail "$what (exit $rc)"
    sed 's/^/       /' "$work/update.log" >&2
  else
    ok "$what"
  fi
}
because() { # because <text> -- the last refusal said this, and so was the one meant
  grep -qF "$1" "$work/update.log" && ok "  because: $1" || {
    fail "  refused, but not because $1:"
    sed 's/^/       /' "$work/update.log" >&2
  }
}
same() { # same <what>
  if [ "$(shasum -a 256 "$work/install/trewd" | awk '{print $1}')" = "$installed" ]; then
    ok "  and the installed binary is byte-identical"
  else
    fail "  the installed binary changed after: $1"
  fi
  if [ "$(ls -A "$work/install")" != trewd ]; then
    fail "  and something was left beside it: $(ls -A "$work/install" | tr '\n' ' ')"
  fi
}

update refuse "a binary altered after signing is refused, though SHA256SUMS matches it" tampered "$work/release.pub" ""
because "packslip refused it"
same "the tampered feed"
update refuse "a feed signed by another key is refused" good "$work/other.pub" ""
because "packslip refused it"
same "another key"
update refuse "the release pin refuses a key-signed feed: a key is not the release workflow" good "" ""
because "packslip refused it"
same "the release pin"
update ok "a dry run verifies the signed release" good "$work/release.pub" "" -dry-run
same "the dry run"
grep -q "verified: signed by" "$work/update.log" || fail "the dry run did not say who signed it"
update ok "the signed release installs" good "$work/release.pub" ""
said=$("$work/install/trewd" version | awk 'NR == 1 { print $2 }')
[ "$said" = "$new" ] && ok "  and the installed binary now says it is $new" \
  || fail "the installed binary says it is $said, not $new"
cmp -s "$work/install/trewd" "$work/dist/$host" && ok "  and is exactly the signed $host" \
  || fail "the installed binary is not the signed $host"
[ "$(ls -A "$work/install")" = trewd ] || fail "the update left something beside the binary: $(ls -A "$work/install")"
update ok "updating it again finds nothing newer" good "" ""
grep -q "nothing to do" "$work/update.log" || fail "a second update did something"
update refuse "a newer binary is not downgraded to the feed's release" good "$work/release.pub" "$work/newer"
because "does not downgrade"

if [ "$fails" -ne 0 ]; then
  echo "$fails check(s) failed" >&2
  exit 1
fi
echo "the release manifest signs and verifies, and trewd update installs only what it names"
