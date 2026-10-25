import Verified.Geo.SegmentMerge
/-!
# The rail-label parser (from `src/geo/passes/rail-absorbers.ts`)

`parseRailWayName` reads a rail leg's `Board → Alight · Line` label for the
passes and the feasibility check.

## `parseRailWayName` is deliberately NOT reused from `Verified.Geo.Worldline`

`Board → Alight · Line` is parsed by THREE different functions in the TS and
they disagree. `Worldline.parseRailWayName` mirrors **rail-snap's**: strip the
` · Line` suffix FIRST, then find the arrow, trimming both endpoints and
rejecting either when empty. The one here is **rail-reconcile.ts**'s and does
none of that — it finds the ARROW first and looks for the line separator only
in what follows, without trimming and without rejecting empties:

| input         | rail-snap / `Worldline`    | rail-reconcile (here)          |
|---------------|----------------------------|--------------------------------|
| `"A · X → B"` | `none` (no arrow left)     | board `"A · X"`, alight `"B"`  |
| `" → B"`      | `none` (empty board)       | board `""`, alight `"B"`       |
| `"A → "`      | `none` (empty alight)      | board `"A"`, alight `""`       |
| `" A → B "`   | trimmed                    | NOT trimmed                    |

A comparison of `prevRail.alight == nextRail.board` sees the difference, and
two of the guards below are exactly that discriminator.

Wholly EXACT — no Float arithmetic in the parser. UNPROVEN; pinned against
Node/V8 (`lean/experiments/rail-absorbers-refs.mts`).
-/

namespace Verified.Geo.RailAbsorbers

-- `refinedMode ?? mode` — `SegmentMerge.effectiveMode`, the one definition.
export Verified.Geo.SegmentMerge (effectiveMode)

/-! ## `parseRailWayName` (rail-reconcile's) -/

def RAIL_STATION_SEP : String := " → "
def RAIL_LINE_SEP : String := " · "

/-- `board`, `alight`, and the line when a ` · ` suffix is present.

`line` is an `Option` because the TS field is optional — but note it is
`some ""` for a label ending in a bare separator (`"A → B · "`), which is
PRESENT-but-falsy in JS; the guards pin it. -/
structure RailTriple where
  board : String
  alight : String
  line : Option String := none
  deriving Inhabited, BEq, Repr

/-- Split on the FIRST occurrence of `sep`, rejoining the tail — exactly what
`indexOf` + two `slice`s do. `none` when the separator is absent. -/
private def splitFirst (s sep : String) : Option (String × String) :=
  match s.splitOn sep with
  | [] => none
  | [_] => none
  | head :: rest => some (head, String.intercalate sep rest)

/-- rail-reconcile's parser: arrow first, then the line separator in the
remainder. No trimming, and an empty board or alight is accepted. -/
def parseRailWayName (wayName : Option String) : Option RailTriple :=
  match wayName with
  | none => none
  | some w =>
    match splitFirst w RAIL_STATION_SEP with
    | none => none
    | some (board, rest) =>
      match splitFirst rest RAIL_LINE_SEP with
      | none => some { board, alight := rest }
      | some (alight, line) => some { board, alight, line := some line }

/-! ## Guards (V8 reference values) -/

private def T (b a : String) (l : Option String := none) : Option RailTriple := some ⟨b, a, l⟩

#guard parseRailWayName (some "Euston Square → Wembley Park · Metropolitan Line")
  == T "Euston Square" "Wembley Park" (some "Metropolitan Line")
#guard parseRailWayName (some "Euston Square → Wembley Park") == T "Euston Square" "Wembley Park"
#guard parseRailWayName (some "Metropolitan Line") == none
#guard parseRailWayName (some "") == none
#guard parseRailWayName none == none
-- The arrow is found FIRST, so a line separator BEFORE it stays inside `board`.
-- rail-snap's parser strips the suffix first, finds no arrow, and returns none.
#guard parseRailWayName (some "A · X → B") == T "A · X" "B"
-- Empty endpoints are ACCEPTED; rail-snap's parser rejects both of these.
#guard parseRailWayName (some " → B") == T "" "B"
#guard parseRailWayName (some "A → ") == T "A" ""
-- Whitespace is NOT trimmed.
#guard parseRailWayName (some " A → B ") == T " A" "B "
-- A bare trailing separator yields a PRESENT but empty line, not `none`.
#guard parseRailWayName (some "A → B · ") == T "A" "B" (some "")
-- Both separators split on the FIRST occurrence with the tail rejoined.
#guard parseRailWayName (some "A → B → C") == T "A" "B → C"
#guard parseRailWayName (some "A → B · L1 · L2") == T "A" "B" (some "L1 · L2")

end Verified.Geo.RailAbsorbers
