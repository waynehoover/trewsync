#!/usr/bin/env bash
#
# The attestation workflow can actually be started (R29).
#
# It publishes the release as its last step, so the release has to exist as a
# draft before it runs, and a draft is exactly what GitHub will not tell it
# about: `created`, `edited` and `deleted` are documented as excluding draft
# releases, and `published` is the thing this workflow is supposed to do rather
# than hear about. A workflow listening for a release event therefore sat there
# with nothing running, on the documented flow, and looked fine.
#
# So it runs on `workflow_dispatch` and `release.sh` prints the command beside
# the one that makes the draft. This reads the shipped files and asserts both
# halves, because the tempting edit is to add the release trigger back for
# convenience, and the way that fails is silence.
set -uo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
workflow="$root/.github/workflows/attest.yml"
release="$root/scripts/release.sh"
fails=0

fail() {
  printf '  FAIL %s\n' "$1" >&2
  fails=$((fails + 1))
}
ok() { printf '  ok   %s\n' "$1"; }

echo "starting the attestation:"

# Settings only. Every one of these is quoted in the paragraph above it, so a
# plain grep would find the explanation with the setting itself deleted.
settings() { grep -v '^ *#' "$@"; }

if settings "$workflow" | grep -q "workflow_dispatch:"; then
  ok "it can be started by hand"
else
  fail "there is no workflow_dispatch, so a draft release starts nothing"
fi

if settings "$workflow" | grep -qE "^ *release:"; then
  fail "it listens for a release event, which a draft does not fire"
else
  ok "it does not wait for an event a draft will never send"
fi

# And nothing still reads the tag off an event that no longer arrives: those
# expressions evaluate to empty, which checks out the default branch and
# attests the wrong bytes rather than failing.
if settings "$workflow" | grep -q "github.event.release"; then
  fail "something still reads github.event.release, which is empty under a dispatch"
else
  ok "the tag comes from the dispatch input everywhere"
fi

if grep -q "gh workflow run attest.yml" "$release"; then
  ok "release.sh prints the command that starts it"
else
  fail "release.sh tells nobody to start the workflow, so the draft just sits there"
fi

# ---- and that its target is still private (R39) ----------------------------
#
# Both upload steps replace assets with `--clobber`, which is safe against a
# draft and against nothing else: a rerun against a published release swaps the
# bytes people are downloading, and a rebuild that differs or an upload that
# fails partway leaves a public release whose checksums describe files it does
# not have. Being draft-only was the whole of the ordering and nothing asked.
#
# The gate belongs in `checked`, which both upload jobs need, so it is asked
# once and asked before the first mutation. Asserted by job, because a check
# placed beside the upload instead would read the same to a grep of the file.
checked=$(
  awk '/^  checked:/ { inside = 1; next } inside && /^  [^ #]/ { inside = 0 } inside' "$workflow"
)
if printf '%s\n' "$checked" | settings | grep -q "isDraft"; then
  ok "it establishes the release is a draft before anything is uploaded"
else
  fail "nothing checks the draft state, so a rerun replaces a public release's files"
fi

# And that job can actually see a draft.
#
# The check above asks whether the step is there, which it was while the job
# could not read the thing it checks: GitHub shows a draft release only to a
# token with push access, so `contents: read` makes `gh release view` answer
# "release not found" and the whole gate fails closed on every release. That
# is a safe failure and a broken one, and it survived a review because the
# step existed and read correctly.
if printf '%s\n' "$checked" | grep -qE "^      contents: write"; then
  ok "and can read one, which needs write: a draft is hidden from a read-only token"
else
  fail "the checked job cannot see a draft release, so every release fails at the gate"
fi

# And two runs against one release do not interleave: one replacing assets
# while the other publishes is the same exposure by another route.
if settings "$workflow" | grep -q "group: attest-"; then
  ok "one run per release at a time"
else
  fail "two runs on one tag can clobber each other's assets while a third step publishes"
fi

# Execute the shipped run blocks, so these checks cover what publishing and
# building actually do rather than whether a comment mentions the right flag.
run_block() {
  awk -v job="$1" -v step="$2" '
    /^  [^ #]/ { in_job = ($0 == "  " job ":") }
    in_job && /^      - / { in_step = ($0 == "      - name: " step); in_run = 0 }
    in_job && in_step && /^        run: \|/ { in_run = 1; next }
    in_run && /^          / { sub(/^          /, ""); print; next }
    in_run && NF { in_run = 0 }
  ' "$workflow"
}

scratch=$(mktemp -d) || exit 1
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/bin" "$scratch/runner"

# GitHub promotes a newly published release by default, including a server
# draft originally created with --latest=false. Model that publication step.
cat > "$scratch/bin/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1 $2" == "release edit" ]] || exit 2
tag=$3
shift 3
latest=true
published=false
for arg in "$@"; do
  case "$arg" in
    --latest=*) latest=${arg#--latest=} ;;
    --draft=false) published=true ;;
  esac
