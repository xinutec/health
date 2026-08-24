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
        # ⚠ THEY USED TO BE TWO, and the duplication was the cost. Each ran its
        # own `lake build` and its own `cargo build`, in separate sandboxes with
        # separate target directories, so the image paid for the Lean statics
        # TWICE and for the dependency compile (sqlx with the full house feature
        # list, tokio multi-thread, axum, chrono) TWICE.
        #
        # MEASURED by ablation on 2026-08-25, warm store, dev machine:
        #
        #     day-shell   98 s
        #     backend    182 s   = 280 s apart
        #     health-bins        = 169 s together      -> 40% off
        #
        # ⚠ NOT the "~800 s" #1131 estimated and this comment first claimed. That
        # figure came from a CI stage timing, and CI is a cold-store Linux
        # container on slower cores — the RATIO should carry, the seconds will
        # not. Do not quote 800 s; quote the ratio, or re-measure where it
        # matters.
        #
        # ⚠ The old comment argued AGAINST merging — "building both in one
        # derivation would make each image rebuild pay for the other's compile".
        # That holds only if something builds them SEPARATELY, and nothing does:
        # the Dockerfile builds both in one RUN, and the single dev-lint gate row
        # names both. Checked before merging rather than assumed.
        #
        # ⚠ `backend`'s static set is a SUPERSET of day-shell's — day-shell
        # serves the `day` mode from `DayEntry`, the backend additionally answers
        # every route from `BackendEntry` and `ServeEntry` — so one `lake build`
        # of the larger set serves both. A missing static is a LINK error, not a
        # runtime miss, which is the good direction but only because they are all
        # named here.
        #
        # ⚠ The Lean build has to happen IN THIS TREE and cannot be reused from
        # `verified-cli`: both `build.rs` files read their link line out of
        # `lean/.lake/build/bin/verified_cli.rsp` — the file lake WROTE when it
        # linked the CLI — rather than restating nine libraries and two store
        # paths that move on every `nix flake update`. `verified-cli` exports the
        # binary, not the `.rsp` or the statics.
        health-bins = pkgs.stdenv.mkDerivation (finalAttrs: {
          name = "health-bins";
          src = ./.;
          # Cargo cannot reach the network inside a nix build, so the crates are
          # vendored from rust/Cargo.lock. Bump the hash when a dependency
          # changes; nix prints the correct one on mismatch.
          cargoDeps = pkgs.rustPlatform.fetchCargoVendor {
            src = ./rust;
            hash = "sha256-SrSqMa+lWep+VYmybTQKZj/A1TUiCG7ikmA2K7rHJTE=";
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
