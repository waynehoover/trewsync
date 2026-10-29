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

**Measured on a phone, October 22, 2026.** A Pixel 9a downloading a 60 MiB
attachment into a vault in App storage: Obsidian's resident memory (total PSS
from `dumpsys meminfo`, sampled about once a second) rose from 258 to 334 MB
and the file landed in 8 s; a 200 MiB attachment rose from 255 to 325 MB and
landed in 28 s, with Obsidian never restarted. Neither came near a copy and a
half of the file, so streaming the assembly is not worth its risk at the
default limit, nor at four times it on a phone like this one. A once a second
sample can miss a short peak, and a phone with less memory may tell another
story; that is what would reopen this.

**Before changing the default:** the 2.7 MB per MiB in
[store.go](../internal/store/store.go) was measured in Basalt, before the
single-buffer assembly and the windowed sealing (now windowed naming) landed,
so the number the 64 MiB default rests on is no longer true. Measure peak
resident on a phone for one large attachment first.

## A first sync on a Mac waits on fsync

Done for new files on 2026-10-22: the headless client writes a file that
nothing on this device has synced straight to its name and fsyncs the batch
together, behind an intent saved in the index, and a first sync of 3,000 notes
went from 21 to 36 s to 2 to 4 s
([research.md](research.md#writing-new-notes-straight-to-their-names-october-22-2026)).
What remains is the replace of a note already here, which still pays two
`F_FULLFSYNC`s through `NodeVault.replace`; that is an ordinary sync's cost, not
a first sync's, and is left for the same reasons the preserving write's other
steps are. The plugin keeps its staged rename, because Obsidian's mobile
adapter has no exclusive create.

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

**Where the measurement got to.** Two Android data points. At five hundred
notes decide plus comparison was 38.1% of a quiet pass. At ten thousand, on a
Pixel 9a with the vault in App storage
([research.md](research.md#ten-thousand-notes-on-the-phone-october-22-2026)),
it was 65% of a quiet pass that took about 100 ms in all: the first clause
holds at that size and the second does not, by half. Fifty thousand has not
been tried.

So this stays declined. The share is now over the line, but a pass nobody
waits on is the case the second clause exists for, and the size the threshold
names is still unmeasured.

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

- **A settings save expires an agent's preview.** Closed on 2026-10-22: a
  preview is bound to the newest uid that is not a setting, in the tool and in
  `CommitOperation`'s snapshot check, and the operator's restore keeps the
  exact head. The threat model already says `vault_status`'s store totals
  include settings versions.
- **Settings shape the Git export's commit timing.** Closed on 2026-10-22:
  settings are skipped before the planner, and the export's position still
  moves past their uids, so `doctor` does not report it behind a settings
  write at the head.
- **There is no quiet period.** Closed on 2026-10-22: a changed setting is
  sent once it has been unchanged for ten seconds.

## Follow-ups from the 2026-10-06 review

Each was found by the review (docs/findings.md, the T series) and left on
purpose, because closing it costs something the review could not decide alone.

**History pages are bounded by count, not bytes (T57).** Closed on
2026-10-28: a client that asks with `paged` is sent pages cut by bytes too,
with `more` saying whether older versions remain, and fetches the rest of a
page cut short. A client that does not ask, which is every release before the
next plugin and `trew`, is answered by count as before, so a server with a
lowered `-max-batch-bytes` and very large files can still send one of those a
page it refuses, loudly.

**A crash during an in-place text update (T09).** Closed on 2026-10-22: the
plugin writes each in-place update down before it truncates the note, and the
next start puts a note the crash cut short back from its backup, keeps the cut
text in a hidden folder the displaced log names, and sends nothing of it.

**A crash during the headless client's replace.** Closed on 2026-10-22: a
note a crash left parked, between being moved aside and the new version being
linked into its name, is linked back under that name by the next listing while
the name is free, so the pass does the update again rather than reading a
deletion. A name taken since leaves the parked copy reported, as before.

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
