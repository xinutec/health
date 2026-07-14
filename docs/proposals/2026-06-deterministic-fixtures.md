---
created: 2026-06-04
updated: 2026-06-04
status: design (revised — adapter pattern for unbounded sources)
references:
  - 2026-06-presence-continuity.md
  - decoder-roadmap.md
---

# Deterministic fixtures for the classification pipeline

## Problem

`computeVelocity` and `decodeAndPersist` are pure functions in their
intent but impure in their dependencies. Each reads from mutable
external state at call time:

- **PhoneTrack/Nextcloud HTTP** — raw GPS fix range fetches
- **`heart_rate_intraday`, `sleep_stages`, `steps_intraday`** —
  Fitbit biometrics, ingested continuously
- **`mode_biometrics`** — per-user mining output, refreshed weekly
- **`focus_places`** — visit-frequency mining output, refreshed
  weekly; `visit_weight` and `hour_profile` shift with every refresh
- **`osm_lines`, `osm_points`, `osm_cache`, `osm_coverage`** — OSM
  mirror, refilled on cache misses
- **`rail_route_cache`** — rail geometry mining output, refreshed
  nightly
- **`decoded_days`** — HSMM output, written by every decode-day run
- **`presence_log`** — cross-day continuity rollup, written by every
  refresh-presence-log run

The golden harness (`tests/golden/`) compares live `computeVelocity`
output against a frozen `expected/<date>-<user>.json` baseline. Every
one of the eight bullets above is a silent drift channel: change any
of them between bless time and check time and the diff surfaces as
"golden regression" with no way to attribute the change to a specific
input.

The regression seen on 2026-06-03 is the canonical example:
re-running `decode-day` for 2026-04-29 / 04-30 / 05-20 / 05-22 during
an unrelated A/B test rewrote `decoded_days` with HEAD code. The
goldens, blessed earlier the same day, then diffed against a
different `decoded_days` row than the bless had captured. The
"continuity flag broke 4 goldens" conclusion was wrong — none of the
flag's code paths fired (flag was off, guard short-circuited). The
goldens broke because `decoded_days[04-30]` changed under them, and
they had no way to see that.

This shape recurs every time a non-input mutates: weekly mining, the
nightly cron, a teammate running `decode-day` locally, the user
re-syncing PhoneTrack. The current test surface cannot distinguish
"my code change broke this" from "the world changed under the
baseline".

## Principle

Tests are reproducible by construction. The pipeline's behaviour on a
given input must be a deterministic function of that input — no
"and whatever the DB happens to hold today". To enforce this, the
pipeline boundary becomes explicit: every external read is plumbed
through a single `ClassificationInputs` value, and the pipeline never
reads from a DB or a network. Production wraps the pipeline with a
DB-loader; tests wrap it with a fixture-loader. Same pipeline, two
sources.

A captured fixture is the **closure** of one day's classifier inputs:
every byte the pipeline needs to produce its output, with no DB
fallthrough. Re-running the pipeline against the fixture is a pure
function call. Re-blessing is an explicit code review of the diff,
not a side effect of running anything.

## Design

### Bounded vs unbounded sources

The external reads split in two by call pattern:

- **Bounded sources** — a fixed set of queries per (user, date) returning
  fixed-shape projections. Three PhoneTrack window fetches; one
  `focus_places` user-scoped query; biometric streams clipped to the
  day's UTC window; the single `decoded_days[date]` row; the whole-table
  `rail_route_cache`. For these, the right capture is the *row set*:
  copy the projection into the inputs value, replay by reading the field.
- **Unbounded sources** — query count and arguments depend on
  pipeline-internal decisions (segment shape, sample points, rail-run
  triggers, sleep-window recursion). OSM (`nearbyWays`, `nearbyStations`,
  `nearbyLandmarks`, `linesAtPoint`) and Nominatim (`reverseGeocode`)
  are both unbounded. For these, the right capture is *the adapter
  interface*: define the lookups as a typed interface, pass an
  implementation through inputs, and let production use a DB-backed
  implementation while tests use a fixture-backed one.

