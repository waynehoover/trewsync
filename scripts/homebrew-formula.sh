#!/usr/bin/env bash
#
# Prints the Homebrew formula for one server release:
#
#   scripts/homebrew-formula.sh 0.2.0 path/to/SHA256SUMS > packaging/homebrew/trewd.rb
#
# from packaging/homebrew/trewd.rb, with its version and every sha256 replaced
# by that release's. The SHA256SUMS is the one downloaded from the published
# release, not the one scripts/release.sh wrote locally: the attest workflow
# rebuilds the binaries before publishing, and the formula has to name the
# bytes a person downloads.
#
# Each sha256 line carries the asset it is for as a trailing comment, and every
# one must be found in SHA256SUMS: a formula with one placeholder left in it is
# a formula that fails on exactly one kind of machine, which is the worst kind
# of failure to find from a bug report.
set -euo pipefail

version=${1:?usage: homebrew-formula.sh VERSION SHA256SUMS}
sums=${2:?usage: homebrew-formula.sh VERSION SHA256SUMS}
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

python3 - "$root/packaging/homebrew/trewd.rb" "${version#server/v}" "$sums" <<'PY'
import re, sys

template, version, sums_path = sys.argv[1], sys.argv[2], sys.argv[3]
if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version):
    sys.exit("homebrew-formula: %r is not a server release version (X.Y.Z)" % version)

sums = {}
for line in open(sums_path):
    fields = line.split()
    if len(fields) == 2 and re.fullmatch(r"[0-9a-f]{64}", fields[0]):
        sums[fields[1].lstrip("*")] = fields[0]

text = open(template).read()
text, n = re.subn(r'^(  version ")[^"]*(")$', r"\g<1>%s\g<2>" % version, text, count=1, flags=re.M)
if n != 1:
    sys.exit("homebrew-formula: no version line in %s" % template)

missing = []
def put(m):
    asset = m.group(3)
    if asset not in sums:
        missing.append(asset)
        return m.group(0)
    return m.group(1) + sums[asset] + m.group(2) + asset
text, n = re.subn(r'^(\s+sha256 ")[0-9a-f]{64}(" # )(trewd-[a-z0-9]+-[a-z0-9]+)$', put, text, flags=re.M)
if n == 0:
    sys.exit("homebrew-formula: no sha256 lines in %s" % template)
if missing:
    sys.exit("homebrew-formula: %s does not list %s" % (sums_path, ", ".join(missing)))
sys.stdout.write(text)
PY
