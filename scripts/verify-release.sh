#!/usr/bin/env bash
#
# Check a release after it is out, from the outside (I23).
#
# Everything else in scripts/ checks what is about to be published. This checks
# what was, by fetching it the way somebody else does: the release assets from
# the release, the image from the registry, the package from npm. Nothing here
# reads the working tree, and that is the point. A release is four channels
# that are built by four different jobs and are only ever assumed to agree.
#
# It also asks about the things that are only wrong afterwards. `latest` moves
# during the release and points at whatever the last job to touch it left; the
# attestations are rebuilt and re-uploaded after the release is published, so
# the bytes attached to it are replaced by a second set that nothing compares
# to the first; and an npm version cannot be replaced, so what is there is
# there. None of those can be checked before the fact.
#
# Usage:
#   verify-release.sh --plugin 0.4.2
#   verify-release.sh --server 0.4.2
#   verify-release.sh --cli 0.4.2
#   verify-release.sh --plugin 0.4.2 --server 0.4.2 --cli 0.4.2
#
# Verbs, not a single version: the three move on their own clocks and asking
# for all of them at one number is how they get assumed to be in step.
set -uo pipefail

repo=${TREW_REPO:-waynehoover/trewsync}
image=ghcr.io/$repo
plugin= server= cli=

while [ $# -gt 0 ]; do
  case $1 in
    --plugin) plugin=${2:?--plugin needs a version}; shift 2 ;;
    --server) server=${2:?--server needs a version}; shift 2 ;;
    --cli)    cli=${2:?--cli needs a version};       shift 2 ;;
    --repo)   repo=${2:?--repo needs owner/name}; image=ghcr.io/$repo; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$plugin$server$cli" ] || { sed -n '/^# Usage:/,/^# Verbs/p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
bad=0
note() { printf '  %s\n' "$*"; }
wrong() { printf '  WRONG: %s\n' "$*" >&2; bad=$((bad + 1)); }

# A step that could not run is reported as such and is not a pass. Same reason
# scripts/check.sh exits 2 rather than 0 when something was skipped: "it did not
# fail" and "it passed" are different sentences and only one of them is news.
missing=()
need() { command -v "$1" >/dev/null || { missing+=("$1"); return 1; }; }

