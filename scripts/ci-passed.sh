#!/usr/bin/env bash
#
# Refuse to publish anything from a commit CI has not passed on (I21).
#
# The three workflows that put bytes somebody else can install (npm, the
# container image, the signed release assets) built and pushed without ever
# asking whether the code they were built from was green. Checks running
# elsewhere are only worth anything if publication cannot get ahead of a run
# that failed, or of one that never happened at all: a tag pushed a minute
# before CI finishes publishes first and goes red afterwards, and by then the
# bytes are out and somebody has them.
#
# A tag is not a branch, so CI's `push: branches: [main]` trigger does not fire
# for it. What this waits for is the run against the same commit, which is the
# one that ran when that commit landed on main. A tag on a commit that was
# never on main has no such run, and that is refused rather than waved through:
# an unchecked commit is exactly the one not to publish from.
#
# Usage: ci-passed.sh <owner/repo> <sha-or-ref> [workflow-name]
#
# Env:
#   GH_TOKEN      a token with actions:read, as `gh api` wants
#   CI_WAIT_TRIES how many times to look          (default 60)
#   CI_WAIT_SLEEP seconds between looks           (default 20)
set -euo pipefail

repo=${1:?usage: ci-passed.sh <owner/repo> <sha-or-ref> [workflow-name]}
ref=${2:?usage: ci-passed.sh <owner/repo> <sha-or-ref> [workflow-name]}
workflow=${3:-CI}
tries=${CI_WAIT_TRIES:-60}
snooze=${CI_WAIT_SLEEP:-20}

# A release event hands us a tag, and `github.sha` on one is the default
# branch's tip rather than the thing being published. Resolving through the API
# means a tag and a SHA can both be passed and the answer is about the commit
# either way.
sha=$(gh api "repos/$repo/commits/$ref" --jq '.sha')
[ -n "$sha" ] || { echo "cannot resolve $ref in $repo" >&2; exit 1; }
[ "$sha" = "$ref" ] || echo "$ref is $sha"

for attempt in $(seq 1 "$tries"); do
  runs=$(gh api "repos/$repo/actions/runs?head_sha=$sha&per_page=100" \
    --jq "[.workflow_runs[] | select(.name == \"$workflow\")]")

  if [ "$(echo "$runs" | jq 'length')" = "0" ]; then
    echo "no $workflow run for $sha yet ($attempt/$tries)"
  elif [ "$(echo "$runs" | jq '[.[] | select(.status != "completed")] | length')" != "0" ]; then
    echo "$workflow still running for $sha ($attempt/$tries)"
  elif [ "$(echo "$runs" | jq '[.[] | select(.conclusion != "success")] | length')" != "0" ]; then
    # Answered, and the answer is no. Waiting longer cannot change it, so this
    # is the one case that does not retry.
    echo "$workflow did not pass on $sha. Nothing is published from it." >&2
    echo "$runs" | jq -r '.[] | "  \(.conclusion)\t\(.html_url)"' >&2
    exit 1
  else
    echo "$workflow passed on $sha."
    exit 0
  fi

  sleep "$snooze"
done

echo "No completed $workflow run for $sha after $((tries * snooze)) seconds." >&2
echo "A tag on a commit that never reached main has no run, and a commit" >&2
echo "nothing has checked is not one to publish from." >&2
exit 1