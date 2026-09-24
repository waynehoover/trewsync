#!/usr/bin/env bash
#
# Prints the path of a pinned release tool, fetching it first if it is not
# already here: goreleaser, which builds the trewd binaries, and packslip, which
# signs and checks the release manifest.
#
#   scripts/release-tools.sh goreleaser
#   scripts/release-tools.sh packslip
#
# One version of each, and one digest per platform, written below. CI and
# scripts/check.sh both come through here, so the binaries a release is built
# and checked with are the ones the checks ran against, rather than whatever
# `latest` was on the day. A version is raised by editing this file in a
# commit, digests and all, where it can be reviewed and reverted.
#
# A copy already on PATH at exactly the pinned version is used as it is.
# Anything else is downloaded into a cache, checked against the digest written
# here, and refused if it does not match. Nothing is installed anywhere a shell
# would find it: the cache is this script's and nobody else's.
set -euo pipefail

tool=${1:?usage: release-tools.sh goreleaser|packslip}

goreleaser_version=2.18.2
packslip_version=1.3.0

os=$(uname -s)
arch=$(uname -m)
case "$arch" in
  x86_64 | amd64) arch=x86_64 ;;
  arm64 | aarch64) arch=arm64 ;;
esac

case "$tool:$os:$arch" in
  goreleaser:Darwin:arm64)
    asset=goreleaser_Darwin_arm64.tar.gz
    sum=a811ff154fe136a0cfb55d00126c151fc39ec370a663d805a9ca5547445aa70c ;;
  goreleaser:Darwin:x86_64)
    asset=goreleaser_Darwin_x86_64.tar.gz
    sum=5e97d6517f73a0b6f71675a2911b15d3136c03c8907650c2b18e114b1c0f5205 ;;
  goreleaser:Linux:x86_64)
    asset=goreleaser_Linux_x86_64.tar.gz
    sum=0a96edc9d9bc594e4a41cc4d59467c182062910ab24d9d1f6dd7b667d32606d3 ;;
  goreleaser:Linux:arm64)
    asset=goreleaser_Linux_arm64.tar.gz
    sum=a71681b29194f08f057a68cfcaa5c6b15d907a83a2622c51900c4faff828f322 ;;
  packslip:Darwin:arm64)
    asset=packslip-v$packslip_version-darwin-arm64.tar.xz
    sum=669f0c1b094b239c041490b079e9c03276656abd1ceb089c98da98c423ca02c9 ;;
  packslip:Linux:x86_64)
    asset=packslip-v$packslip_version-linux-x64.tar.xz
    sum=0f6bcbd108261a6a5ae8ffd9cdbce1deb8c40cd318d65026cbf5ced47a8ffd26 ;;
  packslip:Linux:arm64)
    asset=packslip-v$packslip_version-linux-arm64.tar.xz
    sum=bd939d3c224c0b75d23bc6cdd6fe40e050b7eec6c08a6d565c58803fd8984cc6 ;;
  goreleaser:* | packslip:*)
    echo "release-tools: no pinned $tool for $os/$arch" >&2
    exit 2 ;;
  *)
    echo "release-tools: unknown tool $tool (goreleaser or packslip)" >&2
    exit 2 ;;
esac

case "$tool" in
  goreleaser)
    version=$goreleaser_version
    url=https://github.com/goreleaser/goreleaser/releases/download/v$version/$asset ;;
  packslip)
    version=$packslip_version
    url=https://github.com/jdx/packslip/releases/download/v$version/$asset ;;
esac

# The one on PATH, when it is the pinned version. Both print their version on
# the first line of `--version`/`version`, in their own words.
if found=$(command -v "$tool" 2>/dev/null); then
  case "$tool" in
    goreleaser) says=$("$found" --version 2>/dev/null | sed -n 's/^GitVersion: *//p' | head -1) ;;
    packslip) says=$("$found" version 2>/dev/null | head -1 | awk '{print $NF}') ;;
  esac
  if [ "${says#v}" = "$version" ]; then
    printf '%s\n' "$found"
    exit 0
  fi
fi

cache=${TREW_TOOLS_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/trew-release-tools}
dir="$cache/$tool-$version"
bin="$dir/$tool"
if [ -x "$bin" ]; then
  printf '%s\n' "$bin"
  exit 0
fi

mkdir -p "$cache"
work=$(mktemp -d "$cache/.fetch.XXXXXX")
trap 'rm -rf "$work"' EXIT
if ! curl -fsSL --retry 3 -o "$work/$asset" "$url"; then
  echo "release-tools: could not download $url" >&2
  exit 3
fi
got=$(shasum -a 256 "$work/$asset" | awk '{print $1}')
if [ "$got" != "$sum" ]; then
  echo "release-tools: $asset is $got, and this script pins $sum. Not using it." >&2
  exit 1
fi
mkdir -p "$work/x"
tar -xf "$work/$asset" -C "$work/x"
found=$(find "$work/x" -type f -name "$tool" -perm -u+x | head -1)
[ -n "$found" ] || { echo "release-tools: no $tool inside $asset" >&2; exit 1; }
mkdir -p "$work/out"
mv "$found" "$work/out/$tool"
# Into place in one rename, so a run interrupted halfway leaves no directory
# that looks installed and is not.
rm -rf "$dir"
mv "$work/out" "$dir"
printf '%s\n' "$bin"
