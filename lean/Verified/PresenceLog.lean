import Verified.JsNum
/-!
# One day's decoded segments → one `presence_log` row

Port of `computeRow` in `src/hmm/presence-log.ts`, phase 1 of
`docs/proposals/2026-06-presence-continuity.md`.

The HSMM's output is per-minute and is compacted to `HmmSegment[]` for storage.
This re-expands it to per-minute attribution and rolls the day up: which known
place held the most minutes, and what state the day ENDED in — the seed the next
day's continuation reads.

Pure and total. UNPROVEN; the thresholds and the tie-break are the TypeScript's.

## Two things that are not arithmetic

⚠ **A TIE KEEPS THE FIRST PLACE SEEN.** The TypeScript accumulates into a
`Map` and picks with a strict `>`, and a JS `Map` iterates in INSERTION order —
so two places with equal minutes resolve to whichever the day's segments
mentioned first. That is a real decision about a real day, not an artefact, and
it is why this carries an insertion-ordered array rather than a hash map. The
same trap is open on the PhoneTrack device map (#1073).

⚠ **A ZERO-MINUTE SEGMENT IS SKIPPED ENTIRELY**, before it can contribute to the
denominator. `Math.round` sends anything under 30 seconds to zero, so a day of
nothing but sub-30s segments has `totalMinutes = 0` and produces NO ROW rather
than a row claiming 0% of nothing.
-/

namespace Verified.PresenceLog

/-- The end-of-day posterior for a stay at a known place that consumed the day's
final minute.

⚠ A CONSERVATIVE BASELINE, not a measurement: the HSMM does not emit per-segment
posteriors yet, and this is the magnitude the design's worked example assumes.
When it does, this constant goes and the value is read. -/
def END_OF_DAY_BASELINE_POSTERIOR : Float := 0.95

/-- One compacted HSMM segment, as `src/hmm/persist.ts` stores it. -/
structure Segment where
  startTs : Int
  endTs : Int
  mode : String
  /-- The mined focus place, when the decoder attributed one. -/
  placeId : Option Int
  deriving Inhabited, Repr

/-- The row the rollup produces. The database adds `computed_at` itself. -/
structure Row where
  dominantPlaceId : Option Int
  dominantFraction : Float
  endOfDayPlaceId : Option Int
  /-- Unix SECONDS. The TypeScript builds a `Date` from `endTs * 1000`; the
      caller is what turns this into the column's type. -/
  endOfDayTs : Option Int
  endOfDayPosterior : Float
  deriving Inhabited, Repr

/-- Minutes a segment contributes.

⚠ `Math.round`, not truncation, and clamped at zero — a segment whose end
precedes its start contributes nothing rather than a negative that would corrupt
the denominator. -/
def minutesOf (s : Segment) : Int :=
  max 0 (Verified.JsNum.jsRoundInt (Float.ofInt (s.endTs - s.startTs) / 60.0))

/-- The key a segment's minutes accumulate under: its place when it is a
stationary stay, and `none` for everything else.

⚠ `none` is a REAL BUCKET, not an absence. Non-stationary minutes and stays with
no known place both land there, and they count toward the denominator — which is
what makes `dominantFraction` honest about how much of the day was NOT at the
dominant place. -/
def keyOf (s : Segment) : Option Int :=
  if s.mode == "stationary" then s.placeId else none

/-- Accumulate minutes per key, PRESERVING FIRST-SEEN ORDER. See the header. -/
def tally (segs : List Segment) : Array (Option Int × Int) × Int :=
  segs.foldl
    (fun (acc : Array (Option Int × Int) × Int) s =>
      let m := minutesOf s
      if m == 0 then acc
      else
        let k := keyOf s
        let total := acc.2 + m
        match acc.1.findIdx? (fun p => p.1 == k) with
        | some i => (acc.1.set! i (k, acc.1[i]!.2 + m), total)
        | none => (acc.1.push (k, m), total))
    (#[], 0)

/-- Roll one day up. `none` when the day decoded no segments at all, or when
every segment rounded to zero minutes — an absent row rather than a fabricated
one. -/
def computeRow (segs : List Segment) : Option Row :=
  if segs.isEmpty then none else
  let (buckets, totalMinutes) := tally segs
  if totalMinutes == 0 then none else
  -- ⚠ STRICT `>`, so the FIRST bucket with the maximum wins. With the array in
  -- first-seen order this reproduces the `Map` iteration the TypeScript relies
  -- on without meaning to.
  let (dominantPlaceId, dominantMinutes) :=
    buckets.foldl
      (fun (best : Option Int × Int) (p : Option Int × Int) =>
        match p.1 with
        | none => best
        | some pid => if decide (p.2 > best.2) then (some pid, p.2) else best)
      (none, 0)
  let dominantFraction :=
    if dominantPlaceId.isSome then Float.ofInt dominantMinutes / Float.ofInt totalMinutes
    else 0.0
  -- The day's final state, read off the LAST segment regardless of whether it
  -- contributed minutes — the TypeScript indexes the array, it does not consult
  -- the tally.
  let last := segs.getLast!
  let endOfDayPlaceId := if last.mode == "stationary" then last.placeId else none
  some
  { dominantPlaceId
  , dominantFraction
  , endOfDayPlaceId
  , endOfDayTs := if endOfDayPlaceId.isSome then some last.endTs else none
  , endOfDayPosterior := if endOfDayPlaceId.isSome then END_OF_DAY_BASELINE_POSTERIOR else 0.0 }

/-! ## Guards -/

private def seg (a b : Int) (m : String) (p : Option Int) : Segment :=
  { startTs := a, endTs := b, mode := m, placeId := p }

-- No segments, and every-segment-rounds-to-zero, are both "no row".
#guard computeRow [] |>.isNone
#guard computeRow [seg 0 20 "stationary" (some 1)] |>.isNone

-- One hour at place 1 is the whole day.
#guard (computeRow [seg 0 3600 "stationary" (some 1)]).map (·.dominantPlaceId) == some (some 1)
#guard (computeRow [seg 0 3600 "stationary" (some 1)]).map (·.dominantFraction) == some 1.0

-- ⚠ A TIE KEEPS THE FIRST PLACE SEEN. Reversing the segments flips the answer,
-- which is the point: this pins the order, not just the arithmetic.
#guard (computeRow [seg 0 3600 "stationary" (some 1),
                    seg 3600 7200 "stationary" (some 2)]).map (·.dominantPlaceId) == some (some 1)
