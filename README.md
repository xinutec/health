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
scripts/                        utility scripts (deploy.sh, verify.sh, golden.sh, prod-db.sh)
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
| `npm run verify` | Typecheck (back + front) → schema-types check → format → Biome lint (back) → ESLint (front) → tests. Run before every commit. |
| `scripts/verify.sh` | Thin wrapper that runs `npm run verify` under a `nix-shell` shebang, so the full check runs directly on a machine without npm on PATH (e.g. the Mac mini). `deploy.sh` already runs verify itself — this is for running it standalone. |
| `npm test` | Just the backend test suite. |
| `npm run analyze -- YYYY-MM-DD` | Run the day-analysis CLI. Needs DB + Nextcloud env — easiest via `scripts/prod-db.sh` (below). |
| `npm run golden` | Golden-day regression check — runs the classification pipeline against a curated set of real days and diffs the day-state timeline against blessed baselines. Run around large classification changes; `npm run golden -- --bless` updates baselines. The corpus under `tests/golden/` is local-only (gitignored). |
| `scripts/prod-db.sh <cmd>` | Run a command against the prod health-db: opens an SSH tunnel and exports the DB + Nextcloud env from the running pod, then runs `<cmd>`. e.g. `scripts/prod-db.sh node dist/cli/analyze-day.js 2026-05-15 pippijn Europe/London`. |
| `bash scripts/deploy.sh -m "msg"` | Full deploy: verify → golden + walk gates → commit → push this repo → wait for CI (capped at 15 min) → kubectl rollout on isis. See the script header for `-F file` usage and prerequisites. |

## Deployment

Production runs as `deploy/health-auth` in the `health` namespace of the
isis k3s cluster. The Docker image (`xinutec/health-sync:latest`) is built by
this repo's GitHub Actions on every push to `main` and pulled by the cluster on
rollout. The k8s manifests live in the home monorepo (`xinutec/pippijn`
`code/kubes/health/k8s/`).

`scripts/deploy.sh` is the one-step path. The manual equivalent is:

```
npm run verify && npm run golden && npm run walk-gate   # in this repo
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
  Both run as part of `npm run verify`.

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
