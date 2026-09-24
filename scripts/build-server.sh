#!/usr/bin/env bash
#
# Builds every trewd binary a server release ships, with goreleaser, into one
# flat directory:
#
#   scripts/build-server.sh 0.2.0 release/server
#
# leaves release/server/trewd-<os>-<arch> for each platform in .goreleaser.yml
# and a SHA256SUMS over them, whose lines are bare names so `shasum -c` works in
# a directory of downloaded files.
#
# The one way the server is built for a release. scripts/release.sh calls it for
# the local copy, .github/workflows/attest.yml calls it for the copy that is
# attested and published, and the checks call it for a snapshot. Before this,
# each of those had its own loop over four targets, and they agreed because
# somebody kept them agreeing.
#
# goreleaser leaves binary "archives" in per-target directories under its dist
# and lists them in artifacts.json; they are copied out by that list rather
# than by a glob, so a platform goreleaser did not build is missing here too,
# and the check at the end says so instead of shipping one fewer binary.
set -euo pipefail

version=${1:?usage: build-server.sh VERSION OUTDIR}
out=${2:?usage: build-server.sh VERSION OUTDIR}
version=${version#server/v}
version=${version#v}

cd "$(dirname "$0")/.."
root=$(pwd)

# A version that is not X.Y.Z (with an optional prerelease) is a tag this
# cannot have come from, and `trewd version` would print it to every journal.
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "build-server: $version is not a release version (X.Y.Z)" >&2
  exit 2
fi

goreleaser=$("$root/scripts/release-tools.sh" goreleaser)
dist="$root/release/goreleaser"

TREWD_VERSION=$version "$goreleaser" release --snapshot --clean --config "$root/.goreleaser.yml" >&2

mkdir -p "$out"
python3 - "$dist" "$out" <<'PY'
import json, os, shutil, sys

dist, out = sys.argv[1], sys.argv[2]
copied = []
for a in json.load(open(os.path.join(dist, "artifacts.json"))):
    # The binary "archive" entries are the ones renamed trewd-<os>-<arch>; the
    # plain Binary entries beside them are the same files under goreleaser's
    # own name, trewd.
    if a.get("type") == "Binary" and a.get("name", "").startswith("trewd-"):
        dst = os.path.join(out, a["name"])
        shutil.copyfile(a["path"], dst)
        os.chmod(dst, 0o755)
        copied.append(a["name"])
shutil.copyfile(os.path.join(dist, "SHA256SUMS"), os.path.join(out, "SHA256SUMS"))
print("\n".join(sorted(copied)))
PY

# Every platform the config names, and every one of them in the sums, checked
# here rather than trusted.
want=$(sed -n 's/^\([0-9a-f]\{64\}\)  \(trewd-.*\)$/\2/p' "$out/SHA256SUMS" | sort)
have=$(cd "$out" && find . -maxdepth 1 -name 'trewd-*' -type f | sed 's|^\./||' | sort)
if [ "$want" != "$have" ] || [ -z "$have" ]; then
  echo "build-server: SHA256SUMS and the binaries do not agree" >&2
  diff <(printf '%s\n' "$want") <(printf '%s\n' "$have") >&2 || true
  exit 1
fi
( cd "$out" && shasum -a 256 -c --status SHA256SUMS ) || {
  echo "build-server: $out/SHA256SUMS does not check out" >&2
  exit 1
}
