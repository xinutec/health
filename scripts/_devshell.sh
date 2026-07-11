# shellcheck shell=bash
set -euo pipefail # redundant (every caller sets it first) but satisfies DL-SHELL-STRICT-MODE
#
# Sourced by every health bash script (as the line right after `set`) to
# pin its toolchain — Node, ssh — to the flake devShell (flake.nix /
# flake.lock), the ONE source of truth. This deliberately bypasses the
# ambient nix channel: `nix-shell -p nodejs_24` and a bare `<nixpkgs>`
# resolve through a locally-cached, drifting channel that regularly serves
# a Node below Angular's >=24.15 floor — the recurring "too old node"
# breakage. `nix develop` uses the rev locked in flake.lock instead, so
# the version is identical on every machine and bumped only, deliberately,
# with `nix flake update`.
#
# Mechanism: re-exec the CALLING script once inside `nix develop`, marking
# the environment so this guard is a no-op on the second entry — and so any
# nested health script (e.g. deploy.sh -> npm run golden -> golden.sh)
# inherits HEALTH_DEVSHELL=1 and does not stack another devShell.
#
# Usage, at the top of a script:
#     #!/usr/bin/env bash
#     set -euo pipefail
#     source "$(dirname "${BASH_SOURCE[0]}")/_devshell.sh"

if [[ -z "${HEALTH_DEVSHELL:-}" ]]; then
	_health_repo="$(cd "$(dirname "${BASH_SOURCE[1]}")/.." && pwd)"
	exec nix develop "$_health_repo" -c \
		env HEALTH_DEVSHELL=1 bash "${BASH_SOURCE[1]}" "$@"
fi
