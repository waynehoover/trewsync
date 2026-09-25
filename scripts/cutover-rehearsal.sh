#!/usr/bin/env bash
#
# The M10 rehearsal (PLAN.md M10 step 1, plan/cutover.md), on a copy of a real
# vault, in one command:
#
#   scripts/cutover-rehearsal.sh "$HOME/Documents/My Vault"
#
# It only reads VAULT, once, through `vault-inventory.py snapshot`, which
# proves the copy entry for entry. Everything else happens in a private
# temporary directory that is removed at the end (--keep leaves it, and it
# then holds the vault's notes in the clear: remove it yourself). Nothing
# connects to any server but the scratch trewd this starts on 127.0.0.1.
#
# The steps, each with its verdict:
#   1. snapshot the vault; a second copy stands in for the frozen Basalt side
#   2. a scratch trewd; the copy pairs from first-invite and uploads (timed)
#   3. a freshly paired empty witness downloads everything (timed); compare
#   4. edits after the cut: a Unicode, an NFD and a no-break-space name, a
#      nested folder, an attachment, a large note, an append, a deletion and a
#      nested folder rename on the "Mac", while the witness (the "phone") is
#      offline with edits of its own, one to the same note; then both converge
#   5. the edited words are all still there (merged or in a conflict copy),
#      the two devices agree, and a second fresh witness agrees with both
#   6. an encrypted backup (no note's words in the archive), `trewd rehearse`
#   7. the rollback: every change since the cut exported, cross-checked with
#      the server's own `trewd restore -to-uid` dry run, applied to the frozen
#      copy, and the result compared with the server's state
#
# It prints counts and times, never a note's name or words. Exit 0 means every
# verdict was a go.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 2
root=$(pwd)
vault=""
keep=0
port=3491
while [ $# -gt 0 ]; do
  case $1 in
    --keep) keep=1 ;;
    --port) port=$2; shift ;;
    -*) echo "usage: $0 VAULT [--keep] [--port N]" >&2; exit 2 ;;
    *) vault=$1 ;;
  esac
  shift
done
[ -d "$vault" ] || { echo "usage: $0 VAULT [--keep] [--port N]" >&2; exit 2; }

work=$(mktemp -d "${TMPDIR:-/tmp}/trew-rehearsal.XXXXXX")
chmod 700 "$work"
pids=()
cleanup() {
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null; wait "$p" 2>/dev/null; done
  if [ "$keep" = 1 ]; then
    echo "kept $work: it holds the vault's notes in the clear; remove it when done"
  else
    rm -rf "$work"
  fi
}
trap cleanup EXIT

fails=()
verdict() { # verdict LABEL RC
  if [ "$2" = 0 ]; then printf 'go     %s\n' "$1"; else printf 'NO-GO  %s\n' "$1"; fails+=("$1"); fi
}
now() { python3 -c 'import time; print(time.monotonic())'; }
since() { python3 -c "import sys; print(f'{float(sys.argv[2]) - float(sys.argv[1]):.1f}')" "$1" "$(now)"; }
inv() { uv run --no-project --python 3.13 "$root/scripts/vault-inventory.py" "$@"; }

echo "== building trewd and trew from $(git -C "$root" rev-parse --short HEAD)"
go build -o "$work/trewd" ./cmd/trewd || exit 2
if [ ! -d client/node_modules ]; then (cd client && bun install --frozen-lockfile >/dev/null) || exit 2; fi
(cd client && node esbuild.config.mjs production >/dev/null) || exit 2
cp client/dist/trew.mjs "$work/trew.mjs"
trewd() { "$work/trewd" "$@"; }
trew() { (cd "$1" && shift && node "$work/trew.mjs" "$@"); }

echo "== 1. snapshot"
t=$(now)
inv snapshot "$vault" "$work/source" -o "$work/source.inv" > "$work/snapshot.out"
rc=$?
tail -1 "$work/snapshot.out" | sed "s|$work|WORK|g; s|$vault|VAULT|g"
verdict "the copy holds every entry of the vault ($(since "$t") s)" $rc
[ $rc = 0 ] || exit 1
inv snapshot "$work/source" "$work/frozen" -o "$work/frozen.inv" > /dev/null
verdict "the frozen stand-in holds every entry too" $?
python3 - "$work/snapshot.out" <<'PY'
import json, sys
text = open(sys.argv[1]).read()
s = json.loads(text[: text.rindex("}") + 1])
y = s["synced"]
print(f"   {y['notes']} notes ({y['noteBytes']} bytes), {y['attachments']} attachments, {y['folders']} folders,"
      f" {y['bytes']} bytes synced; largest file {y['largest']} bytes; {y['respelled']} names respelled")
