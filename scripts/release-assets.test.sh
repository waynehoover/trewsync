#!/usr/bin/env bash
#
# The asset check before a release goes public, against a stub `gh`.
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
check="$here/release-assets.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fails=0

mkdir -p "$work/bin"
cat > "$work/bin/gh" <<'STUB'
#!/usr/bin/env bash
# gh release view TAG --repo R --json assets --jq FILTER: answer from a fixture.
jq -r "${@: -1}" < "$GH_FIXTURE"
STUB
chmod +x "$work/bin/gh"
export PATH="$work/bin:$PATH"

run_case() { # run_case <name> <expected exit> <assets json> <wanted names...>
  local name=$1 want=$2 assets=$3; shift 3
  printf '%s\n' "$assets" > "$work/assets.json"
  local out got
  out=$(GH_FIXTURE=$work/assets.json GITHUB_REPOSITORY=owner/repo GH_TOKEN=x \
    bash "$check" server/v9.9.9 "$@" 2>&1)
  got=$?
  if [ "$got" = "$want" ]; then
    printf '  ok   %s\n' "$name"
  else
    printf '  FAIL %s: wanted exit %s, got %s\n' "$name" "$want" "$got"
    printf '%s\n' "$out" | sed 's/^/       /'
    fails=$((fails + 1))
  fi
}

a() { # a <names...>: an assets document naming them
  local out='{"assets":[' sep=''
  for n in "$@"; do out+="$sep{\"name\":\"$n\"}"; sep=','; done
  printf '%s]}' "$out"
}

echo "the release asset check:"
run_case "passes the exact set"                0 "$(a SHA256SUMS trewd-x)" trewd-x SHA256SUMS
run_case "refuses a file nobody attested"      1 "$(a SHA256SUMS trewd-x notes.txt)" trewd-x SHA256SUMS
run_case "refuses a missing attested file"     1 "$(a SHA256SUMS)" trewd-x SHA256SUMS
run_case "refuses an empty release"            1 "$(a)" trewd-x
run_case "is not fooled by a near name"        1 "$(a SHA256SUMS trewd-x.bak)" trewd-x SHA256SUMS
run_case "refuses to run with nothing named"   2 "$(a SHA256SUMS)"

if [ "$fails" != 0 ]; then
  echo "$fails case(s) failed"
  exit 1
fi
echo "all cases passed"
