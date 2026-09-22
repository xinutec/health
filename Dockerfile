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
# ⚠ `verified-cli` BEFORE `COPY rust/`, and that ordering is the whole point of
# splitting this in two. Its `src = ./lean` (see the flake), so it does not
# depend on the Rust tree at all — but while it sat under `COPY rust/` every
# Rust commit invalidated the layer and rebuilt Lean from scratch — a fifth of
# the stage, paid on nearly every push, for a derivation whose inputs had not
# changed.
#
# Verified rather than assumed: `.#verified-cli` evaluates AND builds with only
# `flake.nix`, `flake.lock` and `lean/` in the context.
RUN nix --extra-experimental-features 'nix-command flakes' build --out-link /tmp/vc .#verified-cli
# rust/ AFTER it: `.#health-bins` takes `src = ./.`, so it needs the Rust
# tree. Its `build.rs` runs `lake build verified_cli` in this tree too, which is
# an incremental no-op after the stage above.
COPY rust/ rust/
# Both binaries, and their closures copied ONCE as a union.
#
# ⚠ Not two `cp -a $(nix-store -qR result)` calls. The two closures overlap
# heavily — glibc, gmp, the Lean runtime — and `cp -a` of a store path that is
# already in the destination descends into a read-only directory instead of
# skipping it. `nix-store -qR` over both roots already returns each path once,
# so asking the question once is both correct and cheaper.
RUN nix --extra-experimental-features 'nix-command flakes' build --out-link /tmp/bins .#health-bins && \
    mkdir -p /export/nix/store /export/bin && \
    cp -a $(nix-store -qR /tmp/vc /tmp/bins) /export/nix/store/ && \
    install -m755 /tmp/vc/bin/verified_cli /export/bin/verified_cli && \
    install -m755 /tmp/bins/bin/backend /export/bin/backend

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
# ⚠ NO `pnpm install` AND NO `dist/`. The TypeScript backend is gone (#975), so
# the runtime payload is the Rust binary and the frontend's static build. The
# base image is still node's only because the frontend build stage above uses
# it; nothing in the running container executes node.
COPY --from=frontend-build /app/dist/frontend/browser public/
# The verified core + its /nix/store runtime closure. `bin/backend` SPAWNS it
# (`verified_cli serve`, one NDJSON request per line) and every Lean decision
# crosses that pipe; `VERIFIED_CLI` is how the backend finds it (#1709).
COPY --from=lean-build /export/nix/store /nix/store/
COPY --from=lean-build /export/bin/verified_cli lean/verified_cli
ENV VERIFIED_CLI=/app/lean/verified_cli
# The Rust HTTP server (#982), and the ONLY server — there is no
# `dist/server.js` beside it, so a rollback means building one first.
COPY --from=lean-build /export/bin/backend bin/backend
# Commit stamp, surfaced at /api/version and in the UI footer so a stale
# client/deploy is visible at a glance. Injected by .github/workflows/docker.yml.
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
# The node base image ships a nonroot "node" user (uid 1000), matched by the
# k8s workloads (auth Deployment + the cron Jobs). Files above are
# world-readable, so it can run them.
USER node
# ⚠ THE MANIFESTS SET `command` EXPLICITLY, so this is a default nothing in the
# cluster reads. It still has to name a file that exists, or a `docker run` of
# this image fails on something the k8s workloads never exercise.
CMD ["bin/backend", "serve"]
