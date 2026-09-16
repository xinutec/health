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
            # `rust workspace tests` was the single largest row in the commit
            # gate — 524 s measured on an idle machine, a third to a half of the
            # whole run. nextest runs each test in its own process and schedules
            # across binaries, which this suite (~50 test files) suits.
            #
            # ⚠ nextest does NOT run doctests, so the gate keeps a separate
            # `cargo test --doc` row. There are zero doctests today, which is
            # exactly why the row matters: without it, the first doctest anyone
            # writes would silently never run.
            pkgs.cargo-nextest
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

        # BOTH production Rust binaries, in ONE derivation (#1131).
        #
        # ⚠ Split them and each runs its own `lake build` and `cargo build` in its
        # own sandbox, so the image pays for the Lean statics and the sqlx/tokio/axum
        # dependency compile TWICE — about 40% more, measured by ablation on a warm
        # store. Quote the RATIO, not seconds: CI is a colder, slower machine.
        #
        # ⚠ `backend`'s static set is a SUPERSET of day-shell's, so one `lake build`
        # of the larger set serves both. A missing static is a LINK error, which is
        # the good direction but only because they are all named here.
        #
        # ⚠ The Lean build must happen IN THIS TREE and cannot come from
        # `verified-cli`: both `build.rs` files read their link line out of the
        # `verified_cli.rsp` lake wrote, and `verified-cli` exports the binary alone.
        health-bins = pkgs.stdenv.mkDerivation (finalAttrs: {
          name = "health-bins";
          src = ./.;
          # Cargo cannot reach the network inside a nix build, so the crates are
          # vendored from rust/Cargo.lock. Bump the hash when a dependency
          # changes; nix prints the correct one on mismatch.
          cargoDeps = pkgs.rustPlatform.fetchCargoVendor {
            src = ./rust;
            hash = "sha256-lY9ks4rMU4HYZQdpswOtFCYaCrNVzXkA2/wlWjcldZM=";
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
            (cd lean && lake build verified_cli BackendEntry:static ServeEntry:static DayEntry:static Verified:static)
            # ⚠ Both selectors in ONE invocation, so the shared dependency graph
            # compiles once into one target directory. Two `cargo build` calls
            # here would still share the directory and be nearly as good, but
            # this also lets cargo schedule both crates' codegen together.
            (cd rust && cargo build --release --offline -p day-shell -p backend)
          '';
          installPhase = ''
            mkdir -p $out/bin
            cp rust/target/release/day-shell $out/bin/
            cp rust/target/release/backend $out/bin/
          '';
        });
      });
    };
}
