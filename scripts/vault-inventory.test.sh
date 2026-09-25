#!/usr/bin/env bash
#
# scripts/vault-inventory.py, against vaults built here: the inventory names
# every exclusion with its reason, compare says go only when the witness holds
# every synced path byte for byte, each kind of unexplained difference is a
# no-go, and a rollback export applied to the frozen vault reproduces the
# current one while refusing to overwrite a file changed on both sides.
#
# The M10 cutover rests on this script's verdict (plan/cutover.md), so a
# comparison that passed a missing or different file would be the failure the
# whole procedure exists to catch.
set -euo pipefail

cd "$(dirname "$0")/.."
root=$(pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

inv() { uv run --no-project --python 3.13 "$root/scripts/vault-inventory.py" "$@"; }
fails=0
ok() { printf 'ok    %s\n' "$1"; }
bad() { printf 'FAIL  %s\n' "$1"; fails=$((fails + 1)); }

# expect_rc WANT LABEL PATTERN CMD...: CMD exits WANT and its output matches PATTERN.
expect_rc() {
  local want=$1 label=$2 pattern=$3; shift 3
  local out rc=0
  out=$("$@" 2>&1) || rc=$?
  if [ "$rc" = "$want" ] && grep -Eq -- "$pattern" <<<"$out"; then
    ok "$label"
  else
    bad "$label (exit $rc, want $want, pattern $pattern)"
    printf '%s\n' "$out" | tail -15 | sed 's/^/      /'
  fi
}

# ---- a source vault with one of everything ----------------------------------
src="$tmp/source"
mkdir -p "$src/notes/sub" "$src/.obsidian" "$src/.git" "$src/empty dir"
printf '# a\n' > "$src/notes/a.md"
printf 'b\n' > "$src/notes/sub/b.md"
printf '\x00\x01\xfe\xff' > "$src/attach.bin"
: > "$src/empty.md"
printf 'nfd\n' > "$src/$(printf 'Cafe\xcc\x81.md')"    # NFD on the disk
printf 'nbsp\n' > "$src/$(printf 'no\xc2\xa0break.md')" # U+00A0
printf '{}' > "$src/.obsidian/app.json"
printf 'ref\n' > "$src/.git/HEAD"
printf 'x' > "$src/notes/.DS_Store"
head -c 2000 /dev/zero > "$src/big.bin"
ln -s notes/a.md "$src/link.md"

# A pair the fold holds as one name. A case-folding disk makes them one file
# already, so the group is only exercised where the disk keeps both.
printf 'one\n' > "$src/Stra$(printf '\xc3\x9f')e.md"
printf 'two\n' > "$src/Strasse.md"
collision_disk=0
set -- "$src"/Stra*e.md; [ $# = 2 ] && collision_disk=1

inv inventory "$src" --max-file 1000 -o "$tmp/source.inv" 2> "$tmp/source.summary"
summary=$(cat "$tmp/source.summary")
expect_json() { # expect_json LABEL PYTHON-EXPR-ON-s
  if python3 -c "import json,sys; s=json.loads(sys.argv[1]); sys.exit(0 if ($2) else 1)" "$summary"; then
    ok "$1"
  else
    bad "$1"; printf '%s\n' "$summary" | sed 's/^/      /'
  fi
}
expect_json "dot names are excluded by rule, with their reason" 's["excluded"]["dotprefix"] == 5'
expect_json "a file over -max-file is excluded as toolarge" 's["excluded"]["toolarge"] == 1'
expect_json "a symlink is excluded, not followed" 's["excluded"]["symlink"] == 1'
expect_json "the NFD and no-break-space names are listed as the clients send them" 's["synced"]["respelled"] == 2'
expect_json "an empty folder is a synced entry" 's["synced"]["folders"] == 3'
if [ "$collision_disk" = 1 ]; then
  expect_json "two names the fold holds as one are marked as a collision" 's["excluded"]["collision"] == 2'
fi
if grep -q '"path": "Café.md"' "$tmp/source.inv" && grep -q '"path": "no break.md"' "$tmp/source.inv"; then
  ok "paths are NFC with plain spaces"
else
  bad "paths are NFC with plain spaces"
fi

# ---- the frozen snapshot ----------------------------------------------------
expect_rc 0 "a snapshot proves its copy entry for entry" '^ok .*excluded ones included' \
  inv snapshot "$src" "$tmp/snap" --max-file 1000 -o "$tmp/snap.inv"
if cmp -s "$tmp/snap.inv" "$tmp/source.inv" && [ -L "$tmp/snap/link.md" ] && [ -f "$tmp/snap/.git/HEAD" ]; then
  ok "the snapshot keeps links as links and the excluded files too"
else
  bad "the snapshot keeps links as links and the excluded files too"
fi
expect_rc 1 "a snapshot never writes into an existing directory" 'exists' \
  inv snapshot "$src" "$tmp/snap" -o "$tmp/snap2.inv"

# ---- a witness: what a client downloads from that source --------------------
wit="$tmp/witness"
mkdir -p "$wit/notes/sub" "$wit/empty dir" "$wit/.trew" "$wit/.trash"
cp "$src/notes/a.md" "$wit/notes/a.md"
cp "$src/notes/sub/b.md" "$wit/notes/sub/b.md"
cp "$src/attach.bin" "$src/empty.md" "$wit/"
printf 'nfd\n' > "$wit/$(printf 'Caf\xc3\xa9.md')"
printf 'nbsp\n' > "$wit/no break.md"
printf 'state' > "$wit/.trew/config.json"
printf 'gone' > "$wit/.trash/old.md"
if [ "$collision_disk" = 1 ]; then
  cp "$src/Strasse.md" "$wit/"  # one of the group: the server keeps the first it is sent
else
  # The disk folds: the pair is one file under the first name written, and
  # the glob copies it under that name.
  cp "$src"/Stra*e.md "$wit/"
fi

check() { # check LABEL WANT-RC PATTERN: compare the source with the witness now
  inv inventory "$wit" -o "$tmp/witness.inv" 2>/dev/null
  expect_rc "$2" "$1" "$3" inv compare "$tmp/source.inv" "$tmp/witness.inv"
}
check "a faithful witness is a go" 0 '^go:'

cp "$wit/notes/a.md" "$tmp/a.keep"
printf '# A\n' > "$wit/notes/a.md"
check "one changed byte is a no-go" 1 'different on the witness \(note\)'
cp "$tmp/a.keep" "$wit/notes/a.md"

mv "$wit/notes/sub/b.md" "$tmp/b.keep"
check "a missing note is a no-go" 1 'missing on the witness \(note\)'
mv "$tmp/b.keep" "$wit/notes/sub/b.md"

rmdir "$wit/empty dir"
check "a missing empty folder is a no-go" 1 'missing on the witness \(folder\)'
mkdir "$wit/empty dir"

printf 'x\n' > "$wit/extra.md"
check "a file the source never had is a no-go" 1 'on the witness only \(note\)'
rm "$wit/extra.md"

printf 'x' > "$wit/notes/.trew-tmp-0001"
check "a staging file left behind is a no-go" 1 'left behind on the witness'
rm "$wit/notes/.trew-tmp-0001"

cp "$src/big.bin" "$wit/big.bin"
check "an excluded file that arrived anyway is a no-go" 1 'excluded on the source \(toolarge\) but present'
rm "$wit/big.bin"

if [ "$collision_disk" = 1 ]; then
  cp "$src/Straße.md" "$wit/Straße.md"
  check "both of a collision group arriving is a no-go" 1 'collision group arrived more than once'
  rm "$wit/Straße.md"
fi
check "the witness is a go again once put back" 0 '^go:'

# ---- the rollback: export what changed after the cut, apply it to the freeze -
current="$tmp/current"
cp -Rp "$wit" "$current"
printf '# a, edited after the cut\n' > "$current/notes/a.md"
rm -r "$current/notes/sub"
mkdir -p "$current/new/deeper"
printf 'new\n' > "$current/new/deeper/n.md"
printf '\x02' > "$current/new/pic.bin"
inv inventory "$current" -o "$tmp/current.inv" 2>/dev/null

expect_rc 0 "changes counts each kind of change" '1  modified note' \
  inv changes "$tmp/source.inv" "$tmp/current.inv"
expect_rc 0 "changes exports the added and modified files" 'exported 3 files' \
  inv changes "$tmp/source.inv" "$tmp/current.inv" --from "$current" --to "$tmp/export"
expect_rc 1 "an export never writes into an existing directory" 'exists' \
  inv changes "$tmp/source.inv" "$tmp/current.inv" --from "$current" --to "$tmp/export"

frozen="$tmp/frozen"
cp -Rp "$src" "$frozen"
# The dry run must say what the write will do, folders included: it used to
# refuse a folder as not empty because it had not removed the files it was
# about to remove (found in the M10 rehearsal).
dry=$(inv apply "$tmp/export" "$frozen" 2>&1 || true)
if grep -q 'would .*1  folder deleted' <<<"$dry" && ! grep -q REFUSED <<<"$dry"; then
  ok "the dry run removes a folder whose every file it removes"
else
  bad "the dry run removes a folder whose every file it removes"; printf '%s\n' "$dry" | sed 's/^/      /'
fi
if [ "$(cat "$frozen/notes/a.md")" = "# a" ]; then ok "the dry run wrote nothing"; else bad "the dry run wrote nothing"; fi
expect_rc 0 "apply writes the export" 'applied +1  modified' inv apply "$tmp/export" "$frozen" --apply
inv inventory "$frozen" --max-file 1000 -o "$tmp/frozen.inv" 2>/dev/null
expect_rc 0 "the rolled-back freeze holds what the server held" '^go:' \
  inv compare "$tmp/frozen.inv" "$tmp/current.inv"

frozen2="$tmp/frozen2"
cp -Rp "$src" "$frozen2"
printf '# a, edited on the old system during the window\n' > "$frozen2/notes/a.md"
expect_rc 1 "a file changed on both sides is refused, not overwritten" \
  'REFUSED +1  changed here since the freeze' inv apply "$tmp/export" "$frozen2" --apply
if grep -q 'old system' "$frozen2/notes/a.md"; then
  ok "and it still holds the old system's edit"
else
  bad "and it still holds the old system's edit"
fi

# ---- a case-only rename after the cut ----------------------------------------
# The export records Note.md -> note.md as an add and a delete. On a disk that
# folds case (APFS, the Mac's) the add used to find the old file and call it
# already current, and the delete then removed the only copy; a folder lost
# every file inside it. Both kinds, with and without a content change.
cfrozen="$tmp/case-frozen"
mkdir -p "$cfrozen/Folder" "$cfrozen/Other"
printf 'same words\n' > "$cfrozen/Note.md"
printf 'before\n' > "$cfrozen/Changed.md"
printf 'x in the folder\n' > "$cfrozen/Folder/x.md"
printf 'y before\n' > "$cfrozen/Folder/y.md"
printf 'z in the other folder\n' > "$cfrozen/Other/z.md"
inv inventory "$cfrozen" -o "$tmp/case-frozen.inv" 2>/dev/null
ccur="$tmp/case-current"
mkdir -p "$ccur/folder" "$ccur/other"
printf 'same words\n' > "$ccur/note.md"
printf 'after the rename\n' > "$ccur/changed.md"
printf 'x in the folder\n' > "$ccur/folder/x.md"
printf 'y after\n' > "$ccur/folder/y.md"
printf 'z in the other folder\n' > "$ccur/other/z.md"
inv inventory "$ccur" -o "$tmp/case-current.inv" 2>/dev/null
inv changes "$tmp/case-frozen.inv" "$tmp/case-current.inv" --from "$ccur" --to "$tmp/case-export" > /dev/null
case_apply() { # case_apply NAME: a fresh frozen copy, the export applied to it
  cp -Rp "$cfrozen" "$tmp/$1"
  inv apply "$tmp/case-export" "$tmp/$1" --apply > "$tmp/$1.out" 2>&1
}
rc=0; case_apply case-applied || rc=$?
inv inventory "$tmp/case-applied" -o "$tmp/case-applied.inv" 2>/dev/null
if [ "$rc" = 0 ] && inv compare "$tmp/case-applied.inv" "$tmp/case-current.inv" > "$tmp/case-compare.out" 2>&1; then
  ok "a case-only rename, file and folder, changed and unchanged, applies as the rename it is"
else
  bad "a case-only rename, file and folder, changed and unchanged, applies as the rename it is (apply exit $rc)"
  cat "$tmp/case-applied.out" "$tmp/case-compare.out" 2>/dev/null | tail -20 | sed 's/^/      /' || true
fi
listing=$(cd "$tmp/case-applied" && find . -type f | LC_ALL=C sort | tr '\n' ' ')
if [ "$listing" = "./changed.md ./folder/x.md ./folder/y.md ./note.md ./other/z.md " ] \
  && [ "$(cat "$tmp/case-applied/note.md")" = "same words" ] \
  && [ "$(cat "$tmp/case-applied/changed.md")" = "after the rename" ] \
  && [ "$(cat "$tmp/case-applied/folder/y.md")" = "y after" ]; then
  ok "and every renamed file is there, spelled as the server spells it, with the server's bytes"
else
  bad "and every renamed file is there, spelled as the server spells it, with the server's bytes"
  printf '      %s\n' "$listing"
fi
# The dry run says the same, and removes nothing.
cp -Rp "$cfrozen" "$tmp/case-dry"
dry=$(inv apply "$tmp/case-export" "$tmp/case-dry" 2>&1 || true)
if ! grep -q REFUSED <<<"$dry" && grep -Eq 'would +2  renamed folder' <<<"$dry" && grep -Eq 'would +5  renamed$' <<<"$dry" \
  && [ -f "$tmp/case-dry/Note.md" ] && [ -f "$tmp/case-dry/Folder/x.md" ]; then
  ok "the dry run counts the renames and writes nothing"
else
  bad "the dry run counts the renames and writes nothing"; printf '%s\n' "$dry" | sed 's/^/      /'
fi
# A renamed file edited on the old side during the window is refused, and kept.
cp -Rp "$cfrozen" "$tmp/case-both"
printf 'edited on the old system\n' > "$tmp/case-both/Note.md"
rc=0; out=$(inv apply "$tmp/case-export" "$tmp/case-both" --apply 2>&1) || rc=$?
if [ "$rc" = 1 ] && grep -q 'REFUSED .*changed here since the freeze, not renamed' <<<"$out" \
  && [ "$(cat "$tmp/case-both/"[Nn]ote.md)" = "edited on the old system" ]; then
  ok "a renamed file changed on both sides is refused and keeps the old side's words"
else
  bad "a renamed file changed on both sides is refused and keeps the old side's words (exit $rc)"
  printf '%s\n' "$out" | sed 's/^/      /'
fi

# ---- apply never writes through a link ---------------------------------------
outside="$tmp/outside"
mkdir -p "$outside"
frozen3="$tmp/frozen3"
cp -Rp "$src" "$frozen3"
ln -s "$outside" "$frozen3/new"   # the export adds new/deeper/n.md and new/pic.bin
rc=0; out=$(inv apply "$tmp/export" "$frozen3" --apply 2>&1) || rc=$?
if [ "$rc" = 1 ] && grep -q 'REFUSED .*a link on the way' <<<"$out" && [ -z "$(ls -A "$outside")" ]; then
  ok "a folder that is a link is refused, and nothing lands outside the vault"
else
  bad "a folder that is a link is refused, and nothing lands outside the vault (exit $rc)"
  printf '%s\n' "$out" | sed 's/^/      /'; ls -AR "$outside" | sed 's/^/      /'
fi

echo
if [ "$fails" -gt 0 ]; then
  echo "vault-inventory: $fails failed"
  exit 1
fi
echo "vault-inventory: all passed"