The bounded sources stay row-set. The unbounded sources become adapters.

### The input boundary

Introduce `ClassificationInputs`:

```ts
interface ClassificationInputs {
  // Identity
  userId: UserId;
  date: string;           // YYYY-MM-DD, local
  displayTz: string;      // IANA timezone

  // PhoneTrack fixes for three contextual windows. Same shape the
  // current pipeline pulls — three fetches off one openPhoneTrack
  // session.
  phonetrack: {
    today: TrackFix[];           // full local day
    morning: TrackFix[];         // next-day midnight → next-day morning
    priorEvening: TrackFix[];    // prior-day evening
  };

  // Biometrics — Fitbit series clipped to the day's UTC window.
  biometrics: {
    hr: HrSample[];
    sleepStages: SleepStageSample[];
    steps: StepSample[];
    modeBiometrics: ModeBiometricsRow[];   // per-user, all rows
  };

  // Place / line snapshots — the relevant rows only.
  focusPlaces: FocusPlaceRow[];            // all user rows
  presenceLogPriorDay: PresenceLogRow | null;

  // Unbounded sources — adapter interface, not row set. See
  // "Bounded vs unbounded sources" above.
  osm: OsmAdapter;
  railRoutes: RailRouteCacheRow[];         // routes used by the day's runs

  // Optional HSMM override — when testing the HSMM decode in isolation
  // we skip this; for the velocity-layer golden we supply the HSMM
  // output that velocity reads via loadDecode().
  hsmmDecode: DecodedSegment[] | null;
}
```

The shape mirrors what the pipeline reads from the DB today. No new
fields, no anonymisation pass. The whole point is that this is the
exact closure of inputs.

### The OSM adapter

```ts
interface OsmAdapter {
  nearbyWays(lat: number, lon: number, radiusM?: number): Promise<NearbyWay[]>;
  nearbyStations(lat: number, lon: number, radiusM?: number): Promise<NearbyStation[]>;
  nearbyLandmarks(lat: number, lon: number, radiusM?: number): Promise<NearbyLandmark[]>;
  linesAtPoint(lat: number, lon: number, radiusM?: number): Promise<Set<string>>;
  reverseGeocode(lat: number, lon: number, zoom?: number): Promise<NominatimResult | null>;
}
```

Three implementations:

- `DbOsmAdapter` — wraps the existing `osm.ts` top-level functions.
  Production injects this; behaviour is byte-identical to today.
- `RecordingOsmAdapter` — wraps another adapter (typically
  `DbOsmAdapter`), delegates each call, and records the
  `(args → result)` pair into an `OsmTrace` keyed by
  `${lat}|${lon}|${radius?}`. Used during `capture-day-v2`. `Set<string>`
  results (`linesAtPoint`) serialise as `string[]` for fixture JSON
  round-trip; deserialisation rebuilds the Set.
- `FixtureOsmAdapter` — answers calls by exact-key lookup in the
  trace. An uncaptured query throws an actionable error
  ("uncaptured nearbyWays(51.5, -0.1, 50) — re-capture required");
  the harness surfaces it as the test failure rather than the diff
  against `expected.velocity`, pointing the developer at the actual
  cause. Used during `golden-check-v2`.

Why exact-key replay for every primitive (not row-set filtering):

- The classification pipeline is deterministic in its inputs. Kalman
  is pure; segmentation is pure; OSM call sites are reached at the
  same `(lat, lon, radius)` for the same captured PhoneTrack window.
  Exact-key replay returns byte-identical results.
- A code change that moves a call site (different coordinates,
  different radius) is exactly the kind of change the golden should
  catch. Replay throws "uncaptured query", which is a clearer and
  more localised failure mode than a downstream behaviour diff. The
  developer re-captures explicitly, which is the deliberate-capture
  property the proposal promises.
- Serialisation is trivial: the trace is `Record<string, T>` keyed
  by call args. No row-set parsing, no spatial-kernel kernel at
  replay time, no question of "did we capture a wide enough radius".

