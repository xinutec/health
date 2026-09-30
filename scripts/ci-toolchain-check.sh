#!/usr/bin/env bash
# Do the toolchains CI builds the shipped binaries with match the flake's?
#
# The image's `verified_cli` and `bin/backend` are compiled on the GitHub runner
# with the official Lean release and rustup's rustc, pinned in
# .github/workflows/build.yml. Everything local — the gate, the proofs, the
# tests — runs the flake's nix lean4 and rustc. A flake bump that moved either
# without the workflow would ship binaries from a toolchain nothing here ran.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_devshell.sh"
cd "$(dirname "${BASH_SOURCE[0]}")/.."

wf=.github/workflows/build.yml
ci_lean=$(sed -nE 's/^  LEAN_TOOLCHAIN: leanprover\/lean4:v(.*)$/\1/p' "$wf")
ci_rust=$(sed -nE 's/^  RUST_TOOLCHAIN: (.*)$/\1/p' "$wf")
nix_lean=$(lean --version | sed -nE 's/^Lean \(version ([^,]+),.*/\1/p')
nix_rust=$(rustc --version | awk '{print $2}')

fail=0
if [[ -z "$ci_lean" || "$ci_lean" != "$nix_lean" ]]; then
	echo "Lean: CI builds with '${ci_lean:-?}', the flake provides '$nix_lean' — set LEAN_TOOLCHAIN in $wf" >&2
	fail=1
fi
if [[ -z "$ci_rust" || "$ci_rust" != "$nix_rust" ]]; then
	echo "Rust: CI builds with '${ci_rust:-?}', the flake provides '$nix_rust' — set RUST_TOOLCHAIN in $wf" >&2
	fail=1
fi
[[ $fail -eq 0 ]] && echo "CI toolchains match the flake: Lean $nix_lean, Rust $nix_rust"
exit $fail
