#!/usr/bin/env bash
#
# Every moving image alias, and the versions it may point at, newest first
# (R38, R41).
#
# `release-tags.sh` answers "what may *this* release move", which is the right
# question while a release is being decided and the wrong one afterwards. The
# promotion job is serialised, GitHub keeps one pending run per group, and a
# third release arriving discards whatever was waiting, so a promotion has to
# reconcile every alias rather than append its own: A running, B (0.5.0)
# queued, C (0.3.9) arriving discards B, and C is a backport that moves neither
# `latest` nor `0.5`.
#
# Each line is an alias and then its candidates, newest first, because which
# one an alias may take also depends on what is actually published. Naming one
# version meant an alias whose newest release had not finished building was
# left exactly where it was: with `0.4.1`, `0.4.2` and `0.5.0` tagged but only
# the first two built, `latest` stayed at `0.4.1` while `0.4.2` sat there
# published, and the run exited 0. That is a rollback by omission, reported as
# success. The caller walks the candidates and takes the newest one the
# registry can resolve.
#
# Usage: release-aliases.sh [existing-tags-file]
#
# Prints "<alias> <version>..." a line at a time. The argument is the tag list,
# one per line, and defaults to asking git; passing a file is how this is
# tested without a repository full of fixtures.
#
# No releases at all prints nothing and exits 0. That is a valid plan, not a
# failure: a repository whose only server tag is a prerelease has no moving
# alias to set, and treating an empty plan as an error made the first such
# release fail (R42).
set -euo pipefail

if [ $# -ge 1 ]; then
  existing=$(cat "$1")
else
  existing=$(git tag --list 'server/v*')
fi

# Stable releases only, and exactly three numeric parts.
#
# A prerelease never holds a moving alias, on either side of the question: not
# as the version an alias points at, and not by keeping one away from the
# newest stable server. Anything that is not MAJOR.MINOR.PATCH is not a release
# this project makes, and guessing at what alias it deserves is how a tag
# nobody meant to publish moves `latest`.
stable=$(
  printf '%s\n' "$existing" \
    | sed -n 's|^server/v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$|\1|p' \
    | sort -u -V
)
[ -n "$stable" ] || exit 0

# Newest first, which is the order the caller tries them in.
newest_first=$(printf '%s\n' "$stable" | sort -r -V)

echo "latest $(printf '%s\n' "$newest_first" | tr '\n' ' ' | sed 's/ $//')"

# One alias per minor line that has a stable release in it. A backport
# publishing 0.3.9 moves `0.3` and nothing else, and it says so here as well as
# in `release-tags.sh`.
printf '%s\n' "$stable" \
  | sed -n 's|^\([0-9][0-9]*\.[0-9][0-9]*\)\.[0-9][0-9]*$|\1|p' \
  | sort -u -V \
  | while IFS= read -r minor; do
      line=$(printf '%s\n' "$newest_first" | grep "^${minor//./\\.}\." | tr '\n' ' ' | sed 's/ $//')
      echo "$minor $line"
    done
