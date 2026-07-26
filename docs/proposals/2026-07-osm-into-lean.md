# OSM into Lean — push raw rows, not captured answers

Goal: let Lean own the spatial predicate. Today "the nearest station to this
fix" is computed by MariaDB and reaches the algorithm as a number; nothing about
it can be stated or proved. Pushing the raw OSM rows instead and doing the
distance work in Lean makes the predicate a definition, which is what later
theorems (nearest-station selection, dedupe-keeps-closest, monotonicity in
radius, stability under sub-gap perturbation) need in order to exist at all.

This is the last architectural item before the pass-order pipeline can fold in
Lean: 14 of `computeVelocityFromInputs`'s 37 passes thread `inputs.osm` lookups
in at the call site, so the fold cannot be written until the OSM shape is fixed.

## The alternative, and why it is not taken

`RecordingOsmAdapter` / `FixtureOsmAdapter` (#235 Phase 6e) already implement a
pushed table: every adapter call is captured as `(lat, lon, radius) → result`
and replayed by exact key. It works, it is validated on 32 golden days, and
extending it to production would need no new Lean at all.

It is not taken because the captured value *is* the answer. Replaying it keeps
the spatial predicate an oracle forever, so no property of station selection can
ever be stated. That is precisely the value being bought here, so the cheaper
route forfeits the point rather than deferring it.

## Measurements (2026-07-26, against the live mirror)

Taken via `kubectl -n health exec deploy/health-db` on `isis.xinutec.org`. Note
that bare `isis` resolves to a different host.

- **MariaDB 12.3.2 `ST_Distance_Sphere` uses R = 6370986.0 m exactly** — one
  degree of latitude measures 111194.68229846345 m. `FloatScore.haversineMeters`
  uses 6371000: 2.2 ppm apart, 0.24 m per degree, sub-millimetre at the 100–400 m
  radii these queries use.
- A haversine at 6370986 agrees with MariaDB to ~1e-9 m but **not bit-exactly**
  (18–97888 ULP over five sample pairs); MariaDB arranges the formula
  differently. This does not constrain the design — see below.
- Mirror size: `osm_points` 495,905 rows / 230 MB, `osm_lines` 1,813,334 /
  1010 MB.
- **A buffered-track superset is 11k–19k rows per day at a 300 m buffer.** Fixes
  snapped to 150 m cells: 2026-07-06 = 3354 points + 11905 lines, 2026-07-10 =
  4457 + 14991, 2026-06-02 = 2593 + 9064. The naive whole-day bounding box is
  5.6× worse (07-06: 19968 + 65603).
- The existing fixture already carries 21,024 distinct rows / 19.7 MB for one
  day, so the superset is **no larger than what already crosses the boundary**.

### Buffer sizing — 300 m is NOT enough

Of 3619 captured query coordinates across 32 days, 95% lie within 50 m of a raw
GPS fix and 99.8% within 250 m. That percentile view is misleading for a
superset, which has to cover 100%: the observed **maximum is 435.5 m**
(2026-06-29, a `drivableRoads` query), and a 300 m buffer would miss a query on
**3 of the 32 days**. The far queries are the passes that ask at DERIVED points —
matched-path vertices and resolved station coordinates — not at fixes.

500 m covers all 32 days. Row cost for 2026-07-10 scales as: 300 m = 19,448
rows, 500 m = 34,487, 1000 m = 63,635. So 500 m costs 1.8× the 300 m figure and
remains the same order as the fixture already ships.

**Empirical sizing is not a guarantee**, so the buffer must be paired with a
COVERAGE ASSERTION: the pushed table carries the boxes it was built from, and a
query landing outside them is a hard error rather than a silently short result.
This is the same shape as the existing `isCovered` check that guards the
Overpass mirror, and it is what makes an over-fetch safe to rely on — a miss
becomes loud, exactly as `FixtureOsmAdapter` throws on an uncaptured key.

## Consequence of the radius difference

Under this design the DB stops computing distances — it ships rows, and Lean's
haversine becomes the definition of distance. There is therefore no requirement
to reproduce MariaDB's arithmetic, and the 1e-9 m formula gap is not a defect to
chase. The cost is a one-time golden re-bless; the deltas are sub-millimetre, so
few if any decisions should move. Any that do move are worth reading as findings
rather than fixed away.

## Scope

To port (the `queryPoints` / `queryLines` kernel in `src/geo/osm-local.ts`, and
its consumers in `src/geo/osm.ts`):

- the MBR box test, `ST_Distance_Sphere < radius`, ordering by distance, and the
  `LIMIT 50` truncation. The limit never binds for the methods the pass list
  calls — `nearbyStations` returns at most 11 rows and `linesAtPoint` at most 14
  across the corpus — but it does bind for `walkableRoads` (up to 20000) and
  `buildingsNear` (up to 5364), whose own caps need reproducing.
- `deriveStationSubtype` and `dedupeStationsByName`. The latter carries a
  documented trap: a station and its entrances are separate points sharing a
  name, and naive keep-closest picks the entrance, which `pickBestStation` then
  filters out — deleting the station entirely.
- the line-side equivalents feeding `linesAtPoint`.

Staying in the shell:

- `ensureCovered` — an Overpass fetch when the mirror is cold. Genuine I/O.
- `reverseGeocode` — Nominatim, a third-party HTTP service not mirrored at all.
  Remains a pushed answer-table.
- `stationsOnLine` — keyed by line name rather than coordinates, so there is no
  bbox to take. Also a table, just not a spatial one.

## Order

1. Lean spatial kernel + guards against V8, driven from captured rows. DONE:
   points (`6ea6992`) and lines (`45d830a`), 25 probes.
2. Capture path: query the buffered track once per day at a 500 m buffer,
   serialise raw rows, and record the coverage boxes alongside them.
3. Swap the injected lookups to read the pushed table.
4. Re-bless the golden corpus; read whatever moves.
5. Then the pass-order pipeline, then the `day` serve mode.
