# Dev shell for health (Node backend + Angular frontend). Enter with: nix develop
{
  description = "health — Fitbit sync + dashboard";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "aarch64-darwin" "x86_64-linux" "aarch64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (s: f nixpkgs.legacyPackages.${s});
    in {
      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          # The single source of truth for every script's toolchain — see
          # scripts/_devshell.sh. Pinned via flake.lock so it never drifts
          # to a too-old Node (the ambient nix channel does; that broke the
          # Angular >=24.15 build). Bump with: nix flake update.
          packages = [
            pkgs.nodejs_24 # backend (Hono) + Angular 22 frontend (needs >=24.15)
            pkgs.pnpm # the frontend's installer; node ships npm too, ignore it
            pkgs.openssh # prod-db / capture-golden / backtest tunnel to prod
            pkgs.lean4 # verified core (lean/) — includes lake; toolchain comes from nix, not elan
            pkgs.dhall-json # re-render gate.json from gate.dhall, which the gate's own staleness message tells you to do
            # rust/ — the in-process host that is meant to delete the TS day arm
            # (#952). Links the Lean static libs and calls the fold through the C
            # ABI, so it needs a C toolchain alongside cargo; stdenv supplies cc.
            pkgs.cargo
            pkgs.rustc
            pkgs.rustfmt
            pkgs.clippy
          ];
        };
      });

      packages = forAll (pkgs: {
        # The verified decoder binary (lean/), for the production image's
        # Lean-shadow (Dockerfile lean-build stage). `lake build` runs every
        # #guard spec check, so building this package IS the proof gate.
        verified-cli = pkgs.stdenv.mkDerivation {
          name = "verified-cli";
          src = ./lean;
          nativeBuildInputs = [ pkgs.lean4 ];
          buildPhase = ''
            export HOME=$TMPDIR
            lake build verified_cli
          '';
          installPhase = ''
            mkdir -p $out/bin
            cp .lake/build/bin/verified_cli $out/bin/
          '';
        };
      });
    };
}
