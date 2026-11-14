import Verified.Geo.SegmentMerge
/-!
# The rail-label parser

`parseRailWayName` reads a rail leg's `Board → Alight · Line` label for the
passes and the feasibility check. It deliberately differs from
`Verified.Geo.Worldline.parseRailWayName`: it finds the arrow first, then the
line separator in what follows, without trimming or rejecting empties:

| input         | `Worldline`                | here                           |
|---------------|----------------------------|--------------------------------|
| `"A · X → B"` | `none` (no arrow left)     | board `"A · X"`, alight `"B"`  |
| `" → B"`      | `none` (empty board)       | board `""`, alight `"B"`       |
| `"A → "`      | `none` (empty alight)      | board `"A"`, alight `""`       |
| `" A → B "`   | trimmed                    | not trimmed                    |

`prevRail.alight == nextRail.board` sees the difference; two guards pin it.
Exact. UNPROVEN; pinned by the `#guard`s.
-/

namespace Verified.Geo.RailAbsorbers

-- `refinedMode ?? mode` — `SegmentMerge.effectiveMode`, the one definition.
export Verified.Geo.SegmentMerge (effectiveMode)

/-! ## `parseRailWayName` (rail-reconcile's) -/

def RAIL_STATION_SEP : String := " → "
def RAIL_LINE_SEP : String := " · "

/-- `board`, `alight`, and the line when a ` · ` suffix is present: `some ""`
for a bare trailing separator (`"A → B · "`). -/
structure RailTriple where
  board : String
  alight : String
  line : Option String := none
  deriving Inhabited, BEq, Repr

/-- Split on the first occurrence of `sep`, rejoining the tail — exactly what
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

/-! ## Guards -/

private def T (b a : String) (l : Option String := none) : Option RailTriple := some ⟨b, a, l⟩

#guard parseRailWayName (some "Euston Square → Wembley Park · Metropolitan Line")
  == T "Euston Square" "Wembley Park" (some "Metropolitan Line")
#guard parseRailWayName (some "Euston Square → Wembley Park") == T "Euston Square" "Wembley Park"
#guard parseRailWayName (some "Metropolitan Line") == none
#guard parseRailWayName (some "") == none
#guard parseRailWayName none == none
-- The arrow is found first, so a line separator before it stays inside `board`.
-- rail-snap's parser strips the suffix first, finds no arrow, and returns none.
#guard parseRailWayName (some "A · X → B") == T "A · X" "B"
-- Empty endpoints are accepted; rail-snap's parser rejects both of these.
#guard parseRailWayName (some " → B") == T "" "B"
#guard parseRailWayName (some "A → ") == T "A" ""
-- Whitespace is not trimmed.
#guard parseRailWayName (some " A → B ") == T " A" "B "
-- A bare trailing separator yields a present but empty line, not `none`.
#guard parseRailWayName (some "A → B · ") == T "A" "B" (some "")
-- Both separators split on the first occurrence with the tail rejoined.
#guard parseRailWayName (some "A → B → C") == T "A" "B → C"
#guard parseRailWayName (some "A → B · L1 · L2") == T "A" "B" (some "L1 · L2")

end Verified.Geo.RailAbsorbers