# ---- a release's assets: they are what the sums say, and they are attested --
check_release() { # check_release <tag> <what>
  local tag=$1 what=$2
  local dir="$work/$what"
  local required=() asset
  case "$what" in
    plugin) required=(main.js manifest.json styles.css) ;;
    # Every platform .goreleaser.yml builds (scripts/goreleaser-check.sh holds
    # the list), because `trewd update` on a machine whose binary is missing
    # is told there is no build for it.
    server) required=(trewd-linux-amd64 trewd-linux-arm64 trewd-linux-riscv64
                      trewd-darwin-amd64 trewd-darwin-arm64 trewd-freebsd-amd64 trewd-freebsd-arm64) ;;
  esac
  printf '\n== %s, from the %s release\n' "$what" "$tag"
  mkdir -p "$dir"
  if ! gh release download "$tag" --repo "$repo" --dir "$dir" --clobber 2>"$dir/err"; then
    wrong "cannot download the $tag release: $(cat "$dir/err")"
    return
  fi
  ls "$dir" | grep -v '^err$' | sed 's/^/  /'

  # Valid checksums for a partial download do not make an installable release.
  for asset in "${required[@]}"; do
    [ -s "$dir/$asset" ] || wrong "the $tag release is missing a nonempty $asset"
  done

  if [ ! -f "$dir/SHA256SUMS" ]; then
    wrong "the $tag release has no SHA256SUMS, so nothing anybody downloads can be checked"
  elif ( cd "$dir" && shasum -a 256 -c --status SHA256SUMS ); then
    note "SHA256SUMS checks out, in the spelling somebody downloading gets"
  else
    wrong "SHA256SUMS does not check out:"
    ( cd "$dir" && shasum -a 256 -c SHA256SUMS 2>&1 | grep -v ': OK$' | sed 's/^/    /' >&2 )
  fi

  if [ -f "$dir/SHA256SUMS" ]; then
    for asset in "${required[@]}"; do
      if ! awk -v name="$asset" '
        $2 == name || $2 == "*" name { found = 1 }
        END { exit !found }
      ' "$dir/SHA256SUMS"; then
        wrong "SHA256SUMS does not cover $asset"
      fi
    done
  fi

  # Provenance, on the bytes that are there now. The attest workflow rebuilds
  # and re-uploads these, so this is the only thing that looks at the set a
  # person actually gets rather than the set the release was created with.
  if need gh; then
    local f n=0
    for f in "$dir"/*; do
      # The manifest is a signature itself, checked below, and is not attested.
      case "$(basename "$f")" in SHA256SUMS|err|packslip*.sigstore.json) continue ;; esac
      if gh attestation verify "$f" --repo "$repo" >/dev/null 2>&1; then
        n=$((n + 1))
      else
        wrong "$(basename "$f") has no valid attestation from $repo"
      fi
    done
    [ "$n" = 0 ] || note "$n asset(s) attested to $repo"
  fi

  # The server's signed manifest, which `trewd update` will not install a
  # release without, checked the way it checks it: signed by the release
  # workflow of this repository, run from this release's own tag, through
  # GitHub's issuer, with every binary matching the digest and size it signs.
  # The workflow alone is not enough: it is dispatched with the tag as an
  # input, so a run from a branch someone pushed signs as attest.yml too. And
  # the pin is a prefix, so the signer packslip reports is compared whole,
  # as cmd/trewd/update.go does: server/v1.2.30 and server/v1.2.3-x both
  # begin with server/v1.2.3.
  if [ "$what" = server ]; then
    local bundle="$dir/packslip.server.sigstore.json" args=() covered=0
    local signer="https://github.com/$repo/.github/workflows/attest.yml@refs/tags/$tag"
    local issuer=https://token.actions.githubusercontent.com
    if [ ! -s "$bundle" ]; then
      wrong "the $tag release has no packslip.server.sigstore.json, so trewd update refuses it"
    elif need packslip; then
      for asset in "${required[@]}"; do
        if [ -s "$dir/$asset" ]; then
          args+=(--artifact "$dir/$asset")
          covered=$((covered + 1))
        fi
      done
      if ! packslip verify "$bundle" \
           --identity-prefix "$signer" \
           --issuer "$issuer" \
           ${args[@]+"${args[@]}"} --json > "$work/packslip.out" 2>&1; then
        wrong "packslip does not verify the $tag manifest: $(tr '\n' ' ' < "$work/packslip.out")"
      else
        local said
        said=$(python3 - "$work/packslip.out" "$signer" "$issuer" <<'PY'
import json, sys
try:
    r = json.load(open(sys.argv[1]))
except Exception as e:
    print("packslip said yes but its report is unreadable: %s" % e); raise SystemExit
if r.get("scheme") != "sigstore-oidc":
    print("signed with %r, and a server release is signed with sigstore-oidc" % r.get("scheme"))
elif r.get("key_id") != sys.argv[2]:
    print("signed by %r, which is not %s" % (r.get("key_id"), sys.argv[2]))
elif r.get("issuer") != sys.argv[3]:
    print("issued by %r, and a server release is issued by %s" % (r.get("issuer"), sys.argv[3]))
PY
)
        if [ -z "$said" ]; then
          note "packslip.server.sigstore.json is signed by $repo's attest.yml at $tag, and $covered binaries match it"
        else
          wrong "the $tag manifest: $said"
        fi
      fi
    fi
  fi
}

[ -z "$plugin" ] || check_release "$plugin" plugin
[ -z "$server" ] || check_release "server/v$server" server

# ---- what the plugin release says about itself -----------------------------
#
# The two files that decide whether an install works, read from the release
# rather than from here. Nothing else looks inside them: the sums say the bytes
# are the bytes that were built, and the attestation says this repository built
# them, and both are true of a manifest naming the wrong version.
#
# versions.json is the one with history. It maps a plugin version to the oldest
# Obsidian that runs it, and Obsidian reads it from the repository *at the tag*,
# not from the release assets, so a correct release with the entry in a
# follow-up commit installs on current Obsidian and tells every older one that
# nothing it can run exists. That is what release.sh --prepare and the check in
# release.sh are for, and this is the same question asked of the published
# thing, which is the only place the answer is not taken on trust.
if [ -n "$plugin" ]; then
  printf '\n== the plugin release describes itself\n'
  manifest=$work/plugin/manifest.json
  if [ ! -f "$manifest" ]; then
    wrong "the $plugin release has no manifest.json, and Obsidian installs nothing without one"
  else
    read -r saidversion saidminapp <<EOF2
$(python3 - "$manifest" <<'PY'
import json, sys
m = json.load(open(sys.argv[1]))
print(m.get("version", "-"), m.get("minAppVersion", "-"))
PY
)
EOF2
    if [ "$saidversion" = "$plugin" ]; then
      note "manifest.json says $saidversion, needs Obsidian $saidminapp"
    else
      wrong "the $plugin release ships a manifest.json that says $saidversion"
    fi

    if need gh; then
      if ! raw=$(gh api "repos/$repo/contents/versions.json?ref=$plugin" \
                   -H "Accept: application/vnd.github.raw" 2>"$work/vjson.err"); then
        wrong "no versions.json at the $plugin tag: $(tr -d '\n' < "$work/vjson.err")"
      else
        printf '%s' "$raw" > "$work/versions.json"
        entry=$(python3 - "$work/versions.json" "$plugin" <<'PY'
import json, sys
try:
    known = json.load(open(sys.argv[1]))
except Exception as e:
    print("unreadable:%s" % e); raise SystemExit
print(known.get(sys.argv[2], ""))
PY
)
        case $entry in
          "")            wrong "versions.json at the tag has no entry for $plugin, so an older Obsidian is told nothing it can run exists" ;;
          unreadable:*)  wrong "versions.json at the $plugin tag is not JSON: ${entry#unreadable:}" ;;
          "$saidminapp") note "versions.json at the tag agrees: $plugin needs $saidminapp" ;;
          *)             wrong "versions.json at the tag says $plugin needs $entry, the manifest says $saidminapp" ;;
        esac
      fi
    fi
  fi
fi

# ---- what BRAT installs ------------------------------------------------------
#
# BRAT, which is how the plugin is installed until the community directory
# lists it, does not ask GitHub which release is latest. It ranks the
# repository's releases by the version it reads out of each tag name, keeps
# GitHub's order on a tie (the newest tag first), and installs from the first,
# so any release can be the one it opens, the server's included. A server
# release has no manifest.json, and every BRAT install and update then fails:
# server/v0.12.0 did that, tagged two days after plugin 0.12.0 (BRAT 2.2.0,
# grabReleaseFromRepository in src/features/githubUtils.ts). release.sh refuses
# that before the tag; this is the same question asked of what was published.
#
# The first page only, because BRAT reads no further. Drafts are left out,
# because BRAT asks without a token and never sees one, and prereleases are
# kept, because its first look includes them.
if [ -n "$plugin$server" ] && need gh; then
  printf '\n== what BRAT installs\n'
  if ! gh api "repos/$repo/releases?per_page=30" > "$work/releases.json" 2>"$work/releases.err"; then
    wrong "cannot list the releases: $(tr -d '\n' < "$work/releases.err")"
  else
    pick=$(python3 - "$work/releases.json" <<'PY'
import json, re, sys

# semver.coerce, which BRAT ranks by: the first run of up to three dotted
# numbers anywhere in the tag, a missing part read as 0.
def version(tag):
    m = re.search(r"(?<![0-9])([0-9]{1,16})(?:\.([0-9]{1,16}))?(?:\.([0-9]{1,16}))?(?![0-9])", tag)
    return tuple(int(p or 0) for p in m.groups()) if m else None

releases = [r for r in json.load(open(sys.argv[1])) if not r.get("draft")]
# sorted() is stable, so a tie keeps GitHub's order, as BRAT's sort does.
ranked = sorted(releases, key=lambda r: (version(r["tag_name"]) is None,
                                         tuple(-p for p in version(r["tag_name"]) or ())))
if not ranked:
    print("-")
else:
    top = ranked[0]
    print(top["tag_name"], "manifest" if any(a["name"] == "manifest.json" for a in top["assets"]) else "none")
PY
)
    case $pick in
      "")          wrong "cannot read the release list GitHub returned" ;;
      -)           wrong "the repository has no published release for BRAT to install" ;;
      *" manifest") note "BRAT installs from ${pick% manifest}, which has the plugin's manifest.json" ;;
      *)           wrong "BRAT installs from ${pick% none}, which has no manifest.json, so every BRAT install and update fails. A plugin release has to outrank it" ;;
    esac
  fi
fi

# ---- the image: it runs, on both architectures, and says what it is --------
if [ -n "$server" ]; then
  printf '\n== the container image\n'
  if need docker; then
    ref=$image:$server
    if ! digest=$(docker buildx imagetools inspect --format '{{.Manifest.Digest}}' "$ref" 2>/dev/null); then
      wrong "$ref is not in the registry"
    else
      note "$ref is $digest"

      # The moving tags, against the policy that decided them. `latest` on a
      # backport is the failure this asks about, and it is invisible from
      # inside the release that caused it.
      here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
      while IFS= read -r t; do
        [ "$t" = "$server" ] && continue
        got=$(docker buildx imagetools inspect --format '{{.Manifest.Digest}}' "$image:$t" 2>/dev/null || echo none)
        if [ "$got" = "$digest" ]; then note "$image:$t points here too"
        else wrong "$image:$t is $got, and this release should own it"; fi
      done < <("$here/scripts/release-tags.sh" "server/v$server" 2>/dev/null || true)

      for arch in amd64 arm64; do
        # The local copy goes first, every time. One digest can be stored
        # locally only once, so running amd64 caches that digest as the amd64
        # image and arm64 then cannot be stored under the same name: Docker
        # says "cannot overwrite digest" and the second architecture reads as
        # broken when nothing is. The same bug was in the release workflow,
        # and fixing it there and not here is how one of two call sites keeps
        # the defect.
        docker image rm -f "$image@$digest" >/dev/null 2>&1 || true
        # Docker reports pulls on stderr; only stdout is the binary's version.
        image_err=$work/image-$arch.stderr
        if got=$(docker run --rm --platform "linux/$arch" "$image@$digest" version 2>"$image_err"); then
          if [ "$(printf '%s\n' "$got" | awk 'NR == 1 { print $2 }')" = "$server" ]; then
            note "linux/$arch: $got"
          else
            wrong "linux/$arch says \"$got\", not $server"
          fi
        else
          wrong "linux/$arch will not run: $got $(cat "$image_err")"
        fi
      done
    fi
  fi
fi

# ---- npm: the published tarball installs and runs --------------------------
if [ -n "$cli" ]; then
  printf '\n== the npm package\n'
  if need npm && need node; then
    dir=$work/npm; mkdir -p "$dir/elsewhere"
    # Not `--silent`: it suppresses npm's error text as well as its output,
    # and the first time this ran it turned "your npm is configured to ignore
    # anything published after a date" into "the version is not on npm", which
    # is a different and much more alarming sentence. What npm said is what
    # gets printed.
    # `--prefer-online`, because the point of this script is to check what is
    # published and npm will answer from a cached packument instead. It did:
    # minutes after 0.5.0 went up this said "No matching version found ... with
    # a date before" and named a time before the publish. A verifier that
    # reports a good release as broken is worse than no verifier, because the
    # next person to see it assumes the same.
    if ! tgz=$(cd "$dir" && npm pack --prefer-online "trew-sync@$cli" 2>"$dir/err" | tail -1); then
      wrong "cannot fetch trew-sync@$cli from npm. npm says:"
      sed 's/^/    /' "$dir/err" >&2
    else
      note "$tgz, $(wc -c < "$dir/$tgz" | tr -d ' ') bytes"
      # npm's own record of what it served, which is the closest thing the
      # registry has to a checksum somebody else can quote.
      note "registry integrity: $(npm view --prefer-online "trew-sync@$cli" dist.integrity 2>/dev/null || echo unknown)"
      if ( cd "$dir/elsewhere" && npm install --silent --no-audit --no-fund \
             --prefix "$dir/elsewhere" "$dir/$tgz" >/dev/null 2>&1 ); then
        bin=$dir/elsewhere/node_modules/.bin/trew
        if got=$("$bin" --version 2>&1); then
          if [ "$got" = "$cli" ]; then
            note "installs and runs under node $(node --version): $got"
          else
            wrong "the published CLI says \"$got\", not $cli"
          fi
        else
          wrong "the published CLI will not start: $got"
        fi
      else
        wrong "the published tarball will not install"
      fi
    fi
  fi
fi

printf '\n'
if [ "${#missing[@]}" -gt 0 ]; then
  printf 'Not checked, because these are not installed: %s\n' "$(IFS=', '; echo "${missing[*]:-}")"
  echo "That is not the same as a pass."
  exit 2
fi
if [ "$bad" -gt 0 ]; then
  echo "$bad thing(s) wrong with this release."
  exit 1
fi
echo "Everything asked for checks out."
