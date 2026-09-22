#!/usr/bin/env bash
#
# The promotion step, run against a registry that answers what a test says
# (R38, R41, R42).
#
# `release-aliases.sh` is testable on its own and was; the step that consumes
# it was not, and both remaining defects lived there. So the shell is extracted
# from the workflow and executed, with `docker` replaced by a stub whose
# published set the case controls, and `git`/`release-aliases.sh` fed a fixed
# tag list. Nothing here touches a registry or a release.
set -uo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
fails=0
fail() { printf '  FAIL %s\n' "$1" >&2; fails=$((fails + 1)); }
ok() { printf '  ok   %s\n' "$1"; }

# The step's script, taken out of the workflow rather than copied, so a change
# to one is a change to the other.
extract() {
  awk '
    /^      - name: point every moving alias at the release it belongs to$/ { found = 1; next }
    found && /^        run: \|$/ { inside = 1; next }
    inside && /^      - name: / { exit }
    inside { sub(/^          /, ""); print }
  ' "$root/.github/workflows/release.yml"
}
extract > "$work/promote.sh"
if [ ! -s "$work/promote.sh" ]; then
  echo "could not find the promotion step in the workflow" >&2
  exit 2
fi

# A docker whose registry is a directory: one file per published reference,
# holding its digest. `imagetools create` writes the alias; `inspect` reads.
# A reference becomes a filename by replacing everything a path cannot hold,
# and the fixtures below use the same function so the two cannot drift.
cat > "$work/refname" <<'STUB'
#!/usr/bin/env bash
printf '%s' "$1" | tr '/:@' '---'
STUB
chmod +x "$work/refname"
cat > "$work/docker" <<'STUB'
#!/usr/bin/env bash
ref_file() { printf '%s/%s' "$REGISTRY" "$(refname "$1")"; }
# docker buildx imagetools <verb> ...
case "$3" in
  inspect)
    # ... inspect --format <fmt> <ref>
    tag="${6##*:}"
    while read -r hidden; do
      [ -n "$hidden" ] || continue
      [ "$hidden" = "$tag" ] || continue
      # There and unreadable, which is not the same answer as absent and is
      # the one `inspect` cannot tell apart.
      echo "the registry did not answer" >&2
      exit 1
    done < "$BLIND"
    f=$(ref_file "$6")
    [ -f "$f" ] || exit 1
    cat "$f"
    ;;
  create)
    # ... create --tag <ref> <source>. The source is by digest, which the ref
    # itself carries, as the real command does it.
    case "$6" in
      *@*) digest="${6#*@}" ;;
      *) digest=$(cat "$(ref_file "$6")") ;;
    esac
    printf '%s' "$digest" > "$(ref_file "$5")"
    ;;
  *)
    echo "the stub was asked for $3, which the step should not be using" >&2
    exit 2
    ;;
esac
STUB
chmod +x "$work/docker"

IMG=ghcr.io/owner/repo
# The digest a version's image has, so a test can say where an alias points.
digest_of() { printf 'sha256:%s' "$(printf '%s' "$1" | tr -d '.')"; }
publish() { PATH="$work:$PATH" ; digest_of "$1" > "$work/reg/$("$work/refname" "$IMG:$1")"; }
alias_at() { # alias_at <alias> -> the version its digest belongs to
  local f; f="$work/reg/$("$work/refname" "$IMG:$1")"
  [ -f "$f" ] || return 0
  local want; want=$(cat "$f")
  local v
  for v in $(cat "$work/published"); do
    [ "$(digest_of "$v")" = "$want" ] || continue
    printf '%s' "$v"
    return 0
  done
}

# Stand-ins for the two things the step reads from the repository.
cat > "$work/git" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$work/git"
mkdir -p "$work/scripts"
cat > "$work/scripts/release-aliases.sh" <<STUB
#!/usr/bin/env bash
exec bash "$root/scripts/release-aliases.sh" "\$TAGS"
STUB
chmod +x "$work/scripts/release-aliases.sh"