print(f"   excluded: {s['excluded']}; dot-named at the top: {s['excludedTop']}")
PY

echo "== 2. a scratch server, and the upload"
mkdir -m 700 "$work/data"
# The binary itself, not the trewd function: a function sent to the background
# runs in a subshell, and $! would be that subshell, which the cleanup could
# kill while the server went on running over a deleted directory.
"$work/trewd" serve -data "$work/data" -localhost -addr "127.0.0.1:$port" -mcp -allow-ephemeral -alert-every 0 \
  > "$work/serve.log" 2>&1 &
pids+=($!)
for _ in $(seq 100); do grep -q "listening on" "$work/serve.log" && break; sleep 0.1; done
if ! grep -q "listening on" "$work/serve.log" || ! kill -0 "${pids[0]}" 2>/dev/null || ! trewd health -addr "127.0.0.1:$port" > /dev/null 2>&1 || ! trewd devices -data "$work/data" > /dev/null 2>&1; then
  echo "the scratch server did not start (a long TMPDIR makes its control socket's path too long):"
  tail -5 "$work/serve.log" | sed "s|$work|WORK|g"
  exit 2
fi
trew "$work/source" pair --key-file "$work/data/first-invite" --device rehearsal-mac > /dev/null || exit 2
t=$(now)
trew "$work/source" sync --json > "$work/upload.json"
up_rc=$?
python3 - "$work/upload.json" "$(since "$t")" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
print(f"   uploaded {r['uploaded']} entries, {r['chunksSent']} chunks, {r['bytesSent']} bytes sent, in {sys.argv[2]} s;"
      f" {len(r['needsAttention'])} need attention")
PY
# A sync that exits 1 for files the server refuses is judged by the witness
# comparison, which must explain each of them; anything worse stops here.
[ $up_rc -le 1 ] || { verdict "the upload ran" $up_rc; exit 1; }

witness() { # witness NAME [DATA PORT]: pair a new empty directory and download
  local name=$1 data=${2:-$work/data} p=${3:-$port} t
  mkdir -m 700 "$work/$name"
  trewd invite -data "$data" -url "ws://127.0.0.1:$p" -out "$work/$name.invite" > /dev/null || exit 2
  trew "$work/$name" pair --key-file "$work/$name.invite" --device "$name" > /dev/null || exit 2
  t=$(now)
  trew "$work/$name" sync --json > "$work/$name.json"
  local rc=$?
  [ $rc -le 1 ] || { verdict "$name downloaded" $rc; exit 1; }
  python3 -c "import json,sys; r=json.load(open(sys.argv[1])); print(f'   {sys.argv[2]}: downloaded {r[\"downloaded\"]} files and {r[\"foldersCreated\"]} folders in {sys.argv[3]} s')" \
    "$work/$name.json" "$name" "$(since "$t")"
  inv inventory "$work/$name" -o "$work/$name.inv" 2>/dev/null
  return $rc
}
compare() { # compare LABEL SOURCE.inv WITNESS.inv
  inv compare "$work/$2" "$work/$3" > "$work/compare-$3.out" 2>&1
  local rc=$?
  grep -E '^(explained|FAIL)' "$work/compare-$3.out" | sed 's/^/   /'
  verdict "$1" $rc
}

