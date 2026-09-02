# health-sync

Fitbit + Owntracks/PhoneTrack data ingestion, classification, and dashboard.
Lives at https://health.xinutec.org.

## Android app

A native-feeling phone wrapper — a full-screen WebView onto this dashboard, no
browser chrome. Build & install steps: [`android/README.md`](android/README.md).

## Layout

```
src/                            backend (Hono + Kysely + MariaDB)
frontend/                       Angular SPA (Material)
tests/                          backend tests (vitest)
scripts/                        utility scripts (deploy.sh, golden.sh, prod-db.sh)
docs/                           cross-cutting docs and proposals
├── ideas.md                    Small future-considerations: heuristic
│                               refinements and UX tweaks that aren't
│                               substantial enough for a full proposal
├── design/                     System-as-shipped: current architecture
│   ├── overview.md               Top-level architecture diagram + module map
│   └── timezone.md               Per-row tz handling rules and rationale
└── proposals/                  Design proposals (active work)
    ├── README.md                 Index + status of each proposal
    ├── decoder-roadmap.md        The forward plan: one joint decoder
    └── geometry-roadmap.md       The forward plan: one honest estimator
```

Superseded proposals are deleted, not archived — git history is the
log (see `docs/proposals/README.md`).

## Common commands

| Command | What it does |
|---|---|
| `pnpm run verify` | The commit gate: every row in `gate.json` (rendered from `gate.dhall`) — Rust fmt/clippy/tests/doctests, the frontend's typecheck, lint, unit tests, build and phone-width layout harness, the union copies, the Lean verified core and decode parity, the verified CLI packaging, dev-lint, and the table against its own Dhall. Runs them all and names every one that failed. The pre-commit hook runs the same table, and so does `deploy.sh`. ⚠ The row COUNT is not restated here on purpose — it is counted in `gate.json`, and the number in this sentence was wrong (fourteen, against sixteen) for long enough to be quoted. |
| `cargo nextest run` | The backend test suite, from `rust/`. (`pnpm test` is gone with the TypeScript backend.) |
| `bin/backend <sub>` | The CLI. Run it with no subcommand for the list — `check`, `sync`, `serve`, `coverage`, `freshness`, `zones-census`, `decode-day`, the `compare-*` pairs, and the rest. |
| `cargo test -p backend --release --test walk_gate --test truth_corpus --test journey_corpus --test decoder_scoreboard` | The four replay gates, from `rust/`. They replay the gitignored `tests/golden/` corpora against committed floors a human blessed from the TypeScript: 238 walks, 312 confirmed ground-truth rows, 80 of 92 journeys, and 11 days of decoder-scoreboard counts (scored from the frozen decodes). Each ANNOUNCES A SKIP when the corpus is absent rather than passing quietly. ⚠ `pnpm run compare-gps-outliers` used to be listed here as "the one replay gate left"; it had not run since 2026-08-26 (#1301). |
| `scripts/prod-db.sh <cmd>` | Run a command against the prod health-db: opens an SSH tunnel and exports the DB + Nextcloud env from the running pod, then runs `<cmd>`. e.g. `scripts/prod-db.sh bin/backend coverage`. Refuses anything under `dist/`. |
| `bash scripts/deploy.sh -m "msg"` | Full deploy: verify → the three replay gates → commit → push this repo → wait for CI (capped at 15 min) → kubectl rollout on isis. See the script header for `-F file` usage and prerequisites. |

⚠ **`pnpm run golden`, `walk-gate`, `score-decoder`, `focus-gate`, `day-gate`,
`golden-hsmm` and `compare-match` ARE GONE.** All eight replay gates ran
`node dist/cli/*.js` against the TypeScript backend, deleted 2026-08-26 (#975);
the scripts themselves went on 2026-08-29 (#1225). That coverage is LOST, not
waived — health #1048 holds what replaces it. Do not read `pnpm run verify` as
covering it: `verify` is the static gate, and the replay gates were the ones that
replayed real days.

## Deployment

Production runs as `deploy/health-auth` in the `health` namespace of the
isis k3s cluster. The Docker image (`xinutec/health-sync:latest`) is built by
this repo's GitHub Actions on every push to `main` and pulled by the cluster on
rollout. The k8s manifests live in the home monorepo (`xinutec/pippijn`
`code/kubes/health/k8s/`).

`scripts/deploy.sh` is the one-step path. The manual equivalent is:

```
pnpm run verify   # in this repo; deploy.sh also runs the three replay gates
git add -A && git commit -F msg.txt
git push origin main
gh run watch --exit-status <run-id>
ssh root@isis.xinutec.org \
  'kubectl -n health rollout restart deploy/health-auth && \
   kubectl -n health rollout status  deploy/health-auth --timeout=180s'
```

## Linters

- **Biome** — backend (`src/`, `tests/`). Format + general TS lint.
- **ESLint + angular-eslint** — `frontend/src/`. Angular semantics
  (inline-template ban, template a11y, etc.) that Biome can't see.
  Both run as part of `pnpm run verify`.

## Documentation conventions

Reading order for a new contributor:

1. `docs/design/overview.md` — what the system is.
2. `docs/design/timezone.md` — the one cross-cutting concern that bites if missed.
3. `docs/proposals/README.md` — what we're considering changing.
4. Specific proposal docs as needed.

Archived proposals are kept for context — `docs/archive/2025-model-hmm.md` is
explicitly referenced by the active 2026-05 roadmap. They should be read only
after the active proposal that supersedes/pauses them.

### Proposal status conventions

Every proposal carries a YAML frontmatter block with:

- `status:` — `active` | `paused` | `superseded`
- `superseded-by:` — relative path to the doc that replaces this one (if status is superseded)
- `paused-reason:` — why work stopped (if status is paused)
- `created:` — YYYY-MM-DD
- `updated:` — YYYY-MM-DD

Move a doc between `docs/proposals/` and `docs/archive/` when its status changes —
the directory location and the frontmatter `status` must agree.

### Code-level docs

In-source design lives next to the code as comments and JSDoc. The `docs/`
directory is for cross-cutting docs that span multiple files or describe
planned work not yet in the code. Don't duplicate; link.
