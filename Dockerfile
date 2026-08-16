# Verified Lean decoder for the in-cron shadow (V2 of
# docs/proposals/2026-07-verified-core-lean.md). Built via nix so the
# toolchain is the exact flake-pinned Lean the proofs are written against;
# `lake build` runs every #guard spec check, so this stage is also a proof
# gate. The runtime closure (glibc/gmp from /nix/store) is staged for the
# alpine (musl) final image, where the store-linked binary is self-contained.
FROM nixos/nix:latest AS lean-build
WORKDIR /src
COPY flake.nix flake.lock ./
COPY lean/ lean/
# rust/ too: `.#day-shell` below builds BOTH halves in one derivation, because
# day-shell's build.rs reads its link line out of the .rsp lake writes when it
# links verified_cli. See the flake.
COPY rust/ rust/
RUN nix --extra-experimental-features 'nix-command flakes' build .#verified-cli
RUN mkdir -p /export/nix/store /export/bin && \
    cp -a $(nix-store -qR result) /export/nix/store/ && \
    install -m755 "$(readlink -f result)/bin/verified_cli" /export/bin/verified_cli
# The in-process host. Same contract as verified_cli — byte for byte, which
# scripts/rust-host-check.sh is the gate for — and additionally able to answer
# the fold's OSM callbacks from the mirror while it runs (#959).
RUN nix --extra-experimental-features 'nix-command flakes' build .#day-shell && \
    cp -a $(nix-store -qR result) /export/nix/store/ && \
    install -m755 "$(readlink -f result)/bin/day-shell" /export/bin/day-shell

FROM node:24-alpine AS backend-build
WORKDIR /app
# pnpm-workspace.yaml carries the overrides; without it `pnpm import` re-resolves
# and a constrained package can land below its declared floor. pnpm is taken
# unpinned — the host gets its copy from the flake, and a second version here
# would be two numbers held level by hand.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile
COPY src/ src/
RUN pnpm exec tsc

FROM node:24-alpine AS frontend-build
WORKDIR /app
COPY frontend/package.json frontend/pnpm-lock.yaml frontend/pnpm-workspace.yaml ./
# git: the shared layout harness is a git dependency (github:xinutec/ui-harness),
# so the install clones it — node:alpine ships no git.
RUN apk add --no-cache git ca-certificates \
    && npm install -g pnpm \
    && pnpm install --frozen-lockfile
COPY frontend/ .
RUN pnpm exec ng build --configuration production

FROM node:24-alpine
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# --prod is pnpm's --omit=dev.
RUN npm install -g pnpm && pnpm install --frozen-lockfile --prod
COPY --from=backend-build /app/dist dist/
COPY --from=frontend-build /app/dist/frontend/browser public/
# The verified decoder + its /nix/store runtime closure. LEAN_CLI is the
# switch decode-day.js checks to run the Lean shadow after each decode.
COPY --from=lean-build /export/nix/store /nix/store/
COPY --from=lean-build /export/bin/verified_cli lean/verified_cli
ENV LEAN_CLI=/app/lean/verified_cli
# The day tenant's own binary, and a SEPARATE variable on purpose: LEAN_CLI is
# read by lean-core, lean-hsmm and compare-match as well, and day-shell serves
# the `day` mode only. See `cliPath()` in src/lean/lean-day.ts.
COPY --from=lean-build /export/bin/day-shell lean/day-shell
ENV LEAN_DAY_HOST=/app/lean/day-shell
# Commit stamp, surfaced at /api/version and in the UI footer so a stale
# client/deploy is visible at a glance. Injected by .github/workflows/docker.yml.
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
# The node base image ships a nonroot "node" user (uid 1000), matched by the
# k8s workloads (auth Deployment + the cron Jobs). Files above are
# world-readable, so it can run them.
USER node
CMD ["node", "dist/server.js"]
