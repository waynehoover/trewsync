#!/usr/bin/env bash
#
# That the runbook says what it means to say.
#
# scripts/release.sh prints commands to paste. Three times now it has printed
# something that looked exactly like a command and was not one, and every time
# the reason was the same: the runbook was an unquoted heredoc, so the shell
# read the prose before anybody did.
#
#   `created`                     -> ran `created`, printed nothing
#   `--server 0.5.0`, not `...`   -> "Bare versions, not tag names: , not ."
#   server/v$version              -> `git tag -a server/vcli/v0.5.0-2-g0def89f`
#
# The first fix, ${var//@NAME@/value}, was a fourth: since bash 5.2 an
# unescaped `&` in the replacement stands for the matched text, so on the runner
# every `&&` in the pinning command came back as `@SERVERBLOCK@`. macOS ships
# bash 3.2 and has never had the feature, so this file passed here and failed
# there. It is python3 now, whose replace has no metacharacters, and the two
# checks at the end are what hold it there: one on the `&&` surviving, and one
# on the source, because no shell on a Mac can reproduce what the runner does.
#
# None of the three announced itself. Two of them printed a shorter sentence
# that still read as English, and the third printed a tag name that is only
# wrong if you know what the right one looks like. The runbook is quoted
# heredocs and literal substitution now, and this is what says it stayed that
# way.
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
script="$here/release.sh"
fails=0

ok()   { printf '  ok   %s\n' "$1"; }
bad()  { printf '  FAIL %s\n' "$1"; fails=$((fails + 1)); }

# --runbook, because printing is not building: the build wants a clean tree and
# four Go toolchains, and neither has anything to do with what the text says.
with=$(bash "$script" --runbook 0.5.1 2>&1);  withrc=$?
without=$(bash "$script" --runbook 2>&1);     withoutrc=$?

[ $withrc -eq 0 ]    || bad "release.sh --runbook 0.5.1 exited $withrc"
[ $withoutrc -eq 0 ] || bad "release.sh --runbook exited $withoutrc"

# ---- nothing was eaten ----------------------------------------------------
#
# Each of these is a backtick or a dollar in the prose, which is to say each is
# a character the shell would have taken if the heredoc were unquoted. They are
# checked as literal text because that is how a reader meets them.
for phrase in \
  '`created` is documented as excluding them' \
  'Bare versions, not tag names: `--server 0.5.1`, not `--server server/v0.5.1`.' \
  '`latest` moves during it'
do
  case $with in
    *"$phrase"*) ok "kept: ${phrase:0:46}" ;;
    *)           bad "lost: $phrase" ;;
  esac
done

case $without in
  *'nothing to build a tag name out of but `git describe`'*)
    ok "kept: the git describe sentence" ;;
  *) bad "lost: the git describe sentence, printed when no version is given" ;;
esac

# ---- no placeholder reached the page --------------------------------------
for out in "$with" "$without"; do
  left=$(printf '%s' "$out" | grep -o '@[A-Z][A-Z]*@' | sort -u | tr '\n' ' ')
  [ -z "$left" ] || bad "unsubstituted placeholder in the runbook: $left"
done
[ -n "$(printf '%s' "$with" | grep -o '@[A-Z][A-Z]*@')" ] || ok "no placeholder survives substitution"

# ---- every tag name is one git would take ---------------------------------
#
# The shapes are fixed by three ecosystems and are not interchangeable:
# Obsidian wants the plugin tag bare, Go wants server/vX.Y.Z to resolve a
# module in a subdirectory, and cli/vX.Y.Z matches the server for the look of
# it. Anything else is a tag nobody is waiting for.
badtag=0
while read -r tag; do
  [ -n "$tag" ] || continue
  case $tag in
    [0-9]*.[0-9]*.[0-9]*|server/v[0-9]*.[0-9]*.[0-9]*|cli/v[0-9]*.[0-9]*.[0-9]*)
      case $tag in
        *' '*|*/v*/*|*-g*|*dirty*) bad "runbook prints a tag git would not take: $tag"; badtag=1 ;;
      esac ;;
    *) bad "runbook prints a tag of no known shape: $tag"; badtag=1 ;;
  esac
done < <(printf '%s\n%s\n' "$with" "$without" | grep -o 'git tag -a [^ ]*' | sed 's/git tag -a //' | sort -u)
[ $badtag -eq 0 ] && ok "every tag name printed is one of the three shapes"

# The command must publish this package, not the old example version.
cliversion=$(node -p "require('$here/../client/package.json').version")
for out in "$with" "$without"; do
  case $out in
    *"git tag -a cli/v$cliversion -m \"trew CLI $cliversion\""*)
      ok "the CLI command uses the package version $cliversion" ;;
    *) bad "the CLI tag command does not use the package version $cliversion" ;;
  esac
done

# ---- and the server half is only there when it was asked for --------------
case $with in
  *'git tag -a server/v0.5.1'*) ok "the server commands appear when a version is given" ;;
  *)                            bad "no server tag command, and a version was given" ;;
esac
case $without in
  *'git tag -a server/v'*) bad "a server tag command was built without a version to build it from" ;;
  *)                       ok "no server commands without a version" ;;
esac

# ---- verify-release is called the way it parses ---------------------------
#
# It takes bare versions. A tag name there fetches a release that does not
# exist and reports the release missing, which reads as a broken release
# rather than a mistyped check.
verify=$(printf '%s\n' "$with" | grep -o 'verify-release.sh .*')
case $verify in
  *'--server server/v'*|*'--plugin '[0-9]*'/v'*|*'--cli cli/v'*)
    bad "verify-release is given a tag name: $verify" ;;
  *'--server 0.5.1'*) ok "verify-release is given bare versions: $verify" ;;
  *) bad "no verify-release command in the runbook" ;;
esac

# ---- the formula is rendered for the tap, not over its own template -------
#
# homebrew-formula.sh reads packaging/homebrew/trewd.rb, the template, and the
# runbook sent its output into that same file, so the shell emptied the
# template before the script could read it and the render failed. It did, at
# 0.12.1. The rendered formula is the tap's.
formula=$(printf '%s\n' "$with" | grep '^[[:space:]]*scripts/homebrew-formula.sh ' || true)
case $formula in
  "")                                bad "no formula command in the runbook" ;;
  *'> packaging/homebrew/trewd.rb'*) bad "the formula is rendered over the template it reads: $formula" ;;
  *)                                 ok "the formula is rendered beside its template, not over it" ;;
esac

# ---- and the ampersands in it are ampersands ------------------------------
case $with in
  *"scripts/pin-compose.sh && git add -A && git commit -m 'compose: pin the 0.5.1 server image' && git push"*)
    ok "a command joined by && survives substitution" ;;
  *) bad "the pinning command came back without its &&" ;;
esac

# The same question asked of the source, because the behaviour above is only
# wrong on bash 5.2 and this machine may not have one. A shell pattern
# substitution building the runbook is the defect whatever it prints here.
# Comments are allowed to name it, and the one above the substitution does.
shellsub=$(grep -n '{[a-z]*//@' "$script" | grep -v '^[0-9]*:[[:space:]]*#' || true)
if [ -n "$shellsub" ]; then
  bad "the runbook is substituted with a shell pattern, which is not literal on bash 5.2:"
  printf '%s\n' "$shellsub" | sed 's/^/       /'
else
  ok "the runbook is not substituted by shell pattern replacement"
fi

if [ $fails -eq 0 ]; then
  echo "the runbook prints what it was written to print"
  exit 0
fi
echo "$fails wrong" >&2
exit 1
