#!/usr/bin/env python3
"""Write protocol-transcripts.json: protocol exchanges, message by message.

    uv run --no-project --python 3.13 scripts/protocol-transcripts.py

The fixtures in protocol-fixtures.json pin the pieces of the protocol, one rule
at a time. These pin the exchanges: what a client sends, in order, and what the
server answers, for the operations plan/protocol.md says are "unchanged from
protocol 7" (PLAN.md M0.5 and M1 task 12). Writing them down is what stops
"unchanged" carrying the weight.

Two consumers, and the format serves both:

  - internal/server/transcripts_test.go replays every transcript against a
    real server on a fresh store, and fails on any frame that differs;
  - the TypeScript client's fake socket (M2) plays the server's side back to
    the client, so every expected frame is concrete enough to send, with the
    placeholders' examples substituted.

This script only writes the file. The replay is the check that the file is the
server's behaviour; regenerate after changing a transcript here and read the
diff.
"""

from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VAULT = "v1"

LIMITS = {
    "perFileMax": 64 << 20,
    "chunkMax": 1 << 20,
    "maxChunks": 65536,
    "maxBatchBytes": 16 << 20,
    "maxFetchBytes": 64 << 20,
}


def name(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def token_for(device: str) -> str:
    return b64(hashlib.sha256(f"trew transcript token for {device}".encode()).digest())


DEVICES = {
    d: {"deviceId": d, "token": token_for(d), "device": d, "createdAt": i + 1}
    for i, d in enumerate(["laptop", "phone"])
}


# The protocol a transcript speaks unless it says otherwise: 2, which is 1 and
# undo (plan/protocol.md, "Undo (protocol 2)"). The server answers a hello in
# the version it asks for, and one transcript holds it to answering 1.
PROTO = 2
MIN_PROTO = 1


def hello(device: str, rid: int, cursor: int, proto: int = PROTO) -> dict:
    d = DEVICES[device]
    return {"op": "hello", "id": rid, "proto": proto, "vault": VAULT, "deviceId": d["deviceId"],
            "token": d["token"], "device": d["device"], "cursor": cursor}


def ready(rid: int, cursor: int, proto: int = PROTO) -> dict:
    return {"res": "ready", "id": rid, "proto": proto, "minProto": MIN_PROTO, "serverVersion": "$serverVersion",
            "epoch": "$epoch", "cursor": cursor, **LIMITS}


def entry(uid: int, path: str, bodies: list[bytes], mtime, device: str, prev: str = "") -> dict:
    e = {"uid": uid, "path": path, "size": sum(len(b) for b in bodies), "ctime": 0, "mtime": mtime,
         "folder": False, "deleted": False, "device": device}
    if prev:
        e["prev"] = prev
    e["chunks"] = [name(b) for b in bodies]
    return e


def batch(lo: int, hi: int, entries: list[dict]) -> dict:
    return {"op": "batch", "from": lo, "to": hi, "entries": entries}


def caught_up(cursor: int) -> dict:
    return {"op": "caught-up", "cursor": cursor}


def put(rid: int, path: str, bodies: list[bytes], mtime: int, base: int, prev: str = "", prev_base: int = 0) -> dict:
    meta = {"size": sum(len(b) for b in bodies), "ctime": 0, "mtime": mtime, "folder": False, "deleted": False}
    if prev:
        meta["prev"] = prev
    m = {"op": "put", "id": rid, "path": path, "meta": meta, "chunks": [name(b) for b in bodies], "base": base}
    if prev:
        m["prevBase"] = prev_base
    return m


def raw_frame(body: bytes) -> str:
    """A body frame as a client sends it: marker 0, raw bytes."""
    return (b"\x00" + body).hex()


def err(rid: int, code: str, msg: str = "$msg") -> dict:
    return {"res": "err", "id": rid, "code": code, "msg": msg, "retryable": False}


def c(conn: str, **step) -> dict:
    return {"conn": conn, **step}


def seed(path: str, bodies: list[bytes], mtime: int) -> dict:
    return {"store": {"op": "put", "path": path, "bodies": [b.hex() for b in bodies], "mtime": mtime}}


def agent_edit(path: str, bodies: list[bytes], mtime: int) -> dict:
    """An agent's edit of path, committed as an MCP operation would be."""
    return {"store": {"op": "operation", "path": path, "bodies": [b.hex() for b in bodies], "mtime": mtime}}


def with_op(e: dict, op: dict) -> dict:
    """A protocol 2 history entry: the entry, and the operation that wrote it."""
    return {**e, "op": op}


def match(path: str, uid: int, line: int, column: int, text: str) -> dict:
    """A content match as a search reply carries it, with no context."""
    return {"path": path, "uid": uid, "line": line, "column": column, "text": text, "before": [], "after": [],
            "clipped": False}


def searched(rid: int, matches: list[dict], next_after, complete: bool, head: int, scanned: int,
             scanned_bytes: int) -> dict:
    """A search page from a server that keeps no index: every note is read."""
    return {"res": "searched", "id": rid, "matches": matches, "skipped": [], "nextAfter": next_after,
            "complete": complete, "head": head, "indexedHead": 0, "index": {"usable": False, "why": "$msg"},
            "scanned": scanned, "scannedBytes": scanned_bytes}


def connect(conn: str, device: str, cursor: int, backlog: list[tuple[int, int, list[dict]]], at: int) -> list[dict]:
    """A device's hello, its ready, the batches the backlog replays, and caught-up."""
    steps = [c(conn, send=hello(device, 1, cursor)), c(conn, expect=ready(1, at))]
    for lo, hi, entries in backlog:
        steps.append(c(conn, expect=batch(lo, hi, entries)))
    steps.append(c(conn, expect=caught_up(at)))
    return steps


A, B, C, D = b"alpha body", b"bravo body", b"charlie body", b"delta body"

TRANSCRIPTS = [
    {
        "name": "have",
        "covers": "A put whose every body the server already holds is answered have, with no upload; the "
                  "writer is sent its own version as an empty range first.",
        "steps": [
            seed("a.md", [A], 1),
            *connect("laptop", "laptop", 0, [(1, 1, [entry(1, "a.md", [A], 1, "seed")])], 1),
            c("laptop", send=put(2, "copy-of-a.md", [A], 2, 0)),
            c("laptop", expect=batch(2, 2, [])),
            c("laptop", expect={"res": "have", "id": 2, "uid": 2}),
        ],
    },
    {
        "name": "want",
        "covers": "A put naming bodies the server lacks is answered want, the bodies follow as frames, and "
                  "the ack comes after the echo; another device is sent the version live and fetches it.",
        "steps": [
            *connect("laptop", "laptop", 0, [], 0),
            *connect("phone", "phone", 0, [], 0),
            c("laptop", send=put(2, "b.md", [B, C], 5, 0)),
            c("laptop", expect={"res": "want", "id": 2, "chunks": [name(B), name(C)]}),
            c("laptop", sendBinary=raw_frame(B)),
            c("laptop", sendBinary=raw_frame(C)),
            c("laptop", expect=batch(1, 1, [])),
            c("laptop", expect={"res": "ack", "id": 2, "uid": 1}),
            c("phone", expect=batch(1, 1, [entry(1, "b.md", [B, C], 5, "laptop")])),
            c("phone", send={"op": "fetch", "id": 2, "chunks": [name(B), name(C)]}),
            c("phone", expect={"res": "bodies", "id": 2, "count": 2}),
            c("phone", expectBinary=B.hex()),
            c("phone", expectBinary=C.hex()),
        ],
    },
    {
        "name": "mixed-success putmany",
        "covers": "One putmany whose entries succeed and fail independently: a new file, a write against a "
                  "stale base, and a path the policy refuses. The refused path uploads nothing, the stale "
                  "write uploads and is refused at the commit, only the first commits, and the acks say "
                  "which is which, slot by slot.",
        "steps": [
            seed("kept.md", [A], 1),
            *connect("laptop", "laptop", 1, [], 1),
            c("laptop", send={"op": "putmany", "id": 2, "entries": [
                {k: v for k, v in put(0, "new.md", [D], 6, 0).items() if k not in ("op", "id")},
                {k: v for k, v in put(0, "kept.md", [B], 6, 0).items() if k not in ("op", "id")},
                {k: v for k, v in put(0, ".obsidian/app.json", [C], 6, 0).items() if k not in ("op", "id")},
            ]}),
            # The stale write's body is asked for too: a base is judged at the
            # commit, against the head as it stands then, not before the upload.
            c("laptop", expect={"res": "want", "id": 2, "chunks": [name(D), name(B)]}),
            c("laptop", sendBinary=raw_frame(D)),
            c("laptop", sendBinary=raw_frame(B)),
            c("laptop", expect=batch(2, 2, [])),
            c("laptop", expect={"res": "acks", "id": 2, "results": [
                {"uid": 2},
                {"code": "stale", "msg": "$msg"},
                {"code": "badpath", "msg": "$prefix:dotprefix: the path "},
            ]}),
        ],
    },
    {
        "name": "stale rename source",
        "covers": "A rename prepared against an old version of its source is refused stale and the "
                  "session stays usable; the same rename against the source's head commits.",
        "steps": [
            seed("from.md", [A], 1),
            seed("from.md", [B], 2),
            *connect("laptop", "laptop", 2, [], 2),
            c("laptop", send=put(2, "to.md", [B], 3, 0, prev="from.md", prev_base=1)),
            c("laptop", expect=err(2, "stale")),
            c("laptop", send=put(3, "to.md", [B], 3, 0, prev="from.md", prev_base=2)),
            c("laptop", expect=batch(3, 3, [])),
            c("laptop", expect={"res": "have", "id": 3, "uid": 3}),
        ],
    },
    {
        "name": "stale rename destination",
        "covers": "A rename onto a path whose version it did not prepare against is refused stale, the "
                  "destination's base being the one that is out of date.",
        "steps": [
            seed("from.md", [A], 1),
            seed("to.md", [C], 2),
            *connect("laptop", "laptop", 2, [], 2),
            c("laptop", send=put(2, "to.md", [A], 3, 0, prev="from.md", prev_base=1)),
            c("laptop", expect=err(2, "stale")),
            c("laptop", send={"op": "ping"}),
            c("laptop", expect={"res": "pong"}),
        ],
    },
    {
        "name": "reconnect continuity",
        "covers": "A device replays the backlog from uid 1, goes away, and on reconnecting with its cursor "
                  "is sent exactly what it missed and nothing before it; afterwards it is sent another "
                  "device's writes live, each range continuing the one before.",
        "steps": [
            seed("a.md", [A], 1),
            seed("b.md", [B], 2),
            *connect("laptop", "laptop", 0, [(1, 2, [entry(1, "a.md", [A], 1, "seed"),
                                                     entry(2, "b.md", [B], 2, "seed")])], 2),
            c("laptop", close=True),
            seed("c.md", [C], 3),
            *connect("laptop-again", "laptop", 2, [(3, 3, [entry(3, "c.md", [C], 3, "seed")])], 3),
            *connect("phone", "phone", 3, [], 3),
            c("phone", send=put(2, "d.md", [D], 4, 0)),
            c("phone", expect={"res": "want", "id": 2, "chunks": [name(D)]}),
            c("phone", sendBinary=raw_frame(D)),
            c("phone", expect=batch(4, 4, [])),
            c("phone", expect={"res": "ack", "id": 2, "uid": 4}),
            c("laptop-again", expect=batch(4, 4, [entry(4, "d.md", [D], 4, "phone")])),
        ],
    },
    {
        "name": "resend repair",
        "covers": "The server has lost a body a committed version names; a device that still has it "
                  "resends it, with no entry and no uid, and the version can be fetched again.",
        "steps": [
            seed("a.md", [A], 1),
            {"store": {"op": "loseChunk", "chunk": name(A)}},
            *connect("laptop", "laptop", 1, [], 1),
            c("laptop", send={"op": "resend", "id": 2, "chunks": [name(A)]}),
            c("laptop", expect={"res": "want", "id": 2, "chunks": [name(A)]}),
            c("laptop", sendBinary=raw_frame(A)),
            c("laptop", expect={"res": "resent", "id": 2, "stored": 1, "missing": 0}),
            c("laptop", send={"op": "fetch", "id": 3, "chunks": [name(A)]}),
            c("laptop", expect={"res": "bodies", "id": 3, "count": 1}),
            c("laptop", expectBinary=A.hex()),
        ],
    },
    {
        "name": "applied receipts",
        "covers": "A device reports the checkpoint it has applied, the device list shows it, and a "
                  "checkpoint ahead of the server is refused without ending the session.",
        "steps": [
            seed("a.md", [A], 1),
            seed("b.md", [B], 2),
            *connect("laptop", "laptop", 0, [(1, 2, [entry(1, "a.md", [A], 1, "seed"),
                                                     entry(2, "b.md", [B], 2, "seed")])], 2),
            c("laptop", send={"op": "applied", "id": 2, "applied": 2}),
            c("laptop", expect={"res": "applied", "id": 2, "cursor": 2}),
            c("laptop", send={"op": "devices", "id": 3}),
            c("laptop", expect={"res": "devices", "id": 3, "devices": [
                {"id": "laptop", "name": "laptop", "createdAt": 1, "lastSeen": "$time",
                 "online": True, "applied": 2},
                {"id": "phone", "name": "phone", "createdAt": 2, "lastSeen": 0,
                 "online": False, "applied": None},
            ], "invites": []}),
            c("laptop", send={"op": "applied", "id": 4, "applied": 99}),
            c("laptop", expect=err(4, "badentry")),
            c("laptop", send={"op": "ping"}),
            c("laptop", expect={"res": "pong"}),
        ],
    },
    {
        "name": "undo",
        "covers": "Protocol 2: a history entry an agent wrote names its operation; undoing it writes the "
                  "former bytes back as a new version by the device that asked, which every device is sent "
                  "as an ordinary batch, the asking one first and before its reply; the history then names "
                  "the undo and says the edit was undone, and a second undo is refused.",
        "steps": [
            seed("a.md", [A], 1),
            agent_edit("a.md", [B], 2),
            *connect("laptop", "laptop", 0, [(1, 2, [entry(1, "a.md", [A], 1, "seed"),
                                                     entry(2, "a.md", [B], 2, "agent")])], 2),
            *connect("phone", "phone", 2, [], 2),
            c("laptop", send={"op": "history", "id": 2, "path": "a.md"}),
            c("laptop", expect={"res": "history", "id": 2, "path": "a.md", "entries": [
                with_op(entry(2, "a.md", [B], 2, "agent"), {"id": "$opId", "tool": "edit_note", "kind": "mcp"}),
                entry(1, "a.md", [A], 1, "seed"),
            ]}),
            c("laptop", send={"op": "undo", "id": 3, "opId": "$opId"}),
            c("laptop", expect=batch(3, 3, [entry(3, "a.md", [A], "$time", "laptop")])),
            c("laptop", expect={"res": "undone", "id": 3, "opId": "$undoId", "undoes": "$opId", "toCopy": False,
                                "committedAt": "$time",
                                "steps": [{"action": "restore", "path": "a.md", "before": 1, "after": 2}],
                                "entries": [{"path": "a.md", "uid": 3, "previousUid": 2}]}),
            c("phone", expect=batch(3, 3, [entry(3, "a.md", [A], "$time", "laptop")])),
            c("laptop", send={"op": "history", "id": 4, "path": "a.md"}),
            c("laptop", expect={"res": "history", "id": 4, "path": "a.md", "entries": [
                with_op(entry(3, "a.md", [A], "$time", "laptop"), {"id": "$undoId", "tool": "undo", "kind": "device"}),
                with_op(entry(2, "a.md", [B], 2, "agent"),
                        {"id": "$opId", "tool": "edit_note", "kind": "mcp", "undoneBy": "$undoId"}),
                entry(1, "a.md", [A], 1, "seed"),
            ]}),
            c("laptop", send={"op": "undo", "id": 5, "opId": "$opId"}),
            c("laptop", expect=err(5, "noundo", "$prefix:already_undone: ")),
        ],
    },
    {
        "name": "undo of nothing",
        "covers": "Protocol 2: an undo naming an operation the vault never committed is refused noundo, one "
                  "naming no operation id at all is refused badentry, and the session goes on.",
        "steps": [
            *connect("laptop", "laptop", 0, [], 0),
            c("laptop", send={"op": "undo", "id": 2, "opId": "AAAAAAAAAAAAAAAAAAAAAA"}),
            c("laptop", expect=err(2, "noundo", "$prefix:not_found: ")),
            c("laptop", send={"op": "undo", "id": 3, "opId": "not an operation"}),
            c("laptop", expect=err(3, "badentry")),
            c("laptop", send={"op": "ping"}),
            c("laptop", expect={"res": "pong"}),
        ],
    },
    {
        "name": "search",
        "covers": "Protocol 2: a device searches its vault and is answered from the server's literal search: "
                  "each match with its version, line, column and line text, a page that says it is complete, "
                  "and, on a server with no index, that no index narrowed it; a limit makes pages that "
                  "nextAfter continues, the last one complete; a query or a continuation the search refuses "
                  "is refused without ending the session.",
        "steps": [
            seed("a.md", [b"the harbour at dawn\n"], 1),
            seed("b.md", [b"no match here\n"], 2),
            seed("c.md", [b"Harbour lights\n"], 3),
            *connect("laptop", "laptop", 3, [], 3),
            c("laptop", send={"op": "search", "id": 2, "query": "harbour"}),
            c("laptop", expect=searched(2, [
                match("a.md", 1, 1, 5, "the harbour at dawn"),
                match("c.md", 3, 1, 1, "Harbour lights"),
            ], None, True, 3, 3, 49)),
            c("laptop", send={"op": "search", "id": 3, "query": "harbour", "limit": 1}),
            c("laptop", expect=searched(3, [match("a.md", 1, 1, 5, "the harbour at dawn")],
                                        "$after", False, 3, 3, 49)),
            c("laptop", send={"op": "search", "id": 4, "query": "harbour", "limit": 1, "after": "$after"}),
            c("laptop", expect=searched(4, [match("c.md", 3, 1, 1, "Harbour lights")], None, True, 3, 1, 15)),
            c("laptop", send={"op": "search", "id": 5, "query": ""}),
            c("laptop", expect=err(5, "badentry", "$prefix:invalid_query: ")),
            c("laptop", send={"op": "search", "id": 6, "query": "harbour", "after": "bm90IGEgY3Vyc29y"}),
            c("laptop", expect=err(6, "stale", "$prefix:expired: ")),
            c("laptop", send={"op": "ping"}),
            c("laptop", expect={"res": "pong"}),
        ],
    },
    {
        "name": "protocol 1 is still answered",
        "covers": "A device on protocol 1 is answered in protocol 1 by a server of protocol 2: its ready says "
                  "1, a history entry an agent wrote carries no operation, and undo and search, which protocol 1 "
                  "does not have, are unknown ops that reject the request and keep the session. The server's "
                  "half only: the TypeScript client speaks protocol 2, so it does not play this one.",
        "steps": [
            seed("a.md", [A], 1),
            agent_edit("a.md", [B], 2),
            c("laptop", send=hello("laptop", 1, 0, proto=1)),
            c("laptop", expect=ready(1, 2, proto=1)),
            c("laptop", expect=batch(1, 2, [entry(1, "a.md", [A], 1, "seed"), entry(2, "a.md", [B], 2, "agent")])),
            c("laptop", expect=caught_up(2)),
            c("laptop", send={"op": "history", "id": 2, "path": "a.md"}),
            c("laptop", expect={"res": "history", "id": 2, "path": "a.md", "entries": [
                entry(2, "a.md", [B], 2, "agent"), entry(1, "a.md", [A], 1, "seed")]}),
            c("laptop", send={"op": "undo", "id": 3, "opId": "AAAAAAAAAAAAAAAAAAAAAA"}),
            c("laptop", expect=err(3, "protostate")),
            c("laptop", send={"op": "search", "id": 4, "query": "alpha"}),
            c("laptop", expect=err(4, "protostate")),
            c("laptop", send={"op": "ping"}),
            c("laptop", expect={"res": "pong"}),
        ],
    },
]


def main() -> None:
    doc = {
        "note": [
            "Protocol exchanges, message by message (plan/protocol.md; PLAN.md M1 task 12 and M5 task 7,",
            "and the device search of 2026-09-24):",
            "protocol 2 unless a hello says otherwise, which one transcript does, to hold the server to",
            "answering protocol 1 as protocol 1.",
            "Written by scripts/protocol-transcripts.py and replayed against a real server on a fresh",
            "store by internal/server/transcripts_test.go, which fails on any frame that differs.",
            "",
            "Each transcript starts from an empty store holding the vault and the devices below, each",
            "registered with the SHA-256 of its token's raw bytes and the createdAt given. Steps run in",
            "order. A step names a connection (conn), opened by its first step and closed by close or",
            "by the server (expectClose), and does one thing:",
            "  send          a text frame, the JSON as given, a placeholder marked same standing for the",
            "                value it was bound to earlier in the transcript",
            "  sendBinary    a binary frame, the hex as given, marker byte included",
            "  expect        the next text frame on that connection, compared as JSON: the same keys,",
            "                no others, equal values, except placeholders",
            "  expectBinary  the next frame is a body frame that decodes (plan/protocol.md, 'Chunk",
            "                bodies') to the raw bytes in this hex; a replaying server may deflate or not",
            "  expectClose   the server closes the connection with nothing more sent",
            "  store         done to the store directly, not over the wire: put commits a version of",
            "                path with these bodies (hex) and mtime, written by device 'seed'; operation",
            "                commits the same as an agent's edit of path's head, through the commit",
            "                boundary the MCP tools use, by a token labelled 'agent'; loseChunk removes a",
            "                body from the chunk tree. A fake socket ignores these steps: the server's",
            "                frames already reflect them.",
            "After the last step, no connection may be sent anything more.",
            "",
            "A placeholder is a whole string value beginning with $. $name matches the placeholder's kind;",
            "one marked same must match one value everywhere it appears in a transcript. $prefix:TEXT",
            "matches a string beginning with TEXT. A fake socket sends each placeholder's example, and",
            "for $prefix:TEXT the text followed by 'example', and a client is held to sending a same",
            "placeholder's example where the transcript sends it.",
        ],
        "format": 1,
        "vault": VAULT,
        "placeholders": {
            "$epoch": {"kind": "string", "same": True, "example": "transcript-epoch",
                       "about": "the store's epoch, opaque"},
            "$serverVersion": {"kind": "string", "same": True, "example": "dev",
                               "about": "what the server calls itself"},
            "$msg": {"kind": "string", "same": False, "example": "a message for the person",
                     "about": "a refusal's message, for a person; its wording is not the protocol"},
            "$time": {"kind": "number", "same": False, "example": 1790000000000,
                      "about": "a server timestamp in milliseconds"},
            "$opId": {"kind": "string", "same": True, "example": "EditEditEditEditEditEQ",
                      "about": "an operation's id, 16 random bytes in base64url"},
            "$undoId": {"kind": "string", "same": True, "example": "UndoUndoUndoUndoUndoUQ",
                        "about": "an undo's own operation id, 16 random bytes in base64url"},
            "$after": {"kind": "string", "same": True, "example": "c2VhcmNoLWNvbnRpbnVhdGlvbg",
                       "about": "a search's continuation, opaque: it binds the store's epoch"},
        },
        "devices": DEVICES,
        "transcripts": TRANSCRIPTS,
    }
    path = ROOT / "protocol-transcripts.json"
    path.write_text(json.dumps(doc, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    print(f"wrote {len(TRANSCRIPTS)} transcripts to {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
