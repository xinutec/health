# Episode geometry — one day, two renderers

The "your day" narrative reads clean while the Map tab shows artefacts:
a walk drawn on a rail track near a station, a confident tube ride
rendered as a raw GPS zigzag, a stay smeared into a cloud of jittered
fixes. The narrative does not have these problems. The reason is
structural, not cosmetic.

## The diagnosis

The narrative and the map are two *projections of the same day*, but
today they are computed from different inputs at different levels of
abstraction:

- The **narrative** (`timeline.component`) renders the `DayState[]`
  sequence — the smoothed, merged, non-overlapping episodes produced by
  `segmentsToDayStates`. Short blips are absorbed; sleep spans its full
  window; modes are mutually exclusive.
- The **map** (`map.component`) renders the *raw* `EnrichedSegment[]`
  with an opportunistic train-only snap (`snappedPath`) bolted on. It
  iterates the unmerged segments and draws each one's raw fixes.

Two sources of truth drift. A platform walk that the day-state layer
folds into its surroundings still appears on the map as its own raw
trace — and if those fixes happen to sit over the track (the person was
on the platform), it reads as "walking on the rails". The map is not
wrong about the GPS; it is telling a *different story* than the
narrative because it renders a different model.

The fix is not to patch the map. It is to give the map the **same
source of truth the narrative already uses**, so the two cannot
disagree by construction.

## The principle

Each episode asks one question: *what is the most truthful spatial
depiction of this episode, given everything we know?* The answer is
governed by a single rule:

> **Snap to structure only when structural knowledge beats the raw
> signal. Keep the raw signal when it is itself the best truth.**

- A **train** ride: GPS is coarse or absent underground, but the
  `<board> → <alight> · line` triple is strong structure. The rail
  geometry is *more* truthful than the fixes (this is the lesson of
  rail-snap, see `rail-snap.md`).
- A **walk** across a park with good GPS: the raw trace *is* the truth.
  Map-matching it to the nearest footpath would move it off where the
  person actually walked → keep raw, clean only the teleport spikes.
- A **stay**: the truth is a venue, not a smear of fixes → collapse to
  a single anchored point.
- A **gap / unknown**: we do not know the path → draw an explicit
  tentative connector (or nothing), never a confident-looking invented
  line.

This is the same value system that makes the narrative good — *honest
low-confidence beats fabricated precision* — applied to pixels.

## The model

`DayState` is already the canonical episode for the narrative. We do not
replace it; we resolve a **display geometry** for each one and let both
views render the same episode sequence. The output is a self-describing
geometry array, one entry per `DayState` (1:1):

```
EpisodeGeometry = {
  startTs: number,         // copied from the state, for ordering
  endTs:   number,
  mode:    DayStateMode,   // for the mode colour
  kind:    "snapped" | "raw" | "anchor" | "tentative" | "matched",
  points:  { lat: number; lon: number }[],   // may be empty
}
```

`kind` is the *geometry provenance* and is the only style input the map
needs — solid for `raw`/`matched`, dashed for `snapped`/`tentative`, a
dot for `anchor`. There is deliberately **no** `confidence` field: the
only confidence upstream is `EnrichedSegment.confidence`, which is
*mode-classification* confidence (`segments.ts`), not *geometry* trust.
A `snapped` train can be classified with high confidence while its drawn
line is a guess; styling opacity off classification confidence would
paint a fabricated connector boldly because the *mode* was certain — the
exact "visual certainty exceeds model certainty" failure this design
exists to remove, and a violation of `probabilistic-principles.md` Rule
5. `kind` encodes geometry trust categorically and honestly; that is
enough.

`points` carry no `ts`. The `snappedPath` time-clip (below) is done
backend-side before emitting, and the frontend's live-fix connector uses
only the last drawn vertex — so neither needs per-point time. (A future
"scrub the map to a time of day" feature would need `ts` re-threaded;
noted so it is a deliberate omission, not an accident.)

It is shipped as `VelocityResult.episodes`, alongside the existing
`states` (which the timeline keeps reading). The geometry `points` are
map-only and not present in `states`, so this is not a meaningful
duplication.

