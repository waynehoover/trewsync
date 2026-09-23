#!/usr/bin/env python3
"""Write protocol-transcripts.json: protocol 1 exchanges, message by message.

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
    return b64(hashlib.sha256(f"telimus transcript token for {device}".encode()).digest())


DEVICES = {
    d: {"deviceId": d, "token": token_for(d), "device": d, "createdAt": i + 1}
    for i, d in enumerate(["laptop", "phone"])
}


def hello(device: str, rid: int, cursor: int) -> dict:
    d = DEVICES[device]
    return {"op": "hello", "id": rid, "proto": 1, "vault": VAULT, "deviceId": d["deviceId"],
            "token": d["token"], "device": d["device"], "cursor": cursor}


def ready(rid: int, cursor: int) -> dict:
    return {"res": "ready", "id": rid, "proto": 1, "minProto": 1, "serverVersion": "$serverVersion",
            "epoch": "$epoch", "cursor": cursor, **LIMITS}


def entry(uid: int, path: str, bodies: list[bytes], mtime: int, device: str, prev: str = "") -> dict:
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
]


def main() -> None:
    doc = {
        "note": [
            "Protocol 1 exchanges, message by message (plan/protocol.md; PLAN.md M1 task 12).",
            "Written by scripts/protocol-transcripts.py and replayed against a real server on a fresh",
            "store by internal/server/transcripts_test.go, which fails on any frame that differs.",
            "",
            "Each transcript starts from an empty store holding the vault and the devices below, each",
            "registered with the SHA-256 of its token's raw bytes and the createdAt given. Steps run in",
            "order. A step names a connection (conn), opened by its first step and closed by close or",
            "by the server (expectClose), and does one thing:",
            "  send          a text frame, the JSON as given",
            "  sendBinary    a binary frame, the hex as given, marker byte included",
            "  expect        the next text frame on that connection, compared as JSON: the same keys,",
            "                no others, equal values, except placeholders",
            "  expectBinary  the next frame is a body frame that decodes (plan/protocol.md, 'Chunk",
            "                bodies') to the raw bytes in this hex; a replaying server may deflate or not",
            "  expectClose   the server closes the connection with nothing more sent",
            "  store         done to the store directly, not over the wire: put commits a version of",
            "                path with these bodies (hex) and mtime, written by device 'seed'; loseChunk",
            "                removes a body from the chunk tree. A fake socket ignores these steps: the",
            "                server's frames already reflect them.",
            "After the last step, no connection may be sent anything more.",
            "",
            "A placeholder is a whole string value beginning with $. $name matches the placeholder's kind;",
            "one marked same must match one value everywhere it appears in a transcript. $prefix:TEXT",
            "matches a string beginning with TEXT. A fake socket sends each placeholder's example, and",
            "for $prefix:TEXT the text followed by 'example'.",
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
        },
        "devices": DEVICES,
        "transcripts": TRANSCRIPTS,
    }
    path = ROOT / "protocol-transcripts.json"
    path.write_text(json.dumps(doc, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")
    print(f"wrote {len(TRANSCRIPTS)} transcripts to {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
