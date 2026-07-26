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
  5.6× worse (07-06: 19968 + 65603) — which is why the boxes are per-cell and
  are NOT merged: a day with a train trip is a continuous chain of cells, and
  merging collapses it back to the whole-trip bbox.
- The existing fixture already carries 21,024 distinct rows / 19.7 MB for one
  day, so the superset is **no larger than what already crosses the boundary**.
  (Row cost at the final 1500 m buffer is measured in step 2 below.)

### Buffer sizing — measured twice, wrong the first time

The first sizing pass here asked "how far from a fix does the pipeline query?"
and answered 435.5 m, concluding 500 m. **That was the wrong question.** A query
needs every row within its OWN RADIUS of its own coordinate, so the requirement
is

    buffer ≥ max over queries of (offset to nearest fix + query radius)

and the radius term is the larger one. Re-measured over the 32 golden days
(`lean/experiments/osm-buffer-sizing.mts`), 500 m is short on **32 of 32 days**,
not 3. The first pass measured one of the two terms and read the total off it.

The two terms are different kinds of number, and only one is empirical:

- **The radius is a ceiling, not a sample maximum.** Every kernel call site
  passes a module constant — `RAIL_JOURNEY_LINES_RADIUS_M` (800),
  `RAIL_RUN_STATION_RADIUS_M` (400), `UNDERGROUND_STATION_RADIUS_M` (350),
  `UNDERGROUND_LINES_RADIUS_M` / `ENDPOINT_LINES_RADIUS_M` (300),
  `STATION_AT_ALIGHT_RADIUS_M`, and the `nearbyWays` (50) /
  `nearbyLandmarks` (100) / `nearbyTransitStops` (50) defaults. None is derived
  from data, so **800 m bounds it by construction**.
- **The offset is empirical**: 428 m worst across the corpus, from the passes
  that query at DERIVED points — matched-path vertices, resolved station
  coordinates — rather than at fixes.

### The buffer is per feature type, not global

A single buffer would have to be the widest requirement, and every feature type
would pay it. That is the wrong trade here because **the widest requirement and
the densest table are not the same one**. Per feature type, worst need across
the corpus:

| feature type | worst need | asked by |
| --- | --- | --- |
| `railway` | 1227.9 m | `linesAtPoint` @ 800 |
| `landmark` | 282.2 m | `nearbyLandmarks` @ 100 |
| `highway` / `waterway` / `aeroway` | 262.1 m | `nearbyWays` @ 50 |
| `transit_stop` | 89.0 m | `nearbyTransitStops` @ 50 |

Only `railway` — a sparse table — needs the wide buffer. `highway`, by far the
biggest, is asked exclusively at 50 m. So: **`railway` 1500 m, everything else
500 m.** Measured on 2026-07-10, that is 46,024 rows against 133,284 for a
uniform 1500 m — a 2.9× cut whose dropped rows no query could ever have reached.

All **2521** captured kernel queries across the 32 days replay as covered
through the real `methodIsCovered`.

A third of that saving came from the grid cell, not the buffer: each box is
`cell + 2×buffer` wide, so a coarse cell over-fetches around the parts of itself
the track never entered (cell 1000 → 75,751 rows; cell 250 → 46,024). Coverage
is provably independent of cell size, so it is a free knob — confirmed by
probe: changing it 1000 → 250 leaves every corpus query covered.

Empirical sizing is still not a guarantee, so the buffer is paired with a
COVERAGE ASSERTION: the row-set carries the boxes it was built from, and a query
landing outside them is a hard error rather than a silently short result. Same
shape as the `isCovered` check guarding the Overpass mirror, and the same
discipline as `FixtureOsmAdapter` throwing on an uncaptured key. That assertion
is what demotes the buffer from a correctness parameter to a performance one.

### Why the bulk readers are NOT pushed

`queryDrivableRoads`, `queryWalkableRoads` and `queryBuildingsNear` stay on the
per-query DB path. This is a scope decision, not a deferral, and it survives the
"prefer Lean" default because pushing them buys nothing:

> Their SQL is `feature_type = … AND subtype IN (…) AND MBRIntersects(geom, box)
> LIMIT 20000`. No distance, no ordering, no selection. **The answer is "every
> row in the box", and the box is a parameter the caller chose, not a judgement
> the database made.** There is no oracle to remove, so no theorem becomes
> statable by moving them.

Contrast the kernel: `ST_Distance_Sphere(geom, point) < radius ORDER BY
distance` decides *which feature is nearest*. That is the oracle, and that is
what moves.

