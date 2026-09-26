# Keep a Git history of your vault

[Documentation](index.md) · [Server reference](server-reference.md#git-export) · [Operating TrewSync](operations.md)

The server can keep a Git repository of your vault and push it to a private
repository you own, on GitHub or anywhere else that speaks Git over SSH or
HTTPS. You get an offsite copy in a format every tool reads: `git log -p` for
what changed, blame, diffs between any two days, and a copy that outlives
TrewSync itself.

It goes one way. The server writes the repository from the notes it stores and
never reads anything back: nothing you commit, push or edit in a clone reaches
your vault, and a change made to the repository or the remote behind the
server's back stops the export and is reported, never "fixed". Keep editing in
Obsidian. The server's store stays the vault's only source of truth, and the
export can never delay or refuse a device's write or an agent's.

## Read this first: the history is plaintext, for good

- **Whoever hosts the remote reads every note**, every earlier version, and
  every note you ever deleted. A private GitHub repository is private from
  other people, not from GitHub.
- **`trewd purge` cannot remove anything from it.** Purge drops old versions
  from the server; the Git history still has them. Taking a note out of Git
  history means rewriting it by hand, and the export will then refuse to push
  over the rewritten branch (see [When something goes wrong](#when-something-goes-wrong)).
- **Attachments over 10 MiB go to Git LFS, and LFS objects cannot be purged**
  short of deleting the whole repository. On GitHub's free plan LFS gives you
  **1 GiB of storage and 1 GiB of bandwidth a month**; every version of every
  large attachment counts against the storage, and every clone or `git lfs
  pull` against the bandwidth. A 12 MiB recording edited ten times is 120 MiB.
  Raise the threshold (or set it to 0 to keep everything out of LFS) if that
  matters more than repository size, and see GitHub's
  [LFS billing](https://docs.github.com/billing/managing-billing-for-git-large-file-storage/about-billing-for-git-large-file-storage)
  for the current numbers.
- **Anyone with the deploy key or token can write to that repository.** Give
  the export a credential for that one repository and nothing else.

[Security and privacy](security.md#the-git-export) says the same for the rest
of the server.

## What goes into the repository

- **One commit per agent operation.** An agent's `edit_note` or `move_note`,
  an undo and a `trewd restore` are each one commit, authored by the token's
  label, with trailers naming it: `Trew-Operation`, `Trew-Tool`, `Trew-Actor`
  and `Trew-Actor-Kind`.
- **A device's edits, coalesced.** Obsidian saves every couple of seconds
  while you type; the export commits a device's versions together once that
  device has been quiet for the window (5 minutes by default), authored by the
  device's name, with a `Trew-Device` trailer.
- **Dated by the server**, when it committed the versions, never by a device's
  clock.
- **The files as they are.** A deleted note is absent from the next commit; a
  rename is a deletion and an addition that Git shows as a rename. Conflict
  copies are included, like any other note. Empty folders are not, because Git
  has no empty folders. Nothing whose name starts with a dot is ever synced,
  so `.obsidian/` and other plugins' settings never reach the repository.
- **Large attachments in Git LFS.** A file over the threshold is an LFS pointer
  in the tree and its bytes are uploaded to the remote's LFS store. The export
  writes a `.gitattributes` at the root naming each one, so a clone with
  git-lfs installed checks out the real files.

Every commit also carries `Trew-Versions`, the server's version numbers it
covers, which `trewd history` and `trewd cat -uid` understand.

## Set it up with GitHub and a deploy key

A deploy key is an SSH key that can reach exactly one repository. It is the
recommended credential: nothing else on your account is exposed if it leaks,
and GitHub supports LFS over it.

These steps run on the server's host. With Docker, run the `trewd` commands
as `docker compose exec trew /trewd ...` and keep the key inside the data
volume, owned by the container's user (uid 65532).

1. **Make an empty private repository**, with no README, licence or
   `.gitignore` (the export refuses a branch it did not make; to continue a
   branch that already has your backups, such as the Obsidian Git plugin's,
   see [Continue an existing backup branch](#continue-an-existing-backup-branch)):

   ```bash
   gh repo create you/vault-history --private
   ```

   Or on github.com: New repository, Private, and leave every "Initialize"
   box unticked.

2. **Make a key pair for it**, with no passphrase (the server runs
   unattended), somewhere only the server's user can read:

   ```bash
   mkdir -p ~/.trew-keys && chmod 700 ~/.trew-keys
   ssh-keygen -t ed25519 -N '' -C 'trewsync git export' -f ~/.trew-keys/vault-history
   ```

   For Docker, put it in the volume instead, for example
   `./trew/data/keys/vault-history`, and `chown 65532:65532` it. The private
   half must be mode 0600: the server refuses a key anyone else can read.

3. **Add the public half as a deploy key with write access:**

   ```bash
   gh repo deploy-key add ~/.trew-keys/vault-history.pub --repo you/vault-history \
     --allow-write --title "trewsync"
   ```

   Or on github.com: the repository's Settings, Deploy keys, Add deploy key,
   paste `vault-history.pub`, and tick **Allow write access**.

4. **LFS needs nothing switched on.** GitHub accepts LFS uploads for every
   repository; check your quota under Settings, Billing and plans, if large
   attachments are in the vault.

5. **Point the server at it.** This works with the server running, which takes
   the settings up at once:

   ```bash
   trewd git-export set -remote git@github.com:you/vault-history.git \
     -key ~/.trew-keys/vault-history
   ```

   The server checks github.com's host key against GitHub's published keys,
   which it carries; for another host give `-known-hosts FILE`, below.

6. **Watch it happen.** The first commit is made once your devices have been
   quiet for the window, and pushed straight after:

   ```bash
   trewd git-export status
   trewd doctor
   ```

7. **Read it** from anywhere with access to the repository:

   ```bash
   git clone git@github.com:you/vault-history.git
   cd vault-history && git lfs pull
   git log --stat
   ```

## Or HTTPS with a fine-grained token

If SSH out of the server is blocked, a fine-grained personal access token
limited to the one repository works instead:

1. On github.com: Settings, Developer settings, Personal access tokens,
   Fine-grained tokens, Generate new token. **Repository access: Only select
   repositories**, and pick `you/vault-history`. **Permissions: Contents, Read
   and write** (Metadata read-only comes with it). Give it an expiry you will
   notice, and note the date: the push fails when it lapses, and doctor says
   so.
2. Save it to a file only the server's user can read:

   ```bash
   umask 077 && printf '%s\n' 'github_pat_...' > ~/.trew-keys/vault-history.token
   ```

3. Point the server at it:

   ```bash
   trewd git-export set -remote https://github.com/you/vault-history.git \
     -token ~/.trew-keys/vault-history.token
   ```

The configuration names the file, never the token. The server reads it only
when Git asks for it, and it never appears in a log, an error, the audit or
doctor's output.

## Another host, or no remote at all

For an SSH host other than github.com, give the host's key in a known_hosts
file, checked against the fingerprint its operator publishes:

```bash
ssh-keyscan git.example.com > ~/.trew-keys/known_hosts
ssh-keygen -lf ~/.trew-keys/known_hosts   # compare with the published fingerprint
trewd git-export set -remote git@git.example.com:you/vault-history.git \
  -key ~/.trew-keys/vault-history -known-hosts ~/.trew-keys/known_hosts
```

With no `-remote` (or `-local` later), the export keeps the repository on the
server only, at `git-export/repo.git` in the data directory. Clone it from
there: `git clone /path/to/data/git-export/repo.git`.

## Settings

`trewd git-export set` writes the `git_export` section of the server's
[configuration file](server-reference.md#configuration-file). Each flag given
replaces that setting and the rest are kept; `trewd config set
git_export.KEY VALUE` changes one at a time. A `trewd serve` flag of the same
name wins over the file for as long as that server runs.

| `set` flag | Key | Default | Meaning |
|---|---|---|---|
| `-remote` | `git_export.remote` | None: local only | `git@host:owner/repo.git`, `ssh://`, `https://` or `file:///`. |
| `-key` | `git_export.key` | None | Path to the SSH deploy key's private half, mode 0600. |
| `-token` | `git_export.token` | None | Path to a file holding an HTTPS token, mode 0600. |
| `-known-hosts` | `git_export.known_hosts` | GitHub's published keys | Path to a known_hosts file for an SSH remote. |
| `-branch` | `git_export.branch` | `main` | The branch the export writes and pushes. |
| `-lfs-threshold` | `git_export.lfs_threshold` | 10 MiB | Files larger than this go to Git LFS; `0` never uses LFS. |
| `-quiet` | `git_export.quiet` | `5m` | How long a device must stop writing before its versions are committed. |
| `-local` | | | Clear the remote and its credential. |

`trewd git-export disable` turns it off and keeps the settings;
`trewd git-export set` with no flags turns it on again. `trewd git-export
adopt` continues a branch that already has history
([below](#continue-an-existing-backup-branch)); it writes
`git_export.adopted`, which `trewd config set` does not.

The server needs `git` 2.36 or later and, for a remote with files over the
threshold, `git-lfs` 3.0 or later, with `ssh` for an SSH remote. The container
image and the Nix package carry all three; Homebrew installs git-lfs; on
another Linux install them from your distribution (Debian 12 and Ubuntu 24.04
are new enough). Without them the server still serves every device and doctor
says what is missing.

## Replacing the Obsidian Git plugin

The export does what the Obsidian Git plugin did for backups, from the server,
for every device at once, without a merge in your vault and without the risk of
committing `.obsidian/`. To move over:

1. On every device, in Obsidian: Settings, Community plugins, turn **Obsidian
   Git** off and uninstall it. Leaving it on means two things committing the
   same notes, and it may pull a remote's changes into the vault.
2. Set the export up as above, into a **new** repository or a new branch of
   the old one (`-branch trewsync`), or continue the plugin's own branch with
   its history beneath the export's
   ([Continue an existing backup branch](#continue-an-existing-backup-branch)).
   The export does not take over a branch it did not make unless you adopt it.
   Wait for `trewd git-export status` to show the first push.
3. The plugin's `.git` folder in the vault is not synced by TrewSync (nothing
   starting with a dot is) and is no longer needed. Its history stays on the
   old remote. Delete the folder with your file manager once you no longer
   want the local copy.
4. From then on, read history in the export's branch, and change notes only in
   Obsidian or through an agent.

## Continue an existing backup branch

If the repository already has a branch whose history you want to keep, the
export can continue it rather than start a history of its own. The usual case
is the `main` branch the Obsidian Git plugin (obsidian-git) has been
committing your vault to for years. This is **adoption**: an explicit step,
done once, in which you name the exact commit the export continues from.
Without it, the export refuses any branch it did not make, as before.

What adoption does, and does not do:

- The export's first commit on the branch is a **child of the adopted
  commit**, so every old commit stays in the branch's history beneath it, and
  the first push is a plain fast-forward. Nothing is force-pushed, and nothing
  in the old history is rewritten.
- That first commit's tree is the vault as TrewSync holds it, as every commit's
  is. Anything the old commits held that TrewSync never syncs, such as
  `.obsidian/` and the plugin's own `.gitattributes`, is absent from it and
  stays in the old commits, so `git diff` across the boundary shows it removed.
  Its message starts `TrewSync continues the history from obsidian-git at
  SHA` and ends with a `Trew-Continues: SHA` trailer.
- The old history is left as it is: large files it committed stay ordinary Git
  objects and are not moved to LFS. Only what the export commits from then on
  follows the LFS threshold.
- The adopted commit is recorded in the configuration file
  (`git_export.adopted`) with the remote and branch it belongs to. An export
  rebuilt from scratch fetches that exact commit again and makes the same
  commits, never "whatever the branch is at now".

Continuing obsidian-git's `main`:

1. **Turn obsidian-git off on every device first** (Settings, Community
   plugins, Obsidian Git), and let its last push finish. A commit it pushes
   after the adoption stops the export (below).
2. **Give the server a deploy key** with write access to that repository, as in
   [Set it up with GitHub and a deploy key](#set-it-up-with-github-and-a-deploy-key),
   steps 2 and 3.
3. **Point the export at the branch:**

   ```bash
   trewd git-export set -remote git@github.com:you/obsidian-vault.git \
     -key ~/.trew-keys/obsidian-vault -branch main
   ```

   Until you adopt, `trewd git-export status` says the push is refused: "the
   remote already has a branch main, ..., and the export did not make it".
   That is expected, and the server's own repository keeps committing.
4. **Look at what you would adopt:**

   ```bash
   trewd git-export adopt
   ```

   It fetches the branch (the whole history, once; a large repository can
   take some minutes) and prints its tip: the full commit, its date and its
   subject, such as `vault backup: 2026-09-20 21:15:00`. Nothing changes yet.
   Check that it is the latest commit you see on GitHub.
5. **Adopt it, giving that commit back:**

   ```bash
   trewd git-export adopt 0123456789abcdef0123456789abcdef01234567
   ```

   The commit must be all 40 characters and must still be the branch's tip;
   anything else is refused and changes nothing. If the export had already
   made commits in its own repository (step 3), never pushed, they are set
   aside and made again on top of the adopted commit.
6. **Watch the first push:** `trewd git-export status` shows `continues the
   history adopted at ...`, then, once your devices have been quiet for the
   window, the push. `git log` on GitHub shows the export's commits on top of
   obsidian-git's.

With Docker, run the two `adopt` commands as `docker compose exec trew /trewd
git-export adopt ...`, like the others.

After adopting:

- **Anything else pushing to the branch stops the export**, as for any branch
  changed outside it: status and doctor report it, and the export never
  pushes over the other commit. Before the export's first push, turn off
  whatever pushed, then either put the branch back at the adopted commit or
  run `trewd git-export adopt` again to adopt the new tip. After the first
  push, the export accepts only its own commits there; the branch put back
  even at the adopted commit is refused.
- **Adoption belongs to that remote and branch.** `trewd git-export set
  -remote` or `-branch` naming another leaves it behind; setting them back
  brings it back.
- A branch the export has already pushed to cannot be adopted again: there is
  nothing to adopt.

## When something goes wrong

`trewd doctor` has a `git-export` check, and `trewd git-export status` shows
the details. Sync is never affected by any of these.

- **A push fails** (the network, an expired token, a removed deploy key, a
  full LFS quota): the local repository keeps committing, the push is retried
  every half minute at first and every half hour at most, and doctor shows the
  last error. Fix the cause; nothing else is needed.
- **"The remote's branch was changed outside the export."** Somebody pushed
  to, rewrote or deleted the branch. The export never pushes over a commit it
  did not make. If it was a mistake, put the branch back at the commit status
  names and run `trewd git-export set` to look again. Otherwise push to a new
  branch with `trewd git-export set -branch NAME`. For a branch that already
  held your backups before the export, see
  [Continue an existing backup branch](#continue-an-existing-backup-branch).
- **"The repository was changed outside the export."** The same for the
  server's own copy in `git-export/repo.git`. Put the branch back, or stop the
  server and move `git-export/` aside: the export starts again from the store.
  The rebuilt history has the same commits, byte for byte, provided the store
  has not been purged since and the settings are the same, so the remote
  accepts it as the history it already has.
- **The store was restored from a backup.** The restored store is a different
  history. The export does not rewrite the branch: it adds one commit whose
  message starts `Restore:` and whose tree is the restored notes, and goes on
  from there.
- **A path Git cannot hold.** `git~1`, Windows' short name for `.git`, is
  refused by Git everywhere; such a path is left out and listed in status.
- **git or git-lfs missing or too old.** Doctor names which; install it.

To stop for good: `trewd git-export disable`, then delete `git-export/` in the
data directory and the remote repository (the only way to remove its LFS
objects), and remove the deploy key or revoke the token.

How it works, and how it is tested, is in the
[developer documentation](development.md#the-git-export).
