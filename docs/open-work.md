# Open work

Two things are known, deliberate, and not done. Both are recorded here rather
than in a comment because both are decisions somebody could reasonably make
differently, and each says what would change the answer.

## Downloads hold a whole copy of the file

`assemble` builds the entire plaintext in one buffer before anything is
written, and the inbox holds the sealed bodies until the file lands. So a
download peaks at roughly twice the file's size, on whichever device has the
least memory.

Uploads have not done this since `streamScan`: they cut and name a 256 MiB file
without ever holding it, and above 8 MiB `planUpload` keeps only offsets and
re-seals a chunk when the server asks for it. The asymmetry is the whole of why
the server's `-max-file` defaults to 64 MiB.

The fix is to stream the assembly: write each chunk into a staging file as it
is opened, verify, then rename into place. That removes both copies and makes
the ceiling a question about disks. It touches `land`, `writePreserving` and
both vault adapters, and it has to keep the preserving write exactly as it is,
which is why it is its own piece of work rather than a flag.

Ente Photos does exactly this, for the same reason, with libsodium's
`secretstream` in place of these chunks. Their scheme is not one to copy
wholesale: a chained stream makes every chunk's ciphertext depend on its
position, so nothing dedupes, which is fine for an archive of immutable photos
and wrong for a vault of notes people edit. The part worth copying is that they
never hold a file.

**Before changing the default:** the 2.7 MB per MiB in
[store.go](../internal/store/store.go) was measured before the
single-buffer assembly and the windowed sealing landed, so the number the
64 MiB default rests on is no longer true. Measure peak resident on a phone for
one large attachment first.

## The index snapshot may be the wrong shape at 50,000 notes

Not a decision yet, a hypothesis the Android measurement was built to test, and
written down before the numbers arrive so it cannot be invented afterwards.

`DEFAULT_POLICY` in
[index-journal-store.ts](../client/src/core/index-journal-store.ts) rewrites the
whole index snapshot after 1,000 appended records. Its own comment says why
that cap was chosen over the proportional one: at 10,000 notes it "holds the
log at 380 KiB and replay at 12 ms whatever the vault weighs".

Both of those are load-time costs. Neither is the cost of the write. The
snapshot grows with the vault, and a live vault of 3,796 notes has a 3.1 MB
index, so 50,000 notes is roughly 40 MB. The proportional bound
(`fractionOfSnapshot`) scales with the snapshot and would let the log grow
instead; the record cap fires first at that size and pays a 40 MB write more
often, through Obsidian's adapter, on the single thread the editor runs on.

So the suspicion is that the cap was tuned where the snapshot was 5 MiB and
makes the wrong trade where it is 40 MB. If the measurement bears that out, the
fix is a policy that weighs the write it is about to do, which is a much
smaller change than the work set below and would want doing first.

The instrumentation reports `kind` and `bytes` per save for exactly this
reason: an append and a snapshot are the same call from the outside and nothing
distinguished them.

## A pass still re-decides the whole vault

Every pass rebuilds the combined path set, sorts it, visits every path and
copies the remote map, and the journal then compares every record to find what
changed. At ten thousand local and ten thousand remote records that is twenty
thousand comparisons to establish that a settled pass has nothing to write.

Driving reconciliation from a work set instead, dirty paths plus incoming paths
plus due retries, with derived indexes maintained in place and explicit
mutations handed to the journal, is the largest recurring saving available.

It is not done because the measurement does not yet justify the risk. The two
figures in [research.md](research.md) are 33 ms for an unchanged pass at ten
thousand notes with a healthy watcher, and 20 ms at four thousand. Neither is a
duration anybody feels.

They are **not two points on one curve**, and an earlier version of this
paragraph implied they were. The first is Node on a CLI vault at `aba03b4`; the
second is bun on the `bench-pass` harness at `f7f3512`. `bench-pass.ts` says in
its own header that these numbers move by 20x between JavaScriptCore and V8, so
a scaling claim drawn across the two would be an artefact of the runtime. The
1.9x per doubling quoted below comes from one harness on one runtime and is the
only scaling figure here worth anything. The change is a rewrite of the code that decides what happens to
somebody's notes, and a work set that misses a path is a note that stops
syncing while every status says the vault is fine. That is the
"do not lose a note" rule in [CLAUDE.md](../CLAUDE.md) and rule 7 in
[the design](design.md#the-durability-rules), which says a status describes the
vault rather than the filter. It is not rule 1, which an earlier version of
this cited: rule 1 is about acknowledging only after a write is durable, and it
is not what this would break.

The cheap parts of it are already taken. A CPU profile of that benchmark said
the cost was concentrated in three places that had nothing to do with the
architecture, and removing them left the constant lower and the shape
unchanged: it still scales at about 1.9x per doubling. What remains is the
architecture, which is this.

**What would change the answer:** Android, at ten thousand and fifty thousand
notes, from a saved file to verified content on a peer, with listing,
reconciliation, journal comparison and filesystem time separated.

The threshold is written down here **before** the measurement is taken, because
"reconciliation dominates" decided afterwards is a sentence that can be argued
into either answer. Both of these must hold at fifty thousand notes:

- decide plus journal comparison is more than half of a quiet pass on the phone, and
- a save pass, with transfer time subtracted, takes longer than 200 ms.

Either one alone is not enough. A large share of a pass nobody waits on is not
worth this risk, and a slow pass whose time is somewhere else would not be
fixed by this change.

The evidence for the first is the **quiet ticker passes**, not the save passes.
A phone has one JavaScript thread, so Obsidian's own reaction to a save runs
interleaved with Trew's and lands inside whichever phase holds the event
loop; a save pass therefore cannot say whose time it was. A quiet pass has
Trew alone on the thread. If the quiet-pass shares and the desktop shares
disagree, that disagreement goes in [research.md](research.md) and this rewrite
does not start on the strength of it.

**Where the measurement got to.** The harness exists, it works, and it has
produced one Android data point: five hundred notes, where decide plus
comparison is 38.1% of a quiet pass, below the threshold but at a size nobody
claimed was decisive. Ten thousand was attempted and did not finish; the run is
written up in [research.md](research.md#ten-thousand-notes-on-the-phone-was-attempted-and-not-obtained)
along with why it cannot be read as a result. Fifty thousand has not been tried.

So this stays declined, and the reason is unchanged rather than strengthened:
there is still no phone number at the size the threshold names.