done
[[ "$published" == true ]] || exit 3
if [[ "$latest" == true ]]; then
  printf '%s\n' "$tag" > "$LATEST_RELEASE"
fi
SH
chmod +x "$scratch/bin/gh"

echo "publishing the attested releases:"
for job in plugin server; do
  case "$job" in
    plugin) tag=0.6.2 ;;
    server) tag=server/v0.6.2 ;;
  esac
  run_block "$job" publish > "$scratch/publish.sh"
  if [[ ! -s "$scratch/publish.sh" ]] || ! (
    PATH="$scratch/bin:$PATH" LATEST_RELEASE="$scratch/latest" \
      GITHUB_REPOSITORY=example/trew TAG="$tag" \
      bash -euo pipefail "$scratch/publish.sh" > "$scratch/publish.log" 2>&1
  ); then
    fail "$job publication did not execute successfully"
    cat "$scratch/publish.log" >&2
  elif [[ "$(cat "$scratch/latest" 2>/dev/null)" != 0.6.2 ]]; then
    fail "$job publication left GitHub latest pointing away from the plugin"
  else
    ok "$job publication leaves the plugin as GitHub latest"
  fi
done

# Build a tiny real Go program in a clean temporary checkout, with the
# workflow's own build step, which runs goreleaser through
# scripts/build-server.sh. Its build metadata must name that clean commit;
# generating one binary inside the checkout used to dirty the next three, and
# goreleaser's working directory is inside the checkout too, so this is also
# what shows .gitignore keeps it out of git's sight.
echo "building attested server binaries:"
fixture="$scratch/checkout"
mkdir -p "$fixture/cmd/trewd"
printf 'module example.test/attest-fixture\n\ngo 1.22\n' > "$fixture/go.mod"
cat > "$fixture/cmd/trewd/main.go" <<'GO'
package main

var version = "dev"

func main() { println(version) }
GO
mkdir -p "$fixture/scripts"
cp "$root/.goreleaser.yml" "$root/.gitignore" "$fixture/"
cp "$root/scripts/build-server.sh" "$root/scripts/release-tools.sh" "$fixture/scripts/"
git -c init.templateDir= init -q "$fixture" || exit 1
git -C "$fixture" add go.mod cmd scripts .goreleaser.yml .gitignore || exit 1
git -C "$fixture" -c user.name=Test -c user.email=test@example.test \
  -c commit.gpgsign=false -c core.hooksPath=/dev/null commit -qm fixture || exit 1
revision=$(git -C "$fixture" rev-parse HEAD) || exit 1
run_block server build > "$scratch/build.sh"
if [[ ! -s "$scratch/build.sh" ]] || ! (
  cd "$fixture" && RUNNER_TEMP="$scratch/runner" TAG=server/v0.6.2 \
    bash -euo pipefail "$scratch/build.sh" > "$scratch/build.log" 2>&1
); then
  fail "the extracted server build did not execute successfully"
  cat "$scratch/build.log" >&2
else
  for target in linux-amd64 linux-arm64 linux-riscv64 darwin-arm64 darwin-amd64 freebsd-amd64 freebsd-arm64; do
    binary="$fixture/attested/trewd-$target"
    if ! go version -m "$binary" > "$scratch/metadata" 2>&1; then
      fail "$target has no readable Go build metadata"
    elif ! grep -Fq "vcs.revision=$revision" "$scratch/metadata"; then
      fail "$target does not identify the checked commit"
    elif ! grep -Fq 'vcs.modified=false' "$scratch/metadata"; then
      fail "$target incorrectly records modified source"
    else
      ok "$target identifies the clean checked commit"
    fi
  done
fi

# And that it runs from the tag it was given, or not at all.
#
# A dispatch runs the workflow file of the ref it names, and the tag is only an
# input, so a run from a branch checks out and builds the tag with that
# branch's copy of this file, edited however the branch likes, and signs as
# attest.yml. trewd update refuses its manifest, since the signer must end in
# the release's own tag, but the plugin's attestations and the publish step do
# not ask. So the first step of `checked`, which every other job needs, refuses
# any run whose ref is not refs/tags/ followed by the input, before anything is
# checked out. Executed, against the ref a run can come from.
echo "refusing a run from anything but its own tag:"
run_block checked "refuse a run started from anything but its tag" > "$scratch/ref.sh"
first=$(printf '%s\n' "$checked" | settings | grep -m1 -E '^      - ' || true)
if [[ ! -s "$scratch/ref.sh" ]]; then
  fail "the checked job does not compare the ref it runs from with the tag"
