"""The witness inventory of a vault, and the comparison that proves a migration.

PLAN.md section 2.8 and M10: equal counts do not prove equal paths or equal
bytes, so a migration is proven by listing every file's normalised path, kind,
size and SHA-256 on the source and on a freshly paired empty witness, and
explaining every line that differs. plan/cutover.md is the runbook that uses it.

    uv run --no-project --python 3.13 scripts/vault-inventory.py inventory DIR -o source.inv
    uv run --no-project --python 3.13 scripts/vault-inventory.py compare source.inv witness.inv

`inventory` only reads DIR. It writes one JSON object per line, sorted by the
path's UTF-8 bytes, after a header line:

    {"path": "...", "kind": "note|attachment|folder|other", "size": N, "sha256": "...",
     "excluded": null | "reason", "raw": "the disk's spelling, when it differs"}

`path` is the name the way Obsidian names it (NFC, U+00A0 and U+202F as plain
spaces), which is the name every client sends. `excluded` names why the path is
not expected on a witness, and is the only place a difference may be explained:

  dotprefix, toolong, segmenttoolong, control, backslash, ...
                the server's own path rule (plan/protocol.md "Paths"), taken
                from scripts/protocol-vectors.py, the contract's reference
                implementation, rather than written again here
  toolarge      a file over the server's -max-file (64 MiB by default)
  collision     two names the fold holds as one: at most one of them arrives
  symlink       the clients never follow a link
  other         a socket, a device, anything that is not a file or a folder

`compare` exits 0 only when every line of the source that is not excluded is
on the witness byte for byte (same kind, size and hash), nothing is on the
witness that the source does not explain, every excluded path is absent from
the witness (or, for a collision, exactly one of its group arrived with that
path's own bytes), and the counts it prints add up. Anything else is a
failure, printed by class with counts, and with paths only under --paths, so
that the output of a run against a private vault can be kept without its
names.

A witness-only path is explained only inside the witness's own state (`.trew`,
`.obsidian`, `.trash`, see OWN_STATE); any other dot name it holds after a
finished sync, a staging file above all, is a failure.

Three more commands serve the freeze and the way back (plan/cutover.md):

    vault-inventory.py snapshot VAULT NEW_DIR -o frozen.inv
        copy a vault and prove the copy entry for entry, excluded ones too
    vault-inventory.py changes frozen.inv current.inv --from CURRENT_DIR --to EXPORT_DIR
        what changed after the cut, and the changed files exported
    vault-inventory.py apply EXPORT_DIR FROZEN_VAULT [--apply]
        put the export into a vault as it was at the freeze, refusing any
        path changed there since; a dry run unless --apply

`apply` joins the normalised path onto the vault, which is right on a disk
that ignores normalisation (APFS, the Mac's) and on any vault whose names are
already NFC with plain spaces, which is every vault a client wrote. A delete
and an add that fold alike (a case-only rename) are applied as one rename
where the disk holds both spellings as one entry, and nothing is written or
removed through a link or outside the vault.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import shutil
import stat
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
FORMAT = "trew-inventory 1"
DEFAULT_MAX_FILE = 1 << 26  # internal/store/store.go DefaultPerFileMax

# What a witness holds of its own and the source never had: the headless
# client's state folder, Obsidian's config folder when the witness is a vault
# opened in Obsidian, and the trash both clients move a file into when another
# device deleted it (the copy rule 3 keeps). Only these top-level names are
# accepted as witness-only.
OWN_STATE = {".trew", ".obsidian", ".trash"}


def _contract():
    sys.dont_write_bytecode = True  # no __pycache__ left beside the scripts
    spec = importlib.util.spec_from_file_location("protocol_vectors", HERE / "protocol-vectors.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    if unicodedata.unidata_version != module.UNICODE_VERSION:
        sys.exit(
            f"this interpreter carries Unicode {unicodedata.unidata_version}; the fold is pinned to "
            f"{module.UNICODE_VERSION}. Run: uv run --no-project --python 3.13 scripts/vault-inventory.py"
        )
    return module


def obsidian_name(raw: str) -> str:
    """What Obsidian's normalizePath makes of a name read from the disk.

    client/src/plugin/vault.ts documents the four things it does; on a path
    built from a directory walk only two can apply: U+00A0 and U+202F become
    spaces, and the result is NFC. The headless client maps names the same
    way (NodeVault, PLAN 4.1), so this is the name every client sends.
    """
    return unicodedata.normalize("NFC", raw.replace("\u00a0", " ").replace("\u202f", " "))


def kind_of(path: str) -> str:
    return "note" if path.lower().endswith(".md") else "attachment"


def sha256_file(full: str) -> str:
    h = hashlib.sha256()
    with open(full, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def walk(root: str) -> list[dict]:
    """Every entry under root, by lstat, without following a link."""
    rows = []
    stack = [""]
    while stack:
        rel_dir = stack.pop()
        full_dir = os.path.join(root, rel_dir) if rel_dir else root
        with os.scandir(full_dir) as it:
            names = sorted(e.name for e in it)
        for name in names:
            rel = f"{rel_dir}/{name}" if rel_dir else name
            full = os.path.join(root, rel)
            st = os.lstat(full)
            if stat.S_ISDIR(st.st_mode):
                rows.append({"raw": rel, "kind": "folder", "size": 0, "sha256": ""})
                stack.append(rel)
            elif stat.S_ISREG(st.st_mode):
                rows.append({"raw": rel, "kind": "file", "size": st.st_size, "sha256": sha256_file(full)})
            elif stat.S_ISLNK(st.st_mode):
                rows.append({"raw": rel, "kind": "symlink", "size": 0, "sha256": ""})
            else:
                rows.append({"raw": rel, "kind": "other", "size": 0, "sha256": ""})
    return rows


def inventory(root: str, max_file: int) -> list[dict]:
    contract = _contract()
    table = contract.fold_table()
    out = []
    for row in walk(root):
        path = obsidian_name(row["raw"])
        kind = row["kind"]
        excluded = None
        # The dot rule and the other path rules first: a file under .git is
        # excluded because it is under .git, whatever else is true of it.
        reason = contract.path_reason(path.encode("utf-8", errors="surrogatepass"))
        if reason is not None:
            excluded = reason
        elif kind == "symlink":
            excluded = "symlink"
        elif kind == "other":
            excluded = "other"
        elif kind == "file" and row["size"] > max_file:
            excluded = "toolarge"
        if kind == "file":
            kind = kind_of(path)
        entry = {"path": path, "kind": kind, "size": row["size"], "sha256": row["sha256"], "excluded": excluded}
        if row["raw"] != path:
            entry["raw"] = row["raw"]
        out.append(entry)

    # Two names that fold alike, or that normalise to one name, are one name
    # to the server and to every case-folding disk (PLAN 4.1): the first to
    # arrive is kept and the other is refused with `collision`. Which arrives
    # first is the uploader's order, so the whole group is marked and the
    # comparison accepts exactly one of it. A folder and its own path listed
    # once are one entry, not a collision.
    groups: dict[str, list[dict]] = defaultdict(list)
    for e in out:
        if e["excluded"] is None:
            groups[contract.fold(e["path"], table)].append(e)
    for members in groups.values():
        if len(members) > 1:
            for e in members:
                e["excluded"] = "collision"
    # A path under a folder that collides collides too: it cannot arrive at
    # its own spelling, since the folder it names is the other one's.
    colliding_dirs = [e["path"] + "/" for e in out if e["excluded"] == "collision" and e["kind"] == "folder"]
    if colliding_dirs:
        for e in out:
            if e["excluded"] is None and any(e["path"].startswith(d) for d in colliding_dirs):
                e["excluded"] = "collision"
    out.sort(key=lambda e: e["path"].encode("utf-8", errors="surrogatepass"))
    return out


def write(rows: list[dict], dest) -> None:
    dest.write(json.dumps({"format": FORMAT}) + "\n")
    for e in rows:
        dest.write(json.dumps(e, ensure_ascii=False, sort_keys=True) + "\n")


def read(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as f:
        lines = f.read().splitlines()
    if not lines or json.loads(lines[0]).get("format") != FORMAT:
        sys.exit(f"{path}: not a {FORMAT} file")
    return [json.loads(line) for line in lines[1:]]


def summary(rows: list[dict]) -> dict:
    synced = [e for e in rows if e["excluded"] is None]
    return {
        "entries": len(rows),
        "synced": {
            "notes": sum(1 for e in synced if e["kind"] == "note"),
            "attachments": sum(1 for e in synced if e["kind"] == "attachment"),
            "folders": sum(1 for e in synced if e["kind"] == "folder"),
            "bytes": sum(e["size"] for e in synced),
            "noteBytes": sum(e["size"] for e in synced if e["kind"] == "note"),
            "largest": max((e["size"] for e in synced), default=0),
            "respelled": sum(1 for e in synced if "raw" in e),
        },
        "excluded": dict(sorted(Counter(e["excluded"] for e in rows if e["excluded"]).items())),
        "excludedTop": dict(
            sorted(Counter(e["path"].split("/")[0] for e in rows if e["excluded"] == "dotprefix").items())
        ),
    }


def same(a: dict, b: dict) -> bool:
    return a["kind"] == b["kind"] and a["size"] == b["size"] and a["sha256"] == b["sha256"]


def compare(source: list[dict], witness: list[dict], show_paths: bool, allow_empty_folders: bool) -> int:
    src = {e["path"]: e for e in source}
    wit = {e["path"]: e for e in witness}
    problems: dict[str, list[str]] = defaultdict(list)
    explained: Counter = Counter()

    for path, e in src.items():
        w = wit.get(path)
        if e["excluded"] is None:
            if w is None:
                if e["kind"] == "folder" and allow_empty_folders:
                    explained["empty folder not carried (--allow-empty-folders)"] += 1
                else:
                    problems[f"missing on the witness ({e['kind']})"].append(path)
            elif w["excluded"] is not None:
                problems["synced on the source, excluded on the witness"].append(path)
            elif not same(e, w):
                problems[f"different on the witness ({e['kind']})"].append(path)
        elif e["excluded"] == "collision":
            continue  # judged per group below
        elif w is not None and w["excluded"] is None:
            problems[f"excluded on the source ({e['excluded']}) but present on the witness"].append(path)
        else:
            explained[f"excluded: {e['excluded']}"] += 1

    # A collision group: exactly one member may arrive, with its own bytes.
    contract = _contract()
    table = contract.fold_table()
    groups: dict[str, list[dict]] = defaultdict(list)
    for e in source:
        if e["excluded"] == "collision":
            groups[contract.fold(e["path"], table)].append(e)
    for members in groups.values():
        # Present on the witness at all. A witness on a disk that keeps both
        # spellings marks them a collision of its own, which is exactly the
        # failure this is here to see, not an exclusion that explains it.
        arrived = [m for m in members if m["path"] in wit and wit[m["path"]]["excluded"] in (None, "collision")]
        if len(arrived) > 1:
            problems["collision group arrived more than once"].extend(m["path"] for m in arrived)
        elif len(arrived) == 1 and not same(arrived[0], wit[arrived[0]["path"]]):
            problems["collision survivor has different bytes"].append(arrived[0]["path"])
        else:
            explained["excluded: collision (one of the group kept)"] += len(members)

    for path, w in wit.items():
        if path in src:
            continue
        if w["excluded"] is not None and path.split("/")[0] in OWN_STATE:
            explained[f"witness-only, its own state ({path.split('/')[0]})"] += 1
        elif w["excluded"] is not None:
            # A staging file or any other dot name the witness made and left
            # behind after a finished sync is a client bug, not an exclusion.
            problems[f"left behind on the witness ({w['excluded']})"].append(path)
        else:
            problems[f"on the witness only ({w['kind']})"].append(path)

    print(json.dumps({"source": summary(source), "witness": summary(witness)}, indent=2))
    for label, n in sorted(explained.items()):
        print(f"explained  {n:6d}  {label}")
    for label, paths in sorted(problems.items()):
        print(f"FAIL       {len(paths):6d}  {label}")
        if show_paths:
            for p in sorted(paths):
                print(f"             {p!r}")
    if problems:
        print("no-go: every difference above needs an explanation before the cut")
        return 1
    print("go: the witness holds every synced path of the source, byte for byte")
    return 0


def snapshot(source: str, dest: str, out: str, max_file: int) -> int:
    """A readable copy of a vault, proven by its inventory (M10 step 3).

    Every entry is compared, excluded ones too, since the snapshot is the way
    back and a `.obsidian` or `.git` left out of it is a loss of its own. The
    source is listed again afterwards, so a writer that was still running
    shows up as a failure instead of as a snapshot of nothing in particular.
    """
    if os.path.exists(dest):
        sys.exit(f"{dest}: exists; a snapshot is written to a new directory")
    before = inventory(source, max_file)
    shutil.copytree(source, dest, symlinks=True, copy_function=shutil.copy2)
    copied = inventory(dest, max_file)
    after = inventory(source, max_file)
    if before != after:
        print("FAIL  the source changed while it was copied: stop every writer and take it again")
        return 1
    if before != copied:
        print("FAIL  the copy differs from the source")
        return 1
    with open(out, "w", encoding="utf-8") as f:
        write(before, f)
    print(json.dumps(summary(before), indent=2))
    print(f"ok    {dest} holds every entry of {source}, excluded ones included; inventory in {out}")
    return 0


def synced(rows: list[dict]) -> dict[str, dict]:
    return {e["path"]: e for e in rows if e["excluded"] is None}


def changes(frozen: list[dict], current: list[dict]) -> list[dict]:
    """What changed after the cut: the rollback's export list (PLAN M10 step 6).

    Paths, not histories: a note edited three times after the cut is one
    `modified` line carrying its final bytes, and a rename is a `deleted` of
    the old path and an `added` of the new one, which is what a vault on the
    old system needs to be told.
    """
    old, new = synced(frozen), synced(current)
    # A collision at the freeze is on the old vault's disk under its own name
    # even though the server kept only one of its group, so the survivor is
    # unchanged when current holds it with the frozen bytes, and modified when
    # the bytes differ. It is never a delete: the members that did not arrive
    # were never on the server, and a rollback must not remove them.
    on_disk = {**{e["path"]: e for e in frozen if e["excluded"] == "collision"}, **old}
    out = []
    for path, e in new.items():
        f = on_disk.get(path)
        if f is None:
            out.append({"change": "added", **_fields(e)})
        elif not same(f, e):
            out.append({"change": "modified", **_fields(e), "frozenSha256": f["sha256"], "frozenKind": f["kind"]})
    for path, f in old.items():
        if path not in new:
            out.append({"change": "deleted", **_fields(f), "frozenSha256": f["sha256"]})
    # Folders first on the way in, deepest first on the way out.
    order = {"added": 0, "modified": 1, "deleted": 2}
    out.sort(key=lambda c: (order[c["change"]], c["path"].count("/") * (-1 if c["change"] == "deleted" else 1), c["path"]))
    return out


def _fields(e: dict) -> dict:
    return {"path": e["path"], "kind": e["kind"], "size": e["size"], "sha256": e["sha256"], "raw": e.get("raw", e["path"])}


def export_changes(frozen: str, current: str, from_dir: str | None, to_dir: str | None, show: bool) -> int:
    rows = changes(read(frozen), read(current))
    counts = Counter(f"{c['change']} {c['kind']}" for c in rows)
    for label, n in sorted(counts.items()):
        print(f"{n:6d}  {label}")
        if show:
            for c in rows:
                if f"{c['change']} {c['kind']}" == label:
                    print(f"          {c['path']!r}")
    if to_dir is None:
        return 0
    if from_dir is None:
        sys.exit("--to needs --from, the directory the current inventory was taken of")
    if os.path.exists(to_dir):
        sys.exit(f"{to_dir}: exists; an export is written to a new directory")
    os.makedirs(os.path.join(to_dir, "files"), mode=0o700)
    for c in rows:
        if c["change"] == "deleted" or c["kind"] == "folder":
            continue
        dest = os.path.join(to_dir, "files", c["path"])
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(os.path.join(from_dir, c["raw"]), "rb") as src, open(dest, "xb") as out:
            for block in iter(lambda: src.read(1 << 20), b""):
                out.write(block)
            out.flush()
            os.fsync(out.fileno())
        # Rule 4: verify the outcome. The file may have changed since the
        # inventory was taken; an export that does not hold the inventory's
        # bytes is refused, not shipped.
        if sha256_file(dest) != c["sha256"]:
            sys.exit(f"{c['path']!r} changed since the inventory; take the current inventory again")
    with open(os.path.join(to_dir, "changes.jsonl"), "w", encoding="utf-8") as f:
        f.write(json.dumps({"format": FORMAT + " changes"}) + "\n")
        for c in rows:
            f.write(json.dumps(c, ensure_ascii=False, sort_keys=True) + "\n")
    print(f"exported {sum(1 for c in rows if c['change'] != 'deleted' and c['kind'] != 'folder')} files to {to_dir}")
    return 0


def _ident(full: str):
    """The entry a path names on this disk, or None. Two spellings a folding
    disk holds as one name name the same entry."""
    try:
        st = os.lstat(full)
    except FileNotFoundError:
        return None
    return (st.st_dev, st.st_ino)


def _spelled(vault: str, rel: str) -> bool:
    """Every component of rel is on the disk under exactly that name.

    A disk that folds case (APFS, the Mac's) opens Note.md when asked for
    note.md, so existing is not enough: only the parent's listing says which
    spelling it holds. Normalisation alone is not a difference (the disk
    ignores it, and every client sends the NFC name).
    """
    parent = vault
    for part in rel.split("/"):
        try:
            names = os.listdir(parent)
        except (FileNotFoundError, NotADirectoryError):
            return False
        if part not in names and not any(obsidian_name(n) == part for n in names):
            return False
        parent = os.path.join(parent, part)
    return True


def _outside(vault: str, rel: str) -> bool:
    """rel would be reached through a link, or would land outside the vault.

    A frozen vault may hold a link the clients never followed (the inventory
    excludes it); writing or removing through one would change a file that is
    not the vault's, so every component is checked, and the parent's real path
    must be under the vault's.
    """
    parts = rel.split("/")
    if any(p in ("", ".", "..") for p in parts):
        return True
    full = vault
    for p in parts:
        full = os.path.join(full, p)
        if os.path.islink(full):
            return True
    root = os.path.realpath(vault)
    real = os.path.realpath(os.path.dirname(os.path.join(vault, rel)))
    return real != root and not real.startswith(root + os.sep)


def _respell(old: str, new: str) -> None:
    """Rename an entry to another spelling of the same name, by way of a third
    name: a case-only rename in one step is a no-op on some folding disks."""
    tmp = os.path.join(os.path.dirname(new), f".rollback-respell-{os.getpid()}")
    if os.path.lexists(tmp):
        sys.exit(f"{tmp}: exists; remove it and apply again")
    os.rename(old, tmp)
    os.rename(tmp, new)


def _put(export: str, c: dict, target: str) -> None:
    """Write the export's copy of c over target, atomically, and verify it (rule 4)."""
    tmp = target + ".rollback-tmp"
    with open(os.path.join(export, "files", c["path"]), "rb") as src, open(tmp, "xb") as out:
        for block in iter(lambda: src.read(1 << 20), b""):
            out.write(block)
        out.flush()
        os.fsync(out.fileno())
    os.replace(tmp, target)
    if sha256_file(target) != c["sha256"]:
        sys.exit(f"{c['path']!r}: the written file does not hold the exported bytes")


def apply_changes(export: str, vault: str, write_it: bool, show: bool) -> int:
    """Put an export into a vault as it was at the freeze, or say why not.

    Refuses per path rather than overwriting: a file is replaced or removed
    only while it still holds its frozen bytes, and an added path only lands
    where nothing is. Anything else is a conflict to reconcile by hand, and is
    left exactly as it is (rule 3: nothing is deleted without a verified copy
    elsewhere, and a file changed on this side has none).

    A rename the export records as a delete of one path and an add of another
    that folds alike (Note.md to note.md, Folder/ to folder/) is one entry on a
    disk that folds case. Applied as an add and a delete, the add would find
    the old file and the delete would then remove the only copy; so such a
    pair is applied as the rename it is, and no path is removed while it is
    the same entry on this disk as an added one. Nothing is written or
    removed through a link, or outside the vault.
    """
    with open(os.path.join(export, "changes.jsonl"), encoding="utf-8") as f:
        lines = f.read().splitlines()
    if not lines or json.loads(lines[0]).get("format") != FORMAT + " changes":
        sys.exit(f"{export}: not an export")
    rows = [json.loads(line) for line in lines[1:]]
    contract = _contract()
    table = contract.fold_table()

    def fold_key(c: dict) -> tuple[bool, str]:
        return (c["kind"] == "folder", contract.fold(c["path"], table))

    # The server keeps one name per fold, and so did the frozen inventory (a
    # collision is excluded), so a fold names at most one add and one delete.
    added_by_fold = {fold_key(c): c for c in rows if c["change"] == "added"}
    renamed_from: dict[str, dict] = {}  # added path -> the deleted row it may rename
    for c in rows:
        a = added_by_fold.get(fold_key(c)) if c["change"] == "deleted" else None
        if a is not None and a["path"] != c["path"]:
            renamed_from[a["path"]] = c
    handled: set[str] = set()  # deleted paths a rename took care of
    added_ids = None  # the entries the added paths name, taken once the adds are done

    done: Counter = Counter()
    refused: dict[str, list[str]] = defaultdict(list)
    gone: set[str] = set()  # what a dry run would have removed, so its folders judge alike
    for c in rows:
        if c["change"] == "deleted" and c["path"] in handled:
            continue
        if _outside(vault, c["path"]):
            refused["a link on the way or outside the vault, not followed"].append(c["path"])
            continue
        target = os.path.join(vault, c["path"])
        exists = os.path.lexists(target)
        if c["change"] == "deleted" and exists:
            if added_ids is None:
                added_ids = {_ident(os.path.join(vault, a["path"])) for a in rows if a["change"] == "added"} - {None}
            if _ident(target) in added_ids:
                refused["the same entry here as an added path, not deleted"].append(c["path"])
                continue
        d = renamed_from.get(c["path"]) if c["change"] == "added" else None
        if d is not None and exists and not _outside(vault, d["path"]):
            old = os.path.join(vault, d["path"])
            if _ident(old) == _ident(target):
                # This disk holds the two spellings as one entry: a rename.
                handled.add(d["path"])
                if c["kind"] == "folder":
                    if write_it:
                        _respell(old, target)
                    done["renamed folder"] += 1
                    continue
                current = sha256_file(old) if os.path.isfile(old) else None
                if current != d["frozenSha256"]:
                    refused["changed here since the freeze, not renamed"].append(d["path"])
                    continue
                if write_it:
                    _respell(old, target)
                    if current != c["sha256"]:
                        _put(export, c, target)
                    if not _spelled(vault, c["path"]):
                        sys.exit(f"{c['path']!r}: renamed, but the disk does not hold that spelling")
                done["renamed"] += 1
                continue
        if c["kind"] == "folder":
            if c["change"] == "added":
                if exists and not _spelled(vault, c["path"]):
                    refused["here under another spelling, not changed"].append(c["path"])
                    continue
                if not exists and write_it:
                    os.makedirs(target, exist_ok=True)
                if not exists:
                    done["folder added"] += 1
            elif c["change"] == "deleted" and exists:
                left = [n for n in os.listdir(target) if f"{c['path']}/{obsidian_name(n)}" not in gone]
                if left:
                    refused["folder not empty, kept"].append(c["path"])
                else:
                    if write_it:
                        os.rmdir(target)
                    gone.add(c["path"])
                    done["folder deleted"] += 1
            continue
        if exists and not os.path.isfile(target):
            refused["not a file here, kept"].append(c["path"])
            continue
        current = sha256_file(target) if exists else None
        if c["change"] == "deleted":
            if current is None:
                done["already absent"] += 1
            elif current == c["frozenSha256"]:
                if write_it:
                    os.remove(target)
                gone.add(c["path"])
                done["deleted"] += 1
            else:
                refused["changed here since the freeze, not deleted"].append(c["path"])
            continue
        if current == c["sha256"]:
            if _spelled(vault, c["path"]):
                done["already current"] += 1
            else:
                refused["here under another spelling, not changed"].append(c["path"])
            continue
        expected = c.get("frozenSha256")  # None for an added path
        if current != expected:
            label = "exists here, not overwritten" if c["change"] == "added" else "changed here since the freeze, not overwritten"
            refused[label].append(c["path"])
            continue
        if write_it:
            os.makedirs(os.path.dirname(target) or vault, exist_ok=True)
            _put(export, c, target)
        done[c["change"]] += 1
    if not write_it:
        print("dry run: nothing written; --apply writes")
    verb = "applied" if write_it else "would"
    for label, n in sorted(done.items()):
        print(f"{verb:<8}  {n:6d}  {label}")
    for label, paths in sorted(refused.items()):
        print(f"REFUSED   {len(paths):6d}  {label}")
        if show:
            for p in sorted(paths):
                print(f"            {p!r}")
    return 1 if refused else 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    inv = sub.add_parser("inventory", help="list a vault; only reads it")
    inv.add_argument("dir")
    inv.add_argument("-o", "--out", help="write here instead of standard output")
    inv.add_argument("--max-file", type=int, default=DEFAULT_MAX_FILE, help="the server's -max-file")
    inv.add_argument("--summary", action="store_true", help="print the counts to standard error")
    cmp_ = sub.add_parser("compare", help="compare a source inventory with a witness inventory")
    cmp_.add_argument("source")
    cmp_.add_argument("witness")
    cmp_.add_argument("--paths", action="store_true", help="name each failing path (private output)")
    cmp_.add_argument(
        "--allow-empty-folders",
        action="store_true",
        help="accept source folders missing on the witness (only if the client is known not to carry them)",
    )
    snap = sub.add_parser("snapshot", help="copy a vault and prove the copy by its inventory")
    snap.add_argument("source")
    snap.add_argument("dest", help="a new directory")
    snap.add_argument("-o", "--out", required=True, help="where to write the source's inventory")
    snap.add_argument("--max-file", type=int, default=DEFAULT_MAX_FILE, help="the server's -max-file")
    chg = sub.add_parser("changes", help="what changed after the cut; with --to, export it for a rollback")
    chg.add_argument("frozen", help="the inventory taken at the freeze")
    chg.add_argument("current", help="an inventory of a vault holding the server's current state")
    chg.add_argument("--from", dest="from_dir", help="the directory the current inventory was taken of")
    chg.add_argument("--to", dest="to_dir", help="a new directory to export the changed files into")
    chg.add_argument("--paths", action="store_true", help="name each changed path (private output)")
    app = sub.add_parser("apply", help="put an export into a vault as it was at the freeze; dry run by default")
    app.add_argument("export")
    app.add_argument("vault")
    app.add_argument("--apply", action="store_true", help="write; without it nothing is changed")
    app.add_argument("--paths", action="store_true", help="name each refused path (private output)")
    args = parser.parse_args()

    if args.command == "snapshot":
        sys.exit(snapshot(args.source, args.dest, args.out, args.max_file))
    if args.command == "changes":
        sys.exit(export_changes(args.frozen, args.current, args.from_dir, args.to_dir, args.paths))
    if args.command == "apply":
        sys.exit(apply_changes(args.export, args.vault, args.apply, args.paths))
    if args.command == "inventory":
        if not os.path.isdir(args.dir):
            sys.exit(f"{args.dir}: not a directory")
        rows = inventory(args.dir, args.max_file)
        if args.out:
            with open(args.out, "w", encoding="utf-8") as f:
                write(rows, f)
        else:
            write(rows, sys.stdout)
        if args.summary or args.out:
            print(json.dumps(summary(rows), indent=2), file=sys.stderr)
        return
    sys.exit(compare(read(args.source), read(args.witness), args.paths, args.allow_empty_folders))


if __name__ == "__main__":
    main()
