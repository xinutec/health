# Dev shell for health (Node backend + Angular frontend). Enter with: nix develop
{
  description = "health — Fitbit sync + dashboard";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      systems = [ "aarch64-darwin" "x86_64-linux" ];
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
            pkgs.openssh # prod-db / capture-golden / backtest tunnel to prod
          ];
        };
      });
    };
}