The unbounded-source over-capture problem that bbox-scale loading
would have (load everything the pipeline might query, in advance, to a
bbox big enough to be safe — measured at 16 minutes per day on the
King's Cross radius) does not arise here: capture is exactly what the
pipeline asked for, by construction.

### The function refactor

```ts
// before:
async function computeVelocity(
  config: Config,
  userId: string,
  date: string,
  tz: string,
): Promise<VelocityResult> { ... }

// after:
async function computeVelocity(
  inputs: ClassificationInputs,
): Promise<VelocityResult> { ... }

// production loader (does what the current function does at the
// boundary, called by /api/velocity, decode-day, capture-day):
async function loadClassificationInputs(
  config: Config,
  userId: string,
  date: string,
  tz: string,
): Promise<ClassificationInputs> { ... }
```

`computeVelocity` becomes pure-in-inputs. No `selectFrom`, no
`openPhoneTrack`, no `loadDecode`. All of those move to
`loadClassificationInputs`.

Same refactor for `decodeAndPersist` (decode-day): split into
`loadHsmmInputs(...)` and `decodeHsmm(inputs): HmmResult`.

### The fixture format

Each golden day becomes one file:

```
tests/golden/days/<date>-<user>.json
```

with shape:

```ts
interface CapturedDay {
  meta: {
    fixtureFormatVersion: number;       // bump on schema change
    capturedAt: string;                 // ISO
    capturedAtCodeSha: string;          // git rev at capture
    description: string;                // from manifest
  };
  inputs: ClassificationInputs;         // the closure
  expected: {
    velocity: NormalizedState[];        // what golden-check compares
    decode: DecodedSegment[] | null;    // HSMM-isolated comparison
  };
  groundTruth: GroundTruth | null;      // hand-edited; never overwritten by --bless
}
```

`tests/golden/days/` is gitignored (same private-data rationale as
the current setup). The whole file is the unit of versioning — the
manifest is replaced by the union of files under `days/`.

### The harness

```
golden-check-v2.js                 # reads tests/golden/days/*.json
  for each fixture:
    inputs = fixture.inputs
    actual = computeVelocity(inputs)
    if actual != fixture.expected.velocity:
      print diff
      exit 1

golden-check-v2.js --bless         # for each fixture: update expected.velocity = actual
golden-check-v2.js --bless DATE    # one day

capture-day-v2.js DATE USER TZ     # connects to prod DB, dumps a fresh fixture
  inputs = loadClassificationInputs(config, user, date, tz)
  actual = computeVelocity(inputs)
  write tests/golden/days/<date>-<user>.json with inputs + expected + groundTruth: null

recapture-day-v2.js DATE USER      # re-pulls inputs, keeps groundTruth, requires --bless to update expected
```

`--bless` updates `expected.velocity` from the current pipeline run
against the **already-captured** inputs. It does not re-pull inputs.
This is the key inversion: blessing edits the expected side of the
file, never the inputs side. To refresh inputs from prod you must run
`capture-day-v2` (overwrites inputs + clears expected) or
`recapture-day-v2` (overwrites inputs, keeps expected, requires
explicit bless on the diff).

### Why this is the right boundary

- **Refactor cost is bounded.** Two functions move: `computeVelocity`
  and `decodeAndPersist`. The boundary already exists informally —
  every external read is in the first 50 lines of each function.
- **No prod behaviour change.** Production routes still call
  `loadClassificationInputs(config, ...)` then `computeVelocity(...)`.
  Same DB queries, same wire calls, same output.
- **Tests don't touch a DB.** No port-forward, no mock pool, no
  parity worries. `npm run golden-v2` runs against files only.
- **Code SHA recorded.** When a fixture was captured against commit
  `abc123` and current code differs, the test reports
  `captured_at_code_sha != current_sha` as part of the diff context.
  Doesn't fail — just informs.
- **Mining as input.** `focus_places` (with its `visit_weight` and
  `hour_profile`) is just another field on the fixture. A new mining
  cycle doesn't silently invalidate older fixtures; it requires
  explicit re-capture per day.
- **No hidden state.** `decoded_days` becomes part of the fixture for
  velocity-layer goldens, or the HSMM decode is what's being tested
  and the input is observation tensor inputs only. Either way the
  test is closed.

### What this does *not* do

- Does not anonymise. Fixtures still contain real GPS, real place
  names, real biometric series. They stay gitignored.
- Does not add CI integration. Golden-v2 remains a local-only check
  until anonymisation or synthesis lands. The gain is reproducibility
  on a developer's machine, not CI.
- Does not change the HSMM, the velocity pipeline, or any classifier
  behaviour. Pure refactor + new I/O layer.
- Does not address the cascade-vs-scorer split (#177). That is a
  separate decision about which classifier path is canonical; once
  goldens are deterministic, that decision can be made by comparing
  fixture outputs across both paths.
- Does retire `USE_CONTINUITY_CONTINUATION` once HSMM goldens land
  (Phase 9). Any other "we needed a flag because we couldn't test
  this safely" can retire on the same pattern.

## Phasing

Each phase is small enough to bisect against, large enough to be
useful on its own. Phases land in order; nothing is half-shipped.

The split between bounded-source row-set phases (1, 2a, 4, 5) and the
unbounded-source adapter phases (6c onward) is deliberate: the row-set
work landed without architectural friction; the OSM/Nominatim phases
need the adapter shape (see "Bounded vs unbounded sources" in Design).

**Naming (landed 2026-06-07).** The phases below say `capture-day-v2` /
`golden-check-v2`, framing the new harness as scaffolding to be renamed
in Phase 6i. In practice it landed under its permanent names from the
start — `golden-check.ts` (the deterministic replayer), `capture-golden.ts`
(the prod capture), `fixture-day.ts` (the format) — with no version
suffix. A version suffix in a filename is only justified when two
implementations must run *at the same commit* (a strangler migration's
brief overlap, concurrently-served API versions); git handles everything
temporal. Here the overlap was a single session: capture all ten golden
days, confirm they replay, then replace the live-DB `golden-check.ts` in
place and delete the local `manifest.json` + `expected/` (the `days/`
fixtures are the corpus now). Phases 6f–6i collapse into that one
cutover.

### Phase 1: `ClassificationInputs` type + production loader  ✅

- Type defined in `src/geo/classification-inputs.ts`.
- `loadClassificationInputs` implements the eager DB+HTTP read path
  used by `computeVelocity` (PhoneTrack windows, focus_places,
  biometrics, mode_biometrics).
- Smoke test pins the shape so additive evolution stays additive.

### Phase 2a: consolidate eager loads through the loader  ✅

- `computeVelocity` calls `loadClassificationInputs` once instead of
  the inlined eager reads. No API change to `computeVelocity` yet.

### Phase 4: lift `decoded_days[date]`  ✅

- One row added to inputs; velocity reads the HSMM override from
  there instead of `loadDecode(...)` at request time.

### Phase 5: lift `rail_route_cache`  ✅

- Whole-table load (a few hundred polylines) added to inputs.
- `annotateSnappedPaths` becomes pure in the rail-route cache argument.

### Phase 6a: pure spatial helpers (retired)  ✅ → reverted

- `nearbyWaysInSnapshot` / `nearbyStationsInSnapshot` in
  `src/geo/osm-pure.ts` originally intended as the "filter a row-set"
  half of the now-replaced row-set frame. Phase 6e moved to exact-key
  replay, which has no use for the snapshot helpers. The whole module
  + its tests were deleted in `0db84dc`. `pointToLineDistanceMParsed`
  and `parseLineStringWkt` in `line-stations.ts` un-exported (they had
  no other consumer).

### Phase 6b: snapshot field placeholder (superseded)  ✅ (will be revised)

- `osm: OsmSnapshot` field added to `ClassificationInputs`; loader
  populated an empty snapshot pending the design call.
- Phase 6c renames the field to `osm: OsmAdapter` and changes its
  type. The empty-snapshot loader path is removed.

### Phase 6c: OSM adapter interface + `DbOsmAdapter`

- Define `OsmAdapter` in `src/geo/osm-adapter.ts`.
- Implement `DbOsmAdapter` as a 5-method wrapper over the existing
  `nearbyWays` / `nearbyStations` / `nearbyLandmarks` / `linesAtPoint`
  / `reverseGeocode` functions in `osm.ts`.
- Change `ClassificationInputs.osm` from `OsmSnapshot` to `OsmAdapter`.
- `loadClassificationInputs` constructs a `DbOsmAdapter`.
- velocity.ts callers unchanged in this phase — they still call the
  top-level functions; Phase 6d migrates them.
- Drop the dead `loadOsmSnapshotForDay` / `loadOsmLinesWithGeom` /
  `loadOsmPointsWithGeom` machinery from `load-classification-inputs.ts`.
- Outcome: the unbounded-source boundary is named; no behaviour change.

### Phase 6d: migrate velocity.ts call sites to `inputs.osm`

- One call site at a time: `nearbyWays(...)` → `inputs.osm.nearbyWays(...)`.
- Threading: velocity.ts already receives `inputs` after Phase 2a;
  internal helpers that need OSM access (`bestPlace`, the rail-run
  annotators) get an explicit adapter parameter.
- After this phase, `computeVelocity` reads OSM exclusively through
  the adapter. No top-level imports of `nearbyWays` etc. in the
  pipeline.

### Phase 6e: `RecordingOsmAdapter` + `FixtureOsmAdapter`  ✅

- `RecordingOsmAdapter(inner)`: every call delegates to `inner` and
  records the `(args → result)` pair into an `OsmTrace` keyed by
  `${lat}|${lon}|${radius?}`. `Set<string>` results serialise as
  `string[]` for fixture JSON round-trip.
- `FixtureOsmAdapter(trace)`: answers each call by exact-key lookup.
  An uncaptured query throws an actionable error
  ("uncaptured nearbyWays(51.5, -0.1, 50) — re-capture required") so
  the harness points at the actual cause rather than a downstream
  behaviour diff.
- Eleven unit tests cover capture, replay, error path, and JSON
  round-trip in `tests/osm-adapter-recording-fixture.test.ts`.

### Phase 6f: fixture format + `capture-day-v2` + first migration

- `CapturedDay` zod schema with `fixtureFormatVersion: 1`. Contains
  the row-set fields from inputs plus the captured `OsmTrace`.
- `capture-day-v2 <date> <user> <tz>` CLI: builds inputs with a
  `RecordingOsmAdapter`, runs `computeVelocity`, writes the fixture.
- `golden-check-v2`: reads fixture, builds inputs with a
  `FixtureOsmAdapter`, runs `computeVelocity`, diffs vs
  `expected.velocity`. `--bless` updates `expected.velocity` only.
- Migrate one existing golden day (2026-05-15 — multi-modal, no
  sparse-day weirdness). Both v1 and v2 pass for that day.

### Phase 6g–6h: migrate the remaining 9 golden days

- One commit per day. Per-day v1↔v2 expected diff reviewed and
  documented in the commit message.

### Phase 6i: decommission v1

- Delete `tests/golden/manifest.json`, `tests/golden/expected/`,
  `src/cli/golden-check.ts`, `src/cli/capture-day.ts`.
- Rename `*-v2` → `*`. `npm run golden` points at the new harness.
- Outcome: one harness, one format.

### Phase 7: HSMM-layer refactor — `HsmmInputs` + adapters

- Same shape as the velocity layer:
  - Row-set fields for the bounded sources `decodeAndPersist` reads:
    filtered points, biometrics, focus_places, route graph,
    `presence_log[date-1]`.
  - Adapter field for any unbounded source the HSMM uses. (Today
    the HSMM reuses the velocity layer's OSM access, so this is
    likely just propagating `OsmAdapter` into `HsmmInputs`.)
- `loadHsmmInputs(config, userId, date, tz)` and
  `decodeHsmm(inputs): HsmmResult` + a thin wrapper that loads,
  decodes, and persists. Production cron + `decode-day` CLI use the
  wrapper; tests use `decodeHsmm` directly.

### Phase 8: HSMM-isolated golden harness

- Fixture format `tests/golden/decoded_days/<date>-<user>.json`.
- `capture-hsmm-day-v2` + `golden-check-hsmm-v2`, both following the
  Phase 6 pattern.
- Migrate hospital-week days first — cross-day continuity is the
  HSMM-layer behaviour that started this work.

### Phase 9: retire flags

- With HSMM goldens in place, `USE_CONTINUITY_CONTINUATION` retires
  to default-on. Any other HSMM-gating flag whose only reason to
  exist was "we couldn't test this safely" follows the same path.
- This is the payoff: feature flags retire once tests can hold the
  behaviour they were protecting.

## End state

```
production:
  /api/velocity      → loadClassificationInputs(..., DbOsmAdapter)
                       → computeVelocity(inputs)
  decode-day cron    → loadHsmmInputs(..., DbOsmAdapter)
                       → decodeHsmm(inputs) → persist
  capture-day        → loadClassificationInputs(..., RecordingOsmAdapter)
                       → write fixture (row-set + OsmTrace)
  capture-hsmm-day   → loadHsmmInputs(..., RecordingOsmAdapter)
                       → write fixture

tests:
  golden-check       → read fixture → computeVelocity(inputs with FixtureOsmAdapter)
                       → diff expected
  golden-check-hsmm  → read fixture → decodeHsmm(inputs with FixtureOsmAdapter)
                       → diff expected

  No DB. No network. Pure given (data inputs, adapter).
```

Two pipelines, two thin wrappers, two fixture types, one adapter
interface shared across both. No flags protecting un-tested code
paths. No `decoded_days` drift hiding behaviour change. No OSM drift
hiding behaviour change.

## Open questions

1. **Fixture size**: capturing the OSM row-set via
   `RecordingOsmAdapter` records only the rows the pipeline actually
   touches (deduped by `osm_id`). A typical London day touches
   ~5–50K unique rows; serialised this is ~500 KB to 5 MB per
   fixture. Acceptable on local disk; on the boundary of "matters
   for CI" — revisit at Phase 6f when the first real fixture exists.

2. **PhoneTrack response replay**: captured as row-sets (three
   windows) under the bounded-source path. Phase 1 already plumbed
   this — no separate injection point needed.

3. **`decoded_days` as input vs computed**: for velocity-layer
   goldens, the HSMM output is an input (so we don't have to
   re-decode at test time). For HSMM-layer goldens, it's the output.
   Phase 4-6 covers the velocity case; Phase 7 the HSMM case.

4. **Schema evolution**: when a new column is added to e.g.
   `focus_places`, existing fixtures lack it. Two choices:
   - Bump `fixtureFormatVersion`, refuse to load old fixtures,
     require re-capture (clean but expensive).
   - Make the schema permissive (zod defaults), let old fixtures load
     with missing fields as null/default (organic migration).
   Lean toward the second; bump version only when the missing field
   changes classifier output.

5. **Multi-day chains**: presence-continuity uses the prior day's
   `presence_log` row. For a multi-day chain golden (testing the
   chain itself), each day needs the prior day's fixture's `expected`
   to be its `presenceLogPriorDay` input. The fixture format
   supports this naturally — the dependency is just on
   `presence_log[date-1]`, which is captured as part of each day's
   inputs.

## What "done" looks like

- `tests/golden/days/*.json` is the single source of truth for golden
  expectations.
- `golden-check.js` reads no DB, no network. Exit 0 = pure-function
  equality.
- Re-running any commit's `golden-check.js` produces the same result.
  No flakiness from mining cycles, cron writes, or PhoneTrack drift.
- Capture is a deliberate act: `capture-day` or `recapture-day` with
  explicit `--bless` to accept a diff. Goldens cannot drift without
  an audited commit.
- The 2026-06-03 confusion is structurally impossible.