> **Naming.** This is the *display* layer. It is deliberately **not**
> called "journey" — `src/hmm/tube-journey-assembler.ts` already owns
> `TubeJourney`, the HSMM per-minute composition concept. This layer is
> `EpisodeGeometry`, built by `buildEpisodes` in
> `src/geo/episode-geometry.ts`. The two never touch.

### Resolving geometry for a state

`buildEpisodes(states, segments, points)` is a **pure**, sequence-aware
function (no DB, no side effects). `DayState` carries no geometry and no
back-reference to its segments, so the first step is a **state→segment
re-association**: for each state, find the covering segment(s) by
time-overlap (`seg.startTs < state.endTs && seg.endTs > state.startTs`).
This is the O(states × segments) join the rest of the velocity pipeline
already uses for point bucketing; at single-user scale it is trivial.

| episode kind            | strategy   | geometry                                       |
|-------------------------|------------|------------------------------------------------|
| `train` w/ snappedPath  | `snapped`  | the covering train segment's `snappedPath`, time-clipped to the state window |
| `train` w/o snappedPath | `raw`      | the train segment's own fixes (uncached routes still have real GPS — see grounding), spike-rejected |
| `walking` w/ walkMatchedPath | `matched` | the covering walk segment's `walkMatchedPath` — the pedestrian map-matcher's pavement-snapped line (below) |
| `walking`/`cycling`     | `raw`      | the state-window fixes, spike-rejected **+ speed-plausibility filtered** (below) |
| `driving`/`bus`/`plane` | `raw`      | the state-window fixes, spike-rejected         |
| `stationary`/`sleeping` | `anchor`   | one point — the covering segment's centroid     |
| `unknown`               | `tentative`| capped connector across the gap (below)         |
| no covering segment / no resolvable anchor | empty | empty `points` — the map draws nothing |

Two model constructs need their behaviour stated explicitly, because the
naive "bucket points by window" does not cover them:

- **Synthesized sleeping states are definitionally empty.**
  `segmentsToDayStates` emits a sleeping state from a `SleepWindow` with
  *no covering segment* (`day-state.ts`, the morning-sleep-before-first-
  fix case). There are zero fixes in that window by construction, so the
  episode has empty `points` and the map draws nothing — the same as
  today.
- **A merged moving state has one covering segment per leg.** Adjacent
  same-mode segments merge into one `DayState`, but train legs do *not*
  merge: `mergeAdjacent` only joins states `sameState` deems equal, and
  `sameState` compares `wayName` (`day-state.ts`), so two legs with
  distinct `<board>→<alight>·line` labels stay separate. A `train` state
  therefore maps to exactly one train segment and its `snappedPath` is
  unambiguous. A merged `walking` state is resolved from the union of
  state-window fixes, which is what we want.

### Speed-plausibility filter (the motivating fix)

The "walk drawn on the rail track" is **not** resurfacing GPS scatter,
and it is **not** a `pointCount:0` reconstructed leg — both were
plausible theories, both disproved by replaying a captured fixture (see
grounding). The real cause is a **segmentation boundary that lands ~90 s
too early**: the train→walk boundary puts the train's final *overground*
deceleration into the alighting station (fixes at vehicle speed) inside
the `walking` episode. Drawn raw, those fast fixes trace the rail line —
a green "walking" line at tens of km/h straight down the track. The
genuine walk only begins once speed drops to a few km/h, at the station,
off the rails.

The fix is to drop, from a raw episode's geometry, fixes whose speed
exceeds the **physical ceiling for that episode's mode** — for
`walking`, the 12 km/h ceiling that is already coded as a hard limit in
this system: `V_WALK_MAX_KMH = 12` (`mode-class-lock.ts`, the HSMM
emission constraint) and `MAX_SPEED_FOR_MODE.walking = 12`
(`mode-biometrics.ts`, the mode-flip gate). `probabilistic-principles.md`
constraint C2 is the formal statement of that already-coded fact. A
60 km/h fix in a walking episode is not slow GPS — it is a
neighbouring fast mode bleeding across the boundary, and it is *not
walking* by the same physics the classifier uses. This is the display
analogue of C2: the geometry layer will not *draw* as walking what
cannot *be* walking.

