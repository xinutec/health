import Std.Data.HashSet
import Verified.Geo.LineStations
/-!
# Served-station sets

Does a line stop at a candidate station? The station chain refuses a
(board, alight) pair the mirrored route relations say the line does not serve:
an edge passing near a station is not a service stopping there. Pinned
directly, not through `resolveStationChain`.

`HashSet` iteration is safe here: the one scan (`stationNameServed`) returns a
`Bool` on any match, so order cannot change the answer.
-/

namespace Verified.Hsmm.ServedStations

open Verified.Geo.LineStations (lineBaseToken)

/-- A line's membership entry is trusted only when its relations union to at
    least this many named stops — a fragmentary relation (a stub someone mapped
    with two stops) must not start penalising candidates. -/
def MIN_SERVED_STOPS : Nat := 5

/-- Containment matching (one normalised name inside the other) is believed only
    when the shorter is at least this long: "London St Pancras" ⊂ "London St
    Pancras International" passes, "Euston" ⊂ "Euston Square" does not. -/
def MIN_CONTAINMENT_CHARS : Nat := 10

/-- Substring test, via the `splitOn` idiom `LineStations` established (this core
    has no `containsSubstr`). Every call site guards `needle` non-empty. -/
private def containsSub (hay needle : String) : Bool :=
  (String.splitOn hay needle).length > 1

/-- Lowercase alphanumerics only: "King's Cross St. Pancras" and "King's Cross
    St Pancras" normalise alike. Lowercasing is ASCII-only, so a non-ASCII
    letter is stripped; no mirrored station name has one. -/
def normalizeStationName (name : String) : String :=
  String.ofList (name.toLower.toList.filter (fun c =>
    (c ≥ 'a' && c ≤ 'z') || (c ≥ '0' && c ≤ '9')))

