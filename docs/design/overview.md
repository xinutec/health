# health-sync — Design

Health-and-location aggregation and visualization service. Pulls Fitbit
biometrics on a schedule, fetches GPS history live from Nextcloud
PhoneTrack, joins them per "Your Day" timeline segment, and serves a
web dashboard authenticated through Nextcloud SSO. All running on
isis's k3s cluster behind `health.xinutec.org`.

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
   │  focus_places│  (Kysely typed)  │  (Hono + Kysely)    │
   │ )            │                  │   server.ts         │
   └──────────────┘                  └─────────┬───────────┘
                                               │
                              ┌────────────────┴───────────────┐
                              │ Velocity pipeline:             │
                              │  PhoneTrack → Kalman → segment │
                              │  classify → OSM enrich → join  │
                              │  with Fitbit biometrics        │
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

### Backend (`src/`)

TypeScript on Hono (lightweight HTTP framework). Two entry points:

- **`server.ts`** — HTTP server for the dashboard and OAuth flows.
  Serves the Angular SPA, API endpoints, and handles Nextcloud SSO +
  Fitbit OAuth.
- **`sync.ts`** — CronJob entry point. Iterates over all users with
  linked Fitbit accounts and syncs their data.

### Frontend (`frontend/`)

Angular SPA (currently v22 — see `frontend/package.json`). Zoneless,
standalone components, signals, Chart.js for visualization, Leaflet for
the map. Built to static files, served by the backend from `public/`.

### Infrastructure (`k8s/`)

Deployed on isis's k3s cluster in the `health` namespace:
- MariaDB 11.8 (Deployment + headless Service + PVC)
- health-auth (Deployment + Service running `server.ts`)
- health-sync (CronJob running `sync.ts` hourly)
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
src/
├── server.ts               # Hono app + HTTP server + request-timing + /health
├── sync.ts                 # CronJob: sync all users
├── config.ts               # Validated env config (zod)
├── types.ts                # Shared types (DB rows, API responses)
├── env.ts                  # AppEnv (Hono context types)
├── db/
│   ├── pool.ts             # MariaDB pool + Kysely instance (typed builder)
│   ├── schema.ts           # Numbered migrations, tracked in schema_migrations
│   └── tables.ts           # Kysely table type definitions
├── middleware/
│   ├── session.ts          # Session store, cookie signing, middleware
│   └── auth.ts             # requireAuth middleware
├── routes/
│   ├── api.ts              # /api/* data endpoints (incl. /api/velocity)
│   ├── nextcloud-oauth.ts  # /login, /auth/callback, /logout
│   └── fitbit-oauth.ts     # /fitbit/auth, /fitbit/auth?code=...
├── fitbit/
│   ├── client.ts           # HTTP client with rate limiting + refresh
│   └── sync/               # one module per Fitbit metric (activity, sleep,
│       └── …                 heartrate, body, spo2, hrv, breathing,
│                             temperature, devices)
├── nextcloud/
│   ├── client.ts           # Nextcloud OAuth + per-user-token client
│   ├── phonetrack.ts       # GPS point fetch + visualisation-filter sync
│   └── phonetrack-prefs.ts # per-user preference storage in NC user_prefs
├── geo/
│   ├── velocity.ts         # the orchestrator: PhoneTrack → Kalman →
│   │                         segments → the refinement pass cascade →
│   │                         episodes. The `passes` array in this file is
│   │                         the authoritative, ordered list of the ~40
│   │                         refinement passes — order is load-bearing and
│   │                         each entry's comment says why it sits there.
│   ├── timezone.ts         # tz-aware date bounds + Fitbit ts → unix
│   ├── kalman.ts           # gap-aware Kalman filter for raw GPS
│   ├── segments.ts         # first-pass mode classifier: fixed 5-minute
│   │                         windows → per-mode feature scores → merge.
│   │                         Windows score on median speed, so a window
│   │                         straddling a mode change goes wholesale to the
│   │                         majority mode — boundary defects from this are
│   │                         corrected (not always successfully, #348) by
│   │                         later passes, see episode-geometry.md
│   ├── passes/             # extracted refinement passes (rail absorbers /
│   │                         reconcile / tube-hop, …) — wired in velocity.ts
│   ├── episode-geometry.ts # display geometry per DayState (episode-geometry.md)
│   ├── pedestrian-match*.ts, walk-*.ts, road-match*.ts, rail-snap.ts
│   │                       # per-mode drawn-path machinery (geometry-roadmap.md)
│   ├── place-snap.ts / focus-places.ts / place-prior.ts / venue-*.ts
│   │                       # stay place attribution
│   ├── osm.ts / osm-local.ts  # Overpass/Nominatim + local OSM mirror
│   └── biometrics.ts       # segment HR / cadence / sleep enrichment
├── hmm/                    # HSMM decoder (shadow; place-override is live) —
│                             see proposals/decoder-roadmap.md
└── cli/                    # capture (capture-golden, capture-day), replay
                              (golden-check, analyze-day, decode-day), scoring
                              (score-walk-match, score-decoder-golden, …) and
                              probe tools — one file per job, see src/cli/
