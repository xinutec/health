import Verified.JsNum
/-!
# One day's decoded segments → one `presence_log` row

`computeRow` (`docs/proposals/2026-06-presence-continuity.md`, phase 1)
re-expands the stored `HmmSegment[]` to per-minute attribution and rolls the
day up: the known place holding the most minutes, and the end-of-day state the
next day's continuation reads.

A tie keeps the first place seen (insertion-ordered array, strict `>`): a real
decision about a real day. A zero-minute segment is skipped, so a day of only
sub-30 s segments has `totalMinutes = 0` and produces no row.

Pure and total. UNPROVEN; the guards pin the thresholds and the tie-break.
-/

namespace Verified.PresenceLog

/-- The end-of-day posterior for a stay at a known place holding the day's final
minute: a conservative baseline from the design's worked example, until the
HSMM emits per-segment posteriors. -/
def END_OF_DAY_BASELINE_POSTERIOR : Float := 0.95

/-- One compacted HSMM segment, as `decoded_days` stores it. -/
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
  /-- Unix seconds; the caller turns this into the column's type. -/
  endOfDayTs : Option Int
  endOfDayPosterior : Float
  deriving Inhabited, Repr

/-- Minutes a segment contributes: rounded, clamped at zero, so an inverted
segment cannot corrupt the denominator. -/
def minutesOf (s : Segment) : Int :=
  max 0 (Verified.JsNum.jsRoundInt (Float.ofInt (s.endTs - s.startTs) / 60.0))

/-- The key a segment's minutes accumulate under: its place for a stationary
stay, else `none`. `none` is a real bucket in the denominator, so
`dominantFraction` counts time away from the dominant place. -/
def keyOf (s : Segment) : Option Int :=
  if s.mode == "stationary" then s.placeId else none

/-- Accumulate minutes per key, preserving first-seen order. See the header. -/
def tally (segs : List Segment) : Array (Option Int × Int) × Int :=
  segs.foldl
    (fun (acc : Array (Option Int × Int) × Int) s =>
      let m := minutesOf s
      if m == 0 then acc
      else
        let k := keyOf s
        let total := acc.2 + m
        match acc.1.findFinIdx? (fun p => p.1 == k) with
        | some i => (acc.1.set i (k, acc.1[i].2 + m), total)
        | none => (acc.1.push (k, m), total))
    (#[], 0)

/-- Roll one day up. `none` when the day decoded no segments at all, or when
every segment rounded to zero minutes — an absent row rather than a fabricated
one. -/
def computeRow (segs : List Segment) : Option Row :=
  if segs.isEmpty then none else
  let (buckets, totalMinutes) := tally segs
  if totalMinutes == 0 then none else
  -- Strict `>`, so the first bucket with the maximum wins: with the array in
  -- first-seen order, the first place seen.
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
  -- The day's final state, read off the last segment regardless of whether it
  -- contributed minutes: the array, not the tally.
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

-- A tie keeps the first place seen. Reversing the segments flips the answer,
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

-- End of day: only a stationary stay at a known place seeds the next day.
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

-- The last segment decides the end of day even when it contributed no
-- minutes: the array decides, not the tally.
#guard (computeRow [seg 0 3600 "stationary" (some 1),
                    seg 3600 3610 "walking" none]).map (·.endOfDayPlaceId) == some none

end Verified.PresenceLog
