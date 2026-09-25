# Cutover runbook (PLAN.md M10)

The runbook for moving the owner's vault from Basalt to TrewSync, against the setup that exists today. Drafted on 2026-09-22 from `~/code/homelab` (read only), rehearsed end to end on a disposable copy of the real vault on 2026-09-24 ([the rehearsal](#the-rehearsal-2026-09-24)), and rewritten then as ordered stages with commands, expected output, a go/no-go check and the way back at each one.

**Nothing below runs against the live vault, the live Basalt server or the phone without the owner's explicit go-ahead at the time.** The rehearsal is the only part an agent has run, and it touched only copies.

## What exists today

| Piece | Where | Notes |
|---|---|---|
| Basalt server | `basalt` service in `~/code/homelab/docker-compose.yml`, image `ghcr.io/waynehoover/basalt-sync:0.9.1@sha256:dbdebc93...` (deployed 2026-09-22), data `/home/user/basalt/data` (`./basalt/data`) | Loopback `127.0.0.1:3003`; `tailscale serve` terminates TLS at `https://homelab.example.ts.net:3003`. Read-only root, caps dropped, 30 s stop grace. Watchtower disabled for it. |
| Basalt MCP | `basalt-mcp` service, a paired headless client with a plaintext vault copy at `/home/user/basalt-mcp/data/vault`, serving MCP on `127.0.0.1:3010`, `network_mode: host` | A device in its own right: it is settled like any other before the cut. |
| Server backups | The backup service mounts `/home/user/basalt/data` read-only as `/backup-sources/basalt` | Encrypted Basalt data: useful only with the recovery key and a Basalt build. |
| Mac vault | `~/Documents/My Vault` in Obsidian | The primary vault. One of the owner's two devices (confirmed 2026-09-22). |
| Phone | Pixel 9 (Obsidian on Android) | The other device (confirmed 2026-09-22). Has replayed an old tree before (the 2026-09-09 incident in the owner's notes): settle it first and let it converge before anything else. |
| Other writers | `daily-note-log` and `obsidian-headless` are retired (confirmed 2026-09-22). **Found by the rehearsal, not yet confirmed by the owner:** two enabled plugins in the Mac vault can write to it, see [Writers the rehearsal found](#writers-the-rehearsal-found). | The devices, `basalt-mcp`, and whatever those two plugins are driven by. |

## Settled with the owner (2026-09-22)

1. **Other writers:** none beyond the devices and `basalt-mcp`. The rehearsal questions this for the Mac vault; see below.
2. **Devices:** the phone and the Mac. `basalt-mcp` is a third paired client (headless), settled and retired with the rest.
3. **Encryption at rest:** the data volume is not encrypted, and the owner accepts that (threat model S1, accepted risk). TrewSync's data is plaintext where Basalt's was ciphertext, so anyone who can read the homelab's disk can read the notes.
4. **TrewSync backups:** the destination is deferred. M5.5 has since built encrypted backups (`trewd backup` to an age key) and `trewd rehearse`, so the runbook takes one and restores it before the phone moves (stage 6): PLAN M10's done-when needs a TrewSync backup restored, and retiring Basalt waits for it.

## Writers the rehearsal found

Read from the Mac vault's `.obsidian` on 2026-09-24 (the settings files only, nothing written). Both are enabled in `community-plugins.json`:

- **`obsidian-git`**, with a GitHub remote and a commit the same morning. It commits every 30 minutes and pushes every 30, with **pull before push** and the merge sync method. A pull writes into the vault whenever the remote has anything the vault does not, and a merge that conflicts writes conflict markers into notes. That is a second sync path into the same directory, which the scope refuses, and it is a writer the freeze has to stop. The `.git` folder (365 MB, 286 entries) is dot-named, so TrewSync never syncs it, as Basalt never did.
- **`obsidian-local-rest-api`**, serving HTTPS on `127.0.0.1:27124`. Anything holding its key can create and change notes through Obsidian while it runs. Whether anything uses it is the owner's to say; the freeze stops it either way.

Installed but not enabled, and so not writers: `obsidian-livesync`, `supersync` (whose `.supersync-metadata.json` is still at the vault's root, dot-named, never synced) and 29 others.

**Owner decision needed before stage 2:** disable both for the cutover, and afterwards either keep `obsidian-git` with pulls turned off (`pullBeforePush` false, `autoPullInterval` 0: a one-way copy to GitHub, which is then one more plaintext copy of every note, on GitHub) or remove it.

## The rehearsal, 2026-09-24

On the Mac, against copies of `~/Documents/My Vault` taken read-only, a scratch `trewd` on `127.0.0.1:3491`, and headless `trew` clients standing in for the Mac, the phone and the witnesses. The plugin in a scratch Obsidian vault was not used: it runs the same engine, and stage 5's witness check is what proves the plugin's upload on the day. The copies, the scratch server data, the inventories (which hold note names) and the backups were deleted afterwards; only counts are recorded here and in [docs/development.md](../docs/development.md#the-cutover-rehearsal-m10).

**The vault, measured.** 4,446 entries on disk, 542 MB with `.git` and `.obsidian`.

| | Count | Bytes |
|---|---|---|
| Notes (`.md`) | 3,621 | 18,250,088 (17.4 MiB) |
| Attachments (60 JPEG, 39 PDF, 22 PNG, 15 other) | 136 | 66,578,824 |
| Folders | 96 | |
| **Synced, total** | **3,853** | **84,828,912 (80.9 MiB)** |
| Excluded, dot-named (`.git` 286, `.obsidian` 289, 5 `.DS_Store` in folders, 6 empty `.basalt-tmp-*` staging folders Basalt left behind, `.claude`, `.copilot-index`, `.gitignore`, `.supersync-metadata.json`, the root `.DS_Store`) | 593 | |
| Refused for any other reason (length, control characters, NFC, no-break spaces, case collisions, over 64 MiB) | 0 | |

The largest file is 7.2 MiB, the longest path 186 bytes (the limit is 1,024), the deepest six folders down; 13 paths are non-ASCII, all already NFC; one note is empty. 203 notes have frontmatter the server's YAML reader refuses for tags (201 ambiguous, 2 unclosed), exactly the notes Basalt's TypeScript reader refuses too, checked by running both over the witness; their tags are found by scanning instead, and nothing is refused.

**What was run, and the verdicts** (three runs, the last two by `scripts/cutover-rehearsal.sh`; every verdict go in each):

| Step | Result | Time |
|---|---|---|
| The copy, proven entry for entry against the source (excluded entries too), and the source unchanged meanwhile | identical | 2.3 to 2.6 s |
| Upload: the copy paired from `first-invite` | 3,853 entries, 11,469 chunks, 62.6 MiB sent | 40 to 52 s |
| A freshly paired empty witness downloads everything | 3,757 files and 96 folders | 42 to 91 s |
| Witness inventory against the source | **go**: every synced path byte for byte; 593 dot-named explained as excluded, 7 witness-only in `.trew` | |
| Edits after the cut: an append, a Unicode name, an NFD name, a no-break-space name, an empty note, a three-deep nested folder, a 5 MiB attachment, a 2.9 MB note, a file one byte over 64 MiB, a deletion, a nested folder rename; the "phone" offline with an append to the same note, a phone-only edit, an edit inside the folder the Mac renamed, a new note; in the first run also an agent's append through `/mcp` with a write token (a read token's append refused) and the oversized file | every edit's words present on both devices; the shared note merged both appends in place; the offline edit inside the renamed folder kept at its old path beside the renamed copy (an edit is never lost to a delete); the oversized file refused with its size and the limit, and explained as `toolarge` | 1 to 2 s |
| The two devices, then a second fresh witness | **go** both | 44 to 52 s |
| Encrypted backup (`trewd backup -recipients-file`) | 96.5 MiB of ciphertext; no rehearsal phrase in it | 106 to 183 s |
| `trewd rehearse` | every version identical, a fresh device's every note identical, search rebuilt | recovery time 55 to 82 s |
| By hand (first run): `trewd unpack`, `serve` the restore on another port, a `trew` witness from it | 0 faults; **go** against the pre-backup witness | 42 s download |
| Rollback: every change since the cut exported, cross-checked with `trewd restore -to-uid CUT -json` | the same paths exactly: 48 created and 37 changed or deleted in the first run, 18 and 7 in each scripted run | |
| The export applied to the frozen copy, with an edit made there during the window | the conflicting note refused and left holding the old side's edit; everything else **go** against the server's state | |
| `trewd doctor` on the scratch store (first run) | 15 of 16 checks OK (the short-lived rehearsal tokens warned, as they should) | |

Times are the Mac (APFS, a full fsync per file) and loopback. Over Tailscale to the homelab, and on the phone, expect longer; stage 4 and stage 7 record the real ones.

**Findings, and what became of them.**

1. **`trewd invite > invite.txt` then `trew pair --key-file invite.txt` was refused** as "2 invites, one per address", because the sentence `trewd invite` prints before the invite counted as a second one. Fixed in `trew pair` (only lines holding an invite count), with a regression test that fails without the fix (`client/src/node/cli.test.ts`, "takes everything trewd invite printed").
2. **The rollback's dry run disagreed with its own write**: it refused a folder as not empty because it had not counted the files it was about to remove. Fixed in `scripts/vault-inventory.py` before it was committed, with a regression test (`scripts/vault-inventory.test.sh`) shown failing without the fix.
3. **A client's trash is witness-only state**: a device that receives deletions moves the files into `.trash` (rule 3), so the comparison accepts `.trash`, `.trew` and `.obsidian` on the witness and nothing else dot-named; a staging file left behind is a no-go.
4. **The macOS disk folds `ß` to `ss`**: writing `Strasse.md` beside `Straße.md` on APFS overwrote the first. A fold collision therefore cannot come from the Mac at all; the server's `collision` rule is exercised by the Go and TypeScript suites and by the inventory test where the disk keeps both.
5. **The writers above**: not a code bug, a runbook one. The 2026-09-22 draft said there were none.
6. **Leftover `.basalt-tmp-*` folders** (six, empty) in the real vault: harmless and never synced; the owner can remove them after the cut.
7. **Nothing in the real vault is refused** by the server's path rules or its size limit, so no note is stranded by the cut.
8. **The rollback removed the only copy of a case-only rename** (found in review, not by the first rehearsals, which had none). The export records `Note.md` to `note.md` as an add and a delete; on the Mac's disk, which holds both spellings as one file, the add found the old file and called it current, and the delete then removed it (a folder: every file inside, then the folder), with exit 0. Fixed in `scripts/vault-inventory.py`: such a pair is applied as a rename, "already current" needs the exact spelling, and no path is removed while it is the same file as an added one. `apply` also refuses to write or remove through a link. Regression tests in `scripts/vault-inventory.test.sh`, shown failing without the fix; `scripts/cutover-rehearsal.sh` now makes case-only renames of a folder, a note and an edited note in step 4, and its step 7 was NO-GO without the fix.
9. **A case-only folder rename is not respelled on the other device** (a synthetic run of the rehearsal, 2026-09-24): the offline "phone" kept the folder's files under the old spelling while the server and a fresh witness hold the new one. No words are lost, but step 5 reports the two devices as not converged. Open, in the clients; until it is fixed, the rehearsal's step 5 is expected to say NO-GO for this one check, and a case-only folder rename during the window is checked by hand on each device.

## The tools

On the Mac, in a TrewSync checkout at the approved commit (`~/code/gabbro`):

```bash
cd ~/code/gabbro
alias inv='uv run --no-project --python 3.13 scripts/vault-inventory.py'
mkdir -m 700 -p ~/trew-cutover        # private: inventories name every note
go build -o ~/trew-cutover/trewd ./cmd/trewd
(cd client && bun install --frozen-lockfile && node esbuild.config.mjs production)
alias trew='node ~/code/gabbro/client/dist/trew.mjs'
```

- `inv inventory DIR -o FILE`: every entry's normalised path, kind, size and SHA-256, and why each excluded one is excluded. Only reads.
- `inv compare SOURCE.inv WITNESS.inv`: ends `go:` and exits 0, or lists each unexplained difference by class and exits 1 (`--paths` names them, privately).
- `inv snapshot VAULT NEW_DIR -o FILE`: a copy proven entry for entry, excluded entries included, and the source listed again after.
- `inv changes FROZEN.inv CURRENT.inv --from DIR --to NEW_DIR`: what changed after the cut, exported.
- `inv apply EXPORT VAULT [--apply]`: put an export into a vault as it was at the freeze; refuses, per path, anything changed there since. A dry run without `--apply`.
- `scripts/cutover-rehearsal.sh VAULT`: the whole rehearsal above, on a fresh copy, in about ten minutes; ends `GO: every verdict passed`.

`~/trew-cutover` holds note names and, later, copies of notes. It is not a vault and not in any repository; it is removed at [stage 10](#stage-10-retire-basalt).

## Stage 0: approvals and prerequisites

The owner approves, in writing (a note in the vault is fine, made after the cut):

1. **The build.** A TrewSync commit that `scripts/check.sh` passes (exit 0) and CI passes for that exact commit, and the image built from it. No `trewd` image is published yet (M9 configured the release, nothing is released): either publish one (`scripts/release.sh --prepare`, [docs/development.md](../docs/development.md#releases)) and pin it by digest, or build it on the homelab from the checkout at that commit (`docker build -t trewd:COMMIT .`). The plugin's three files (`main.js`, `manifest.json`, `styles.css`) from the same commit.
2. **The address.** TrewSync on `127.0.0.1:3005` behind `tailscale serve` at `https://homelab.example.ts.net:3005` for verification, moving to `:3003` only at stage 10 (or staying on `:3005`, and the invites say so).
3. **The rollback window and who owns edits in it** (the owner; suggested: 14 days, and until stage 10's evidence exists, whichever is later).
4. **The two plugin writers** above: disabled for the cutover, and what becomes of `obsidian-git` afterwards.
5. **The backup key's custody**: the identity `trewd backup-key` writes lives in the password manager and one more place, never on the homelab.

Then, on the day, rehearse once more on that day's vault:

```bash
scripts/cutover-rehearsal.sh "$HOME/Documents/My Vault"
```

**Go if** it ends `GO: every verdict passed`, with 0 refused beyond `dotprefix` in its first summary. **Way back:** nothing has changed.

## Stage 1: settle every device against Basalt, the phone first

1. **Phone.** Open Obsidian, open the Basalt panel, and wait until it reports nothing pending, with no conflict copies (`(Conflicted copy` in a name) left unresolved. Resolve any by hand, then wait again. Leave it open until it has been settled for a few minutes, then close Obsidian (swipe it away) and leave it closed.
2. **Mac.** The same in the Basalt panel.
3. **`basalt-mcp`.** Make sure no agent is using it (`docker compose logs --tail 50 basalt-mcp` shows no recent tool calls), then leave it until stage 2 stops it.
4. **Evidence: every device holds the same notes.**

   ```bash
   inv inventory "$HOME/Documents/My Vault" -o ~/trew-cutover/mac-settled.inv
   # The phone, copied off it read-only (USB debugging on; the path is where Obsidian keeps the vault):
   adb pull "/storage/emulated/0/Documents/My Vault" ~/trew-cutover/phone-settled
   inv inventory ~/trew-cutover/phone-settled -o ~/trew-cutover/phone-settled.inv
   inv compare ~/trew-cutover/mac-settled.inv ~/trew-cutover/phone-settled.inv
   # basalt-mcp's plaintext copy, read-only from the homelab:
   rsync -a homelab:/home/user/basalt-mcp/data/vault/ ~/trew-cutover/mcp-settled/
   inv inventory ~/trew-cutover/mcp-settled -o ~/trew-cutover/mcp-settled.inv
   inv compare ~/trew-cutover/mac-settled.inv ~/trew-cutover/mcp-settled.inv
   ```

   Expect each compare to end `go:`. The phone and `basalt-mcp` hold no `.git`; that is an excluded entry, explained, not a failure.

**Go if** both compares say go. **No-go:** a FAIL line names a class (`missing on the witness`, `different on the witness`, `on the witness only`): that device is not settled, or holds an older tree. Open it, let it sync, and take its inventory again; `--paths` names the paths. A device that cannot settle is frozen as it is (keep its copy) and rejoins later from an empty vault, never with its old tree. **Way back:** nothing has changed.

## Stage 2: freeze and capture

1. **Stop every writer.** On the Mac, in Obsidian: disable `obsidian-git` and `Local REST API` (Settings, Community plugins), then quit Obsidian. The phone stays closed. On the homelab (after the drift check in stage 3, if it deploys at the same time): `docker compose stop basalt-mcp`.
2. **The Basalt server backup, verified**, on the homelab:

   ```bash
   cd ~
   sudo install -d -m 700 -o 65532 -g 65532 /srv/basalt-backups
   docker compose run --rm --no-deps -v /srv/basalt-backups:/backup basalt backup -to /backup/cutover-$(date +%F)
   docker compose run --rm --no-deps -v /srv/basalt-backups:/backup basalt verify -deep -data /backup/cutover-$(date +%F)
   docker image inspect --format '{{index .RepoDigests 0}}' ghcr.io/waynehoover/basalt-sync:0.9.1
   ```

   Expect verify to finish with no faults, and the digest to be `sha256:dbdebc93...`.
3. **Stop the Basalt server**, so no device can write to it by accident from here on: `docker compose stop basalt`. (It is started again only by the way back.)
4. **The readable snapshot of the Mac vault, proven**, on the Mac:

   ```bash
   inv snapshot "$HOME/Documents/My Vault" ~/trew-cutover/frozen-vault -o ~/trew-cutover/frozen.inv
   inv compare ~/trew-cutover/mac-settled.inv ~/trew-cutover/frozen.inv
   ```

   Expect `ok ... holds every entry of ..., excluded ones included`, then `go:`.
5. **Archive together**, off the homelab: the verified Basalt backup directory, the Basalt recovery key (from the password manager), the image digest, `frozen-vault` and `frozen.inv`. Write down the rollback window and that the owner owns edits made in it.

**Go if** verify shows no faults, the snapshot says ok, and the compare says go. **Way back:** `docker compose start basalt basalt-mcp`, open Obsidian, re-enable the two plugins. Nothing else changed.

## Stage 3: deploy TrewSync on an isolated address

On the homelab, following the homelab repo's drift rule (compare the local and remote compose files, md5, before deploying). Add beside the Basalt services, which stay stopped and untouched:

```yaml
  trew:
    image: IMAGE@sha256:DIGEST        # the build approved at stage 0
    container_name: trew
    ports:
      - "127.0.0.1:3005:3003"
    volumes:
      - /home/user/trew/data:/data
      - /home/user/trew/backups:/backups
      - /home/user/trew/backup-key.pub:/backup-key.pub:ro
    command: ["serve", "-addr", "0.0.0.0:3003", "-mcp", "-url", "wss://homelab.example.ts.net:3005"]
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    stop_grace_period: 30s
    labels:
      - "com.centurylinklabs.watchtower.enable=false"
    logging:
      driver: json-file
      options: {max-size: "10m", max-file: "3"}
    restart: unless-stopped
```

```bash
sudo install -d -m 700 -o 65532 -g 65532 /home/user/trew/data /home/user/trew/backups
# On the Mac, once: the backup key. Keep the identity; send only the .pub.
~/trew-cutover/trewd backup-key -out ~/trew-cutover/trew-backup-key
scp ~/trew-cutover/trew-backup-key.pub homelab:/home/user/trew/backup-key.pub
# On the homelab:
docker compose up -d trew
tailscale serve --bg --https=3005 http://127.0.0.1:3005
docker compose exec trew /trewd doctor -accept encryption
curl -s https://homelab.example.ts.net:3005/health
```

Expect `doctor` to fail nothing but `backup` and `rehearsal` (nothing recorded yet) and `devices` to show none; `/health` to answer `ok`.

**Go if** so. **Way back:** `docker compose rm -sf trew`, `tailscale serve --https=3005 off`; Basalt is untouched and still frozen.

## Stage 4: remove the old writer from the Mac, then pair TrewSync

The two plugin ids differ, so both could sit installed at once, the one arrangement the scope refuses. Remove Basalt's first.

1. Open Obsidian (the Basalt server is stopped, so its plugin cannot sync). Settings, Community plugins: disable **Basalt Sync**, then uninstall it. Quit Obsidian.
2. Check it is gone and nothing else moved:

   ```bash
   ls "$HOME/Documents/My Vault/.obsidian/plugins" | grep -c basalt       # 0
   grep -c basalt-sync "$HOME/Documents/My Vault/.obsidian/community-plugins.json"   # 0
   inv inventory "$HOME/Documents/My Vault" -o ~/trew-cutover/mac-before-pair.inv
   inv compare ~/trew-cutover/frozen.inv ~/trew-cutover/mac-before-pair.inv          # go:
   ```

3. Install the TrewSync plugin (the three files into `.obsidian/plugins/trew-sync/`, or BRAT), open Obsidian, enable it.
4. Make the first invite on the homelab and pair the Mac with it:

   ```bash
   docker compose exec trew /trewd invite -url wss://homelab.example.ts.net:3005
   ```

   Paste the `trew1i_` line into the TrewSync panel's **Invite**, check the server it names, press **Pair**. Wait until the panel reports nothing pending. **Do not edit any note until stage 5 passes.**
5. Check the server holds what the Mac sent:

   ```bash
   docker compose exec trew /trewd stats
   ```

   Expect `newest uid 3853` and `3853 versions in all` (the rehearsal's count: the synced total in `frozen.inv`'s summary on the day), and the panel's list of notes that cannot sync to be empty. Note how long the upload took.

**Go if** the counts match and nothing is stranded. **No-go:** a stranded path names its reason; stop and fix it (rename it through Obsidian and let it sync) before stage 5. **Way back:** disable and uninstall TrewSync; check `inv compare frozen.inv` against a new inventory says go; reinstall Basalt Sync from the archive (same version); `docker compose start basalt`. The Mac vault never changed.

## Stage 5: the witness

```bash
mkdir -m 700 ~/trew-cutover/witness && cd ~/trew-cutover/witness
ssh homelab 'cd ~ && docker compose exec -T trew /trewd invite -url wss://homelab.example.ts.net:3005' > ../witness.invite
trew pair --key-file ../witness.invite --device witness
time trew sync
cd ~/code/gabbro
inv inventory ~/trew-cutover/witness -o ~/trew-cutover/witness.inv
inv compare ~/trew-cutover/frozen.inv ~/trew-cutover/witness.inv
ssh homelab 'cd ~ && docker compose exec -T trew /trewd stats'    # record the newest uid as CUT
```

Expect the compare to end `go: the witness holds every synced path of the source, byte for byte`, with `explained 593 excluded: dotprefix` (the day's count) and the witness's own `.trew` state; nothing under FAIL. Record `CUT`, the newest uid now: the rollback's reference.

**Go if** go. Then `trew unlink`, revoke the witness (`trewd devices`, `trewd revoke ID`) and remove `~/trew-cutover/witness`. Editing on the Mac may resume. **No-go:** every FAIL is a bug, not an exclusion; stop, keep the witness and the server as they are, and take the way back of stage 4.

## Stage 6: a TrewSync backup, restored by hand

Before the phone moves (PLAN: nothing touches the other device before the recovery path is exercised).

```bash
# On the homelab:
docker compose exec trew /trewd backup -to /backups/trew-$(date +%F).tar.age -recipients-file /backup-key.pub
# On the Mac: bring it over, and restore it where no device can reach it.
scp homelab:/home/user/trew/backups/trew-$(date +%F).tar.age ~/trew-cutover/
~/trew-cutover/trewd unpack -from ~/trew-cutover/trew-$(date +%F).tar.age -identity ~/trew-cutover/trew-backup-key -to ~/trew-cutover/restored
~/trew-cutover/trewd serve -data ~/trew-cutover/restored -localhost -addr 127.0.0.1:3480 & SERVER=$!
~/trew-cutover/trewd invite -data ~/trew-cutover/restored -url ws://127.0.0.1:3480 -out ~/trew-cutover/restore.invite
mkdir -m 700 ~/trew-cutover/restore-witness && (cd ~/trew-cutover/restore-witness && trew pair --key-file ../restore.invite && trew sync)
inv inventory ~/trew-cutover/restore-witness -o ~/trew-cutover/restore-witness.inv
inv compare ~/trew-cutover/frozen.inv ~/trew-cutover/restore-witness.inv
kill $SERVER; rm -rf ~/trew-cutover/restored ~/trew-cutover/restore-witness
```

Expect `unpack` to end `0 faults` and the compare to say go (if the Mac was edited since stage 5, compare against a fresh stage 5 witness instead of `frozen.inv`). `docker compose exec trew /trewd rehearse -backup /backups/... -identity ...` is the automated form, and needs the identity on the homelab while it runs; the rehearsal ran it on the copy.

**Go if** go. **Way back:** nothing changed; stage 4's way back still applies.

## Stage 7: migrate the phone

1. **Its verified local backup** is `~/trew-cutover/phone-settled` from stage 1, which matched the Mac. The phone has been closed since, so it still holds that.
2. Open Obsidian on the phone (Basalt's server is stopped). Settings, Community plugins: disable and uninstall **Basalt Sync**. Confirm nothing else syncs that folder (no Syncthing, Drive or other sync app pointed at it), and `adb shell ls "/storage/emulated/0/Documents/My Vault/.obsidian/plugins"` shows no `basalt-sync`.
3. Install the TrewSync plugin; on the Mac, **Add another device, Create invite**; paste it on the phone; pair. The phone's notes equal the server's, so its first sync should upload and download nothing and make no conflict copy. If it names a stranded path, stop.
4. Evidence:

   ```bash
   adb pull "/storage/emulated/0/Documents/My Vault" ~/trew-cutover/phone-after
   inv inventory ~/trew-cutover/phone-after -o ~/trew-cutover/phone-after.inv
   inv compare ~/trew-cutover/witness.inv ~/trew-cutover/phone-after.inv   # or a fresh witness, if notes changed since
   find ~/trew-cutover/phone-after -name '*Conflicted copy*' | wc -l       # 0
   ```

5. **Exercise it** (PLAN M10 step 5), each with its outcome checked on the other device: airplane mode, edit a scratch note on the phone and a different one on the Mac, reconnect, both arrive; edit the same scratch note on both while the phone is offline, and both edits survive (merged, or in a conflict copy named after the phone); delete a scratch note and restore it from the panel's deleted notes; the agent's conditional undo is stage 8.

**Go if** the compare says go, no conflict copies appeared at pairing, and each exercise's words are on both devices. **Way back:** the [rollback](#the-way-back-after-the-cut).

## Stage 8: the agent endpoint

```bash
docker compose exec trew /trewd mcp-token -label claude-read        # read scope, the default
```

Point the agent at `https://homelab.example.ts.net:3005/mcp` with that bearer token and check a `read_note` and a `search_notes` answer. Only later, deliberately: `-scope write -label claude-write`, and then the conditional undo: have the agent append to a scratch note, `trewd audit -since 1h` names the operation, `trewd undo OPID` puts it back; edit the note on the Mac after another agent append and `trewd undo` refuses, naming the Mac. Retire `basalt-mcp` only now (`docker compose rm -sf basalt-mcp` and its route), since it has been stopped since stage 2.

**Go if** each outcome is as described. **Way back:** `trewd mcp-token -revoke ID`.

## Stage 9: the window

Each day of the window: `docker compose exec trew /trewd doctor` (no FAIL), a nightly `trewd backup` (a timer or cron on the homelab), and the devices' panels. Keep Basalt stopped and its archive untouched.

## Stage 10: retire Basalt

Only on evidence, not elapsed time: a TrewSync backup restored (stage 6), both devices' inventories matching (stages 5 and 7), the rollback window over and not needed, and the owner's recorded acceptance. Then: remove the `basalt` and `basalt-mcp` services and the second MCP route; move TrewSync to `:3003` if wanted (new invites name the new address; paired devices keep working only if their configured URL still answers, so re-pair or leave it on `:3005`); move the homelab backup source from `/home/user/basalt/data` to `/home/user/trew/data` and the encrypted archives; keep the digest pin and Watchtower opt-out; update the compose comments and the homelab README. Keep the Basalt archive (backup, recovery key, image digest, frozen snapshot) under an explicit policy, and remove `~/trew-cutover` (it holds note names and copies).

## The way back after the cut

At any stage from 4 on, if validation fails (PLAN M10 step 6). The frozen snapshot is the directory Basalt knows; the Mac's TrewSync vault is not, and the old plugin is never pointed at it.

1. **Stop new writers.** Quit Obsidian on both devices; `trewd mcp-token -list`, then `-revoke` each.
2. **Preserve the TrewSync server.** Leave it running for the export, take `trewd backup`, and never delete its data directory until the reconciliation is done.
3. **Export what changed since the cut**, from a fresh witness (stage 5's commands, into `~/trew-cutover/current`):

   ```bash
   inv inventory ~/trew-cutover/current -o ~/trew-cutover/current.inv
   inv changes ~/trew-cutover/frozen.inv ~/trew-cutover/current.inv --from ~/trew-cutover/current --to ~/trew-cutover/rollback-export
   ssh homelab "cd ~ && docker compose exec -T trew /trewd restore -to-uid CUT -json" > ~/trew-cutover/since-cut.json
   ```

   The export's added count must equal the dry run's `remove` and `remove_folder` steps, and its modified and deleted counts its `restore` steps; the rehearsal checked the paths themselves, and `scripts/cutover-rehearsal.sh` shows how.
4. **Put the frozen vault back** where Obsidian expects it, keeping the TrewSync-era one: `mv "$HOME/Documents/My Vault" "$HOME/Documents/My Vault (TrewSync)"` and `inv snapshot ~/trew-cutover/frozen-vault "$HOME/Documents/My Vault" -o ~/trew-cutover/restored.inv` (its `.obsidian` holds the Basalt plugin and its state as they were at the freeze).
5. **Apply the export**, with Obsidian quit: `inv apply ~/trew-cutover/rollback-export "$HOME/Documents/My Vault"` (a dry run), then again with `--apply`. A REFUSED line means that path changed on the Basalt side during the window as well: reconcile it by hand from the two versions (the export's copy and the vault's). A rename that changed only the case of a name (`Note.md` to `note.md`, or a folder) is applied as a rename, since the Mac's disk holds both spellings as one file; `apply` never removes a path that is the same file as one it added, and never writes through a link.
6. **Verify the vault before Basalt sees it**, with Obsidian and Basalt still stopped: `inv inventory "$HOME/Documents/My Vault" -o ~/trew-cutover/rolled.inv` and `inv compare ~/trew-cutover/rolled.inv ~/trew-cutover/current.inv --paths`. **Go if** it says go, or its only FAIL lines name the paths reconciled by hand in step 5. **No-go:** any other FAIL (above all `missing on the witness`) means the vault does not hold the server's state: stop, keep Basalt stopped, and restore the missing paths from `rollback-export/files` or `My Vault (TrewSync)` before going on. Basalt uploads whatever it finds, a loss included, to every device, so this check comes first.
7. **Bring Basalt back:** `docker compose start basalt`, open Obsidian on the Mac; Basalt uploads the applied changes as ordinary edits made while it was closed. Re-enable the two plugins if wanted. The phone: uninstall TrewSync, and rejoin Basalt from an empty vault (its old tree does not rejoin).
8. **Verify again from Basalt's side:** a Basalt witness (a new empty vault paired with Basalt) inventoried and compared with `current.inv` says go, apart from the paths reconciled by hand.

The rehearsal ran steps 3 to 6 and 8's comparison on copies: the export matched the server's own list exactly, a note changed on both sides was refused and left as the old side had it, and case-only renames of a folder, a note and an edited note came back under the new spelling.
