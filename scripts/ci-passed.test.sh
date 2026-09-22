#!/usr/bin/env bash
#
# What the publish gate does with each answer the API can give (I21).
#
# The gate is four lines of shell inside three workflow files, which is where
# untested logic lives: the only way to find out it was wrong would be a
# release that published from a red commit, and that is the thing it exists to
# prevent. So it is one script, and this drives it against a stub `gh`.
#
# The case that matters most is the third. "No run for this commit" and "the
# run passed" are one missing check apart, and a gate that treated silence as
# consent would pass every test above while protecting nothing.
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
gate="$here/ci-passed.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fails=0

# A stub `gh` that answers from a file, so a case is a fixture rather than a
# mock framework. `jq` is real: the gate's filters are half of what is under
# test and stubbing them would test nothing.
mkdir -p "$work/bin"
cat > "$work/bin/gh" <<'STUB'
#!/usr/bin/env bash
url=$2
if [[ "$url" == *"/commits/"* ]]; then
  printf '"%s"\n' "$(cat "$GH_FIXTURE_DIR/sha")"
  exit 0
fi
# Successive calls to the runs endpoint read successive fixtures, which is how
# "still running, then finished" is expressed.
n=$(cat "$GH_FIXTURE_DIR/n" 2>/dev/null || echo 1)
echo $((n + 1)) > "$GH_FIXTURE_DIR/n"
body=$GH_FIXTURE_DIR/runs.$n.json
[ -f "$body" ] || body=$GH_FIXTURE_DIR/runs.last.json
jq "${@: -1}" < "$body"
STUB
chmod +x "$work/bin/gh"
export PATH="$work/bin:$PATH"

run_case() { # run_case <name> <expected exit> <sha> [runs fixtures...]
  local name=$1 want=$2 sha=$3; shift 3
  local dir; dir=$(mktemp -d "$work/case.XXXXXX")
  echo "$sha" > "$dir/sha"
  local i=1
  for f in "$@"; do printf '%s\n' "$f" > "$dir/runs.$i.json"; i=$((i + 1)); done
  cp "$dir/runs.$((i - 1)).json" "$dir/runs.last.json"

  local out got
  out=$(GH_FIXTURE_DIR=$dir GH_TOKEN=x CI_WAIT_TRIES=3 CI_WAIT_SLEEP=0 \
    bash "$gate" owner/repo "$sha" 2>&1)
  got=$?
  if [ "$got" = "$want" ]; then
    printf '  ok   %s\n' "$name"
  else
    printf '  FAIL %s: wanted exit %s, got %s\n' "$name" "$want" "$got"
    printf '%s\n' "$out" | sed 's/^/       /'
    fails=$((fails + 1))
  fi
}

none='{"workflow_runs":[]}'
passed='{"workflow_runs":[{"name":"CI","status":"completed","conclusion":"success","html_url":"u"}]}'
failed='{"workflow_runs":[{"name":"CI","status":"completed","conclusion":"failure","html_url":"u"}]}'
cancelled='{"workflow_runs":[{"name":"CI","status":"completed","conclusion":"cancelled","html_url":"u"}]}'
running='{"workflow_runs":[{"name":"CI","status":"in_progress","conclusion":null,"html_url":"u"}]}'
# A run of a different workflow on the same commit. Attest and the image build
# both run against tags, so there is always something green here that is not CI.
other='{"workflow_runs":[{"name":"attest","status":"completed","conclusion":"success","html_url":"u"}]}'

echo "the publish gate:"
run_case "lets a passing commit through"                0 deadbeef "$passed"
run_case "refuses a failed run"                         1 deadbeef "$failed"
run_case "refuses a cancelled run, which is not a pass" 1 deadbeef "$cancelled"
run_case "refuses a commit with no CI run at all"       1 deadbeef "$none"
run_case "is not satisfied by some other workflow"      1 deadbeef "$other"
run_case "waits for a run still going, then passes"     0 deadbeef "$running" "$running" "$passed"
run_case "waits for a run still going, then refuses"    1 deadbeef "$running" "$failed"
run_case "refuses a run that never finishes"            1 deadbeef "$running"
run_case "resolves a tag to the commit it points at"    0 v9.9.9   "$passed"

# One mixed case on its own: two CI runs on the same commit, one of them red.
# A re-run of a failed job leaves both behind, and taking the first or the
# newest would let the green one speak for the red one.
mixed='{"workflow_runs":[
  {"name":"CI","status":"completed","conclusion":"success","html_url":"a"},
  {"name":"CI","status":"completed","conclusion":"failure","html_url":"b"}]}'
run_case "refuses when any CI run on the commit is red" 1 deadbeef "$mixed"

if [ "$fails" != 0 ]; then
  echo "$fails case(s) failed"
  exit 1
fi
echo "all cases passed"
