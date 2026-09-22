#!/usr/bin/env bash
#
# Every action a workflow runs is pinned to a commit (I22).
#
# `uses: actions/checkout@v7` is a request for whatever that tag points at
# today, and a tag is a mutable name somebody else controls. It is the ordinary
# way to write a workflow and it is fine right up until the account that owns
# the action is not the person you think it is, at which point the thing that
# builds, signs and publishes this project changes without a commit here and
# without anybody looking at a diff. That has happened to other projects, more
# than once, and the way it is found out is afterwards.
#
# A SHA cannot be moved. The version goes in a trailing comment so the file is
# still readable, and so an update is a commit that says which version it is
# going to rather than forty characters changing for reasons nobody records.
#
# To update one: find the SHA the new tag points at and change both halves.
#
#   gh api repos/actions/checkout/git/ref/tags/v7.0.2 --jq .object.sha
#
# The comment is checked too, because a SHA with a stale version beside it is
# worse than a bare SHA: it is a wrong answer to the question the comment
# exists to answer.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
bad=0
count=0

while IFS= read -r line; do
  file=${line%%:*}; rest=${line#*:}
  n=${rest%%:*};    text=${rest#*:}
  ref=$(sed -n 's/.*uses: *//p' <<< "$text")

  # A local action, which is this repository and moves with it.
  case "$ref" in ./*) continue ;; esac

  count=$((count + 1))
  if [[ ! "$ref" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+(/[A-Za-z0-9._/-]+)?@[0-9a-f]{40}\ \#\ v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    printf '%s:%s\n  %s\n' "$file" "$n" "$ref" >&2
    bad=$((bad + 1))
  fi
done < <(grep -rn "uses:" "$root/.github/workflows"/*.yml)

if [ "$bad" -gt 0 ]; then
  cat >&2 <<'WHY'

Every action must be pinned to a 40-character commit SHA with the version it
came from in a trailing comment:

  uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1

A tag is a name its owner can repoint, which means the workflow that publishes
this project could change without a commit here. See scripts/actions-pinned.sh.
WHY
  exit 1
fi

echo "$count action references, all pinned"
