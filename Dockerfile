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
RUN nix --extra-experimental-features 'nix-command flakes' build .#verified-cli
RUN mkdir -p /export/nix/store /export/bin && \
    cp -a $(nix-store -qR result) /export/nix/store/ && \
    install -m755 "$(readlink -f result)/bin/verified_cli" /export/bin/verified_cli

FROM node:24-alpine AS backend-build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src/ src/
RUN npx tsc

FROM node:24-alpine AS frontend-build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
# git: the shared layout harness is a git dependency (github:xinutec/ui-harness),
# so npm ci clones it — node:alpine ships no git.
RUN apk add --no-cache git ca-certificates && npm ci
COPY frontend/ .
RUN npx ng build --configuration production

FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=backend-build /app/dist dist/
COPY --from=frontend-build /app/dist/frontend/browser public/
# The verified decoder + its /nix/store runtime closure. LEAN_CLI is the
# switch decode-day.js checks to run the Lean shadow after each decode.
COPY --from=lean-build /export/nix/store /nix/store/
COPY --from=lean-build /export/bin/verified_cli lean/verified_cli
ENV LEAN_CLI=/app/lean/verified_cli
# Commit stamp, surfaced at /api/version and in the UI footer so a stale
# client/deploy is visible at a glance. Injected by .github/workflows/docker.yml.
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
# The node base image ships a nonroot "node" user (uid 1000), matched by the
# k8s workloads (auth Deployment + the cron Jobs). Files above are
# world-readable, so it can run them.
USER node
CMD ["node", "dist/server.js"]
