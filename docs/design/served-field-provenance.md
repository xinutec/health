# Where a served field comes from

Given a field on the Your Day timeline, which code decided it. Written because
grepping a plausible name finds a plausible answer: on 2026-08-30 three separate
conclusions were built on symbols that were not on the serving path, and only
rendering the real page refuted them (#1280).

⚠ **By SYMBOL, never by line.** Line numbers here would be wrong within a week;
#919 is what a document of line numbers becomes. Every entry names a definition
you can grep for by name.

⚠ **All nine STATE fields and all 25 SEGMENT fields are covered** — but five of
the segment fields are covered by SHOWING they have no single producer, which is
the answer, not a gap. See the end.

## The entry point

`Verified.Geo.DayChain.dayChain` returns the served states AND their episodes,
and returns both together on purpose: episodes are 1:1 with the FINAL states, so
building them from anything but the continued list would draw a day the
timeline does not describe.

Its order, which is the order that decides every field below:

1. `enrichSleepWindows` over `sleepCandidates` — the sleep windows
2. `Verified.Geo.DayState.segmentsToDayStates` — the boundary sweep
3. the empty-day arm (`inferredEmptyDay` → `buildInferredStayState`)
4. `Verified.Geo.DwellContinuation.applyDwellContinuation` — **the final word**
5. `Verified.Geo.EpisodeGeometry.buildEpisodes` over the continued list

Inside step 2: every distinct boundary is collected, each sub-interval is probed
at its MIDPOINT for a covering segment and sleep window, `stateForInterval`
decides the state, then `mergeAdjacent` collapses touching identical runs and
`stripPartialMinutesAsleep` clears a partial sleep figure.

## The nine served state fields

| field | decided by | notes |
| --- | --- | --- |
| `startTs` / `endTs` | `DayState.collectBoundaries` | sub-interval bounds, not copied from a segment |
| `mode` | `DayState.stateForInterval` | `vehicleKind == "bus"` wins, else `refinedMode`, else `mode`; a sleep window can rewrite it to `sleeping` |
| `place` | `Seg.place` via `makeStateFromSegment` | synthesized sleep takes `SleepWindow.place` instead |
| `wayName` | `Seg.wayName` via `makeStateFromSegment` | the state layer only copies it; see below for who sets it on the segment |
| `asleep` | `DayState.stateForInterval` | `some true` only when moving THROUGH a sleep window — never on `mode = "sleeping"`, where it would be redundant |
| `tz` | `Seg.displayTz` via `makeStateFromSegment` | synthesized sleep takes `SleepWindow.tz`; the rewritten-stationary half prefers the window's and falls back to the segment's, deliberately, so both halves of one sleep can merge |
| `minutesAsleep` | `SleepWindow.minutesAsleep` | sleeping states only, and only when > 0 |
| `inferred` | `DwellContinuation.applyDwellContinuation`, or `DayState.buildInferredStayState` on a no-data day | **never** set by `makeStateFromSegment`, which always writes `none` |

## ⚠ What is NOT on this path

The expensive half of #1280 was not failing to find a producer. It was
confidently finding a non-producer.

* **`Verified.HsmmSegments.sameState`** — the DECODER's per-minute states. It
  compares mode/placeId/lineName, which is exactly the question you have, and it
  is the wrong answer. Served states carry **no `placeId` at all**
  (`focusPlaceId` is a segment field, not a state field).
* **`Verified.Hsmm.Transitions.sameState`** — also the decoder. A grep for
  `sameState` returns three definitions and two of them are this trap.
* The served one is **`Verified.Geo.DayState.sameState`**, reached only through
  `mergeAdjacent`, which `segmentsToDayStates` calls at its end. It compares
  mode, place, wayName, asleep, tz and minutesAsleep — note `tz` is in that list,
  which is why the sleep rewriting above bothers to align it.

## ⚠ Where two mechanisms express one concept, both are live

A reader who greps hits whichever matches their guess. Known instance:

**"this stay is inferred"** is rendered TWO ways in `timeline.component`.
`.inferred-dot` in the template is journeys only; the state-level marker is the
`no data (inferred)` suffix appended to the secondary line in the component's
TypeScript. Finding the first and concluding states are unmarked is a recorded
error.

## ⚠ Do not merge adjacent same-place states

`DwellContinuation` splices them in DELIBERATELY, and `DayChain`'s own comment
says why: `inferred := true` is not decoration, it is what lets the renderer say
"no data" instead of presenting an asserted stay as an observed one. Merging
them once turned 4h35m of assumption into what reads as an observed stay.

## The segment half — partly established

25 fields ship per segment: everything on `segs` except `snappedPath`,
`matchedPath` and `walkMatchedPath`, which `routes::velocity::strip_paths`
removes because `episodes` already carries the drawn geometry.

The fold is `Verified.Geo.PassFold.passes`, **41 passes** run in order by
`runPasses`, each a `Seg[] -> Seg[]`. The served value of a field is whatever
the LAST pass to write it left, so an entry here names a pass, not just a
module.

### Established

| field | written by | pass |
| --- | --- | --- |
| `displayTz` | `PassFold`'s local `displayTz` — `homeTz` when the segment has no points, else `e.tzAt lat lon` | `displayTz` |
| `biometrics` | `PassFold`, sole writer | `biomEnrich` |
| `walkSmoothedPath` | `WalkAnnotate`, attached only when the smoother's output is kept | `walkMatch` |
| `focusPlaceId` | `StayEnrich` sets it with the venue; `SegmentMerge` CLEARS it when stays merge | `merge` clears after any earlier set |
| `needsReenrich` | `StaySplit` sets it; `PassFold` consumes and clears it | `reenrichSplitWalks` |
| `needsRename` | `StaySplit` sets it; `PassFold` clears it and re-reads `wayName` | `reenrichSplitWalks` |
| `roadCorridorFraction` | `Enrich`, via `Velocity.computeRoadNearestFraction`; `orElse` keeps an earlier value | the enrich fold |

### Born before the fold, then blended

⚠ **Ten fields are NOT produced by a pass at all.** They are built by
`Verified.Geo.Segments.classifySegments`, which turns filtered points into the
segment list the fold then operates on — so the fold's job for these is to
MERGE them, not to decide them.

| field | born in | changed after by |
| --- | --- | --- |
| `startTs` / `endTs` | `classifySegments` (window bounds) | every pass that splits or merges |
| `mode` | `classifySegments` (the classifier's verdict) | many passes — see the five below |
| `confidence` | `classifySegments`, mean of normalised scores | `SegmentMerge` blends on merge; `Enrich` applies `roadSupportedConfidence` |
| `confidenceMargin` | `classifySegments`, mean of the score margins | `SegmentMerge` blends on merge |
| `avgSpeed` | `classifySegments`, median of window medians | blended on merge |
| `maxSpeed` | `classifySegments`, max over windows | blended on merge |
| `linearity` | `classifySegments`, mean over windows | `RailReconcile` re-blends when it joins rail legs |
| `pointCount` | `classifySegments`, sum over windows | summed on merge |

So a question about one of these is usually a question about the CLASSIFIER, not
about a pass — and looking for a pass that "sets avgSpeed" finds only the merge
arithmetic, which is the confidently-wrong answer for anyone asking why the
number is what it is.

### The rest

| field | decided by |
| --- | --- |
| `centroidLat` / `centroidLon` | `SegmentMerge`, from the merged stay's recomputed centroid |
| `city` | `StayEnrich` sets it; ⚠ `SegmentMerge` CLEARS it when two segments disagree, so an absent city can mean "merged across a boundary" rather than "unknown" |
| `vehicleKind` | `Bus` sets `some "bus"`; `PlaceOverride` clears it. The `busEvidence` / `busRoutes` passes |
| `refinedKinds` | `SegmentMerge`, set to `["gps-jitter"]` when the merge was a jitter collapse |

⚠ `needsReenrich` and `needsRename` are FLAGS THE FOLD CONSUMES. They ship, but
a served `true` means the fold did not get to clear it — which is a signal about
the pipeline, not about the day.

### ⚠ Five fields do not have a single producer, and that is the finding

`mode`, `place`, `wayName`, `refinedMode` and `refinedReason` are assigned in 31,
13, 19, 23 and 18 modules respectively. Even discounting fixtures and other
types, each is written by many passes, and WHICH one wrote the served value
depends on which passes fired for that segment on that day.

So "the producer of `wayName`" is not a well-posed question, and a table row
claiming one would be the confident-wrong answer this document exists to
prevent. For those five the honest procedure is per-case:

    CORPUS_DAYS=<date> … the day grader, or `runPassesTraced`, which keeps each
    pass's output beside its name — it exists for the shadow ledger and is the
    tool for exactly this.

Adding a row for one of the five means naming the pass that wrote it FOR A
STATED CASE, not in general.
