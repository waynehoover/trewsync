#!/usr/bin/env bash
#
# Install the npm package the way somebody else will, and run it (I21).
#
# What the publish workflow checked was `test -s dist/trew.mjs`: that a build
# had produced a file. Everything between that file and a working `trew` on
# somebody's machine was unchecked, and it is not a short list. `files` decides
# what is in the tarball, `bin` decides what the name points at, the shebang
# decides whether it runs, and `engines` claims a runtime the whole suite runs
# under a different one. Any of those can be wrong while every test passes, and
# an npm version cannot be replaced once it is published.
#
# So: pack it, install the tarball into a directory of its own, and run the
# command out of that directory under plain node. Nothing here reaches into the
# working tree, which is the point: a check that can see src/ proves nothing
# about a tarball that cannot.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root/client"

want=$(node -p "require('./package.json').version")
echo "==> packing trew-sync $want"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

[ -s dist/trew.mjs ] || { echo "no build to pack; run bun run build first" >&2; exit 1; }

tarball=$work/$(npm pack --silent --pack-destination "$work")
echo "    $(basename "$tarball"), $(wc -c < "$tarball" | tr -d ' ') bytes"

# What is actually in it.
#
# The direction that bites is extra, not missing. npm forces package.json, the
# README and whatever `bin` names into every tarball whatever `files` says, so
# "the bundle is present" cannot fail here and is not worth asserting; whether
# the bundle is any good is settled below by running it. What `files` does
# decide is everything else, and there it is a whitelist that stops being one
# quietly: an added entry, or a `files` key deleted altogether, ships src/, the
# test suite and the lockfile to everyone who installs this.
listing=$(tar tzf "$tarball" | sed 's|^package/||' | sort)
echo "$listing" | sed 's/^/    /'
unexpected=$(grep -vxF -e dist/trew.mjs -e package.json -e README.md <<< "$listing" || true)
if [ -n "$unexpected" ]; then
  echo "the tarball carries things the package does not mean to ship:" >&2
  echo "$unexpected" | sed 's/^/  /' >&2
  echo "Either add them to the list in this script on purpose, or fix client/package.json." >&2
  exit 1
fi

# Installed somewhere with no relationship to this checkout, so the only code
# that can run is the code in the tarball.
echo "==> installing it somewhere else"
mkdir -p "$work/elsewhere"
( cd "$work/elsewhere" && npm install --silent --no-audit --no-fund --prefix "$work/elsewhere" "$tarball" )

bin=$work/elsewhere/node_modules/.bin/trew
[ -x "$bin" ] || { echo "no trew command was installed" >&2; exit 1; }

# Under node, not bun. `engines` claims node and the whole suite runs under bun,
# so this is the only thing that has ever run the shipped bundle on the runtime
# the package says it needs.
echo "==> running it under node $(node --version)"
got=$("$bin" --version)
echo "    version: $got"
if [ "$got" != "$want" ]; then
  echo "the packed CLI says \"$got\", and the package says $want" >&2
  exit 1
fi

# `--help` is what somebody types first, and a bundle that throws on startup
# throws here too.
"$bin" --help > "$work/help" 2>&1 || {
  echo "--help failed:" >&2; cat "$work/help" >&2; exit 1;
}
# Matching on a command rather than a heading: the wording of the summary line
# is somebody's prose and will change, and a check that breaks when it does is
# a check people learn to edit rather than read.
for listed in "trew sync" "trew pair" "--version"; do
  grep -qF -- "$listed" "$work/help" || {
    echo "--help does not mention $listed:" >&2; cat "$work/help" >&2; exit 1;
  }
done

# The command has no MCP server any more: the server's /mcp is the only one.
# A packed bundle that still answered `trew mcp` would be shipping code the
# release says is gone.
if "$bin" mcp > "$work/mcp" 2>&1; then
  echo "the packed CLI still runs trew mcp:" >&2; cat "$work/mcp" >&2; exit 1
fi
grep -qF "trewd mcp-token" "$work/mcp" || {
  echo "the packed CLI does not say where MCP went:" >&2; cat "$work/mcp" >&2; exit 1;
}

echo "==> pairing and syncing with the packed artifact under node"
bun run "$root/client/src/node/artifact.run.ts" \
  "$work/elsewhere/node_modules/trew-sync/dist/trew.mjs" "$(command -v node)"

echo "==> the packed CLI installs and runs"
