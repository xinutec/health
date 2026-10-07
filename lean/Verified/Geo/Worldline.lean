import Verified.Hsmm.FloatScore
import Verified.FloatConst
/-!
# Rail labels and step cadence for the cascade's passes

The pieces of the old worldline port (`src/eval/worldline-feasibility.ts`) the
passes still read: the `Board → Alight · Line` label parser rail-snap uses, the
per-minute step cadence and the pedestrian-pace bounds the stay splitter judges
walking by. The worldline invariants themselves live in
`Verified.Eval.Feasibility`, the one the corpus gate runs.

Exact: string handling, comparison and one prorated sum. UNPROVEN; pinned by the
`#guard`s against Node/V8.
-/

namespace Verified.Geo.Worldline

/-! ## Constants (verbatim) -/
def PEDESTRIAN_STEP_MAX_KMH : Float := 9
def PEDESTRIAN_MIN_RUN_NET_M : Float := 120
def PEDESTRIAN_MIN_RUN_S : Float := 90
def PEDESTRIAN_MIN_CADENCE_SPM : Float := 60
def RAIL_STATION_SEP : String := " → "
def RAIL_LINE_SEP : String := " · "

/-! ## Shapes -/

structure FeasibilityStepPoint where
  ts : Int
  steps : Float
  deriving Inhabited

/-- Parsed train label: two stations and an optional line. -/
structure RailTriple where
  board : String
  alight : String
  line : Option String
  deriving Inhabited, BEq

/-! ## Helpers -/

/-- Parse `Board → Alight · Line`. `none` without the station arrow; the line is
    optional.

    Mirrors the TS `indexOf`/`slice` exactly, and the ORDER matters: the line
    suffix is stripped from the WHOLE string FIRST, then the remainder is split
    on the station arrow. Doing it the other way round accepts
    `"A · X → B"` — which the TS rejects, because after stripping ` · X → B`
    the remainder `"A"` has no arrow left in it.

    Each field is trimmed, an empty board or alight rejects the whole label
    (`" → B"`, `"A → "` are not station pairs), and a blank line suffix
    degrades to `none` rather than to a whitespace string. Both separators
    split on their FIRST occurrence with the tail rejoined, so
    `"A → B → C"` alights at `"B → C"`. -/
def parseRailWayName (wayName : Option String) : Option RailTriple :=
  match wayName with
  | none => none
  | some s =>
    -- Strip the ` · Line` suffix from the whole string first (TS order).
    let (rest, line) :=
      match s.splitOn RAIL_LINE_SEP with
      | [] => (s, none)
      | [_] => (s, none)
      | head :: lineRest =>
        let lineStr := (String.intercalate RAIL_LINE_SEP lineRest).trimAscii.toString
        (head, if lineStr.isEmpty then none else some lineStr)
    match rest.splitOn RAIL_STATION_SEP with
    | [] => none
    | [_] => none
    | board :: alightRest =>
      let b := board.trimAscii.toString
      let a := (String.intercalate RAIL_STATION_SEP alightRest).trimAscii.toString
      if b.isEmpty || a.isEmpty then none else some ⟨b, a, line⟩

/-- Mean steps/min over `[startTs, endTs]` from per-minute buckets, or `none`
    when no bucket overlaps (no data ≠ zero cadence).

    A bucket counts in proportion to its overlap with the window: its steps are
    spread over its minute, so a bucket that shares one second with the window
    brings a sixtieth of them. Counting edge buckets whole let the minute of
    walking AWAY from a stop vote on the stop — 05-12's seven-minute shop stop
    read 56 steps/min (the 93 of the arrival minute and the 100 of the
    departure minute, each overlapping by seconds) and was vetoed as walked
    through; prorated it reads 30 (#185, 2026-09-30). -/
def meanCadenceSpm (steps : List FeasibilityStepPoint) (startTs endTs : Int) : Option Float := Id.run do
  let mut total : Float := 0
  let mut overlapped := false
  for s in steps do
    if decide (s.ts + 60 ≤ startTs) || decide (s.ts ≥ endTs) then pure ()
    else
      overlapped := true
      let ov := min (s.ts + 60) endTs - max s.ts startTs
      total := total + s.steps * Float.ofInt ov / 60
  if !overlapped then return none
  return some (total / max 1 (Float.ofInt (endTs - startTs) / 60))

/-! ## Parity with Node/V8 (`lean/experiments/worldline-refs.mts`) -/

#guard parseRailWayName (some "A → B · Victoria") == some ⟨"A", "B", some "Victoria"⟩
#guard parseRailWayName (some "A → B") == some ⟨"A", "B", none⟩
#guard parseRailWayName (some "no arrow here") == none
#guard parseRailWayName none == none
-- Both separators take their FIRST occurrence, tail rejoined.
#guard parseRailWayName (some "A → B → C") == some ⟨"A", "B → C", none⟩
-- The line suffix is stripped BEFORE the arrow split, so a ` · ` ahead of the
-- arrow consumes it and leaves no station pair behind.
#guard parseRailWayName (some "A · X → B") == none
-- An empty endpoint is not a station pair.
#guard parseRailWayName (some " → B") == none
#guard parseRailWayName (some "A → ") == none
-- The separators carry their own spaces; without them there is no pair.
#guard parseRailWayName (some "A→B") == none
-- A blank line suffix degrades to `none`, not to a whitespace string.
#guard parseRailWayName (some "A → B ·  ") == some ⟨"A", "B", none⟩
-- Every field is trimmed.
#guard parseRailWayName (some "  A  →  B  · L ") == some ⟨"A", "B", some "L"⟩

private def steps3 : List FeasibilityStepPoint := [⟨0, 100⟩, ⟨60, 110⟩, ⟨120, 0⟩]
private def approxC (a b : Float) : Bool := Float.abs (a - b) < 1e-9
#guard match meanCadenceSpm steps3 0 180 with | some v => approxC v 70 | none => false
#guard match meanCadenceSpm steps3 0 120 with | some v => approxC v 105 | none => false
#guard meanCadenceSpm steps3 1000 2000 == none

end Verified.Geo.Worldline