This is principled, not a magic threshold: the ceilings are the existing
per-mode physical limits (walking ≤12, cycling ≤~40, …), the same
constants the classifier's walking veto uses. It needs **no** station
coordinate, **no** enrichment plumbing, **no** fixture re-capture — it
reads `speed_kmh`, already on every `FilteredPoint`. And it is honest:
the dropped fixes were never the walk; the kept fixes are the real,
slow, on-foot portion. The geometric `rejectSpikes` (detour-ratio)
stays — it catches teleports; the speed filter catches smooth-but-too-
fast boundary bleed that `rejectSpikes` misses precisely because the
bleed is smooth and monotonic along the track.

The train side is unaffected and already correct: the train segment
keeps its 27 real fixes (or its `snappedPath` when the route is cached),
so the ride itself still renders — only the impossible-for-walking tail
stops being mis-coloured green.

### Pavement-matched walks (`walkMatchedPath`)

On a house-lined residential street the raw GPS sits ~10–30 m off the pavement,
clipping the houses. `src/geo/pedestrian-match.ts` map-matches the walk onto the
OSM **walkable** network (footway / path / pedestrian / residential…) the same
way `road-match.ts` matches driving onto roads — both are thin profiles over the
shared Newson-Krumm core `map-match-core.ts`. The walk profile drops the road
turn-prior (`wayContinuityNats: 0` — walkers change ways at every crossing),
tightens the candidate radius (walk GPS is closer to truth) and the length bail
(a 2× detour is a blunder), and widens the gap-bridge (the pedestrian network is
more fragmented). `pedestrian-match-annotate.ts` runs it per walk and attaches
`walkMatchedPath` only when the display gate (`matchImprovesDisplay`, judged on
the drawn chords vs the walkable surface) confirms it both follows the pavement
better than the raw line AND stays faithful to the fixes. `episode-geometry`
prefers it (`kind:"matched"`), falling back to the raw track when the matcher
bails (off-network, or a graph too fragmented to route — the honest `null`).
Measured (`score-walk-match`, off-walkable p90) across the golden corpus: 37
walks improved (e.g. 55 m → 3 m), 0 regressed. This is the pedestrian slice of
map-constrained positioning, shipped as a display layer.

### Reconstructed walks (`walkSmoothedPath`, behind `WALK_RECON`)

A second, evidence-fused walk drawer exists alongside the matcher:
`reconstructWalk` (`walk-smooth-map.ts`) computes the walk as the MAP
estimate of one robust energy — redescending Geman–McClure GPS emission
under a deterministic graduated-non-convexity anneal, accuracy as a weak
clamped prior, L2 smoothness, soft walkable attraction, building clearance
field. `pedestrian-match-annotate.ts` swaps it in for a leg **only when the
reconstruction is ≥25 % and ≥150 m shorter** than the matched/raw line —
the signature of a dissolved phantom out-and-back (an isolated GPS spur the
accuracy-blind matcher snapped into a detour). The segment then carries
`walkSmoothedPath` and `episode-geometry` prefers it as `kind:"smoothed"`,
above `walkMatchedPath`. The swap ships **off by default** (`WALK_RECON=1`
opt-in): it does not yet fix the coherent-smear phantom class, which needs
the independent-evidence factors tracked in
`../proposals/geometry-roadmap.md`.

### Bounding the `unknown` connector

An `unknown` (no-GPS) state between two anchors gets a `tentative`
connector — but a long gap (an unclassified cross-town hop) would
otherwise draw a straight dashed line kilometres across a city, which
still *implies a route*. So the connector is endpoints-only beyond a
capped distance: draw the two anchor markers and no line between them.
The cap is a display constant (like `rejectSpikes`'s existing 500 m
spike bar), documented at its definition — not a classifier threshold.
If **either** endpoint is unresolvable (an interior all-`unknown` run on
a sparse day, with no anchored neighbour on one side), the episode is
empty — draw nothing, as in the inferred-day fallback below.

### Inferred empty-days carry no coordinate

`DayState` has no lat/lon, and an inferred empty-day stay
(`buildInferredStayState`) keeps only the place *name* — the resolved
centroid is dropped. So `buildEpisodes` cannot anchor geometry for a
no-GPS inferred day; it emits an empty episode and the map draws nothing
(unchanged from today). Carrying the inferred centroid forward is a
later, optional refinement.

## Where it runs, and the frontend/backend split

