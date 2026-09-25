# health-sync

Fitbit + Owntracks/PhoneTrack data ingestion, classification, and dashboard.
Lives at https://health.xinutec.org.

## Android app

A native-feeling phone wrapper — a full-screen WebView onto this dashboard, no
browser chrome. Build & install steps: [`android/README.md`](android/README.md).

## Layout

```
rust/                           the backend: `bin/backend` (axum + sqlx), its
                                tests, and the corpus gates
lean/                           the verified core: every rule the timeline
                                depends on, served by `verified_cli`
frontend/                       Angular SPA (Material)
tests/golden/                   the replay corpora (gitignored: real days)
scripts/                        deploy.sh, prod-db.sh, the gate helpers
docs/                           cross-cutting docs and proposals
├── ideas.md                    Small future-considerations: heuristic
│                               refinements and UX tweaks that aren't
│                               substantial enough for a full proposal
├── design/                     System-as-shipped: current architecture
│   ├── overview.md               Top-level architecture diagram + module map
│   ├── lean-and-rust.md          What goes in Lean, what goes in Rust, the seam
│   ├── probabilistic-principles.md   The rules behind every factor and constraint
│   ├── episode-geometry.md, rail-snap.md, timezone.md, google-health.md, …
│   └── privacy-in-tests-and-commits.md
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
| `pnpm run verify` | The COMMIT gate: `gate-commit.json`, which is `gate.json` (rendered from `gate.dhall`) minus its slow rows — Rust fmt/clippy/tests/doctests, the frontend's typecheck, lint, unit tests, build and phone-width layout harness, the union copies, the Lean verified core, dev-lint, and both tables against their sources. Names every row that failed. The pre-commit hook runs the same table. ⚠ The row COUNT is not restated here on purpose — count it in the JSON. |
| `pnpm run verify:deploy` | The FULL gate: `gate.json`, every row — the commit table plus the 42-day corpus replay, the mode-reachability pair and the sandboxed CLI build. `deploy.sh` runs this once; nothing reaches the pod without it. `scripts/commit-table.sh` names the rows that differ. |
| `cargo nextest run` | The backend test suite, from `rust/`. (`pnpm test` is gone with the TypeScript backend.) |
| `bin/backend <sub>` | The CLI. Run it with no subcommand for the list — `check`, `sync`, `serve`, `coverage`, `freshness`, `zones-census`, `decode-day`, the `compare-*` pairs, and the rest. |
| `cargo test -p backend --release --test corpus_gate --test decoder_scoreboard --test hsmm_decode_corpus` | The replay gates, from `rust/`. `corpus_gate` replays each golden day ONCE and grades it four ways — walks, truth, journeys, day (#1359). They replay the gitignored `tests/golden/` corpora against committed floors blessed from Lean's own output (`DAY_BLESS`, `WALK_BLESS`, `TRUTH_BLESS`, `FEASIBILITY_BLESS`): the walks, the confirmed ground-truth rows, the journeys, the decoder scoreboard, and the same days RE-DECODED from raw materials against their blessed segments. Read the counts off the baselines, not from here. Each ANNOUNCES A SKIP when the corpus is absent rather than passing quietly. |
| `scripts/prod-db.sh <cmd>` | Run a command against the prod health-db: opens an SSH tunnel and exports the DB + Nextcloud env from the running pod, then runs `<cmd>`. e.g. `scripts/prod-db.sh bin/backend coverage`. Refuses anything under `dist/`. |
| `bash scripts/deploy.sh -m "msg"` | Full deploy: the full gate once → commit (the hook is skipped: its table is a subset of what just ran) → push this repo → wait for CI (capped at 30 min; a build is 20-23) → kubectl rollout on isis. See the script header for `-F file` usage and prerequisites. |

⚠ The TypeScript-era replay scripts went with the backend (#975, #1225).
What they measured is carried by the corpus gates above, except the ones
that had two arms to compare — the day gate (Lean against the TypeScript it
ported), the focus gate and `compare-match` — which have no successor by
construction; health #1048 holds that. `pnpm run verify` is the static gate;
the corpus gates are what replay real days.

## Deployment

Production runs as `deploy/health-auth` in the `health` namespace of the
isis k3s cluster. The Docker image (`xinutec/health-sync:latest`) is built by
this repo's GitHub Actions on every push to `main` and pulled by the cluster on
rollout. The k8s manifests live in the home monorepo (`xinutec/pippijn`
`code/kubes/health/k8s/`).

`scripts/deploy.sh` is the one-step path. The manual equivalent is:

```
pnpm run verify:deploy   # the full table, corpus replay included
git add -A && git commit --no-verify -F msg.txt   # the hook's table is a subset of what just ran
git push origin main
gh run watch --exit-status <run-id>
ssh root@isis.xinutec.org \
  'kubectl -n health rollout restart deploy/health-auth && \
   kubectl -n health rollout status  deploy/health-auth --timeout=180s'
```

## Linters

- **rustfmt + clippy** — `rust/`, as gate rows.
- **ESLint + angular-eslint** — `frontend/src/`. Angular semantics
  (inline-template ban, template a11y, etc.).
  All run as part of `pnpm run verify`.

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
