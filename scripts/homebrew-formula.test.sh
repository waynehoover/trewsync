#!/usr/bin/env bash
#
# The Homebrew formula renders from a release's SHA256SUMS into something
# Homebrew would install from, and refuses sums that do not cover it.
#
# Without Homebrew: the formula is evaluated by Ruby against a stand-in for
# Homebrew's Formula DSL that records, for each of the four platforms, which
# URL and which sha256 the formula would use. That is the part of a formula
# that can be wrong in a way nobody notices until one kind of machine fails.
set -uo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
fails=0
ok() { printf '  ok   %s\n' "$1"; }
bad() { printf '  FAIL %s\n' "$1" >&2; fails=$((fails + 1)); }

command -v ruby >/dev/null || { echo "ruby is needed to evaluate the formula" >&2; exit 2; }

ruby -c "$root/packaging/homebrew/trewd.rb" >/dev/null && ok "the formula in the repository parses" \
  || bad "packaging/homebrew/trewd.rb is not valid Ruby"

# A release's sums, with more platforms than Homebrew installs, as a real one has.
for p in darwin-arm64 darwin-amd64 linux-arm64 linux-amd64 linux-riscv64 freebsd-amd64 freebsd-arm64; do
  printf '%s  trewd-%s\n' "$(printf '%s' "$p" | shasum -a 256 | awk '{print $1}')" "$p"
done > "$work/SHA256SUMS"

if bash "$root/scripts/homebrew-formula.sh" 0.2.0 "$work/SHA256SUMS" > "$work/trewd.rb" 2>"$work/err"; then
  ok "it renders for 0.2.0"
else
  bad "it does not render: $(cat "$work/err")"
fi

cat > "$work/check.rb" <<'RUBY'
# Just enough of Homebrew's DSL to see what the formula would fetch where.
class Formula
  class << self
    attr_reader :seen
    def desc(*) end
    def homepage(*) end
    def license(*) end
    def version(v = nil)
      @version = v if v
      @version
    end
    def on_macos
      @os = "darwin"
      yield
    end
    def on_linux
      @os = "linux"
      yield
    end
    def on_arm
      @arch = "arm64"
      yield
    end
    def on_intel
      @arch = "amd64"
      yield
    end
    def url(u)
      (@seen ||= {})["#{@os}-#{@arch}"] = { url: u }
    end
    def sha256(s)
      @seen["#{@os}-#{@arch}"][:sha256] = s
    end
    def service(*) end
    def test(*) end
  end
end
load ARGV[0]
sums = File.readlines(ARGV[1]).to_h { |l| l.split.reverse }
want = %w[darwin-arm64 darwin-amd64 linux-arm64 linux-amd64]
bad = []
bad << "it covers #{Trewd.seen.keys.sort}" unless Trewd.seen.keys.sort == want.sort
want.each do |p|
  got = Trewd.seen[p] || {}
  url = "https://github.com/waynehoover/trew/releases/download/server/v#{ARGV[2]}/trewd-#{p}"
  bad << "#{p} fetches #{got[:url]}" unless got[:url] == url
  bad << "#{p} expects #{got[:sha256]}" unless got[:sha256] == sums["trewd-#{p}"]
end
bad << "it is version #{Trewd.version}" unless Trewd.version == ARGV[2]
warn bad.join("\n") unless bad.empty?
exit(bad.empty? ? 0 : 1)
RUBY
if ruby "$work/check.rb" "$work/trewd.rb" "$work/SHA256SUMS" 0.2.0 2>"$work/err"; then
  ok "each of the four platforms fetches its own binary from the release, with its own sum"
else
  bad "the rendered formula is wrong: $(cat "$work/err")"
fi

grep -q '"0\{64\}"' "$work/trewd.rb" && bad "a placeholder sum survived rendering" \
  || ok "no placeholder sum survives"

grep -v 'trewd-linux-arm64' "$work/SHA256SUMS" > "$work/short"
if bash "$root/scripts/homebrew-formula.sh" 0.2.0 "$work/short" > /dev/null 2>"$work/err"; then
  bad "it rendered from sums that do not list trewd-linux-arm64"
else
  grep -q "trewd-linux-arm64" "$work/err" && ok "sums missing a platform are refused, naming it" \
    || bad "the refusal does not name what is missing: $(cat "$work/err")"
fi
for v in v0.2.0x 0.2 0.2.0-rc.1; do
  bash "$root/scripts/homebrew-formula.sh" "$v" "$work/SHA256SUMS" > /dev/null 2>&1 \
    && bad "it rendered for $v" || ok "$v is refused"
done
bash "$root/scripts/homebrew-formula.sh" server/v0.2.0 "$work/SHA256SUMS" > /dev/null 2>&1 \
  && ok "a tag name is read as its version" || bad "server/v0.2.0 was refused"

if [ "$fails" -ne 0 ]; then
  echo "$fails check(s) failed" >&2
  exit 1
fi
echo "the Homebrew formula renders from the release sums"
