# Rail-snap — drawing train journeys on the rail track

On the Map tab a train ride otherwise renders as a wild GPS zigzag:
underground and in cuttings the phone falls back to cell-tower
positioning and the fixes scatter hundreds of metres off the track.
Rail-snap replaces that zigzag, for a confidently-classified train
segment, with the journey drawn on the actual OSM rail line.

⚠ **Its `src/**.ts` paths are HISTORICAL** — they name the TypeScript backend,
deleted whole in #975. The prose is kept as the record of why each decision was
taken; the paths are not a map of the code today. `docs/design/timezone.md`
shows the convention: a "Where these things live now" section mapping each name
to the Rust or Lean symbol that does the work (#919).

## Station-anchored algorithm

The snapper never looks at fix positions. Real train-run GPS cannot
trace the journey — a platform dwell-clump, fixes that report good
accuracy but sit a kilometre off, and coarse cell-tower scatter each
defeat a different route-fit metric. What *is* reliable for a confident
train run is its `<board> → <alight>` station-pair label.

`src/geo/rail-snap.ts` (`snapTrainSegment`, pure) therefore:

1. parses the boarding and alighting station names from the label;
2. resolves their coordinates from the local OSM station mirror;
3. builds a graph of the rail network from `osm_lines` geometry, with
   gap-bridging so ways that fail to share a node still connect;
4. runs Dijkstra between the two stations;
5. interpolates the segment's time window linearly along that path.

Because fix positions are never load-bearing, the three GPS
pathologies above cannot corrupt the result. A segment that cannot be
snapped — unknown station, geometry disconnected in the mirror — yields
no path, and the map falls back to the raw track.

## Precompute architecture

Reading the rail corridor (`queryRailCorridor`) is a heavy spatial
scan of the ~1M-row `osm_lines` mirror — far too slow for the dashboard
request path. So the geometry is computed offline:

- **`rail_route_cache`** table — the snapped polyline keyed by the
  run's `<board> → <alight>` route label. A route's drawn geometry is
  the same every time it is travelled, so the work is reused across
  every day that route appears. It is a pure cache: recomputable, no
  incremental accumulator.
- **`refresh-rail-routes`** CLI — walks a recent window of days
  (default 21), resolves each distinct route's geometry, and rebuilds
  the table transactionally. Runs daily in the `health-rail-refresh`
  CronJob. The window is short on purpose: `computeVelocity` lazily
  fetches OSM for uncovered areas, and reaching months back hits old
  trips to uncovered cities where a single dense-city Overpass fetch
  can take minutes.
- **Request path** — `annotateSnappedPaths` in the velocity pipeline
  does one indexed lookup into `rail_route_cache` and interpolates the
  segment's time window onto the cached geometry. A route not yet
  cached simply draws raw until the next cron run.

Because the cache key is the full `wayName` string, the *label* is
load-bearing for geometry: a run that loses its `· <line>` suffix keys
a different route than the same journey labelled with it, and a
labelling failure downgrades the drawn line to raw GPS — whose
alight-side reacquire tail can cut across buildings at street level.
One measured cause: `resolveRailRunLabel`'s line intersection used the
raw endpoint fixes, and an off-corridor street-reacquire fix returns no
lines at all, emptying the intersection. The labeller now retries the
intersection at the *resolved stations' own node coordinates*
(`NearbyStation.lat/lon`) when the fix-point intersection is empty or
ambiguous — the stations are the physical endpoints being asked about;
the fixes were only ever a proxy for them. Fallback-only, so runs the
fix-point intersection already resolves are untouched, and fixture
recordings that predate the coordinate fields skip the retry.

The frontend renders a `snappedPath` as a distinct dashed polyline so
it reads as inferred, not measured.

A verified Lean port of the shortest-path core (V3 of
[`../proposals/2026-07-verified-core-lean.md`](../proposals/2026-07-verified-core-lean.md))
is in progress under `lean/Verified/Rail/`; production behaviour is
unchanged until that lands.

## Testing

`tests/railsnap-e2e.test.ts` runs the snapper against a captured
real-day fixture (`tests/fixtures/railsnap/`, gitignored — real
coordinates) and asserts outcome properties a synthetic test cannot:
the path spans the journey, sits on the rail network, is monotonic,
and is a sane length. It is `skipIf`-absent, so CI without the fixture
skips it; locally it is the verdict. The capture tool is
`src/cli/capture-railsnap-fixture.ts`.

## Rejected approaches

- **Per-fix map-matching.** The first attempt projected each raw GPS
  fix onto a route polyline. It shipped and was reverted three times —
  no route-fit metric survived the GPS pathologies above, and the
  snapped path collapsed to a degenerate blob.
- **Corridor query on the request path.** Running `queryRailCorridor`
  inside `computeVelocity` blew a rail-day computation out to minutes.
  Hence the offline precompute + cache.
- **`osm_way_routes` route-relation mirror.** Mirroring way → route
  membership was intended to disambiguate parallel lines. Its Overpass
  fetches and bulk inserts created DB write contention that crippled
  the corridor query, and nothing consumed the data. It was dropped;
  the table remains inert. If line disambiguation is built later it
  needs route membership, but populated by a deliberate, throttled,
  non-request-path job.

## Where these things live now

⚠ **THE `src/**.ts` PATHS ABOVE ARE HISTORICAL** — see the note at the top. This
is the map from those names to the code that does the work today, BY SYMBOL: a
symbol survives a move, a line number does not (#919, #1205).

| the document says | today |
| --- | --- |
| `src/geo/rail-snap.ts` — `snapTrainSegment` | `lean/Verified/Geo/RailSnap.lean` — `snapTrainSegment`, plus `snapTrainSegmentOnLine` for the single-line fallback. Its production caller is `lean::rail_snap`, the `railsnap` serve mode |
| `tests/railsnap-e2e.test.ts` — the end-to-end check | `rust/backend/tests/suite/rail_snap.rs` |
| `src/cli/capture-railsnap-fixture.ts` — the capture tool | ⚠ **NO SUCCESSOR, and the fixture under `tests/fixtures/railsnap/` therefore cannot be regenerated.** The tool went with `src/` (#975) and nothing replaced it, so the captured file is the only copy and a lost or stale one cannot be rebuilt from this repo |