The cost side agrees. Their radii are leg-scaled (120–2240 m measured), so no
buffer bounds them the way 800 m bounds the kernel; a whole-day 2700 m buffer
would be needed on this corpus alone, with no ceiling argument behind it. And
`building` is the density bomb that already forced its own tight 500 m coverage
box (cf. #255). The determinism they need is already supplied by
`FixtureOsmAdapter`.

When the map-matchers themselves are ported, they will need this geometry pushed
too — but per-leg, bounded by the leg, not per-day.

## Consequence of the radius difference

Under this design the DB stops computing distances — it ships rows, and Lean's
haversine becomes the definition of distance. There is therefore no requirement
to reproduce MariaDB's arithmetic, and the 1e-9 m formula gap is not a defect to
chase.

**MEASURED (`lean/experiments/osm-sphere-delta.mts`): the point side moves
NOTHING.** The haversine is `R · 2 · atan2(√a, √(1−a))` and `a` depends only on
the coordinates, so R is a pure scale factor and every distance scales by
exactly 1 + 2.198e-6. Two consequences:

- **Ordering cannot change** — a uniform positive scaling is order-preserving,
  so no `ORDER BY distance` result can be permuted and no nearest-feature pick
  can flip.
- **Only the radius bar can move a decision**, and only for a feature within
  `radius · 2.198e-6` of it: 0.22 mm at 100 m, 0.88 mm at 400 m, 1.76 mm at 800.

Across the corpus — 331 point-side queries, 1431 returned features — **zero**
fall in that window, and the closest any feature comes to its own bar is
**8.7 cm**, a hundredfold margin. So the re-bless expectation for the point side
is not "few changes", it is **none**; anything that does move is a finding about
something else, not expected drift.

### The line side: MariaDB has a defect, and we are not reproducing it

`queryLines` never touches the sphere, so the radius change is a no-op there by
construction. The open question was whether MariaDB's `ST_Distance` and this
port's `segDistDeg` agree. **They do not, and MariaDB is the one that is wrong.**

Measured on 12.3.2 — same point, same coordinates:

| geometry | `ST_Distance` |
| --- | --- |
| a real 12-vertex OSM way | 0.002419365488074187 |
| **that way's nearest segment alone** | 0.002405760590290686 |
| **the way's nearest vertex** | 0.002419365488074187 |

The full-line answer is **bit-identical to the vertex distance**. MariaDB
computes the true perpendicular for a two-point linestring and the nearest
VERTEX for a multi-vertex one. `lineDistDeg` computes the true minimum, checked
against an independent dense-sampling brute force that agrees to 1e-13 and
locates the minimum mid-segment.

**This one is not reproduced.** The whole point of the port is that Lean's
version becomes the definition; encoding a database defect into it would make
every later theorem a theorem about the defect. Note the contrast with the
planar/anisotropic metric two sections up, which IS reproduced exactly — the
rule is *reproduce an approximation the corpus was blessed under, do not
reproduce a defect that makes the definition unstatable*.

#### Impact — measured twice, understated the first time

The first measurement drew 3840 ways at 96 captured query points and reported
**4 differing, worst 0.94 m, zero bar crossings**. Those numbers are correct for
what they sampled and *wrong as a description of the impact*: the dump query
selects `highway`/`railway` rows only. The size of this defect is the **vertex
spacing along the nearest edge** — and roads carry dense vertices around their
curves, so the perpendicular foot is never far from one.

Replaying all **2521** captured kernel queries against the pushed row-set
(`lean/experiments/osm-rowset-parity.mts`) gives the real scale:

| method | queries differing | worst Δ | membership changes |
| --- | --- | --- | --- |
| `nearbyWays` | 664 | **37.96 m** | 18 (9 gain, 9 gain+lose) |
| `nearbyLandmarks` | 114 | **17.67 m** | 0 |
| `nearbyStations` | 269 | 0.0009 m | 0 |
| `nearbyTransitStops` | 24 | 4.12 m¹ | 0 |
| `linesAtPoint` | 2 | 0 | 0 |

¹ one query, and NOT the port: point distances differ only by R, bounded at
0.11 mm at r=50. It is an unnamed `traffic_signals` node the mirror has moved
since capture — mirror drift, the third contaminant listed in the harness header.

The landmark row is the one that matters. `nearbyLandmarks` reads closed ways —
parks, buildings, car parks — and a polygon's long wall carries vertices only at
its corners. Measured: **Paleistuin** (`osm_lines` 86909138, 59 vertices) sits
**2.0687 m** from the query point by the true metric and **16.9640 m** by
MariaDB's, bit-identical to its own nearest vertex. Since `venue-prior.ts` uses
`NEAR_FIELD_DECISIVE_M = 12`, that single geometry crosses the near-field
short-circuit bar: under the fix, the park decides the venue; under MariaDB, it
did not even qualify.

#### One-directional as a predicate, NOT as a method

A vertex is never nearer than the true minimum, so this port is never FARTHER
than MariaDB and the *filter* can only bring ways in. The *method* is not
monotone, because `LIMIT 50` is applied after ordering. `nearbyWays` lost a named
street on **9** queries — Marylebone Road, Euston Circus, Finchley Road, Holloway
Road, A501, and three unnamed footway/cycleway rows — and in every one the
highway bucket was already saturated at exactly 50 rows, so the gains displaced
the tail. Reason from the filter version; the method version is false.

**Unlike the sphere, this is NOT provably safe** and the corpus shows it moving
real answers, so the re-bless must be read rather than assumed benign.

#### What is provably inert

Of `nearbyWays`' 664 differences, **541 are reordering only** — and no consumer
reads that order. `velocity.ts` folds the list into a `type/subtype/name → min
distance` map before use; `computeRailRoadProximity`,
`computeRoadNearestFraction` and `railRoadDistFromWays` take minima;
`underground-rail.ts` re-sorts by distance itself. `linesAtPoint` returns a
`Set`, so its 2 reorderings carry no content at all. That leaves distance
changes and the 18 membership changes as the whole of the behavioural surface.

**How this was missed twice**, because both failures generalise:

1. The original port recorded these semantics as "confirmed against the live
   server rather than assumed" — but the confirmation ran on a two-vertex
   fixture, and a two-vertex line cannot tell "minimum over segments" apart from
   "distance to the nearest vertex". *A fixture that cannot distinguish the
   candidate behaviours does not confirm one of them, however real the server it
   ran against.*
2. The impact was then measured on a road-only sample, which understated it by a
   factor of ~40. The spread of this error depends on a property of the input —
   vertex spacing — and the sample covered one regime of that property. *When a
   measurement's spread is driven by a property of the input, sample across that
   property; an average over one regime is not a bound.*

`lean/experiments/osm-line-metric-vs-mariadb.mts`.

## Scope

To port (the `queryPoints` / `queryLines` kernel in `src/geo/osm-local.ts`, and
its consumers in `src/geo/osm.ts`):

- the MBR box test, `ST_Distance_Sphere < radius`, ordering by distance, and the
  `LIMIT 50` truncation. The limit never binds for the methods in scope —
  `nearbyStations` returns at most 11 rows and `linesAtPoint` at most 14 across
  the corpus — but it is reproduced anyway, since a cap that has never bound is
  still part of the function being defined.
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
- `queryDrivableRoads` / `queryWalkableRoads` / `queryBuildingsNear` — see "Why
  the bulk readers are NOT pushed" above. They ship rows already; there is no
  decision in them to lift.

## Order

1. Lean spatial kernel + guards against V8, driven from captured rows. DONE:
   points (`6ea6992`) and lines (`45d830a`), 25 probes.
2. Capture path: query the buffered track once per day — **1500 m for `railway`,
   500 m for the rest** — serialise raw rows, and record the coverage boxes
   alongside them. DONE: `src/geo/osm-rowset.ts` + `tests/osm-rowset.test.ts`,
   sized by `lean/experiments/osm-buffer-sizing.mts`.
3. Swap the injected lookups to read the pushed table. DONE for the kernel:
   `src/geo/osm-rowset-query.ts` + `src/geo/osm-adapter-rowset.ts`. NOT yet
   wired into `loadClassificationInputs` — see step 3b.
3b. Wire `RowSetOsmAdapter` into `loadClassificationInputs`. Open design
   question first: the caller passes the adapter in, so a row-set wrapper would
   sit OUTSIDE the recorder and the five kernel calls would stop being captured
   — which breaks `FixtureOsmAdapter` replay unless the fixture carries the
   row-set too. Decide that before writing the wiring.
4. Re-bless the golden corpus; read whatever moves. **The brief is now measured,
   not guessed** — `lean/experiments/osm-rowset-parity.mts`, run 2026-07-26 over
   all 2521 captured kernel queries, 0 uncovered:
   - the point side must not move: `nearbyStations` worst 0.0009 m, no
     membership change anywhere. Any point-side movement past the sphere budget
     is a finding.
   - the line side moves substantially, and place naming is where it lands:
     landmark polygons shift by up to 17.67 m and cross
     `NEAR_FIELD_DECISIVE_M = 12`.
   - 9 queries LOSE a named street to `LIMIT 50` displacement. Expected, not a
     regression, but each should be recognisable in the diff.
   - 541 `nearbyWays` reorderings are inert — no consumer reads that order.
5. Then the pass-order pipeline, then the `day` serve mode.
