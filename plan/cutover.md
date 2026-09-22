# Cutover runbook (draft for PLAN.md M10)

A concrete version of M10 against the setup that exists today, drafted on 2026-09-22 from `~/code/homelab` (read only). **Nothing here runs against the live vault or the live Basalt server without the owner's explicit go-ahead at the time**, and nothing runs at all before M5.5 has exercised the recovery path (PLAN §6: M5.5 gates M10).

## What exists today

| Piece | Where | Notes |
|---|---|---|
| Basalt server | `basalt` service in `~/code/homelab/docker-compose.yml`, image `ghcr.io/waynehoover/basalt-sync:0.9.0@sha256:4718...`, data `/home/user/basalt/data` (`./basalt/data`) | Loopback `127.0.0.1:3003`; `tailscale serve` terminates TLS at `https://homelab.example.ts.net:3003`. Read-only root, caps dropped, 30 s stop grace. Watchtower disabled for it. |
| Basalt MCP | `basalt-mcp` service, a paired headless client with a plaintext vault copy at `./basalt-mcp/data/vault`, serving MCP on `127.0.0.1:3010`, `network_mode: host` | A device in its own right: it has to be settled like any other before the cut. |
| Server backups | The backup service mounts `/home/user/basalt/data` read-only as `/backup-sources/basalt` | Encrypted Basalt data: useful only with the recovery key and a Basalt build. |
| Mac vault | `~/Documents/My Vault` in Obsidian | The primary vault. One of the owner's two devices (confirmed 2026-09-22). |
| Phone | Pixel 9 (Obsidian on Android) | The other device (confirmed 2026-09-22). Has replayed an old tree before (the 2026-09-09 incident in the owner's notes): settle it first and let it converge before anything else. |
| Other writers | None. `daily-note-log` and `obsidian-headless` are retired (confirmed 2026-09-22); `deploy.sh`, the homelab README and the dashboard were updated to match. | The only writers are the two devices and `basalt-mcp`. |

## Settled with the owner (2026-09-22)

1. **Other writers:** none. `daily-note-log` and `obsidian-headless` no longer run.
2. **Devices:** the phone and the Mac. `basalt-mcp` is a third paired client (headless), settled and retired with the rest.
3. **Encryption at rest:** the data volume is not encrypted, and the owner accepts that (threat model S1, accepted risk). Telimus's data is plaintext where Basalt's was ciphertext, so anyone who can read the homelab's disk can read the notes.
4. **Telimus backups:** deferred. The cutover's own way back still stands: the verified Basalt backup (already covered by the homelab's backup job) and the readable snapshot of the Mac vault in step 3.

## The procedure

Each step names what proves it. A step without evidence has not happened (rule 11).

1. **Rehearse on a disposable copy first.** Copy the Mac vault's readable content (not the Basalt server data, which Telimus cannot read) to a scratch directory. Run a Telimus server on a scratch port with scratch data. Pair two scratch vaults and one headless client. Exercise attachments, large notes, nested renames, deleted notes, conflict copies, Unicode names, a device offline with edits, and the M5.5 restore. *Evidence:* the witness inventory below matches, and the restore rehearsal passes, on the copy.
2. **Settle every device against Basalt.** Bring each device online; account for local-only changes and conflicts; wait for each to report nothing pending. The phone first, and let it converge. *Evidence:* every device's Basalt status reads settled, and the inventory of each device's vault matches the Mac's.
3. **Freeze and capture.** Stop the writers (close Obsidian on each device, stop `basalt-mcp`). Take and verify a Basalt server backup (`basaltd backup` then `verify`) and a snapshot of the Mac vault's readable content (a plain copy, verified by the inventory). Archive the backup, the recovery key and a Basalt 0.9.0 image digest together. Record the rollback window and who owns edits made during it. *Evidence:* both verifications pass; the snapshot's inventory equals the settled one.
4. **Disable the old writer per directory before enabling the new one.** Disable and remove the Basalt plugin from each vault before installing Telimus's (the two plugin ids differ, so both could otherwise sit installed, the one arrangement the scope refuses). Deploy Telimus on an isolated address first (not `:3003`). Pair the Mac, let it upload, then pair a **freshly created empty witness vault** and compare. *Evidence:* the witness inventory equals the snapshot's, path for path.
5. **Migrate the phone** from a verified local backup against the reconciled inventory, after removing its Basalt plugin. Confirm no two sync systems share its vault directory. Exercise an offline edit, catch-up, delete and restore, and a conditional undo. *Evidence:* the phone's inventory matches.
6. **Agent endpoint.** Start `--mcp`; issue a **read** token first and point the agent at it; issue a write token deliberately and separately, later. Retire `basalt-mcp` only after the Telimus MCP answers.
7. **If validation fails:** stop new writers, preserve the Telimus server, export post-cutover changes (`telimus export`), and reconcile against the frozen Basalt baseline. Do not point the old plugin at a changed directory.
8. **Retire on evidence, not elapsed time.** Basalt's services and data go only after a Telimus backup has been restored successfully, every device passes the inventory check, and the rollback is no longer needed. Keep the Basalt archive under an explicit policy.
9. **Homelab bookkeeping.** Replace the `basalt` and `basalt-mcp` services with one `telimus` service (PLAN §3.5), keep the digest pin and the Watchtower opt-out, update the comments, remove the second MCP route, and move the backup source from `/home/user/basalt/data` to Telimus's data directory. Follow the homelab repo's drift rule: compare the local and remote compose files before deploying.

## The witness inventory

The comparison that proves a migration, because equal counts do not prove equal paths or bytes (PLAN §2.8). For each vault: every file's normalized path (NFC, as Obsidian names it), kind (note, attachment, folder), size and SHA-256, sorted by path; dot-prefixed paths listed separately as **excluded on purpose** (they never sync), and compared explicitly rather than assumed. Two inventories match when every line is equal. A tool for this belongs in the headless client (`telimus-sync inventory`), so the same code produces it on every device; until it exists, a short script over the directory is acceptable if it applies the same normalization.