elif [[ "$first" != "      - name: refuse a run started from anything but its tag" ]]; then
  fail "the ref is checked after another step of checked ran: $first"
else
  ok "the checked job compares the ref with the tag first"
  for c in \
    "0 server/v0.6.2 refs/tags/server/v0.6.2" \
    "0 0.6.2 refs/tags/0.6.2" \
    "1 server/v0.6.2 refs/heads/main" \
    "1 server/v0.6.2 refs/heads/server/v0.6.2" \
    "1 server/v0.6.2 refs/tags/server/v0.6.20" \
    "1 server/v0.6.2 refs/tags/server/v0.6.1" \
    "1 0.6.2 refs/heads/main"; do
    read -r want tag ref <<< "$c"
    got=0
    GITHUB_REF="$ref" TAG="$tag" bash -euo pipefail "$scratch/ref.sh" > "$scratch/ref.log" 2>&1 || got=$?
    if [[ "$want" == 0 && "$got" == 0 ]] || [[ "$want" != 0 && "$got" != 0 ]]; then
      ok "  tag $tag from $ref: exit $got"
    else
      fail "tag $tag from $ref exited $got, and should have $([[ $want == 0 ]] && echo run || echo refused)"
      cat "$scratch/ref.log" >&2
    fi
  done
fi
if grep -qE 'gh workflow run attest\.yml --ref @PLUGIN@ -f tag=@PLUGIN@' "$release" \
  && grep -qE 'gh workflow run attest\.yml --ref server/v@SERVER@ -f tag=server/v@SERVER@' "$release"; then
  ok "and release.sh dispatches both from their tags"
else
  fail "release.sh prints a dispatch that does not name its tag as the ref, which the workflow refuses"
fi

# The signed manifest `trewd update` refuses to install without. What it pins
# is in cmd/trewd/update.go, and each of these is a way for the two to stop
# agreeing that no release would say out loud until somebody's update refused.
echo "signing the server's release manifest:"
server_job=$(awk '/^  server:/ { inside = 1 } inside' "$workflow" | settings)
packslip_step=$(printf '%s\n' "$server_job" | awk '/uses: jdx\/packslip@/ { inside = 1 } inside && /^      - name:/ { exit } inside')
if [ -n "$packslip_step" ]; then
  ok "the server job signs a packslip manifest"
else
  fail "the server job signs no packslip manifest, so trewd update refuses every release"
fi
for want in \
  "project: github.com/\${{ github.repository }}/server" \
  "version: \${{ steps.source.outputs.version }}" \
  "commit: \${{ steps.source.outputs.commit }}" \
  "tag: \${{ inputs.tag }}" \
  "artifacts: attested/trewd-*" \
  "bin: trewd" \
  "attest: link"; do
  if printf '%s\n' "$packslip_step" | grep -qF "$want"; then
    ok "  with $want"
  else
    fail "the packslip step does not say $want"
  fi
done
if grep -qF 'updateProject  = "github.com/waynehoover/trew/server"' "$root/cmd/trewd/update.go" \
  && grep -qF '/.github/workflows/attest.yml@"' "$root/cmd/trewd/update.go"; then
  ok "and trewd update pins that project and this workflow"
else
  fail "trewd update no longer pins github.com/waynehoover/trew/server signed by attest.yml"
fi
# Before publish, so a failed signature leaves a draft.
order=$(printf '%s\n' "$server_job" | grep -nE 'uses: jdx/packslip@|- name: publish' | cut -d: -f1 | tr '\n' ' ')
read -r sign_at publish_at <<< "$order"
if [ -n "${publish_at:-}" ] && [ "$sign_at" -lt "$publish_at" ]; then
  ok "  before the release is published"
else
  fail "the manifest is signed after the release is published, or not at all"
fi
for perm in "id-token: write" "attestations: write" "contents: write"; do
  if settings "$workflow" | grep -qE "^  ${perm%%:*}: write"; then
    ok "  and the workflow may: $perm"
  else
    fail "the workflow lacks $perm, which the packslip action needs"
  fi
done

if [ "$fails" != 0 ]; then
  echo "$fails check(s) failed"
  exit 1
fi
echo "all checks passed"
