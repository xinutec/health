# Where a served field comes from

Given a field on the Your Day timeline, which code decided it. Written because
grepping a plausible name finds a plausible answer: on 2026-08-30 three separate
conclusions were built on symbols that were not on the serving path, and only
rendering the real page refuted them (#1280).

⚠ **By SYMBOL, never by line.** Line numbers here would be wrong within a week;
#919 is what a document of line numbers becomes. Every entry names a definition
you can grep for by name.

⚠ **This covers the STATE half.** The 25 served segment fields are not mapped
yet — see the end.

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

## The segment half — not written

25 fields ship per segment (everything on `segs` except `snappedPath`,
`matchedPath` and `walkMatchedPath`, which `routes::velocity::strip_paths`
removes because `episodes` already carries the drawn geometry).

They are NOT mapped here, deliberately: the fold runs 38 passes and several
fields are written by more than one, so the honest entry is "the pass that LAST
decides it", which needs the fold order traced per field. A half-checked table
would be exactly the artefact this document exists to replace. Start from
`Verified.Geo.PassFold` and add rows as they are established.
