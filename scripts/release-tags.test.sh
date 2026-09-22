#!/usr/bin/env bash
#
# Which tags a release may move (I23).
#
# The cases that matter are the ones that only happen once: the first backport,
# the first prerelease. Both are ordinary things to do and both used to take
# `latest` from the newest stable server, and nobody would have found out here,
# because until one of them happens the old unconditional `latest` is right
# about every release there has ever been.
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
script="$here/release-tags.sh"
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
fails=0

# What is already released. The tag being tested is not in here: a release asks
# this before its own tag is pushed as often as after, and the answer must be
# the same either way.
cat > "$work/tags" <<'TAGS'
server/v0.2.0
server/v0.3.0
server/v0.3.1
server/v0.4.0
server/v0.4.1
TAGS

want() { # want <tag> <expected tags, space separated, or FAIL>
  local tag=$1 expect=$2 got rc
  got=$(bash "$script" "$tag" "$work/tags" 2>/dev/null | tr '\n' ' '); rc=$?
  got=${got% }
  if [ "$expect" = FAIL ]; then
    if [ $rc -eq 0 ]; then
      printf '  FAIL %s: accepted, and gave "%s"\n' "$tag" "$got"; fails=$((fails + 1))
    else
      printf '  ok   %s is refused\n' "$tag"
    fi
  elif [ "$got" = "$expect" ]; then
    printf '  ok   %-22s -> %s\n' "$tag" "$got"
  else
    printf '  FAIL %s: wanted "%s", got "%s"\n' "$tag" "$expect" "$got"; fails=$((fails + 1))
  fi
}

echo "the tags a server release may move:"
want server/v0.4.2      "0.4.2 0.4 latest"
want server/v0.5.0      "0.5.0 0.5 latest"
want server/v1.0.0      "1.0.0 1.0 latest"

echo "a patch to an older minor takes its own alias and not latest:"
want server/v0.3.2      "0.3.2 0.3"
want server/v0.2.1      "0.2.1 0.2"

echo "a release behind one already out takes neither:"
want server/v0.3.0      "0.3.0"
want server/v0.4.0      "0.4.0"
# The one already at the head of its minor is still at the head of it.
want server/v0.4.1      "0.4.1 0.4 latest"

echo "a prerelease takes nothing but its own name:"
want server/v0.5.0-rc.1 "0.5.0-rc.1"
want server/v0.4.2-beta "0.4.2-beta"
# Even ahead of everything: a prerelease of the next version is still the one
# somebody has to ask for.
want server/v9.9.9-rc.1 "9.9.9-rc.1"

echo "and the full tag syntax:"
want server/v1.2        FAIL
want server/v1.2.3.4    FAIL
want server/v01.2.3     FAIL
want v1.2.3             FAIL
want server/1.2.3       FAIL
want cli/v1.2.3         FAIL
want "server/v1.2.3 "   FAIL
want ""                 FAIL

# The other side of the same rule. An rc that is out and ahead of everything is
# still not released, so it must not hold `latest` away from the newest stable
# server: somebody trying an rc would otherwise stop everyone else's `latest`
# from moving, and the only sign would be a version number nobody updated.
echo "a prerelease already out holds nothing back:"
cat > "$work/tags" <<'TAGS'
server/v0.4.0
server/v0.4.1
server/v0.5.0-rc.1
server/v0.5.0-rc.2
TAGS
want server/v0.4.2      "0.4.2 0.4 latest"
want server/v0.5.0      "0.5.0 0.5 latest"
# And an rc is not a patch level within its own minor either.
want server/v0.5.0-rc.3 "0.5.0-rc.3"

# A minor is a whole number, not a prefix of the text. 0.4 and 0.41 share four
# characters and nothing else, and a prefix match would put the newest 0.41
# release at the head of the 0.4 series, so 0.4's own alias would stop moving
# and no release would ever mention it.
echo "and a minor is a number rather than a prefix:"
cat > "$work/tags" <<'TAGS'
server/v0.4.0
server/v0.41.0
TAGS
want server/v0.4.2      "0.4.2 0.4"
want server/v0.41.1     "0.41.1 0.41 latest"

# Ordering is numeric, not lexical: 0.10 is after 0.9, and a sort that did not
# know it would hand `latest` to the older release for the whole of a 0.10
# series.
echo "and versions are ordered as numbers:"
cat > "$work/tags" <<'TAGS'
server/v0.9.0
server/v0.10.0
TAGS
want server/v0.10.1     "0.10.1 0.10 latest"
want server/v0.9.1      "0.9.1 0.9"

