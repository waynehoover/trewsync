#!/usr/bin/env bash
#
# Points compose.yaml and the docs at the newest published server image.
#
# Why this is not part of scripts/release.sh: the digest does not exist until
# the image does, and the image is built by CI from the `server/v*` tag. The
# order is commit, tag, push, wait for CI, then run this. A release script
# cannot pin what has not been published yet.
#
# Why the file is pinned at all, rather than saying `latest`: compose.yaml is
# the example somebody copies for the machine they keep running, and the whole
# point of a pin is that `docker compose pull` cannot move them to an image
# nobody tested against their devices. `latest` would make the example
# contradict the paragraph beside it.
#
# Forgetting to run this is caught: .github/workflows/ci.yml fails when the pin
# is older than the newest server tag, which is how it went two releases stale
# without anybody noticing.
#
# Reads the digest from the registry rather than computing or guessing it, and
# refuses if the tag is not published. No commit, no push: it edits the files
# and prints what changed.
set -euo pipefail

cd "$(dirname "$0")/.."
image=ghcr.io/waynehoover/trewsync

version=${1:-}
if [ -z "$version" ]; then
  version=$(git tag --list 'server/v*' | sed 's|server/v||' | sort -V | tail -1)
  [ -n "$version" ] || { echo "pin-compose: no server/v* tag to pin to" >&2; exit 1; }
fi
version=${version#server/v}
version=${version#v}

echo "pinning to $image:$version"

# The registry, not a local build: what a person pulls is what is published,
# and a digest from `docker build` here would name an image nobody can fetch.
digest=$(docker buildx imagetools inspect "$image:$version" 2>/dev/null \
  | awk '/^Digest:/ { print $2; exit }')
if [ -z "$digest" ]; then
  echo "pin-compose: $image:$version is not published yet." >&2
  echo "  The image is built by CI from the server/v$version tag. Wait for it, then re-run." >&2
  exit 1
fi
echo "digest $digest"

# `|| true`, because grep exits 1 when it counts nothing, which is the ordinary
# answer on the first pin (compose.yaml built from the checkout and named no
# image), and pipefail would end the script there without a word.
before=$( { grep -c "$image:[0-9]" compose.yaml docs/*.md README.md 2>/dev/null || true; } \
  | awk -F: '{s+=$2} END {print s+0}')

# The first pin replaces the local build. Until a server release existed there
# was no image to name, and compose.yaml built from the checkout between two
# markers; everything between them, markers included, becomes the pin, and
# the two lines below keep it current from then on.
if grep -q '^ *# pin-compose: begin' compose.yaml; then
  PIN_IMAGE=$image PIN_VERSION=$version PIN_DIGEST=$digest perl -0pi -e '
    s{^( *)\# pin-compose: begin\n.*?^ *\# pin-compose: end\n}{$1\# The digest came from:\n$1\#   docker buildx imagetools inspect $ENV{PIN_IMAGE}:$ENV{PIN_VERSION}\n$1image: $ENV{PIN_IMAGE}:$ENV{PIN_VERSION}\@$ENV{PIN_DIGEST}\n}ms
  ' compose.yaml
fi

# Both the pinned line and the comment above it that says where the digest came
# from, so the file never explains itself with the wrong command.
perl -pi -e "s|\Q$image\E:[0-9][^\@\s]*\@sha256:[0-9a-f]+|$image:$version\@$digest|g" compose.yaml
perl -pi -e "s|(imagetools inspect \Q$image\E):[0-9][^\s]*|\$1:$version|g" compose.yaml

# The runbooks are copied as readily as the compose file, and docs/server.md
# went stale in exactly the same way it did.
perl -pi -e "s|\Q$image\E:[0-9][^\@\s]*(?!\@)|$image:$version|g" docs/*.md README.md

echo
git diff --stat compose.yaml docs README.md
echo
echo "Now check it, then commit:"
echo "  git add compose.yaml docs README.md"
echo "  git commit -m 'compose: pin the $version server image'"
echo
echo "($before references were named before this ran.)"
