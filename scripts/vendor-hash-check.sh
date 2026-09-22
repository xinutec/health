#!/usr/bin/env bash
# Does `flake.nix`'s `cargoDeps.hash` match what `rust/Cargo.lock` vendors to?
#
# Two steps, because a fixed-output derivation is addressed by its DECLARED
# hash and nix answers each question differently depending on whether an
# output with that hash is already in the store:
#
#   1. `nix build`     — absent: fetches and FAILS on a mismatch, printing the
#                        hash to pin. Present: a store hit, which proves nothing
#                        about the lockfile in the tree (2026-09-22: a 409-line
#                        lock change passed a row that did only this).
#   2. `--rebuild`     — present: recomputes and compares. Absent: refuses
#                        ("checking is not possible"), which is why step 1 is
#                        first.
#
# `vendorStaging` by name: `--rebuild` on the outer `cargoDeps` re-runs only
# the outer stage and still says nothing about the fetch.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
target='.#health-bins.cargoDeps.vendorStaging'
nix build --no-warn-dirty --no-link "$target"
nix build --rebuild --no-warn-dirty --no-link "$target"
