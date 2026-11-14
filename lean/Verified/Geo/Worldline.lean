import Verified.Hsmm.FloatScore
import Verified.FloatConst
/-!
# Rail labels and step cadence for the cascade's passes

The `Board → Alight · Line` label parser, the per-minute step cadence, and the
pedestrian-pace bounds the stay splitter uses. The worldline invariants are
`Verified.Eval.Feasibility`.

Exact. UNPROVEN; pinned by the `#guard`s.
-/

namespace Verified.Geo.Worldline

/-! ## Constants (verbatim) -/
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

/-- Parse `Board → Alight · Line`; `none` without the arrow, the line optional.
    The line suffix is stripped first, so `"A · X → B"` is rejected. Fields are
    trimmed; an empty board or alight rejects; a blank line is `none`. Both
    separators split at their first occurrence, so `"A → B → C"` alights at
    `"B → C"`. -/
def parseRailWayName (wayName : Option String) : Option RailTriple :=
  match wayName with
  | none => none
  | some s =>
    -- Strip the ` · Line` suffix from the whole string first.
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
    with no overlapping bucket (no data ≠ zero). Each bucket counts in
    proportion to its overlap, so the arrival and departure minutes cannot
    make a short stop read as walked through. -/
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

/-! ## Guards -/

#guard parseRailWayName (some "A → B · Victoria") == some ⟨"A", "B", some "Victoria"⟩
#guard parseRailWayName (some "A → B") == some ⟨"A", "B", none⟩
#guard parseRailWayName (some "no arrow here") == none
#guard parseRailWayName none == none
-- Both separators take their first occurrence, tail rejoined.
#guard parseRailWayName (some "A → B → C") == some ⟨"A", "B → C", none⟩
-- The line suffix is stripped before the arrow split, so a ` · ` ahead of the
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