# run <tags> <published versions> [alias=version ...] [references the registry
# will not answer for]
run() {
  local tags=$1 published=$2 aliases=${3:-} blind=${4:-}
  rm -rf "$work/reg"; mkdir -p "$work/reg"
  : > "$work/tags"
  for t in $tags; do echo "server/v$t" >> "$work/tags"; done
  printf '%s\n' $published > "$work/published"
  for v in $published; do publish "$v"; done
  # Aliases the last release left behind.
  local pair
  for pair in $aliases; do
    digest_of "${pair#*=}" > "$work/reg/$("$work/refname" "$IMG:${pair%%=*}")"
  done
  # And what the registry will not answer for this pass, which is a different
  # thing from what it does not have: the stub refuses these by name while the
  # files stay exactly where they are.
  printf '%s\n' $blind > "$work/blind"
  ( cd "$work" && REGISTRY="$work/reg" BLIND="$work/blind" TAGS="$work/tags" REPO="Owner/Repo" \
      PATH="$work:$PATH" bash "$work/promote.sh" ) > "$work/out" 2>&1
  echo $? > "$work/code"
}

# Every case checks the exit status as well as the registry, because a step
# that died on line two leaves the aliases exactly as an unchanged one does,
# and two of these read as passes the first time round for that reason.
wants() { # wants <expected code> <what>
  local got; got=$(cat "$work/code")
  if [ "$got" = "$1" ]; then return 0; fi
  fail "$2: exited $got, wanted $1
$(sed 's/^/      /' "$work/out")"
  return 1
}

echo "the promotion, against a registry it does not control:"

# ---- R38: a backport repairs a promotion that was dropped -------------------
run "0.4.2 0.5.0 0.3.9" "0.4.2 0.5.0 0.3.9"
wants 0 "the backport case"
if [ "$(alias_at latest)" = "0.5.0" ] && [ "$(alias_at 0.5)" = "0.5.0" ] && [ "$(alias_at 0.3)" = "0.3.9" ]; then
  ok "a backport's promotion sets the aliases a dropped one would have"
else
  fail "aliases after a backport: latest=$(alias_at latest) 0.5=$(alias_at 0.5) 0.3=$(alias_at 0.3)"
fi

# ---- R41: the newest release has not finished building ----------------------
# `latest` is where the last release left it, which is the realistic state.
run "0.4.1 0.4.2 0.5.0" "0.4.1 0.4.2" "latest=0.4.1"
wants 0 "the unbuilt-newer case"
if [ "$(alias_at latest)" = "0.4.2" ]; then
  ok "latest goes as far forward as the registry can support"
else
  fail "latest=$(alias_at latest), wanted 0.4.2: an unbuilt newer release left it behind"
fi

# ---- a first release, where the alias does not exist yet --------------------
run "0.4.1" "0.4.1"
wants 0 "the first release"
if [ "$(alias_at latest)" = "0.4.1" ] && [ "$(alias_at 0.4)" = "0.4.1" ]; then
  ok "a first release creates the aliases it earns"
else
  fail "latest=$(alias_at latest) 0.4=$(alias_at 0.4) on a first release"
fi

# ---- R45: the alias lookup fails as well ------------------------------------
# All three images exist and `latest` is at 0.5.0. The registry will not answer
# for 0.5.0 or for `latest` this pass. Reading either silence as "absent" moves
# `latest` back onto 0.4.2, which is the rollback with an extra step.
run "0.4.1 0.4.2 0.5.0" "0.4.1 0.4.2 0.5.0" "latest=0.5.0" "0.5.0 latest"
wants 0 "the both-unreadable case"
if [ "$(alias_at latest)" = "0.5.0" ]; then
  ok "an alias that cannot be read is left where it is"
else
  fail "latest was moved to $(alias_at latest) while nothing could read it"
fi

# ---- R41: a lookup that fails must not roll an alias back -------------------
# `latest` is readable and already carries 0.5.0's digest, whose own tag the
# registry will not answer for. Moving it to 0.4.2 would be a rollback caused
# by a bad minute on the network.
run "0.4.1 0.4.2 0.5.0" "0.4.1 0.4.2 0.5.0" "latest=0.5.0" "0.5.0"
wants 0 "the uncertain-registry case"
if [ "$(alias_at latest)" = "0.5.0" ]; then
  ok "an alias already ahead is left alone when its version cannot be read"
else
  fail "latest was rolled back to $(alias_at latest)"
fi

# ---- R42: a repository with nothing to promote ------------------------------
run "" ""
if wants 0 "an empty plan"; then ok "an empty plan is a no-op rather than a failure"; fi

# And a plan with lines in it that resolves none of them is still an error:
# that is the registry not answering, which is not the same thing.
run "0.4.1" ""
if [ "$(cat "$work/code")" != "0" ]; then
  ok "a plan that resolves nothing at all still fails"
else
  fail "a promotion that could not see one image reported success"
fi

if [ "$fails" != 0 ]; then echo "$fails check(s) failed"; exit 1; fi
echo "all checks passed"
