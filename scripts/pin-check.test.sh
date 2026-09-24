#!/usr/bin/env bash
#
# When the compose pin being behind is a mistake, and when it is a Tuesday.
#
# pin-check exists because docs/server.md and compose.yaml both went stale
# without anybody noticing. It then made a second problem: pushing server/vX.Y.Z
# is what *builds* the image, so on the commit the tag points at the digest does
# not exist yet and cannot be pinned, and this failed there. Main went red from
# the server tag until the pin commit, and the publish gate refuses a tag whose
# commit CI has not passed on, so a plugin tag pushed inside that window could
# not be released at all. The fix excuses exactly one commit and no others, so
# it needs a test that watches it fail everywhere else.
#
# Run against a throwaway repository rather than this one, because the cases are
# about which commit HEAD is, and this one only ever has the answer it has.
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
fails=0
image=ghcr.io/waynehoover/trew

mkdir -p "$work/scripts" "$work/docs"
cp "$here/pin-check.sh" "$work/scripts/"

pin() { # pin <version> -- write compose.yaml and the docs naming that image
  printf 'services:\n  trew:\n    image: %s:%s@sha256:%064d\n' "$image" "$1" 0 > "$work/compose.yaml"
  printf 'Run `docker run %s:%s@sha256:%064d`\n' "$image" "$1" 0 > "$work/docs/server.md"
  printf '# trew\n' > "$work/README.md"
}

git -C "$work" init -q
git -C "$work" config user.email t@example.com
git -C "$work" config user.name test
commit() { git -C "$work" add -A && git -C "$work" commit -qm "$1"; }

want() { # want <pass|fail> <what it is>
  local expect=$1 what=$2 out rc
  out=$(cd "$work" && bash scripts/pin-check.sh 2>&1); rc=$?
  if [ "$expect" = pass ] && [ $rc -ne 0 ]; then
    printf '  FAIL %s: refused it\n%s\n' "$what" "$(echo "$out" | sed 's/^/       /')"; fails=$((fails + 1))
  elif [ "$expect" = fail ] && [ $rc -eq 0 ]; then
    printf '  FAIL %s: allowed it\n%s\n' "$what" "$(echo "$out" | sed 's/^/       /')"; fails=$((fails + 1))
  else
    printf '  ok   %s\n' "$what"
  fi
}

pin 0.5.0; commit "pin 0.5.0"
git -C "$work" tag server/v0.5.0
want pass "a compose file pinning the newest release"

# The window. The tag is pushed, the image is being built, this commit is the
# one it was built from and there was no digest to write into it.
git -C "$work" tag server/v0.5.1
want pass "the commit the new server tag points at, before the image exists"

# And out of it, which is the whole reason the check exists.
printf 'a note\n' > "$work/NOTES.md"; commit "something else entirely"
want fail "a later commit that still pins the old image"

# The pin commit is what that later commit is supposed to be.
pin 0.5.1; commit "compose: pin the 0.5.1 server image"
want pass "the pin commit"

# A tag on an older commit does not excuse the tip. The excuse is for the commit
# that could not have known the digest, and this one could.
git -C "$work" tag server/v0.6.0 HEAD~1
want fail "a server tag on an older commit, with the tip unpinned"

# The docs half, which is how this started: compose right, a runbook stale.
git -C "$work" tag -d server/v0.6.0 >/dev/null
printf 'Run `docker run %s:0.4.0`\n' "$image" > "$work/docs/server.md"; commit "stale runbook"
want fail "a doc naming an image tag that is not the pinned one"

# ---- before the first server release: compose builds from the checkout -------
#
# There is no image to pin until a server release exists, so compose.yaml
# builds locally between two markers. That is right exactly until the first
# server tag, excused on that tag's own commit like the pin above, and then
# pin-compose.sh turns the local build into the pin.
local_build() {
  cat > "$work/compose.yaml" <<'YAML'
services:
  trew:
    # pin-compose: begin
    # Built from this checkout until a release exists.
    build:
      context: .
    image: trewd:local
    # pin-compose: end
    container_name: trew
YAML
  printf 'Run `docker compose up -d --build`\n' > "$work/docs/server.md"
}
for t in $(git -C "$work" tag --list); do git -C "$work" tag -d "$t" >/dev/null; done
local_build; commit "build locally"
want pass "no server release, and compose builds from the checkout"
printf 'Run `docker run %s:0.4.0`\n' "$image" > "$work/docs/server.md"; commit "names an image"
want fail "no server release, and a doc names a numbered image that cannot exist"
local_build; commit "build locally again"
git -C "$work" tag server/v0.6.0
want pass "the commit the first server tag points at, still building locally"
printf 'later\n' >> "$work/NOTES.md"; commit "after the first release"
want fail "a later commit that still builds locally after a server release"
printf 'services:\n  trew:\n    image: somewhere/else:1\n' > "$work/compose.yaml"; commit "neither"
want fail "a compose file that neither pins the image nor builds from the checkout"

# pin-compose.sh turning the local build into the pin, against a registry that
# answers with a fixed digest.
mkdir -p "$work/fakebin"
cat > "$work/fakebin/docker" <<'SH'
#!/usr/bin/env bash
printf 'Name: x\nMediaType: y\nDigest: sha256:%064d\n' 7
SH
chmod +x "$work/fakebin/docker"
cp "$here/pin-compose.sh" "$work/scripts/"
local_build; commit "build locally for the pin"
if (cd "$work" && PATH="$work/fakebin:$PATH" bash scripts/pin-compose.sh 0.6.0 >/dev/null 2>&1); then
  pin_line=$(grep -c "image: $image:0.6.0@sha256:$(printf '%064d' 7)" "$work/compose.yaml")
  if [ "$pin_line" = 1 ] && ! grep -q 'pin-compose:\|build:\|trewd:local' "$work/compose.yaml" \
     && grep -q '^    container_name: trew$' "$work/compose.yaml"; then
    printf '  ok   %s\n' "pin-compose replaces the local build with the pin, and only that"
  else
    printf '  FAIL %s\n%s\n' "pin-compose left the wrong compose file" "$(sed 's/^/       /' "$work/compose.yaml")"
    fails=$((fails + 1))
  fi
  commit "compose: pin the 0.6.0 server image"
  want pass "the pin pin-compose wrote"
else
  printf '  FAIL %s\n' "pin-compose failed against the local build"
  fails=$((fails + 1))
fi

if [ $fails -eq 0 ]; then
  echo "the pin check excuses one commit and no others"
  exit 0
fi
echo "$fails wrong" >&2
exit 1
