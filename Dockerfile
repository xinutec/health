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
# Rust commit invalidated the layer and rebuilt Lean from scratch. Measured
# 2026-08-23 on run 32670483768: 225 s of an 1101 s stage, paid on nearly every
# push, for a derivation whose inputs had not changed.
#
# Verified rather than assumed: `.#verified-cli` evaluates AND builds with only
# `flake.nix`, `flake.lock` and `lean/` in the context.
RUN nix --extra-experimental-features 'nix-command flakes' build --out-link /tmp/vc .#verified-cli
# rust/ AFTER it: `.#health-bins` takes `src = ./.`, so it needs the Rust tree,
# and it rebuilds the Lean statics because both `build.rs` files read their link
# line out of the `.rsp` lake wrote in this tree — which no other derivation
# exports.
#
# ⚠ ONE derivation for BOTH binaries since 2026-08-25 (#1131). It was two, and
# each ran its own `lake build` and its own `cargo build` in a separate sandbox,
# so the image paid for the Lean statics twice and for the sqlx/tokio/axum
# dependency compile twice.
#
# Ablated on the dev machine: 98 s + 182 s apart against 169 s together, so 40%
# off this stage. ⚠ The "~800 s" this comment used to claim was #1131's estimate
# from a CI timing, never a measured saving — expect the ratio to carry and the
# seconds not to.
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
    install -m755 /tmp/bins/bin/day-shell /export/bin/day-shell && \
    install -m755 /tmp/bins/bin/backend /export/bin/backend

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
# The Rust+Lean HTTP server (#982). Shipped ALONGSIDE `dist/server.js` rather
# than replacing it: which one runs is the k8s `command`, so a rollback is a
# manifest change and a restart rather than an image rebuild. That matters
# because the image is the slow half — CI builds it on every push to main, and
# a bad cutover should not have to wait for one.
COPY --from=lean-build /export/bin/backend bin/backend
# Commit stamp, surfaced at /api/version and in the UI footer so a stale
# client/deploy is visible at a glance. Injected by .github/workflows/docker.yml.
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
# The node base image ships a nonroot "node" user (uid 1000), matched by the
# k8s workloads (auth Deployment + the cron Jobs). Files above are
# world-readable, so it can run them.
USER node
CMD ["node", "dist/server.js"]