#guard (computeRow [seg 0 3600 "stationary" (some 2),
                    seg 3600 7200 "stationary" (some 1)]).map (·.dominantPlaceId) == some (some 2)

-- Non-stationary minutes dilute the fraction without ever winning.
#guard (computeRow [seg 0 3600 "stationary" (some 1),
                    seg 3600 7200 "walking" none]).map (·.dominantFraction) == some 0.5
#guard (computeRow [seg 0 3600 "walking" none]).map (·.dominantPlaceId) == some none
#guard (computeRow [seg 0 3600 "walking" none]).map (·.dominantFraction) == some 0.0

-- End of day: only a stationary stay at a KNOWN place seeds the next day.
#guard (computeRow [seg 0 3600 "stationary" (some 7)]).map (·.endOfDayPlaceId) == some (some 7)
#guard (computeRow [seg 0 3600 "stationary" (some 7)]).map (·.endOfDayTs) == some (some 3600)
#guard (computeRow [seg 0 3600 "stationary" (some 7)]).map (·.endOfDayPosterior)
       == some END_OF_DAY_BASELINE_POSTERIOR
#guard (computeRow [seg 0 3600 "stationary" (some 1),
                    seg 3600 7200 "walking" none]).map (·.endOfDayPlaceId) == some none
#guard (computeRow [seg 0 3600 "stationary" (some 1),
                    seg 3600 7200 "walking" none]).map (·.endOfDayPosterior) == some 0.0
-- A stationary segment with no mined place seeds nothing either.
#guard (computeRow [seg 0 3600 "stationary" none]).map (·.endOfDayPlaceId) == some none

-- ⚠ The LAST segment decides the end of day even when it contributed no
-- minutes, because the TypeScript indexes the array rather than the tally.
#guard (computeRow [seg 0 3600 "stationary" (some 1),
                    seg 3600 3610 "walking" none]).map (·.endOfDayPlaceId) == some none

end Verified.PresenceLog
