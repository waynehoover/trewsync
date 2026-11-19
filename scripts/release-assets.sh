#!/usr/bin/env bash
#
# Refuse to publish a release holding anything but the files named.
#
# scripts/release.sh uploads a draft from a laptop and attest.yml replaces the
# files it rebuilds. Anything else on the draft (a stray file, a binary that
# goreleaser stopped building, a name typed wrong) would go public beside the
# attested ones, unattested, and look exactly as trustworthy. So the attest
# workflow names what it attested, and this refuses the release unless that is
# the whole of it: nothing extra and nothing missing.
#
# Usage: release-assets.sh <tag> <asset name>...
#
# Env:
#   GH_TOKEN           a token that can read the draft
#   GITHUB_REPOSITORY  owner/repo
set -euo pipefail

tag=${1:?usage: release-assets.sh <tag> <asset name>...}
shift
[ "$#" -gt 0 ] || { echo "release-assets.sh: name at least one asset" >&2; exit 2; }
repo=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}

want=$(printf '%s\n' "$@" | sort -u)
have=$(gh release view "$tag" --repo "$repo" --json assets --jq '.assets[].name' | sort -u)

extra=$(comm -13 <(printf '%s\n' "$want") <(printf '%s\n' "$have") | sed '/^$/d')
missing=$(comm -23 <(printf '%s\n' "$want") <(printf '%s\n' "$have") | sed '/^$/d')

if [ -n "$extra" ] || [ -n "$missing" ]; then
  echo "$tag does not hold exactly the attested files:" >&2
  [ -z "$extra" ] || printf '  not attested, remove it: %s\n' $extra >&2
  [ -z "$missing" ] || printf '  missing: %s\n' $missing >&2
  exit 1
fi
echo "$tag holds exactly: $(printf '%s ' $want)"