The expensive structural geometry (rail snapping; future road
map-matching) is already precomputed offline and cached (`rail-snap.md`)
and reaches the pipeline as `snappedPath` on the segments.
`buildEpisodes` does only the **cheap per-episode assembly** — the
state→segment join, fix bucketing, spike rejection, the per-mode
speed-plausibility filter, centroid, the `unknown` cap, and `kind`.

It is computed **inside `computeVelocityFromInputs`**, which is the
closure that the route memoises: `api.ts` wraps `computeVelocity`
(→ `computeVelocityFromInputs`) in `getVelocityCached`
(`src/routes/velocity-cache.ts`, 5-min per-pod TTL). So the whole
`VelocityResult` including `episodes` is cached as one unit, and
`buildEpisodes` runs once per cache miss — no separate geometry cache.

The split must be explicit, so geometry logic lives in exactly one place
(per `overview.md`'s maximal-normalisation rule):

| Concern | Owner |
|---|---|
| state→segment join, fix bucketing, spike rejection, per-mode speed filter, centroid, `unknown` cap, `kind` | **backend** `buildEpisodes` |
| Leaflet polyline/marker construction; colour per `mode`; dash per `kind`; grouping episodes into consecutive same-mode/same-kind polyline *runs* and bridging run boundaries for visual continuity; view-fit; live-fix marker + connector | **frontend** `map.component` |

`rejectSpikes` and the stationary-centroid computation **move** from
`map.component` to `buildEpisodes` — they are *deleted* from the
frontend, not duplicated. The map's stay-marker block, which currently
re-buckets points to recompute a centroid, instead reads the `anchor`
episode's single point. The frontend keeps no *point-geometry* logic
(no bucketing, spikes, or centroids); it does keep the run-grouping and
cross-run continuity, which are Leaflet-shaped concerns operating over
the resolved `EpisodeGeometry[]` (now bridging adjacent episodes'
endpoints rather than reaching back into a `DisplayPoint` array).

## Invariants (enforced, not hoped)

1. **Narrative-freeze.** `segmentsToDayStates` output is byte-identical
   before and after any geometry work. Already guarded: `golden-check.ts`
   diffs `normalizeStates(states)` against a frozen baseline, and
   `normalizeStates` reads only state fields, never geometry — so
   geometry work *cannot* perturb the baseline. Geometry is downstream of
   classification and never feeds back.
2. **No fabrication.** A geometry of `kind: snapped`/`matched` must be
   backed by real structure (a cached route, a resolved station). When
   the backing is missing the episode resolves to `tentative` or empty,
   never a confident-looking guess.
3. **No mis-attributed trace.** No episode draws geometry that belongs to
   a different mode — the speed filter is the walk-side enforcement (a
   60 km/h fix is never drawn as walking). On the train side, a cached
   route renders `snapped`; an un-snapped ride renders `raw` from the
   leg's *own* real fixes (an uncached overground ride still has GPS —
   grounding), and a fully GPS-dark leg draws nothing rather than a guess.
   Phase 2 makes cached coverage a guarantee so confident rides reliably
   snap; until then the raw-own-fixes fallback is honest, not a zigzag of
   someone else's trace.
4. **Determinism.** `buildEpisodes` is a pure function of its inputs, so
   replaying a golden fixture reproduces its geometry exactly. *Note:*
   adding *golden geometry baselines* is not free — `golden-check.ts`
   today diffs only `expected.velocity` states; a geometry baseline needs
   the fixture schema and the diff extended. Phase 1 instead asserts
   geometry **properties** in a unit / real-data test (below); the full
   golden-geometry baseline is deferred.

## Grounding (captured-fixture replay)

The fix mechanism was chosen by **replaying a captured day's fixture
zero-DB** (the golden input closure) and reading the actual segments,
points, and speeds — not by theory. Two attractive theories were both
disproved by the data:

- *"Resurfacing GPS scatter on the rails."* No — the fixes are smooth and
  monotonic along the track, not scattered.
- *"A `pointCount:0` reconstructed leg with no usable fix."* No — the
  train leg has dozens of real overground fixes, `snapped=-` (route
  uncached, but the GPS is present); its last fix sits at the alighting
  station.

The shape of the data (abstract):

