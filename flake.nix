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

        # The in-process host (rust/day-shell), for the production image. Same
        # stdin/stdout contract as verified-cli above, and the difference is the
        # whole point: this one can ANSWER the fold's walkableRoads /
        # buildingsNear / drivableRoads callbacks from the OSM mirror as it
        # generates them, where a spawned pure function cannot (#959).
        #
        # ⚠ Both halves build HERE, in one derivation, and that is forced rather
        # than chosen: `rust/day-shell/build.rs` reads its link line out of
        # `lean/.lake/build/bin/verified_cli.rsp` — the file lake WROTE when it
        # linked the CLI — instead of restating nine libraries and two store
        # paths that move on every `nix flake update`. So the Lean build has to
        # have happened in the same tree, and `verified-cli` above cannot be
        # reused as an input: it exports the binary, not the `.rsp` or the
        # static libs.
        day-shell = pkgs.stdenv.mkDerivation (finalAttrs: {
          name = "day-shell";
          src = ./.;
          # Cargo cannot reach the network inside a nix build, so the crates are
          # vendored from rust/Cargo.lock. Bump the hash when a dependency
          # changes; nix prints the correct one on mismatch. Vendored from
          # `rust/` alone — the workspace and its lockfile are all the vendoring
          # needs, and pointing it at the whole tree would re-fetch whenever an
          # unrelated file changed.
          cargoDeps = pkgs.rustPlatform.fetchCargoVendor {
            src = ./rust;
            hash = "sha256-NKrGrLC7Ks0BaUItXEjWfZvEJuJSfF5l3dxSJbPZKrY=";
          };
          cargoRoot = "rust";
          nativeBuildInputs = [
            pkgs.lean4
            pkgs.cargo
            pkgs.rustc
            pkgs.rustPlatform.cargoSetupHook
          ];
          buildPhase = ''
            export HOME=$TMPDIR
            (cd lean && lake build verified_cli DayEntry:static Verified:static)
            (cd rust && cargo build --release --offline)
          '';
          installPhase = ''
            mkdir -p $out/bin
            cp rust/target/release/day-shell $out/bin/
          '';
        });
      });
    };
}
