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
          # Playwright's browsers come from the lock, not ~/Library/Caches: the
          # driver's version must match @playwright/test's (tables/deps.dhall).
          PLAYWRIGHT_BROWSERS_PATH = pkgs.playwright-driver.browsers;
          PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "1";
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
    };
}