```
seg train       … overground fixes, route uncached (no snappedPath)
   walking       spd ~60 km/h  ┐ these "walking" fixes are the train
   walking       spd ~50 km/h  │ decelerating into the alighting station
   walking       spd ~16 km/h  ┘ — not walking
   walking       spd ~1 km/h   ← the genuine walk starts here
   walking       spd 0–8 km/h  ← real on-foot walk to the next stay
seg stationary   the arrival stay
```

The `walking` episode's first few fixes are tens of km/h — impossible for
walking. The boundary lands ~90 s early, so the walk absorbs the train's
fast tail and draws it along the rail line. The speed-plausibility filter
drops every fix over the 12 km/h walking ceiling; what remains is the
real walk at the station, off the track.

**The test is cache-independent and needs no station coordinate** — it
reads only `speed_kmh`, which is on every fix:

- Assert the affected `walking` episode's geometry contains **no point
  whose source fix exceeds 12 km/h**, and that it retains the genuine
  slow walk near the following stay's centroid.
- Run it with the fixture's `railRouteCache` **as captured** and
  **emptied** — identical result, since the filter never consults
  `snappedPath`.

## Phased plan

The architecture is the commitment; the resolvers fill in incrementally,
each justified by a real day that looks wrong.

- **Phase 1 — unify + speed-plausibility filter (the motivating fix).**
  Introduce `EpisodeGeometry` + `buildEpisodes` (state→segment join,
  per-mode speed filter, capped `unknown` connector); compute `episodes`
  inside `computeVelocityFromInputs`; ship it on `VelocityResult`; move
  the map to render `episodes`, deleting `rejectSpikes`/centroid from the
  frontend; style by `kind`; surface an episode summary in `analyze-day`
  (CLI mirrors UI). Tests: `buildEpisodes` units + a cache-independent
  speed-filter assertion over a captured fixture. Narrative-freeze
  guarded by the existing golden harness. No coordinate plumbing, no
  fixture re-capture.
- **Phase 2 — honest train gaps + structural coverage.** Make rail-route
  coverage a guarantee keyed on structural identity
  `(board_id, alight_id, line_id)` rather than the label string, so an
  un-snapped confident ride reliably snaps once cached. (An un-snapped
  ride still renders from its own real fixes meanwhile — see the table.)
- **Phase 3 — road map-matching (only when a real day demands it).** Add
  a `matched` strategy for drive/bus, and for *poor-GPS* walks, computed
  offline and cached like rail. Good-GPS walks stay `raw` — the raw trace
  is the truth.

## Notes and exposure

- **Share-token view.** The public share viewer calls the same
  `/api/velocity`, so `episodes` geometry (home/venue coordinates) ships
  to share recipients — the same privacy surface as the `points` and
  `snappedPath` already exposed, no *new* leak, but noted.

## Rejected alternatives

- **Snap everything to the network.** Map-matching a good-GPS walk to a
  footpath moves it off the truth. Snapping is earned per episode by the
  principle above, not applied blanket.
- **Fix the map renderer in place.** Patching `map.component` to hide
  blips without unifying the model leaves two sources of truth that will
  drift again. The win is the shared model, not the patch.
- **Re-classify: move the train→walk boundary later.** Tempting (the
  boundary is ~90 s early), but it changes the `DayState` sequence the
  golden harness freezes and the narrative already reads fine. Geometry
  is downstream: the speed filter fixes the *depiction* without touching
  classification. A boundary fix can be a separate classification task if
  a day ever needs it.
- **Anchor a station-egress connector on the alight station coordinate.**
  Designed, then dropped once the data showed the cause was mis-segmented
  *fast train fixes*, not GPS scatter — so there is nothing to connect
  around. It also rested on a coordinate that `NearbyStation` does not
  carry (dropped at the `nearbyStations` query), which would have forced
  enrichment-chain plumbing and a `FIXTURE_FORMAT_VERSION` re-capture for
  no benefit. The speed filter needs none of that.
- **A continuous `confidence` field for styling.** Rejected: the only
  upstream confidence is classification confidence, which is not geometry
  trust. `kind` encodes geometry provenance honestly.
- **Feed a cleaned map back into classification.** Map-matching upstream
  of the classifier can erase the GPS-vs-network mismatch the classifier
  uses as signal. Geometry is strictly downstream: we depict the
  decision, we never let depiction re-decide.
