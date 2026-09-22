#!/usr/bin/env bash
#
# Every doc comment sits on the thing it names.
#
# A declaration inserted between a doc comment and its function leaves the
# paragraph documenting something else and the function undocumented, and the
# compiler has nothing to say about it. Eight of them had accumulated, one the
# whole bodies-then-names durability contract on `chunks.Store.Put`, and two
# were added the same afternoon by the person fixing the other six.
#
# The rule is narrow so that it has no false positives worth arguing with: a
# doc comment opening with a name that *is declared elsewhere in the same
# file*, sitting on a declaration of some other name, is misplaced. A comment
# opening with an ordinary word is not checked, because plenty here begin with
# a sentence about the problem rather than with the identifier.
set -uo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root" || exit 2

fails=0
while IFS= read -r file; do
  awk -v file="$file" '
    function nameOf(line,   d) {
      d = line
      sub(/^func \([^)]*\) /, "func ", d)
      sub(/^(func|var|const|type) /, "", d)
      sub(/[ (\[=].*$/, "", d)
      return d
    }
    # First pass: every name this file declares at the top level.
    NR == FNR {
      if ($0 ~ /^(func|var|const|type) /) declared[nameOf($0)] = 1
      next
    }
    /^\/\/ [A-Za-z_][A-Za-z0-9_]* / {
      if (!indoc) { indoc = 1; named = $2; at = FNR }
      next
    }
    /^\/\// { next }
    indoc && /^(func|var|const|type) / {
      here = nameOf($0)
      # A grouped `const (` yields nothing to compare against.
      if (here != "" && named != here && (named in declared)) {
        printf "  %s:%d: the comment describes %s and sits on %s\n", file, at, named, here
        bad = 1
      }
      indoc = 0
      next
    }
    { indoc = 0 }
    END { exit(bad) }
  ' "$file" "$file" || fails=$((fails + 1))
done < <(find cmd internal -name '*.go' -not -name '*_test.go' | sort)

if [ "$fails" != 0 ]; then
  echo "$fails file(s) have a doc comment on the wrong declaration"
  exit 1
fi
echo "every doc comment names the declaration it sits on"
