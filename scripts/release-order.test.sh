#!/usr/bin/env bash
#
# The workflow decides which tags to move at the moment it moves them (R17).
#
# The failure this guards is an ordering, not a value. Release A starts while
# it is the newest and works out that it may take `latest`. Release B is
# tagged, builds, and promotes a newer version. A finishes last and applies the
# answer it worked out twenty minutes earlier, moving `latest` backward onto an
# older server. Both pass their own digest checks, because each is checking its
# own image.
#
# Two things stop it, and neither is visible from the tag script alone: a
# concurrency group so two promotions cannot overlap, and re-running the
# decision inside the promotion step so it cannot be stale by the time it is
# used. Both live in the workflow, so this reads the workflow.
#
# Asserted rather than trusted because the tempting edit is to hoist that
# `release-tags.sh` call back out of the promotion step into the earlier one,
# where it reads more tidily and is wrong.
#
# The other tempting edit is to put the build back inside the group, which is
# what this file used to check for (R30). A concurrency group keeps one run
# pending and no more: a third arrival discards the one that was waiting, and
# `cancel-in-progress: false` does not change that, because it governs the
# running job rather than the queue. Losing a queued promotion costs an alias
# the next release will set correctly anyway. Losing a queued build costs the
# immutable version tag, which nothing else will ever apply, so the build must
# stay out of the group and the version tag must be applied there.
set -uo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
workflow="$root/.github/workflows/release.yml"
fails=0

# One top-level job, by name, comments and all.
job() {
  awk -v want="  $1:" '
    $0 == want { inside = 1; next }
    inside && /^  [^ #]/ { inside = 0 }
    inside { print }
  ' "$workflow"
}

fail() {
  printf '  FAIL %s\n' "$1" >&2
  fails=$((fails + 1))
}
ok() { printf '  ok   %s\n' "$1"; }

echo "the image release:"

build=$(job image)
promotion=$(job promote)
[ -n "$build" ] || fail "there is no image job to read"
[ -n "$promotion" ] || fail "there is no promote job to read"

# Comment lines dropped throughout: every one of these settings is quoted in
# the paragraph explaining it, so a plain grep would find the explanation even
# with the setting itself deleted, which is a check that cannot fail.
settings() { grep -v '^ *#'; }

# One promotion at a time.
if printf '%s\n' "$promotion" | settings | grep -q "group: image-promotion"; then
  ok "promotion is serialised by a concurrency group"
else
  fail "the promote job has no concurrency group, so two releases can promote at once"
fi

# And the build is not in that group, because a queue that holds one pending
# run drops the second, and a version tag nothing published is a release that
# silently did not happen (R30).
if printf '%s\n' "$build" | settings | grep -q "concurrency:"; then
  fail "the build shares the promotion group, so a third release discards a queued build and its version tag"
else
  ok "the build is outside the promotion group, where a queue cannot discard it"
fi

# Which is only worth anything if the version tag is applied there.
if printf '%s\n' "$build" | settings | grep -q 'imagetools create --tag "\$IMAGE:\$VERSION"'; then
  ok "the immutable version tag is applied by the build itself"
else
  fail "nothing outside the promotion group applies the version tag, so a dropped promotion loses it"
fi

# The decision is made inside the step that applies it.
promote=$(printf '%s\n' "$promotion" | awk '/name: point every moving alias/,/^      - name: the published/')
if printf '%s' "$promote" | grep -q "release-aliases.sh"; then
  ok "the aliases are worked out inside the promotion step"
else
  fail "the promotion step applies a decision made somewhere earlier, which can be stale"
fi

# And it reconciles all of them rather than appending this release's (R38).
# The queue keeps one pending run, so a dropped promotion must cost nothing
# that another release will not set right; that is only true if every
# promotion fixes every alias.
if printf '%s' "$promote" | grep -q "release-tags.sh"; then
  fail "the promotion applies only this release's tags, so a dropped one strands its aliases"
else
  ok "the promotion reconciles every alias rather than appending its own"
fi
if printf '%s' "$promote" | grep -q "git fetch --tags"; then
  ok "it refreshes the tags before deciding"
else
  fail "it decides from whatever tags the checkout had, which predates any release that overtook it"
fi

# And nothing carries a precomputed list forward.
if grep -q "steps.tags.outputs.refs" "$workflow"; then
  fail "a precomputed tag list is still being used; that is the stale answer"
else
  ok "no precomputed tag list is carried past the build"
fi

if [ "$fails" != 0 ]; then
  echo "$fails check(s) failed"
  exit 1
fi
echo "all checks passed"
