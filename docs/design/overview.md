# health-sync — Design

Health-and-location aggregation and visualization service. Pulls Fitbit
biometrics on a schedule, fetches GPS history live from Nextcloud
PhoneTrack, joins them per "Your Day" timeline segment, and serves a
web dashboard authenticated through Nextcloud SSO. All running on
isis's k3s cluster behind `health.xinutec.org`.

⚠ **Its `src/**.ts` paths are HISTORICAL** — they name the TypeScript backend,
deleted whole in #975. The prose is kept as the record of why each decision was
taken; the paths are not a map of the code today. `docs/design/timezone.md`
shows the convention: a "Where these things live now" section mapping each name
to the Rust or Lean symbol that does the work (#919).

## Architecture

```
   ┌──────────────┐                     ┌────────────────────┐
   │  Fitbit API  │                     │ Nextcloud (dash.*) │
   └──────┬───────┘                     │  SSO + PhoneTrack  │
          │ OAuth2 + REST               └─────┬───────┬──────┘
          ▼ (CronJob, hourly)                 │       │ live GPS fetch
   ┌──────────────┐                           │       │ (no mirror)
   │ MariaDB      │◄───── biometrics ─────────┤       │
   │ on isis      │                           │       │
   │ (per-user    │                           ▼       ▼
   │  tables +    │                  ┌─────────────────────┐
   │  osm_cache + │◄────── SQL ──────│  health-auth        │
   │  focus_places│  (sqlx)          │  (Rust axum + sqlx) │
   │ )            │                  │  bin/backend serve  │
   └──────────────┘                  └─────────┬───────────┘
                                               │
                              ┌────────────────┴───────────────┐
                              │ Velocity pipeline:             │
                              │  PhoneTrack → Kalman → segment │
                              │  classify → OSM enrich → join  │
                              │  with the biometrics — decided │
                              │  in Lean (verified_cli serve)  │
                              └────────────────┬───────────────┘
                                               │
                                               ▼
                                       ┌──────────────┐
                                       │   Browser    │
                                       │  (Angular)   │
                                       └──────────────┘
   ┌──────────────────┐
   │ OSM Overpass +   │  4s timeout per mirror, kumi.systems fallback,
   │ Nominatim        │  results memoised in osm_cache (HTTP + negative)
   └──────────────────┘
```

## Components

### Backend (`rust/backend` and `lean/`)

One Rust binary, `bin/backend`, and one Lean binary, `verified_cli`, which it
spawns and drives over a pipe (`lean-and-rust.md`). Rust does the IO: HTTP
(axum), MariaDB (sqlx), OAuth, and the Fitbit, Google Health, Nextcloud,
Overpass and Nominatim clients. Lean makes every decision the timeline
depends on. The entry points are subcommands of `bin/backend`; the list is
`rust/backend/src/main.rs`:

- **`serve`** — the dashboard: the Angular build, the `/api/*` endpoints,
  Nextcloud SSO, Fitbit OAuth, the OwnTracks proxy.
- **`sync`** — the CronJob: every user with a linked account, every stream,
  each written by the one API that owns it (`google/source.rs`).
- the refresh jobs (`decode-day`, `refresh-focus-places`, `refresh-rail-*`,
  `refresh-bus-routes`, `fetch-osm`, `fetch-geocodes`) and the operator tools
  (`day`, `velocity`, `census`, `mirror-check`, `rows-check`, the
  `google-compare*` family).

### Frontend (`frontend/`)

Angular SPA (currently v22 — see `frontend/package.json`). Zoneless,
standalone components, signals, Chart.js for visualization, Leaflet for
the map. Built to static files, served by the backend (`routes/site.rs`).

### Infrastructure (`k8s/`)

Deployed on isis's k3s cluster in the `health` namespace:
- MariaDB (Deployment + headless Service + PVC)
- health-auth (Deployment + Service running `bin/backend serve`)
- health-sync (CronJob running `bin/backend sync` every 15 minutes), and the
  refresh CronJobs in `04-cronjobs.yaml` — count them there
- Ingress with cert-manager TLS at `health.xinutec.org`

Docker image built by GitHub Actions, pushed to `xinutec/health-sync`
on Docker Hub.

## Authentication

Two OAuth2 flows:

1. **Nextcloud SSO** — users log in via Nextcloud (`dash.xinutec.org`).
   The callback creates a signed, HttpOnly session cookie. All API
   endpoints require a valid session.

2. **Fitbit linking** — authenticated users link their Fitbit account
   via `/fitbit/auth`. Tokens are stored in MariaDB keyed by the
   Nextcloud user ID.

Both flows use CSRF-protected `state` parameters stored in a
time-limited pending map (10 minute expiry). Fitbit's flow also uses
PKCE (S256 code challenge).

## Multi-user data model

Every data table includes `user_id` as part of the primary key.
API queries filter by the session's user ID — users can only see their
own data. The sync job iterates over all users in the `tokens` table.

## Module structure

```
rust/backend/src/
├── main.rs                 # the subcommand table: serve, sync, check, jobs, tools
├── routes/                 # axum handlers: velocity, tables, locations, share,
│                             owntracks, oauth, nextcloud_connect, me, site, …
├── auth/                   # sessions, cookie signing
├── fitbit/  google/  nextcloud/   # the clients and the sync writers
├── classification_inputs.rs, head.rs, fold.rs, fold_payload.rs
│                           # a day: load the inputs, run the head, drive the fold
├── lean.rs, lean_worker.rs # the pipe to verified_cli and the worker pool
├── osm_mirror.rs, overpass.rs, nominatim.rs, mirror_source.rs, osm_trace.rs,
│   rowset_answerer.rs, rowset_capture.rs   # the OSM mirror and how asks are answered
├── velocity_cache.rs, location_cache.rs, schema.rs, sync_state.rs, timezone.rs
└── cli/                    # census, day, decode, google, mirror, refresh, session

lean/
├── Verified/Geo/           # the day: quality filter, Kalman, segments, the
│                             PassFold cascade, walks, rail, venues, episodes
├── Verified/Hsmm/          # the decoder: state space, emissions, trellis, chains
├── Verified/Rail/          # rail-snap and its certified shortest path
├── Verified/*.lean         # the rest of the rules: sessions, sync, backfill,
│                             OwnTracks, the velocity cache policy, …
├── DayEntry/, DayEntry.lean, ServeEntry.lean, BackendEntry.lean
│                           # the three entry surfaces verified_cli serves
└── experiments/            # refuted patches only
```

## Testing and gates

`cargo nextest run` in `rust/` is the suite: auth, timezone math, the pipeline
head, the OwnTracks rules, the caches, row rendering, and the Lean host. Count
it rather than quote a number. `lake build` in `lean/` runs every `#guard`, so
a value that drifts fails the build. The frontend has its own Vitest suite.
The fixtures a corpus test replays are `tests/golden/days/<date>-<user>.json`
(`meta`, `inputs`, `expected`) and `tests/golden/decoded_days/` for the
decoder; every unbounded source (OSM, the mirror) is recorded into `inputs`
at capture and answered from there on replay, so a replay touches no
database.

Beyond the unit suite, a set of replay gates guards behaviour on **real
captured days** (fixtures gitignored — see
`privacy-in-tests-and-commits.md`). The ones below are the shape of it, NOT
the list: **count the commands in `scripts/deploy.sh` step 2 rather than
quoting a number from here.** Every attempt to summarise it has been wrong in
BOTH directions: this section once said "three" when it ran seven, and the
script's own banner said four gates had died when eight had. They run under `set -e`, so **a red gate behind a red
gate is never reached** — which stopped being a caution and became the actual
history: from 2026-08-26 to 2026-08-29 step 2 aborted on its first gate and the
one working gate behind it never ran at all.

- `gate.json` (from `gate.dhall`) — Rust fmt/clippy/tests/doctests, the
  frontend's typecheck, lint, unit tests, build and layout harness, the Lean
  verified core and decode parity, and dev-lint. Run by the pre-commit hook and
  by `pnpm run verify`. ⚠ Count the rows in `gate.json`; the number was wrong in
  the README for long enough to be quoted.
- `rust/backend/tests/corpus_gate.rs` with `tests/corpus/{walk,truth,journey,day}.rs` — the
  replay gates, restored 2026-08-31 and 2026-09-01. Rust replays the gitignored
  corpora and Lean judges; each gates a committed floor, re-blessed from Lean's
  own output (`DAY_BLESS`, `WALK_BLESS`, `TRUTH_BLESS`), and each announces a
  SKIP when the corpus is absent rather than passing quietly.

The TypeScript-era replay scripts (`golden.sh`, `walk-gate.sh`,
`score-decoder.sh`, `day-gate.sh`, `focus-gate.sh`, `golden-hsmm.sh`,
`compare-match.sh`) went with the backend (#975, #1225). What they measured is
carried by the corpus gates above; `day-gate.sh`, Lean against the TypeScript
it ported, has no successor by construction (#1048), and #943's per-pass
witnesses are the Lean-native replacement.

**They gate less than this section used to claim, and the difference matters.**
`deploy.sh` builds nothing: `.github/workflows/build.yml` pushes
`xinutec/health-sync:latest` on every push to `main`, gated only on CI's verify
— typecheck, lint, unit tests, `lean-check`. Every CronJob in the `health`
namespace pulls `:latest` per invocation, so a green CI run puts new
classification code into production the next time a cron fires, and no replay
gate has seen it. What `deploy.sh` uniquely does is run these gates locally and
then `rollout restart deploy/health-auth` — the one workload that does not
re-pull by itself, and therefore the only one they gate.

So the gates measure the algorithm; they do not gate the artefact that runs it.
Measured 2026-08-14 (#813), which sets out the two ways to end that: accept it
and treat the replay gates as advisory measurement, or have `deploy.sh` promote
a digest (`:prod`) that the CronJobs pin. Not yet decided — until it is, read a
red gate as "this needs looking at", not as "this cannot ship".

## Security checklist

- [x] Session cookies: HttpOnly, Secure, SameSite=Lax, HMAC-signed
- [x] Sessions persisted in MariaDB (`sessions` table), TTL 7 days, swept at server startup and every 6 hours so the table doesn't grow unbounded
- [x] CSRF: state parameter on both OAuth flows, validated on callback
- [x] PKCE: Fitbit OAuth uses S256 code challenge
- [x] User isolation: all DB queries filtered by session user_id
- [x] No credentials in Docker image or git (git-crypt for secret.sh)
- [x] Input validation: query parameters validated with zod
- [x] Connection pool: no per-request connect/disconnect
- [x] OAuth `state` is in-memory only — depends on `replicas: 1` for `health-auth`. Scaling out would silently break login flows; revisit before that happens.
- [x] Fitbit + Nextcloud OAuth tokens stored as plaintext TEXT columns. Acceptable in the current trust model (single-tenant cluster, MariaDB on the same node, PVC at rest); revisit if/when the data leaves this boundary.
- [ ] Rate limiting on login endpoint (future)
- [ ] CSP headers (future)

## Schema evolution

Migrations are numbered SQL statements in `rust/backend/src/schema.rs`. A
`schema_migrations` table tracks which have been applied. To change the
schema, append a new migration — never modify or remove existing ones.
This means data is never dropped during deployment.

## Data ownership / what we store

Default rule: **maximal normalisation**. Every fact has exactly one
storage location; nothing else mirrors, copies, or pre-aggregates it.
Two copies of the same fact eventually drift apart, and keeping them
in sync is its own bug surface. We accept slower queries (joins, live
re-fetches, on-the-fly aggregation) to avoid that class of problem.

Three deliberate exceptions, each justified:

- **Mirror third-party data we don't own.** Fitbit health metrics (HR,
  sleep, activity, ...) — Fitbit may sunset, accounts may close,
  history disappears. Without our own copy we lose access. So we sync
  Fitbit into MariaDB and treat *our* tables as the source of truth
  henceforth.
- **Cache external API responses we don't own** when the upstream is
  rate-limited or slow. `osm_cache` mirrors Nominatim/Overpass results;
  the cache is a courtesy to them, not duplication of ours. Cached
  results are pure functions of inputs (lat/lon), so drift is impossible.
- **Persist algorithmic outputs, not their inputs.** `focus_places` is
  the result of running the focus-places pipeline over the user's
  PhoneTrack history; it's a computed cache that's cheap to refresh
  (re-fetch + recompute weekly) and avoids a slow recompute on every
  dashboard load. Crucially, we **don't** persist the raw GPS history
  itself — that lives in Nextcloud (PhoneTrack), which we own. When
  the algorithm runs, it re-fetches.

What we explicitly do **not** do:

- Mirror PhoneTrack history into the health DB.
- Pre-aggregate summary tables (e.g. "weekly_step_total") that can be
  computed at query time from the underlying intraday data.
- Store derivable values alongside the inputs they're derived from.
- Cache anything from a system we already control unless there's a
  measured performance problem.

When a join across "kept" sources (e.g. Fitbit HR × PhoneTrack
location) is needed, fetch both into memory and join in code. At our
scale (single-digit users, MBs of data per quarter per user) this is
fast enough.

## Velocity / "Your Day" pipeline

The dashboard's centerpiece. Per request: take a date + tz, return a
list of typed segments (stay / walk / cycle / drive / rail / plane)
with human-readable place / route names and per-segment biometric
overlays. Owned by `rust/backend/src/routes/velocity.rs`, which loads the
inputs and runs the head and then the fold; the passes themselves are Lean
(`lean/Verified/Geo/PassFold.lean`).

```
PhoneTrack fixes (Nextcloud, live) — classification_inputs.rs
       │
       ▼
filter to date bounds in the user's tz (timezone.rs)
       │
       ▼
snapToPlace ← focus_places (DB)
       │
       ▼
GPS quality filter, gap-aware Kalman (Verified/Geo/GpsQuality.lean, Kalman.lean)
       │
       ▼
classifySegments (Verified/Geo/Segments.lean) — window features → mode score
       │
       ▼
the fold (DayEntry, driven by fold.rs): every place, way and biometric
lookup is an ask, answered from the OSM mirror and the DB
       │
       ▼
the refinement pass cascade (Verified/Geo/PassFold.lean — rail runs,
underground reconstruction, boarding/alight anchors, journey assembly,
vehicle splits, the dwell pass, walk/road/rail drawn paths, the HSMM
place override, …)
       │
       ▼
DayState[] (DayState.lean) + EpisodeGeometry[] (EpisodeGeometry.lean)
→ API response (Angular timeline + map)
```

### Caches and their purpose

Three caches sit in front of the slow parts. Each is a *cache*, not a
source of truth — wiping any of them is safe; the next request rebuilds.

- **`focus_places`** (per-user) — clusters of overnight + frequent
  presence, computed offline by `backend refresh-focus-places` (the rule in
  `Verified/Geo/FocusMining.lean`; full
  DELETE+recompute over a rolling window; **median** stay centroids).
  Used by `place-snap` to pull noisy GPS to a stable centroid, and by
  velocity to short-circuit OSM lookups for Home/Work. Carries an
  `hour_profile` (24-bucket dwell-by-hour-of-day histogram) plus
  visit counts and total dwell, so a stay at a co-located
  residence + café is routed to whichever fits the stay's time-of-
  day — superseding the earlier sleep/awake binary. Co-located clusters
  are split (`splitCluster`) on a time-of-day circle, gated by
  bimodality + multi-day substantiality + spatial distinctness, so a
  café and an evening residence ~45 m apart don't fuse. The magnetic
  pull from established places is in `2026-06-magnetic-focus-places.md`.
  Two **don'ts**, learned by reverting them: do not weight centroids by
  reported GPS accuracy (it lies; a non-robust weighted mean dragged a
  home onto a neighbouring monument), and do not mine `P(dwell|kind)`
  from `focus_places` (the ≥10-min stay floor censors short visits, so
  the distribution comes out flat).
- **`osm_cache`** (global) — keyed Overpass/Nominatim query → response.
  Stores both successful results and a sentinel `{_err, _at}` for
  failures, with a TTL so transient 429s and timeouts don't stick.
- **`place_snap` decisions** — not a DB table; the `snapToPlace`
  function is pure given `focus_places`.

### Performance and observability

- **`/health` endpoint.** Bare `GET /health` returns `ok` (k8s
  liveness friendly). `GET /health?detail=1` returns JSON with DB
  latency, focus-places count, osm-cache size, last-sync date, and
  process uptime.
- **OSM mirror fallback.** `overpass.rs`: overpass-api.de first, kumi.systems
  second, and a retry goes to the primary alone.
- **HR per-minute aggregation.** Fitbit stores 1-second-resolution
  HR (~21k rows/day). For segment-level mean/std the per-minute
  average loses essentially no precision and is ~60× cheaper to
  load + parse. Done in SQL (`classification_inputs.rs`, a
  `DATE_FORMAT` per-minute average).

### Graceful degradation

Built-in: any stage may legitimately have no data and the pipeline
must keep going. Concretely:
- No Fitbit data for the day (battery, charger, off-arm) →
  `loadBiometrics` returns empty arrays → segment biometrics are
  `null`, frontend hides the badge.
- OSM unreachable on both mirrors → `bestPlace` returns `null` →
  segment shows coords or focus_place name only.
- No PhoneTrack data for the day (linked but no GPS recorded) →
  `fetchTrackPoints` returns `[]` → empty timeline, no error.
- User has not linked Nextcloud at all → `fetchTrackPoints` throws
  `NextcloudNotLinkedError`; the `/api/velocity` route catches that
  specific error and returns `{points: [], segments: []}` with HTTP
  200. The frontend distinguishes this from "linked but empty" via
  `/api/me.nextcloudLinked` and can prompt the user to link.

## Classification system

The per-segment mode classification in `Verified/Geo/Segments.lean` is the
heuristic that has shipped since day one. A **probabilistic
constraint solver** (HMM → HSMM with learned emissions, posterior
marginals, sleep-conditional factors) is being built alongside it
under `lean/Verified/Hsmm/`. The two coexist:

- The heuristic still produces `velResult.segments` consumed by
  the frontend.
- The HSMM consumes the same observations + heuristic-as-labels,
  produces per-day decodes cached in `decoded_days`, and surfaces
  posterior marginals exposing model uncertainty.

The HSMM's **place** decode is live in the user-facing path: when a
decode exists in `decoded_days`, `Verified/Geo/PlaceOverride.lean` overrides
the heuristic's place attribution in the fold. **Mode** and **line**
are still heuristic-owned; the full cutover (the decoder owning mode
in the timeline) is gated on the measurement and phases tracked in
`docs/proposals/decoder-roadmap.md`. The `compare-hmm-vs-heuristic`
CLI is the audit harness behind those gates.

**Read `docs/design/probabilistic-principles.md` before adding
new factors, tuning parameters, or proposing changes.** That
document captures the architectural philosophy, the ground rules
(no hard constraints; graduated probabilities; runtime budget is
offline-side; expose uncertainty), and the current factor library.

The decode shell shipped through the joint-sequence and
HSMM-physical-constraints work (Viterbi + state space + emission +
transition; per-state duration distributions; sleep-coherence; learned
per-mode/per-place emissions). The forward plan — finishing the decoder
so it owns the day — lives in one place:

- `docs/proposals/decoder-roadmap.md` — the consolidated decoder plan
  (vision, generator/scorer architecture, measurement, Phases 0–5)
- learned per-mode emissions: #208 is closed and its proposal retired. A
  `learned_hmm_models` table exists and nothing reads it; fitting waits on a
  load path (#366).

## Future extensions

- Altitude-aware features (e.g. distinguish flat walk from stairs).
- "Patterns" tab — health × location correlations (largest product win).
- Off-site backup of `health` PVC (tracked under fleet-wide odin work).
- `daily_activity`'s Fitbit-only columns. ⚠ NOT the Google migration, which is
  done — ten of eleven streams are Google-owned and `daily_activity` cut over on
  `DAILY_ACTIVITY_CUTOVER` (2026-09-01), Fitbit keeping the history before it.
  What has no Google equivalent is `minutes_sedentary` and `active_score`: they
  stop when the Web API does. `google::source::STREAMS` is the roster and each
  entry carries the measurement that moved it.

## Where these things live now

⚠ **THE `src/**.ts` PATHS ABOVE ARE HISTORICAL** — see the note at the top. This
is the map from those names to the code that does the work today, BY SYMBOL: a
symbol survives a move, a line number does not (#919, #1205).

| the document says | today |
| --- | --- |
| `src/db/schema.ts` — the numbered migrations | `rust/backend/src/schema.rs` — the same array under the same rule: APPEND ONLY. The index IS the version and `schema_migrations` records applied indices, so a statement inserted in the middle is silently never applied while the log reports the schema up to date |
| `src/geo/velocity.ts` — owns the day, orchestrates the rest | `rust/backend/src/routes/velocity.rs` — `run` (the route) and `compute_with` (the day). ⚠ It no longer owns the reasoning: the passes are Lean, reached through `mirror_source::fold_from_mirror`. What is left here is orchestration and the cache around it |
