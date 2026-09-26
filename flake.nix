{
  # The TrewSync server, trewd, built from this checkout.
  #
  #   nix build            ./result/bin/trewd
  #   nix run . -- version
  #   nix profile install github:waynehoover/trewsync
  #
  # From source, with the release's flags: static (CGO off, which pure-Go
  # SQLite is what makes possible), trimmed, and stamped with a version. The
  # version is not a release number, because a flake builds whatever commit it
  # is given: it is `unstable-` and that commit, so `trewd version` says which.
  # `trewd update` leaves a binary in the Nix store alone, and says to update
  # the flake input instead.
  #
  # The tests are not run here. They are run by scripts/check.sh and CI, some
  # read repository files a store build does not have, and the source below is
  # filtered to what the binary is built from so that editing a doc does not
  # rebuild it. scripts/flake-check.sh builds this and runs the result.
  description = "TrewSync server (trewd): self-hosted Obsidian vault sync with full version history";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      rev = self.shortRev or self.dirtyShortRev or "unknown";
    in
    {
      packages = forAllSystems (
        pkgs:
        let
          fs = pkgs.lib.fileset;
          # go.mod asks for Go 1.27, and buildGoModule is whatever nixpkgs'
          # default Go is, which lags a new release by weeks.
          buildGoModule = pkgs.buildGo127Module or pkgs.buildGoModule;
        in
        rec {
          trewd = buildGoModule {
            pname = "trewd";
            version = "unstable-${rev}";
            src = fs.toSource {
              root = ./.;
              fileset = fs.unions [
                ./go.mod
                ./go.sum
                ./cmd
                ./internal
              ];
            };
            subPackages = [ "cmd/trewd" ];
            # The Git export runs git, git-lfs and ssh (docs/git-export.md),
            # so the installed trewd finds these on its PATH before any other.
            nativeBuildInputs = [ pkgs.makeWrapper ];
            postInstall = ''
              wrapProgram $out/bin/trewd --prefix PATH : ${
                pkgs.lib.makeBinPath [
                  pkgs.git
                  pkgs.git-lfs
                  pkgs.openssh
                ]
              }
            '';
            # The hash of the module dependencies go.sum names. It changes when
            # go.sum does; scripts/flake-check.sh says what the new one is.
            vendorHash = "sha256-lo75ngKpnZTdJCTQqRC4Vec9YX4PNXygRXo95ksvg80=";
            env.CGO_ENABLED = 0;
            flags = [ "-trimpath" ];
            ldflags = [
              "-s"
              "-w"
              "-X main.version=unstable-${rev}"
            ];
            doCheck = false;
            meta = {
              description = "TrewSync server: self-hosted Obsidian vault sync with full version history";
              homepage = "https://github.com/waynehoover/trewsync";
              license = pkgs.lib.licenses.mit;
              mainProgram = "trewd";
              platforms = systems;
            };
          };
          default = trewd;
        }
      );

      apps = forAllSystems (pkgs: {
        default = {
          type = "app";
          program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.trewd}/bin/trewd";
        };
      });
    };
}
