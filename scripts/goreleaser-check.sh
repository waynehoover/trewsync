#!/usr/bin/env bash
#
# The goreleaser config builds what a server release ships, and nothing a
# release should not.
#
# Checked on every change rather than on the day of a release, because the
# release is the one run of this config that cannot fail quietly: a platform
# dropped from the list is a platform whose users `trewd update` tells there is
# no build, and a stray build tag is a binary whose trust pin is not the
# release's (cmd/trewd/update_testpin.go).
#
# Nothing here publishes. The build is a snapshot into a scratch directory.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fails=0
fail() { printf '  FAIL %s\n' "$1" >&2; fails=$((fails + 1)); }
ok() { printf '  ok   %s\n' "$1"; }

goreleaser=$("$root/scripts/release-tools.sh" goreleaser)
( cd "$root" && "$goreleaser" check >/dev/null 2>&1 ) && ok "goreleaser accepts .goreleaser.yml" \
  || fail "goreleaser check refuses .goreleaser.yml"

version=0.0.1-check
"$root/scripts/build-server.sh" "$version" "$work/dist" > "$work/built" 2>"$work/build.log" || {
  cat "$work/build.log" >&2
  fail "the snapshot build failed"
  exit 1
}

# Exactly these. Adding one is a decision (and a line in the Homebrew formula,
# scripts/verify-release.sh and docs/development.md); losing one is a bug.
want="trewd-darwin-amd64
trewd-darwin-arm64
trewd-freebsd-amd64
trewd-freebsd-arm64
trewd-linux-amd64
trewd-linux-arm64
trewd-linux-riscv64"
have=$(cd "$work/dist" && ls trewd-* | sort)
if [ "$have" = "$want" ]; then
  ok "it builds the seven platforms a release ships"
else
  fail "it builds a different set of platforms:"
  diff <(printf '%s\n' "$want") <(printf '%s\n' "$have") >&2 || true
fi

for name in $have; do
  meta=$(cd "$root" && go version -m "$work/dist/$name")
  problems=""
  grep -q $'\tbuild\t-trimpath=true' <<< "$meta" || problems="$problems no -trimpath;"
  grep -q $'\tbuild\tCGO_ENABLED=0' <<< "$meta" || problems="$problems cgo is on;"
  grep -q $'\tbuild\t-tags=' <<< "$meta" && problems="$problems built with tags;"
  # -trimpath leaves -ldflags out of the build info, so the stamp is looked
  # for where it ends up: as a string in the binary.
  grep -qaF "$version" "$work/dist/$name" || problems="$problems not stamped $version;"
  if [ -z "$problems" ]; then
    ok "$name is static, trimmed, untagged and stamped $version"
  else
    fail "$name:$problems"
  fi
done

host="trewd-$(cd "$root" && go env GOOS)-$(cd "$root" && go env GOARCH)"
if [ -x "$work/dist/$host" ]; then
  said=$("$work/dist/$host" version | awk 'NR == 1 { print $2 }')
  [ "$said" = "$version" ] && ok "$host runs here and says $version" \
    || fail "$host says it is $said, not $version"
fi

# The same bytes a plain `go build` with the release flags makes, so a binary
# anyone rebuilds from the tag can be compared to the published one.
( cd "$root" && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$version" \
    -o "$work/by-hand" ./cmd/trewd )
if cmp -s "$work/by-hand" "$work/dist/$host"; then
  ok "goreleaser's $host is byte-identical to go build with the release flags"
else
  fail "goreleaser's $host differs from go build with the same flags"
fi

if [ "$fails" -ne 0 ]; then
  echo "$fails check(s) failed" >&2
  exit 1
fi
echo "goreleaser builds every platform"
