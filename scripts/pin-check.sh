#!/usr/bin/env bash
#
# Fails when compose.yaml, or a runbook, names a server image older than the
# newest server release.
#
# One implementation, called by .github/workflows/ci.yml and by
# scripts/check.sh, because the point of a check is undermined by having two
# copies of it that can disagree.
#
# Compared against the newest `server/v*` tag and not the plugin's manifest:
# the image is built on a server tag, so a client-only release correctly ships
# no image, and comparing against the manifest would fail every one of those
# for no reason.
#
# Older fails. Equal or newer passes, because the version bump commit lands
# before the tag that releases it.
set -euo pipefail

cd "$(dirname "$0")/.."
image=ghcr.io/waynehoover/trewsync

pinned=$(sed -n "s|.*image: $image:\([0-9][^@]*\)@sha256:.*|\1|p" compose.yaml)
newest=$(git tag --list 'server/v*' | sed 's|server/v||' | sort -V | tail -1)

# Before the first server release there is no image to pin, and compose.yaml
# builds from the checkout instead, between the markers pin-compose.sh
# replaces. That is correct exactly until a server release exists.
if [ -z "$pinned" ]; then
  if ! grep -q '^ *# pin-compose: begin' compose.yaml || ! grep -q '^ *build:' compose.yaml; then
    echo "compose.yaml neither pins $image by tag and digest nor builds from the checkout" >&2
    exit 1
  fi
  if [ -z "$newest" ]; then
    echo "no server release yet, and compose.yaml builds from the checkout"
    # And nothing names a numbered image that cannot exist yet.
    stale=$(grep -rn "$image:[0-9]" docs README.md compose.yaml 2>/dev/null || true)
    if [ -n "$stale" ]; then
      echo "these name a $image release, and there is none:" >&2
      echo "$stale" >&2
      exit 1
    fi
    exit 0
  fi
  tagged=$(git rev-list -n1 "server/v$newest" 2>/dev/null || echo none)
  if [ "$tagged" = "$(git rev-parse HEAD)" ]; then
    echo "this is the commit server/v$newest tags, so its image does not exist yet."
    echo "Pin it once it is published: scripts/pin-compose.sh"
    exit 0
  fi
  echo "server/v$newest is released, and compose.yaml still builds from the checkout." >&2
  echo "Pin the published image:  scripts/pin-compose.sh" >&2
  exit 1
fi

if [ -z "$newest" ]; then
  echo "no server/v* tag in the repository, nothing to compare against"
  exit 0
fi

echo "compose pins $pinned, newest server release is $newest"
older=$(printf '%s\n%s\n' "$pinned" "$newest" | sort -V | head -1)
if [ "$pinned" != "$newest" ] && [ "$older" = "$pinned" ]; then
  # Except on the commit the tag itself points at, which is the one commit that
  # could not have pinned the new digest: the image is built *by* that tag being
  # pushed, so the digest does not exist until after the commit is written. This
  # used to fail there, which made main red from the server tag until the pin
  # commit, and that was not only untidy. The publish gate refuses to release a
  # tag whose commit CI has not passed on, so a plugin tag pushed in the window
  # sat there unreleasable, and the way out was to wait, pin, and tag again.
  #
  # Only that commit is excused, and only until something lands on top of it.
  # The pin commit is what should land on top, and if anything else does, this
  # fails again and is right to: by then the digest exists and nothing pinned it.
  tagged=$(git rev-list -n1 "server/v$newest" 2>/dev/null || echo none)
  if [ "$tagged" = "$(git rev-parse HEAD)" ]; then
    echo "this is the commit server/v$newest tags, so the image it builds does not"
    echo "exist yet and cannot be pinned from here. Pin it once it is published:"
    echo
    echo "  scripts/pin-compose.sh && git add -A && git commit -m 'compose: pin the $newest server image' && git push"
    echo
    echo "Anything that lands on this commit without that pin fails here."
    exit 0
  fi
  echo "compose.yaml pins $pinned but the newest server release is $newest." >&2
  echo "Update the tag and its digest together:  scripts/pin-compose.sh" >&2
  exit 1
fi

# The runbooks are copied and pasted as readily as the compose file, and
# docs/server.md went stale in exactly the same way it did.
stale=$(grep -rn "$image:[0-9][^@ ]*" docs README.md | grep -v "$image:$pinned" || true)
if [ -n "$stale" ]; then
  echo "these name an image tag that is not the pinned $pinned:" >&2
  echo "$stale" >&2
  exit 1
fi
echo "every image reference names $pinned"
