#!/usr/bin/env bash
#
# flake.nix builds trewd, and the trewd it builds runs.
#
#   scripts/flake-check.sh          build with the committed flake.lock
#   scripts/flake-check.sh --lock   write flake.lock (first time, or to move nixpkgs)
#
# With nix if this machine has it, and otherwise with nix in a container, so a
# machine without nix can still answer the question instead of skipping it. The
# container's store is a named volume, trew-nix-store, so the second run does
# not download nixpkgs again; `docker volume rm trew-nix-store` gives the space
# back.
#
# The flake is built from a copy of exactly the files it names, outside git, so
# what is checked is the committed flake and lock over the source the binary is
# made from, not whatever else is lying in the working tree. When go.sum
# changes, vendorHash in flake.nix has to change with it, and the failure here
# says what the new hash is.
#
# Exit 2 means neither nix nor a docker daemon was available: not a pass.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
mode=${1:-check}
# nixos/nix 2.x, by digest, so the check does not move when the tag does.
image=nixos/nix@sha256:7a007c766426c1877758ddc5cb87a965ac131fc78c582ce0083d922d51ae945c

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
src=$work/src
mkdir -p "$src"
cp -R "$root/flake.nix" "$root/go.mod" "$root/go.sum" "$root/cmd" "$root/internal" "$src/"
if [ "$mode" = --lock ]; then
  rm -f "$src/flake.lock"
elif [ -f "$root/flake.lock" ]; then
  cp "$root/flake.lock" "$src/"
else
  echo "flake-check: there is no flake.lock; write one with scripts/flake-check.sh --lock" >&2
  exit 1
fi

# The script run inside, by nix or the container, from /src. It builds, runs
# the result, and leaves the lock beside the source for --lock to take.
cat > "$src/.flake-check.sh" <<'INSIDE'
set -eu
nixf="nix --extra-experimental-features nix-command --extra-experimental-features flakes"
if [ "$1" = --lock ]; then
  $nixf flake lock "path:$PWD"
  lockflag=""
else
  lockflag="--no-update-lock-file"
fi
out=$($nixf build "path:$PWD#trewd" $lockflag --no-link --print-out-paths --print-build-logs)
echo "built $out"
"$out/bin/trewd" version
INSIDE

if command -v nix >/dev/null 2>&1; then
  ( cd "$src" && sh .flake-check.sh "$mode" ) | tee "$work/log"
elif docker info >/dev/null 2>&1; then
  docker run --rm -v trew-nix-store:/nix -v "$src:/src" -w /src "$image" \
    sh /src/.flake-check.sh "$mode" 2>&1 | tee "$work/log"
else
  echo "flake-check: neither nix nor a docker daemon is available, so the flake was not built" >&2
  exit 2
fi
status=${PIPESTATUS[0]}
if [ "$status" -ne 0 ]; then
  got=$(sed -n 's/.*got: *\(sha256-[A-Za-z0-9+/=]*\).*/\1/p' "$work/log" | tail -1)
  [ -z "$got" ] || echo "flake-check: vendorHash in flake.nix should be $got" >&2
  exit 1
fi

# What it says it is: the one binary, built by the flake, stamped as a flake
# build rather than as a release.
if ! grep -qE '^trewd unstable-[0-9a-z-]+ (linux|darwin)/' "$work/log"; then
  echo "flake-check: the flake's trewd does not say it is an unstable build" >&2
  exit 1
fi
if [ "$mode" = --lock ]; then
  cp "$src/flake.lock" "$root/flake.lock"
  echo "wrote flake.lock"
fi
echo "the flake builds trewd"
