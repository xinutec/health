# The production image ASSEMBLES; it builds nothing.
#
# `verified_cli`, `bin/backend` and the frontend's static build are compiled on
# the CI runner (.github/workflows/build.yml), where Lean's `.lake` and cargo's
# dependencies persist in the Actions cache and a commit recompiles only what
# it changed. Built inside Docker they compiled from scratch on every commit:
# ~10 min of the ~15 min image job (2026-09-30), the layer cache being
# all-or-nothing per stage. The build context is the directory CI stages the
# three artifacts into, not the repo.
#
# ubuntu:24.04 because the runner is ubuntu-24.04: both binaries link the
# runner's glibc dynamically, and the image must carry that glibc or newer.
FROM ubuntu:24.04

# rustls verifies against the platform's roots (reqwest 0.13's verifier), so
# the store has to be there.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY public/ public/

# `--chmod`: artifact upload drops the executable bit.
# The verified core. `bin/backend` SPAWNS it (`verified_cli serve`, one NDJSON
# request per line) and every Lean decision crosses that pipe; `VERIFIED_CLI`
# is how the backend finds it (#1709).
COPY --chmod=755 verified_cli lean/verified_cli
ENV VERIFIED_CLI=/app/lean/verified_cli

# The Rust HTTP server (#982), and the ONLY server.
COPY --chmod=755 backend bin/backend

# Commit stamp, surfaced at /api/version and in the UI footer so a stale
# client/deploy is visible at a glance.
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA

# uid 1000, which the k8s workloads run as (runAsUser: 1000) — the id the node
# base image's "node" user had. The files above are world-readable.
USER 1000:1000

# ⚠ THE MANIFESTS SET `command` EXPLICITLY, so this is a default nothing in the
# cluster reads. It still has to name a file that exists, or a `docker run` of
# this image fails on something the k8s workloads never exercise.
CMD ["bin/backend", "serve"]
