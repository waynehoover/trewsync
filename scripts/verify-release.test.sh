#!/usr/bin/env bash
# Exercise the real verifier against incomplete downloads, without publishing
# or reaching GitHub, npm or a container registry.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
verifier=${TREW_VERIFY_SCRIPT:-"$root/scripts/verify-release.sh"}
package_path=$PATH
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/bin" "$scratch/assets"
export TREW_VERIFY_FIXTURE="$scratch/assets"
export TREW_VERIFY_SERVER_VERSION=1.2.3
export TREW_VERIFY_CLI_VERSION=1.2.3

cat > "$scratch/bin/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  'release download')
    shift 3
    while [ $# -gt 0 ]; do
      case "$1" in
        --dir) destination=$2; shift 2 ;;
        --repo) shift 2 ;;
        --clobber) shift ;;
        *) exit 2 ;;
      esac
    done
    cp "$TREW_VERIFY_FIXTURE"/* "$destination/"
    ;;
  'attestation verify') exit 0 ;;
  api*) printf '{"1.2.3":"1.7.2"}\n' ;;
  *) exit 2 ;;
esac
SH
cat > "$scratch/bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  'buildx imagetools') printf 'sha256:fixture\n' ;;
  'image rm') exit 0 ;;
  'run --rm')
    printf 'Pulling image from the registry\n' >&2
    printf 'trewd %s linux/test go-test\n' "$TREW_VERIFY_SERVER_VERSION"
    ;;
  *) exit 2 ;;
esac
SH
cat > "$scratch/bin/npm" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  pack)
    printf 'tarball fixture\n' > trew-sync-1.2.3.tgz
    printf 'trew-sync-1.2.3.tgz\n'
    ;;
  view) printf 'sha512-fixture\n' ;;
  install)
    shift
    while [ $# -gt 0 ]; do
      if [ "$1" = --prefix ]; then destination=$2; shift 2; else shift; fi
    done
    mkdir -p "$destination/node_modules/.bin"
    printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$TREW_VERIFY_CLI_VERSION"\n' > "$destination/node_modules/.bin/trew"
    chmod +x "$destination/node_modules/.bin/trew"
    ;;
  *) exit 2 ;;
esac
SH
# packslip, which says yes unless told to refuse, records the pin it was
# given so the test can see it was the release workflow's, and reports the
# signer it is told to (the real one, by default), as --json asks.
cat > "$scratch/bin/packslip" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$TREW_VERIFY_FIXTURE/../packslip.args"
[ -z "${TREW_VERIFY_PACKSLIP_REFUSE:-}" ] || { echo "signature does not verify" >&2; exit 1; }
signer=${TREW_VERIFY_SIGNER:-https://github.com/waynehoover/trew/.github/workflows/attest.yml@refs/tags/server/v1.2.3}
printf '{"scheme":"sigstore-oidc","key_id":"%s","issuer":"https://token.actions.githubusercontent.com","checked_artifacts":[]}\n' "$signer"
SH
chmod +x "$scratch/bin/gh" "$scratch/bin/docker" "$scratch/bin/npm" "$scratch/bin/packslip"
export PATH="$scratch/bin:$PATH"

plugin_assets=(main.js manifest.json styles.css)
server_assets=(trewd-linux-amd64 trewd-linux-arm64 trewd-linux-riscv64 trewd-darwin-amd64
  trewd-darwin-arm64 trewd-freebsd-amd64 trewd-freebsd-arm64)
fixture() {
  local asset
  rm -f "$scratch/assets/"*
  if [ "$1" = plugin ]; then
    printf 'module.exports = {};\n' > "$scratch/assets/main.js"
    printf '{"version":"1.2.3","minAppVersion":"1.7.2"}\n' > "$scratch/assets/manifest.json"
    printf '.trew { display: block; }\n' > "$scratch/assets/styles.css"
  else
    for asset in "${server_assets[@]}"; do
      printf 'binary fixture for %s\n' "$asset" > "$scratch/assets/$asset"
    done
    # Not in SHA256SUMS: packslip uploads it after the sums are written.
    printf '{"mediaType":"fixture"}\n' > "$scratch/assets/packslip.server.sigstore.json"
  fi
}
sums() { ( cd "$scratch/assets" && shasum -a 256 "$@" > SHA256SUMS ); }
failures=0
check() {
  local expected=$1 component=$2 scenario=$3 result=0
  bash "$verifier" "--$component" 1.2.3 > "$scratch/output" 2>&1 || result=$?
  if [ "$result" -ne "$expected" ]; then
    printf 'FAIL: %s: expected exit %s, got %s\n' "$scenario" "$expected" "$result"
    cat "$scratch/output"
    failures=$((failures + 1))
  else
    printf 'ok: %s\n' "$scenario"
  fi
}

for component in plugin server; do
  if [ "$component" = plugin ]; then assets=("${plugin_assets[@]}"); else assets=("${server_assets[@]}"); fi
  fixture "$component"
  sums "${assets[@]}"
  check 0 "$component" "complete $component release"
  for asset in "${assets[@]}"; do
    fixture "$component"
    remaining=()
    for other in "${assets[@]}"; do
      [ "$other" = "$asset" ] || remaining+=("$other")
    done
    sums "${remaining[@]}"
    check 1 "$component" "$asset omitted from checksums"
    rm "$scratch/assets/$asset"
    check 1 "$component" "$asset missing from the download"
  done
done

fixture server
sums "${server_assets[@]}"
TREW_VERIFY_SERVER_VERSION=1.2.30 check 1 server 'a different version containing the requested version'

# The signed manifest: present, verified against the release workflow's pin,
# and the release refused when it is missing or does not verify.
fixture server
sums "${server_assets[@]}"
check 0 server 'a server release with its manifest'
pin=$(tr '\n' ' ' < "$scratch/packslip.args")
case "$pin" in
  *"--identity-prefix https://github.com/waynehoover/trew/.github/workflows/attest.yml@refs/tags/server/v1.2.3 --issuer https://token.actions.githubusercontent.com"*"--artifact"*)
    echo "ok: the manifest is checked against the release workflow, with the binaries" ;;
  *)
    echo "FAIL: packslip was not given the release pin and the binaries: $pin"
    failures=$((failures + 1)) ;;
esac
TREW_VERIFY_PACKSLIP_REFUSE=1 check 1 server 'a manifest packslip refuses'
# The signer is the release workflow run from this release's own tag, the
# whole identity, as trewd update requires: attest.yml dispatched from a
# branch, or from a tag the prefix alone would accept, is not it.
workflow=https://github.com/waynehoover/trew/.github/workflows/attest.yml@
for signer in "${workflow}refs/heads/main" "${workflow}refs/tags/server/v1.2.30" "${workflow}refs/tags/server/v1.2.3-evil"; do
  TREW_VERIFY_SIGNER=$signer check 1 server "a manifest signed by $signer"
done
rm "$scratch/assets/packslip.server.sigstore.json"
check 1 server 'a server release without its manifest'
check 0 cli 'the CLI reports the requested version'
TREW_VERIFY_CLI_VERSION=1.2.30 check 1 cli 'the CLI reports a different version containing the requested version'

# Run the image workflow's actual version check against the same two replies.
awk '
  /^      - name:/ { selected = /both architectures run, and agree about what they are/; block = 0 }
  selected && /^        run: \|/ { block = 1; next }
  block && /^          / { sub(/^          /, ""); print; next }
  block && NF { block = 0 }
' "$root/.github/workflows/release.yml" > "$scratch/image-check.sh"
[ -s "$scratch/image-check.sh" ] || { echo 'no image version check found'; exit 1; }
for actual in 1.2.3 1.2.30; do
  result=0
  REF=example/image@sha256:fixture WANT=1.2.3 TREW_VERIFY_SERVER_VERSION="$actual" \
    bash -euo pipefail "$scratch/image-check.sh" > "$scratch/output" 2>&1 || result=$?
  if { [ "$actual" = 1.2.3 ] && [ "$result" -eq 0 ]; } || { [ "$actual" != 1.2.3 ] && [ "$result" -eq 1 ]; }; then
    echo "ok: image publication check for $actual"
  else
    echo "FAIL: image publication check accepted/refused the wrong version $actual (exit $result)"
    failures=$((failures + 1))
  fi
done

# Packing and installation are real here; only the tiny CLI's version differs.
package_root="$scratch/package"
mkdir -p "$package_root/scripts" "$package_root/client/dist" "$package_root/client/src/node"
cp "$root/scripts/pack-check.sh" "$package_root/scripts/"
# This fixture tests exact version comparison with a deliberately tiny CLI.
# The real pair and sync workflow runs in pack-check and artifact.test.ts;
# record delegation here so a metadata fixture need not imitate a server.
cat > "$package_root/client/src/node/artifact.run.ts" <<'TREW_PACK_FIXTURE'
import { access } from "node:fs/promises";
if (process.argv.length !== 4) throw new Error("missing artifact or Node executable");
await access(process.argv[2]);
await access(process.argv[3]);
console.info("packed artifact fixture invoked");
TREW_PACK_FIXTURE
printf '{"name":"trew-sync","version":"1.2.3","files":["dist/trew.mjs"],"bin":{"trew":"dist/trew.mjs"}}\n' > "$package_root/client/package.json"
for actual in 1.2.3 1.2.30; do
  printf '#!/usr/bin/env node\nif (process.argv[2] === "mcp") { console.error("trew mcp is gone: trewd mcp-token"); process.exit(2); }\nconsole.log(process.argv.includes("--version") ? "%s" : "trew sync trew pair --version");\n' "$actual" > "$package_root/client/dist/trew.mjs"
  result=0
  PATH="$package_path" bash "$package_root/scripts/pack-check.sh" > "$scratch/output" 2>&1 || result=$?
  if { [ "$actual" = 1.2.3 ] && [ "$result" -eq 0 ] && grep -qF 'packed artifact fixture invoked' "$scratch/output"; } || { [ "$actual" != 1.2.3 ] && [ "$result" -eq 1 ]; }; then
    echo "ok: packed CLI version check for $actual"
  else
    echo "FAIL: packed CLI check accepted/refused the wrong version $actual (exit $result)"
    cat "$scratch/output"
    failures=$((failures + 1))
  fi
done
# A packed CLI that still answers `trew mcp` is refused.
printf '#!/usr/bin/env node\nconsole.log(process.argv.includes("--version") ? "1.2.3" : "trew sync trew pair --version");\n' > "$package_root/client/dist/trew.mjs"
result=0
PATH="$package_path" bash "$package_root/scripts/pack-check.sh" > "$scratch/output" 2>&1 || result=$?
if [ "$result" -eq 1 ] && grep -qF 'still runs trew mcp' "$scratch/output"; then
  echo "ok: a packed CLI that still runs trew mcp is refused"
else
  echo "FAIL: pack-check accepted a CLI that still runs trew mcp (exit $result)"
  cat "$scratch/output"
  failures=$((failures + 1))
fi

if [ "$failures" -gt 0 ]; then
  printf '%s verification checks failed\n' "$failures"
  exit 1
fi
echo 'all release verification checks passed'