echo "== 3. a fresh witness"
witness witness1
verdict "the witness synced" $?
compare "the witness holds every synced path of the vault, byte for byte" source.inv witness1.inv
# Nothing after this means anything if the first comparison failed.
[ ${#fails[@]} = 0 ] || { echo "NO-GO: stopping at the first witness"; exit 1; }
cut=$(trew "$work/witness1" status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["server"]["cursor"])')
echo "   the cut is at uid $cut"

echo "== 4. edits after the cut, one device offline"
python3 - "$work" <<'PY'
import json, os, random, sys, unicodedata
work = sys.argv[1]
rows = [json.loads(l) for l in open(os.path.join(work, "source.inv"), encoding="utf-8").read().splitlines()[1:]]
synced = [r for r in rows if r["excluded"] is None]
notes = sorted(r["path"] for r in synced if r["kind"] == "note" and "raw" not in r)
folders = sorted(r["path"] for r in synced if r["kind"] == "folder" and "raw" not in r)
cands = sorted((sum(1 for n in notes if n.startswith(f + "/")), f) for f in folders
               if "/" in f and any(g.startswith(f + "/") for g in folders)
               and 1 <= sum(1 for n in notes if n.startswith(f + "/")) <= 40)
F = cands[0][1] if cands else None
outside = [n for n in notes if F is None or not n.startswith(F + "/")]
if len(outside) < 3:
    sys.exit("the vault needs at least three notes to rehearse edits on")
pick = {"A": outside[len(outside) // 4], "B": outside[len(outside) // 2], "C": outside[3 * len(outside) // 4], "F": F}
pick["E"] = max((n for n in notes if F and n.startswith(F + "/")), key=lambda n: n.count("/"), default=None)
json.dump(pick, open(os.path.join(work, "picks.json"), "w"))

mac, phone = os.path.join(work, "source"), os.path.join(work, "witness1")
def append(root, path, text):
    with open(os.path.join(root, path), "a", encoding="utf-8") as f:
        f.write(text)
append(mac, pick["A"], "\n\nTREW-REHEARSAL-MAC appended on the Mac after the cut\n")
d = os.path.join(mac, "TrewSync rehearsal")
os.makedirs(os.path.join(d, "deep", "er", "still deeper"))
rnd = random.Random(10)
files = {
    "Ünïcødé ノート café ✓.md": "# unicode\nTREW-REHEARSAL-MAC\n",
    "deep/er/still deeper/nested.md": "nested TREW-REHEARSAL-MAC\n",
    unicodedata.normalize("NFD", "Café décomposé.md"): "nfd TREW-REHEARSAL-MAC\n",
    "non\u00a0breaking space.md": "nbsp TREW-REHEARSAL-MAC\n",
    "empty.md": "",
    "large note.md": "# large\nTREW-REHEARSAL-MAC\n" + "".join(f"- line {i} {rnd.random()}\n" for i in range(60000)),
}
for name, text in files.items():
    open(os.path.join(d, name), "w", encoding="utf-8").write(text)
open(os.path.join(d, "attachment.bin"), "wb").write(rnd.randbytes(5 << 20))
os.remove(os.path.join(mac, pick["B"]))
if F:
    os.rename(os.path.join(mac, F), os.path.join(mac, F + " renamed"))
append(phone, pick["A"], "\n\nTREW-REHEARSAL-PHONE appended on the phone while offline\n")
append(phone, pick["C"], "\n\nTREW-REHEARSAL-PHONE phone-only edit\n")
if pick["E"]:
    append(phone, pick["E"], "\n\nTREW-REHEARSAL-PHONE edit inside a folder the Mac renamed\n")
os.makedirs(os.path.join(phone, "TrewSync rehearsal offline"))
open(os.path.join(phone, "TrewSync rehearsal offline", "phone note.md"), "w").write("TREW-REHEARSAL-PHONE new\n")
print(f"   the Mac: 1 append, {len(files) + 1} new files, 1 deletion, {'1 nested folder rename' if F else 'no folder to rename'};"
      f" the phone, offline: {3 if pick['E'] else 2} appends (one to the Mac's note), 1 new note")
PY
[ $? = 0 ] || exit 1
for d in source witness1 source witness1; do
  trew "$work/$d" sync > /dev/null
  rc=$?
  [ $rc -le 1 ] || { verdict "sync of $d" $rc; }
done

echo "== 5. preservation and convergence"
python3 - "$work" <<'PY'
import json, os, sys
work = sys.argv[1]
p = json.load(open(os.path.join(work, "picks.json")))
bad = 0
for dev in ("source", "witness1"):
    root = os.path.join(work, dev)
    texts = {}
    for dp, dn, fn in os.walk(root):
        dn[:] = [x for x in dn if not x.startswith(".")]
        for f in fn:
            if f.endswith(".md"):
                rel = os.path.relpath(os.path.join(dp, f), root)
                texts[rel] = open(os.path.join(dp, f), encoding="utf-8", errors="replace").read()
    def where(mark):
        return [k for k, v in texts.items() if mark in v]
    checks = {
        "the Mac's append to the shared note": p["A"] in where("TREW-REHEARSAL-MAC appended"),
        "the phone's append to the shared note, merged or in a conflict copy": bool(where("TREW-REHEARSAL-PHONE appended")),
        "the phone-only edit": p["C"] in where("TREW-REHEARSAL-PHONE phone-only"),
        "the deletion": p["B"] not in texts,
        "every new note": len(where("TREW-REHEARSAL-MAC")) >= 6 and bool(where("TREW-REHEARSAL-PHONE new")),
    }
    if p["E"]:
        checks["the offline edit inside the renamed folder"] = bool(where("TREW-REHEARSAL-PHONE edit inside"))
    for label, ok in checks.items():
        print(f"   {'ok  ' if ok else 'LOST'}  {dev}: {label}")
        bad += 0 if ok else 1
    merged = p["A"] in where("TREW-REHEARSAL-PHONE appended")
    print(f"         {dev}: the shared note {'merged both appends' if merged else 'kept the phone words in a conflict copy'}")
sys.exit(1 if bad else 0)
PY
verdict "every edit made after the cut is still there" $?
inv inventory "$work/source" -o "$work/mac.inv" 2>/dev/null
inv inventory "$work/witness1" -o "$work/phone.inv" 2>/dev/null
compare "the two devices converged" mac.inv phone.inv
witness witness2
compare "a second fresh witness holds what the devices hold" mac.inv witness2.inv

echo "== 6. an encrypted backup, restored"
mkdir -m 700 "$work/offsite"
trewd backup-key -out "$work/key" > /dev/null
t=$(now)
trewd backup -data "$work/data" -to "$work/offsite/trew.tar.age" -recipients-file "$work/key.pub" > "$work/backup.out" 2>&1
rc=$?
echo "   backup: $(stat -f %z "$work/offsite/trew.tar.age" 2>/dev/null || stat -c %s "$work/offsite/trew.tar.age") bytes of ciphertext in $(since "$t") s"
verdict "the encrypted backup" $rc
n=$(grep -c -a "TREW-REHEARSAL" "$work/offsite/trew.tar.age")
[ "$n" = 0 ]; verdict "no note's words in the archive" $?
trewd rehearse -data "$work/data" -backup "$work/offsite/trew.tar.age" -identity "$work/key" > "$work/rehearse.out" 2>&1
rc=$?
grep -E '^ +[0-9.]+s |^Recovery time' "$work/rehearse.out" | sed "s|$work|WORK|g; s/^ */   /"
verdict "trewd rehearse restored the backup and a fresh device matched it" $rc

echo "== 7. the rollback, with the edits after the cut"
inv changes "$work/frozen.inv" "$work/witness2.inv" --from "$work/witness2" --to "$work/export" | sed "s|$work|WORK|g; s/^/   /"
verdict "every change since the cut exported" "${PIPESTATUS[0]}"
trewd restore -data "$work/data" -to-uid "$cut" -json > "$work/restore-plan.json"
python3 - "$work/restore-plan.json" "$work/export/changes.jsonl" <<'PY'
import json, sys
plan = json.load(open(sys.argv[1]))
ch = [json.loads(l) for l in open(sys.argv[2], encoding="utf-8").read().splitlines()[1:]]
removed = {s["path"] for s in plan["steps"] if s["action"] in ("remove", "remove_folder")}
restored = {s["path"] for s in plan["steps"] if s["action"] == "restore"}
added = {c["path"] for c in ch if c["change"] == "added"}
back = {c["path"] for c in ch if c["change"] != "added"}
print(f"   the server's dry run: {len(removed)} created and {len(restored)} changed or deleted since the cut;"
      f" the export: {len(added)} and {len(back)}")
sys.exit(0 if (removed, restored) == (added, back) else 1)
PY
verdict "the export names exactly the paths the server says changed" $?
inv apply "$work/export" "$work/frozen" --apply | sed 's/^/   /'
verdict "the export applied to the frozen copy" "${PIPESTATUS[0]}"
inv inventory "$work/frozen" -o "$work/rolled.inv" 2>/dev/null
compare "the rolled-back copy holds what the server holds" rolled.inv witness2.inv

echo
if [ ${#fails[@]} -gt 0 ]; then
  echo "NO-GO: ${#fails[@]} verdicts failed:"
  printf '  %s\n' "${fails[@]}"
  exit 1
fi
echo "GO: every verdict passed"
