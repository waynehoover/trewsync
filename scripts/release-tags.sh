#!/usr/bin/env bash
#
# Which image tags a server release is allowed to move (I23).
#
# `latest` was requested unconditionally for every `server/v*` tag. That is
# right exactly when releases only ever go forwards, and wrong the first time
# they do not: a patch to an old minor, or a prerelease put out for one person
# to try, would take `latest` from the newest stable release and hand every
# `docker run ghcr.io/.../trew` an older or unfinished server. Nothing would
# say so. The compose file pins a version, so the people who would find out are
# the ones following the README, which is the worst set to pick.
#
# So the moving tags are earned rather than assumed, from the one fact that
# decides it: where this version sits among the ones already released.
#
#   server/v0.4.2  and it is the newest      -> 0.4.2, 0.4, latest
#   server/v0.3.9  a patch to an old minor   -> 0.3.9, 0.3
#   server/v0.2.1  behind its own minor      -> 0.2.1
#   server/v0.5.0-rc.1  a prerelease         -> 0.5.0-rc.1
#
# A prerelease never takes a moving tag, including its own minor alias. It is
# the version somebody asked for by name, and no version they did not ask for
# should arrive because of it.
#
# Usage: release-tags.sh <tag> [existing-tags-file]
#
# The second argument is the list of tags already in the repository, one per
# line, and defaults to asking git. Passing a file is how this is tested
# without a repository full of fixtures.
set -euo pipefail

tag=${1:?usage: release-tags.sh <tag> [existing-tags-file]}

# Full syntax, anchored. A tag is what decides the version people run and what
# `trew version` will print for the life of that image, and "close enough to
# a version" is how server/v1.2 or server/v1.2.3.4 would get published as
# something no ref resolves.
if [[ ! "$tag" =~ ^server/v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "not a server release tag: $tag" >&2
  echo "expected server/vMAJOR.MINOR.PATCH, optionally -prerelease" >&2
  exit 1
fi
version=${tag#server/v}
minor="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}"
# Group 4 is the prerelease suffix, if any. It is not captured: what it means
# is handled by the stable-version filter below, in one place rather than two.

echo "$version"

if [ $# -ge 2 ]; then
  existing=$(cat "$2")
else
  existing=$(git tag --list 'server/v*')
fi

# The stable releases, this one included whether or not its tag has been pushed
# yet: a release asks this before pushing as often as after, and the answer must
# not depend on which.
#
# This is also the whole of "a prerelease takes nothing". The pattern is
# anchored at both ends and allows only digits and dots, so `server/v0.5.0-rc.1`
# is not in this list, whether it is the version being released (in which case
# it matches neither of the two comparisons below, and gets no moving tag) or
# one already out (in which case it does not hold `latest` away from the newest
# stable server, which would be the same mistake from the other side).
#
# Exactly three numeric parts, which is the same rule the input tag above is
# held to and the same one `release-aliases.sh` uses (R38). It was looser here,
# so a stray `server/v1.2` in the repository counted as a release newer than
# every real one: this script would deny `latest` to the actual newest server
# while the promotion, which reconciles from the strict list, would set it.
# Two answers to one question is how a channel ends up somewhere nobody chose.
stable=$(
  { echo "$tag"; echo "$existing"; } \
    | sed -n 's|^server/v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$|\1|p' \
    | sort -u -V
)
newest=$(echo "$stable" | tail -1)
# `|| true` because pipefail turns "no releases yet in this minor" into a
# failed pipeline, and that is an ordinary answer rather than an error.
newest_in_minor=$(echo "$stable" | grep "^${minor//./\\.}\." | tail -1 || true)

[ "$version" = "$newest_in_minor" ] && echo "$minor"
[ "$version" = "$newest" ] && echo "latest"
exit 0
