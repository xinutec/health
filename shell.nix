# Dev shell for health-sync. Enter with: nix-shell
#
# Node 24 (24.16+) from nixpkgs-unstable — the Angular 22 frontend requires
# ≥24.15, and the ambient <nixpkgs> channel lags (24.14 in 2026-07, which fails
# `ng test`). Pinning unstable here mirrors scripts/deploy.sh's `nixpkgs#nodejs_24`
# and the life flake (../life/flake.nix), so the dev shell, verify, and deploy all
# use the same ≥24.16 toolchain.
{ pkgs ? import (fetchTarball "https://channels.nixos.org/nixpkgs-unstable/nixexprs.tar.xz") { } }:

pkgs.mkShell {
  buildInputs = [
    pkgs.nodejs_24
  ];
}