# Out-of-order releases, which is the failure the workflow's concurrency group
# and its late re-evaluation are for (R17).
#
# Release A starts while it is the newest and records `latest`. Release B is
# tagged, builds, and promotes a newer version. A finishes last and applies the
# answer it worked out at the start, moving the channel backward onto an older
# server. Both pass their own digest checks, because each is checking its own
# image.
#
# The script cannot serialise anything; what it can do is give the right answer
# for the tags that exist *at the moment it is asked*, so that asking it late is
# worth doing. These two cases are the same release asked at two moments.
echo "the same release, asked before and after a newer one appears:"
cat > "$work/tags" <<'TAGS'
server/v0.4.0
TAGS
want server/v0.4.1      "0.4.1 0.4 latest"

cat > "$work/tags" <<'TAGS'
server/v0.4.0
server/v0.4.2
TAGS
# Asked again once 0.4.2 is out, the older release must no longer claim either
# moving tag. This is the answer the workflow gets by re-running it inside the
# promotion step rather than reusing the one from before the build.
want server/v0.4.1      "0.4.1"

# A tag that is not a release this project makes counts as nothing, on both
# sides of the question (R38). It was counted as a version here and not in
# `release-aliases.sh`, so this script would deny `latest` to the newest real
# server while the promotion set it: two answers to one question.
echo "a malformed tag in the repository is not a release:"
cat > "$work/tags" <<'TAGS'
server/v0.4.0
server/v1.2
server/v1.2.3.4
TAGS
want server/v0.4.1      "0.4.1 0.4 latest"

# ---- and what every alias should be, whoever is promoting (R38) ------------
#
# `release-tags.sh` answers "what may this release move", which stops being the
# right question the moment a promotion is dropped. The queue keeps one pending
# run: A running, B pending and C arriving discards B, and if C is a backport
# it moves neither of the aliases B was going to. B's immutable image is
# published and nothing ever points at it.
#
# So the promotion reconciles every alias from the releases that exist. Each
# line is an alias and then the versions it may point at, newest first, because
# which one it takes also depends on what is actually published: a newer
# release whose build has not finished must not leave the alias behind on an
# older one (R41). Picking among them is the workflow's job and is checked in
# `release-promote.test.sh`; what is checked here is the plan.
aliases() { # aliases <expected, "alias candidates..." lines separated by |>
  local expect=$1 got
  got=$(bash "$here/release-aliases.sh" "$work/tags" | tr '\n' '|')
  got=${got%|}
  if [ "$got" = "$expect" ]; then
    printf '  ok   %s\n' "$got"
  else
    printf '  FAIL wanted "%s", got "%s"\n' "$expect" "$got"; fails=$((fails + 1))
  fi
}

echo "every moving alias, from the releases that exist:"
cat > "$work/tags" <<'TAGS'
server/v0.2.0
server/v0.3.0
server/v0.3.1
server/v0.4.0
server/v0.4.1
TAGS
aliases "latest 0.4.1 0.4.0 0.3.1 0.3.0 0.2.0|0.2 0.2.0|0.3 0.3.1 0.3.0|0.4 0.4.1 0.4.0"

# A prerelease holds nothing and is pointed at by nothing, on either side.
cat > "$work/tags" <<'TAGS'
server/v0.4.1
server/v0.5.0-rc.1
TAGS
aliases "latest 0.4.1|0.4 0.4.1"

# Versions are numbers, so 0.10 is after 0.9 here as everywhere else.
cat > "$work/tags" <<'TAGS'
server/v0.9.1
server/v0.10.1
TAGS
aliases "latest 0.10.1 0.9.1|0.9 0.9.1|0.10 0.10.1"

# And nothing published yet is not an error, it is no aliases.
: > "$work/tags"
aliases ""

# The three-release schedule, which two releases marching up one line never
# reaches. A (0.4.2) is promoting, B (0.5.0) is queued behind it, and C (0.3.9)
# arrives and takes B's place in the queue. B is never promoted.
echo "a backport promoting after a dropped release repairs it:"
cat > "$work/tags" <<'TAGS'
server/v0.3.0
server/v0.4.0
server/v0.4.2
server/v0.5.0
server/v0.3.9
TAGS
# What C itself may move, which is the point: neither of the two B needed.
want server/v0.3.9      "0.3.9 0.3"
# And what C's promotion sets, which is all of them. `latest` reaches 0.5.0
# without B ever promoting, because B's immutable image was published outside
# the queue and this is worked out from the releases rather than from whose
# turn it is.
aliases "latest 0.5.0 0.4.2 0.4.0 0.3.9 0.3.0|0.3 0.3.9 0.3.0|0.4 0.4.2 0.4.0|0.5 0.5.0"

# And the same malformed list, asked of both, which is the pair that drifted.
echo "and both scripts read the repository the same way:"
cat > "$work/tags" <<'TAGS'
server/v0.4.0
server/v0.4.1
server/v1.2
server/v1.2.3.4
TAGS
want server/v0.4.1      "0.4.1 0.4 latest"
aliases "latest 0.4.1 0.4.0|0.4 0.4.1 0.4.0"

if [ "$fails" != 0 ]; then echo "$fails case(s) failed"; exit 1; fi
echo "all cases passed"
