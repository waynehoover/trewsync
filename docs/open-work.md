# Open work

These are known, deliberate, and not done. Each is recorded here rather than
in a comment because it is a decision somebody could reasonably make
differently, and each says what would change the answer.

## Downloads hold a whole copy of the file

`assemble` builds the entire file in one buffer before anything is written, and
the inbox holds the chunk bodies until the file lands. So a download peaks at
roughly twice the file's size, on whichever device has the least memory.

Uploads have not done this since `streamScan`: they cut and name a 256 MiB file
without ever holding it, and above 8 MiB `planUpload` keeps only offsets and
re-reads and re-hashes a chunk when the server asks for it. The asymmetry is the
whole of why the server's `-max-file` defaults to 64 MiB.

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
[store.go](../internal/store/store.go) was measured in Basalt, before the
single-buffer assembly and the windowed sealing (now windowed naming) landed,
so the number the 64 MiB default rests on is no longer true. Measure peak
resident on a phone for one large attachment first.

## A first sync on a Mac waits on fsync

At ten thousand notes on an M4 Pro, a fresh headless device's first download
took about two minutes and the first upload about a minute and a half
([research.md](research.md#ten-thousand-notes-on-a-mac-september-24-2026)).
Both are linear in the number of files, so this is a constant, not a curve,
and almost all of it is the disk being made to promise.

The download writes each file through `NodeVault.replace`, which costs two
`F_FULLFSYNC`s: the staged file's own, and the staging folder's, so that the
staged name is durable before whatever is at the note's path is moved aside.
Each costs about 8 ms on this machine's SSD. Counted over a 2,000-file
download, 4,112 of them took 17.5 s of a 23.6 s run: three quarters of the
wall clock, with the client's JavaScript and the server both idle.

The staging folder's flush protects nothing on a first download, because
there is nothing at the path to move aside, and dropping it there would save
close to half. It is not done because it is a change to the preserving write,
where nearly every step carries a review finding (R18, R33, R37, R43, R46
among them), and the argument that it is safe (a note that appears in the
instant between the check and the move is still moved aside rather than
written over, and the server's bytes can be fetched again after a crash) is
one to prove at a new seam in `faults.stress.ts` before anybody relies on it.
Landing a batch's files concurrently is the other saving, about 2.6 times on
this disk for eight at once, and carries more risk than the first.

**What would change the answer:** a first sync that matters more than it
does now, which is a phone. Android's fsync is not macOS's `F_FULLFSYNC`, so
measure there (`bun run bench:phone`) before spending anything on this Mac's
number.

## search_notes reads every note at the head

A search the index answers with one candidate took 50 to 64 ms at ten
thousand notes and 3.5 ms at five hundred. The index proposes candidates, but
`searchNotes` in `internal/mcp/tools.go` still walks every live entry at the
head through `EachAsOf`, two correlated subqueries per row, and asks the
proposal about each one. So the cost of a search is the vault's size whatever
it finds, about 6 µs a note.

The fix is to read only the proposed candidates when the index is usable and
has indexed the head being searched, and walk as now otherwise, keeping the
rule that the index only ever narrows. It is not done here because the search
code was being changed at the same time for the `trew search` wire operation,
and at this size it does not matter: the endpoint lets one token make five
requests a second, so 64 ms is under a third of the gap it enforces.

**What would change the answer:** fifty thousand notes, where the same walk
is about 300 ms and the rate limit no longer hides it.

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
"do not lose a note" rule in [AGENTS.md](../AGENTS.md) and rule 7 in
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
interleaved with TrewSync's and lands inside whichever phase holds the event
loop; a save pass therefore cannot say whose time it was. A quiet pass has
TrewSync alone on the thread. If the quiet-pass shares and the desktop shares
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

**What the Mac run at ten thousand notes adds, and what it does not.** On the
realistic corpus a quiet pass of the headless client took 58 ms and a saved
edit reached a second watching device in about 100 ms
([research.md](research.md#ten-thousand-notes-on-a-mac-september-24-2026)).
Neither clause is about this machine, so neither is resolved, and the Mac
number is not evidence for the phone's: the desktop's biggest term is a
directory walk the plugin does not do. What changed is the harness. The phone
run the threshold waits on is now `bun run bench:phone`, which holds the
phone awake and in front for the whole run and records any moment it was
not, the confound that voided the last attempt.

## Server releases are held below the plugin's, for BRAT

BRAT, which installs the plugin until the community directory lists it, does
not ask GitHub which release is latest. It ranks every release in this
repository by the version in its tag, server/v0.12.0 as 0.12.0, takes the
later tag on a tie, and installs from the first. A server release at or above
the newest plugin release is therefore the one it opens, and with no
manifest.json in it every BRAT install and update fails, as they did from
server/v0.12.0 until plugin 0.12.1 outranked it.

So `scripts/release.sh` refuses a server version the plugin would not outrank,
its runbook tags the server before a plugin at the same version, and
`scripts/verify-release.sh` checks what BRAT would install from the published
list. The cost is that the server cannot be released ahead of the plugin: a
server fix at a new version takes a plugin release with it.

The fix belongs in BRAT, which should take the newest release that has a
manifest.json, and is proposed to it upstream as
[TfTHacker/obsidian42-brat#227](https://github.com/TfTHacker/obsidian42-brat/pull/227).
Once a BRAT release with that has been out long enough for installs to have
it, remove the guard, the runbook's paragraph on order and the check.

## Settings sync, after its review

Settings sync (M11) had three reviews on 2026-10-10, and these were left on
purpose, each with what would change the answer:

- **A settings save expires an agent's preview.** MCP previews are bound to
  the vault's head, so any device saving a setting between an agent's preview
  and its apply refuses the apply as `plan_changed`, and the agent previews
  again. The fix is to bind previews to the newest uid of a path that is not a
  setting, in the tool and in `CommitOperation`'s snapshot check, keeping the
  exact head for the operator's restore. Worth it once agents meet it often.
  `vault_status`'s store totals, `entries` and `bodies`, include settings
  versions too, and say so in the threat model.
- **No listing finds a deleted setting.** The deleted list, `deleted_notes`
  and `trewd deleted` leave settings out, because they are where somebody
  looks for a lost note; a deleted snippet is found by its history, which
  needs its path. A `-settings` flag on `trewd deleted` would do.
- **Settings shape the Git export's commit timing.** The export leaves their
  content out, but they still go to its planner, so a setting saved between
  two note edits can split one commit or move its time. Skipping them before
  the planner needs the export's position to cover their uids all the same,
  or `doctor` reports the export behind a settings write at the head.
- **The check after a reload compares bytes, and there is no quiet period.**
  Obsidian re-saving a setting with the same values in another byte order
  reads as a change, which costs a second Apply and never a value. Comparing
  parsed values needs the applied bytes after the reload. The plan's ten
  second quiet period before an upload is not built either; every settings
  save is a version, which costs history and nothing else.
- **A profile is copied as it is read.** A settings file Obsidian or a plugin
  is writing at that moment is copied torn, and the new profile starts with
  that plugin's defaults; a large folder copies behind a "Copying" button with
  no count. Reading again a copied JSON file that does not parse, and a count
  as it goes, would do. The copy already leaves out `node_modules` and `.git`,
  which are most of a plugin developer's folder.

## Follow-ups from the 2026-10-06 review

Each was found by the review (docs/findings.md, the T series) and left on
purpose, because closing it costs something the review could not decide alone.

**History pages are bounded by count, not bytes (T57).** Catch-up batches now
stop at the advertised `maxBatchBytes`; history pages do not, because every
client reads a page shorter than its limit as the end of a note's history, so
a page cut by bytes would quietly hide older versions. The fix is a `more`
flag on the history reply that all three clients page on, then a byte bound.
Until then the client's fixed 32 MiB text-frame ceiling (T07) covers default
settings; a server with a lowered `-max-batch-bytes` and very large files can
still produce a page a client refuses, loudly.

**A crash during an in-place text update (T09).** A failed write now puts the
note back, but a crash or power loss in the middle of the write leaves no
record, so after a restart the cut note reads as an edit. Its original content
survives in the backup conflict copy. Closing it needs a durable intent record
per incoming text edit: one append and one clear each.

**A crash during the headless client's replace.** If a crash keeps the note's
move aside but loses the link back, the next pass reads the note as deleted.
The parked copy is reported as stranded, but the deletion is still sent.

**A stale lock after a reboot (T21).** `trew unlock --force` now clears a
record whose pid is running but holds nothing, which is what a pid reused
after a reboot looks like, but it still takes a person. Treating any record
written before the current boot as stale would make it automatic, at the cost
of trusting the boot time.

**Replacing the read-back after the landing rename with a stat (rule 4).** It
would save about 10 ms per new file on a phone. Declined for now: the staging
copy is read back in full, but a same-size write into the name in the same
instant would go unnoticed.

**Skipping the index stats on a quiet pass.** Declined: it would let an index
overwritten from outside go unrewritten until the next change (R3).

**Linux `fs.protected_hardlinks`.** A note owned by another user that holds an
unexpected edit cannot be linked to its conflict-copy name; it stays at a
hidden name, recorded in the ledger and reported by `status`. Nothing is lost.

**The dotless i on NTFS.** The protocol's fold keeps `ı` (U+0131) apart from
`i` and `I`, which NTFS treats as one name. The engine's pass keys now fold
then upper-case, which covers deletions, but two server paths could still be
one file on Windows, which is unsupported.