structure RailStop where
  name : Option String
  /-- Where the stop is, when the cache says (the chain's pass term). -/
  lat : Option Float := none
  lon : Option Float := none
  deriving Inhabited, Repr

structure RailStopRelation where
  lineRef : Option String
  lineName : Option String
  stops : Array RailStop
  deriving Inhabited, Repr

/-- Relations that are the line: ref equal to the line's base token, or a name
    whose base token it is, case-insensitively. Containment would give the
    Victoria line every Southern service into London Victoria (38 relations, 147
    stations); the tube carries its designation in the ref, National Rail an
    operator code. An empty base matches nothing, as in `lineNamesMatching`. -/
def railRelationsForLine (relations : Array RailStopRelation) (lineName : String) :
    Array RailStopRelation :=
  let base := (lineBaseToken lineName).toLower
  if base.isEmpty then #[]
  else relations.filter (fun r =>
    (r.lineRef.getD "").toLower == base
      || (lineBaseToken (r.lineName.getD "")).toLower == base)

/-- The normalised names of the stations a line's mirrored relations stop at, or
    `none` when the mirror has no trustworthy data for the line. -/
def servedStationSet (relations : Array RailStopRelation) (line : String) :
    Option (Std.HashSet String) :=
  let matched := railRelationsForLine relations line
  if matched.isEmpty then none
  else
    let names := matched.foldl (fun acc rel =>
      rel.stops.foldl (fun acc s =>
        match s.name with
        | none => acc
        | some n => acc.insert (normalizeStationName n)) acc) (∅ : Std.HashSet String)
    if names.size ≥ MIN_SERVED_STOPS then some names else none

/-- Does a station (by POI name) match the line's served set? Exact normalised
    equality, or guarded containment. Only meaningful on a non-`none` set. -/
def stationNameServed (served : Std.HashSet String) (stationName : String) : Bool :=
  let norm := normalizeStationName stationName
  if served.contains norm then true
  else if norm.length < MIN_CONTAINMENT_CHARS then false
  else
    -- Order-independent: any match answers `true`. No "London " prefix
    -- stripping: it lost more stations than it found, since at mainline
    -- complexes this term separates co-located names.
    served.fold (fun acc s =>
      if acc then true
      else if min s.length norm.length < MIN_CONTAINMENT_CHARS then false
      else containsSub s norm || containsSub norm s) false

/-- Where a relation calls at a station, by the `stationNameServed` rule (exact
    normalised name, or guarded containment), first match. -/
def stopIndexOf (rel : RailStopRelation) (stationName : String) : Option Nat :=
  let one := fun (n : String) => stationNameServed ((∅ : Std.HashSet String).insert (normalizeStationName n)) stationName
  (List.range rel.stops.size).find? fun i =>
    match rel.stops[i]? with
    | some s => match s.name with | some n => one n | none => false
    | none => false

/-- The stations `line` calls at between two named ones, over its relations in
    either direction, fewest hops winning (a semi-fast variant is still the
    line). `none` when no relation calls at both. The decoder's counterpart of
    `LineStoppingPattern.intermediateStopCount`. -/
def intermediateCalls (relations : Array RailStopRelation) (line a b : String) :
    Option (Array RailStop) :=
  (railRelationsForLine relations line).foldl (init := (none : Option (Array RailStop))) fun acc rel =>
    match stopIndexOf rel a, stopIndexOf rel b with
    | some i, some j =>
      let lo := min i j
      let hi := max i j
      if hi == lo then acc
      else
        let between := rel.stops.extract (lo + 1) hi
        match acc with
        | none => some between
        | some f => if between.size < f.size then some between else acc
    | _, _ => acc

/-- `intermediateCalls`, counted. -/
def intermediateStops (relations : Array RailStopRelation) (line a b : String) : Option Nat :=
  (intermediateCalls relations line a b).map (·.size)

/-! ## Guards -/

private def rel (lineRef lineName : Option String) (stops : List String) : RailStopRelation :=
  ⟨lineRef, lineName, (stops.map (fun n => ({ name := some n } : RailStop))).toArray⟩

-- Five stops is exactly MIN_SERVED_STOPS; four is one short. The floor is pinned
-- from both sides, because `≥ 5` and `> 5` agree everywhere except this pair.
private def FIVE : List String :=
  ["Aldgate", "Barbican", "Baker Street", "Euston Square", "Farringdon"]
private def FOUR : List String := FIVE.take 4

private def members (s : Option (Std.HashSet String)) : Option (List String) :=
  s.map (fun h => h.toList.mergeSort (fun a b => a ≤ b))

#guard MIN_SERVED_STOPS == 5
#guard MIN_CONTAINMENT_CHARS == 10

-- Punctuation and case go, digits stay, and a name of pure punctuation
-- normalises to the empty string rather than to itself.
#guard normalizeStationName "King's Cross St. Pancras" == "kingscrossstpancras"
#guard normalizeStationName "King's Cross St Pancras" == "kingscrossstpancras"
#guard normalizeStationName "Euston Square" == "eustonsquare"
#guard normalizeStationName "Paddington (H&C Line)-Underground" == "paddingtonhclineunderground"
#guard normalizeStationName "A1" == "a1"
#guard normalizeStationName "—" == ""

-- A relation matches on either ref or name, and the line's qualifier is stripped
-- before comparison ("H&C Line" → "h&c").
#guard members (servedStationSet #[rel (some "H&C") none FIVE] "H&C Line")
  == some ["aldgate", "bakerstreet", "barbican", "eustonsquare", "farringdon"]
#guard members (servedStationSet #[rel none (some "Hammersmith & City") FIVE] "Hammersmith & City Line")
  == some ["aldgate", "bakerstreet", "barbican", "eustonsquare", "farringdon"]
-- Matching is case-insensitive on both sides.
#guard members (servedStationSet #[rel (some "H&C") none FIVE] "h&c")
  == some ["aldgate", "bakerstreet", "barbican", "eustonsquare", "farringdon"]

-- No relation matches the line: `none`, distinct from "matched but too few".
#guard servedStationSet #[rel (some "H&C") none FIVE] "Victoria Line" |>.isNone
-- Matched, but one stop short of the floor.
#guard servedStationSet #[rel (some "H&C") none FOUR] "H&C Line" |>.isNone
-- The floor is on the UNION across relations, not per relation: 4 + 1 clears it.
#guard members (servedStationSet #[rel (some "H&C") none FOUR, rel (some "H&C") none ["Great Portland Street"]] "H&C Line")
  == some ["aldgate", "bakerstreet", "barbican", "eustonsquare", "greatportlandstreet"]
-- A line whose base token strips to empty matches nothing — the `'%%'` guard.
#guard servedStationSet #[rel (some "H&C") none FIVE] "Line" |>.isNone

private def probe : Std.HashSet String :=
  (["London St Pancras International", "Euston Square", "Aldgate", "Barbican", "Farringdon"].map
    normalizeStationName).foldl (fun acc n => acc.insert n) ∅

#guard stationNameServed probe "Aldgate" == true
#guard stationNameServed probe "aldgate" == true
-- The suffix pattern the containment rule exists for: 15 chars, clears the floor.
#guard stationNameServed probe "London St Pancras" == true
-- The pattern it exists to refuse: "euston" is 6 chars, so a different station
-- cannot be absorbed into its neighbour by prefix.
#guard stationNameServed probe "Euston" == false
#guard stationNameServed probe "Euston Square" == true
-- Refused: "barbicanstation" clears the floor, but the member "barbican" does
-- not, and the floor applies to the shorter of the two.
#guard stationNameServed probe "Barbican Station" == false
#guard stationNameServed probe "Kings Cross" == false

-- The calls between a pair, either direction, fewest hops.
private def metFive : RailStopRelation := rel (some "Metropolitan") none FIVE
#guard (intermediateCalls #[metFive] "Metropolitan Line" "Aldgate" "Euston Square").map
  (·.toList.map (·.name)) == some [some "Barbican", some "Baker Street"]
#guard intermediateStops #[metFive] "Metropolitan Line" "Euston Square" "Aldgate" == some 2
#guard intermediateStops #[metFive] "Metropolitan Line" "Aldgate" "Barbican" == some 0
#guard intermediateStops #[metFive] "Metropolitan Line" "Aldgate" "Aldgate" == none
#guard intermediateStops #[metFive] "Jubilee Line" "Aldgate" "Euston Square" == none

end Verified.Hsmm.ServedStations