```

## Testing and gates

Vitest across `tests/` (~160 test files; auth, timezone math, the full
geo pipeline, OSM cache mechanics, HSMM decode, and scenario tests that
run synthetic days end-to-end). Tests share the same strict type
checking as production code, so a stale call into a refactored
signature surfaces immediately.

Beyond the unit suite, three replay gates guard behaviour on **real
captured days** (fixtures gitignored — see
`privacy-in-tests-and-commits.md`):

- `scripts/verify.sh` — typecheck (src + tests), biome, vitest,
  frontend build + e2e. Run by the pre-commit hook.
- `scripts/golden.sh` — replays the golden day corpus
  (`tests/golden/days/`) byte-identically, checks confirmed ground
  truths, worldline feasibility, and the journey ratchet.
- `scripts/walk-gate.sh` — the walk-geometry referee
  (`score-walk-match`) against the per-metric ratchet floor in
  `tests/golden/walk-baseline.json` (tracked in git, moved only by an
  explicit re-bless).

`scripts/deploy.sh` runs all three before building, pushing, and
rolling out. Every script enters the pinned nix devshell itself
(`scripts/_devshell.sh`) — run them directly, no wrapper needed.

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

Migrations are numbered SQL statements in `src/db/schema.ts`. A
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
overlays. Owned by `src/geo/velocity.ts`; orchestrates the rest of
`src/geo/` plus the Nextcloud and DB layers.

```
fetchTrackPoints (Nextcloud, live)
       │
       ▼
filter to date bounds in user's tz (timezone.ts)
       │
       ▼
snapToPlace ← focus_places (DB)
       │
       ▼
filterGpsTrack (kalman.ts) — gap-aware Kalman
       │
       ▼
classifySegments (segments.ts) — window features → mode score
       │
       ▼
per segment, in parallel:
   bestPlace / placeLabel / nearbyWays (osm.ts)  ──► osm_cache (DB)
   enrichSegmentWithBiometrics (biometrics.ts)   ──► fitbit tables (DB)
       │
       ▼
refinement pass cascade (velocity.ts `passes` — rail runs, underground
reconstruction, boarding/alight anchors, journey assembly, vehicle
splits, walk/road/rail drawn paths, HSMM place override, …)
       │
       ▼
EnrichedSegment[] → DayState[] (day-state.ts) + EpisodeGeometry[]
(episode-geometry.ts) → API response (Angular timeline + map)
```

### Caches and their purpose

Three caches sit in front of the slow parts. Each is a *cache*, not a
source of truth — wiping any of them is safe; the next request rebuilds.

- **`focus_places`** (per-user) — clusters of overnight + frequent
  presence, computed offline by `refresh-focus-places.ts` (full
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
  In-flight requests are deduped via a `Map<key, Promise>`.
- **`place_snap` decisions** — not a DB table; the `snapToPlace`
  function is pure given `focus_places`.

### Performance and observability

- **Per-step timing.** `computeVelocity` instruments each stage and
  emits one summary line on completion: `velocity 2026-05-10
  user=pippijn: total=4200ms phonetrack=820ms loadPlaces=15ms
  kalman=22ms segments=8ms osm=3100ms biomLoad=180ms biomEnrich=12ms
  segments=14`. Surfaces which stage dominates without ad-hoc logging.
- **Request-timing middleware.** Hono middleware logs any request
  ≥100ms with method, path, status, duration. Quieter than logging
  everything, surfaces real bottlenecks immediately in `kubectl logs`.
- **`/health` endpoint.** Bare `GET /health` returns `ok` (k8s
  liveness friendly). `GET /health?detail=1` returns JSON with DB
  latency, focus-places count, osm-cache size, last-sync date, and
  process uptime.
- **OSM mirror fallback.** Each Overpass call is wrapped in
  `AbortController` with a 4s timeout. On primary failure or timeout,
  falls through to the kumi.systems mirror within 4s rather than
  hanging on the kernel TCP timeout (was minutes before).
- **HR per-minute aggregation.** Fitbit stores 1-second-resolution
  HR (~21k rows/day). For segment-level mean/std the per-minute
  average loses essentially no precision and is ~60× cheaper to
  load + parse. Done in SQL via Kysely's typed builder with `sql\`...\``
  for the `GROUP BY DATE_FORMAT(...)` aggregate.
- **Cached `Intl.DateTimeFormat`.** One formatter per tz, module-level
  `Map`. Was a 90s+ hot loop hit when called once per Fitbit timestamp.

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

The per-segment mode classification in `segments.ts` is the
heuristic that has shipped since day one. A **probabilistic
constraint solver** (HMM → HSMM with learned emissions, posterior
marginals, sleep-conditional factors) is being built alongside it
under `src/hmm/`. The two coexist:

- The heuristic still produces `velResult.segments` consumed by
  the frontend.
- The HSMM consumes the same observations + heuristic-as-labels,
  produces per-day decodes cached in `decoded_days`, and surfaces
  posterior marginals exposing model uncertainty.

The HSMM's **place** decode is live in the user-facing path: when a
decode exists in `decoded_days`, `place-override.ts` overrides the
heuristic's place attribution in `velocity.ts`. **Mode** and **line**
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
- `2026-05-hmm-learned-emissions.md` — supervised MLE per-mode +
  per-place emission distributions (#208)

## Future extensions

- Altitude-aware features (e.g. distinguish flat walk from stairs).
- "Patterns" tab — health × location correlations (largest product win).
- Off-site backup of `health` PVC (tracked under fleet-wide odin work).
- Google Health API migration (Fitbit API deprecated September 2026).
