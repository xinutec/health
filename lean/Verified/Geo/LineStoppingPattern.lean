/-!
# Stopping-pattern line disambiguation (port of `src/geo/line-stopping-pattern.ts`)

Which of two lines sharing a track did the train run on? Ask where it STOPPED.
Out of Wembley Park the Metropolitan and the Jubilee run on the same rails for
seven kilometres, so every fix supports both and `lineUnderTheTrack` drops the
label — but the Metropolitan runs fast past four stations the Jubilee calls at,
and that difference IS in the fix stream.

The question is asked as a POSSIBILITY, not a fit. Counting the pauses the train
visibly made is a lower bound on its stops; asking how many more could have
hidden in the unobserved stretches is an upper bound. A candidate survives when
its true intermediate-stop count falls between them, and a line is named only
when exactly one candidate survives — so a dark ride excludes nobody and missing
data yields silence rather than a confident guess.

## What this module carries that the TS spreads over four files

`intermediateStopCount` reaches through `railRelationsForLine`
(`rail-stops-cache.ts`) into `lineBaseToken` (`line-stations.ts`) and
`normalizeStationName` (`served-stations.ts`). All three are pure and none had a
Lean twin, so they are ported here rather than stubbed. The DB-backed halves of
those modules (`loadAllRailStopRelations`, the station cache) stay shell — they
are I/O, and the relation array arrives as an argument exactly as it does in the
TS.

## Deviations from the TS, all deliberate

* `stopBounds` reads `p.speed_kmh ?? 0`. `FilteredPoint.speed_kmh` is declared
  non-optional, so the `?? 0` is unreachable under the declared type and the
  Lean reads the field directly. The port is faithful to the TYPE, not to the
  defensive coalesce.
* `lineBaseToken`'s `/\s+lines?\b.*$/i` and `normalizeStationName`'s
  `/[^a-z0-9]/g` are matched on ASCII only. JS `\s` also covers ` `,
  `﻿` and the Unicode `Zs` class, and JS `toLowerCase` case-folds
  non-ASCII before the strip. Station and line names in the OSM mirror are
  ASCII; a non-ASCII space or a Turkish dotted capital would diverge.
* `Math.floor` stays in `Float`. TS never converts these counts to integers —
  `atMost` is `atLeast + hidden` with both sides JS numbers — so neither does
  this, and `intermediateStopCount` returns `Option Float` for the same reason.

Exactness: every arithmetic decision is exact (one multiply, one divide, one
add, one `floor` per gap). UNPROVEN; pinned against Node/V8
(`lean/experiments/line-stopping-refs.mts`).
-/

namespace Verified.Geo.LineStoppingPattern

/-! ## Inputs -/

/-- One ordered stop of a route relation. Only `name` is read here; the
coordinates and sequence number are carried so the structure matches the
mirror's row shape for a later consumer. -/
structure RouteStop where
  name : Option String
  lat : Float := 0
  lon : Float := 0
  seq : Nat := 0
  deriving Inhabited, BEq, Repr

/-- ONE DIRECTION of a service, with its stops in route order. At least one of
`lineRef` / `lineName` is non-null — a relation with neither is dropped upstream,
since there would be nothing to match a pipeline line label against. -/
structure RailStopRelation where
  stops : Array RouteStop
  lineRef : Option String := none
  lineName : Option String := none
  osmRelationId : Nat := 0
  routeType : String := "subway"
  deriving Inhabited, BEq, Repr

/-- A Kalman-filtered fix. `bearing` is unread here. -/
structure FilteredPoint where
  ts : Int
  lat : Float := 0
  lon : Float := 0
  speedKmh : Float := 0
  bearing : Float := 0
  deriving Inhabited, BEq, Repr

/-! ## Constants -/

/-- At or above this the train is unambiguously running between stations — well
clear of a platform crawl, a reacquire wobble, or anything a pedestrian or a bus
in traffic reaches. -/
def RUNNING_KMH : Float := 25

/-- At or below this the train is standing. Not zero: a fix taken at a platform
still carries Kalman residue from the deceleration that preceded it. -/
def DWELL_KMH : Float := 8

/-- Service brake / acceleration rate, m/s². Deliberately at the top of the
realistic range: a higher rate means a stop fits into a shorter gap, which
permits MORE hidden stops. Over-permitting yields a null; under-permitting
yields a wrong line label. -/
def BRAKE_MS2 : Float := 1.3

/-- Shortest station dwell worth calling a stop, seconds. -/
def DWELL_MIN_S : Float := 20

def KMH_TO_MS : Float := 1 / 3.6

/-! ## `lineBaseToken` — `lineName.replace(/\s+lines?\b.*$/i, "").trim()` -/

/-- JS `\s`, ASCII half. -/
private def isJsSpace (c : Char) : Bool :=
  c == ' ' || c == '\t' || c == '\n' || c == '\r' || c.toNat == 0x0B || c.toNat == 0x0C

/-- JS `\w` — `[A-Za-z0-9_]`. `Char.isAlphanum` is already ASCII-only. -/
private def isJsWord (c : Char) : Bool := c.isAlphanum || c == '_'

/-- Does this (already lower-cased) tail begin `lines?\b`? `s?` is greedy, so
`"lines"` is tried first and `"line"` is the backtrack — which is why
`"linesman"` matches NEITHER: `"lines"` is followed by `m` and `"line"` by `s`,
both word characters. -/
private def startsWithLineWord (lowered : List Char) : Bool :=
  let boundedBy (w : List Char) : Bool :=
    w.isPrefixOf lowered &&
      (match lowered.drop w.length with
       | [] => true
       | c :: _ => !isJsWord c)
  boundedBy "lines".toList || boundedBy "line".toList

/-- The kept prefix: everything before the FIRST whitespace run that is followed
by `line`/`lines` at a word boundary.

`\s+` is greedy and then backtracks, but backtracking inside a whitespace run
can never help — the character after a shortened run is still whitespace, never
`l` — so testing each MAXIMAL run is exactly what the regex engine does. -/
private def cutAtLineWord : List Char → List Char
  | [] => []
  | c :: tl =>
    if isJsSpace c then
      let run := (c :: tl).takeWhile isJsSpace
      let after := (c :: tl).drop run.length
      if startsWithLineWord (after.map Char.toLower) then [] else c :: cutAtLineWord tl
    else c :: cutAtLineWord tl

/-- A line label stripped to the token that identifies it: `"Metropolitan Line:
Aldgate → Amersham"` → `"Metropolitan"`. A compound label
(`"Circle and District lines"`) keeps both words and so matches no single-line
relation — which is why an empty result must be read as "no membership data",
never as "serves no stations". -/
def lineBaseToken (lineName : String) : String :=
  (String.ofList (cutAtLineWord lineName.toList)).trimAscii.toString

/-! ## `normalizeStationName` and relation lookup -/

/-- Lowercase alphanumerics only: `"King's Cross St. Pancras"` and
`"King's Cross St Pancras"` normalize identically. -/
def normalizeStationName (name : String) : String :=
  String.ofList ((name.toList.map Char.toLower).filter Char.isAlphanum)

/-- Is `needle` a prefix of any suffix of the list? (Lean 4.30 has
`List.isPrefixOf` but no `List.isInfixOf`.) -/
private def containsSubList (needle : List Char) : List Char → Bool
  | [] => needle.isEmpty
  | c :: tl => needle.isPrefixOf (c :: tl) || containsSubList needle tl

/-- `String.prototype.includes`, over `List Char`. -/
private def containsSub (haystack needle : String) : Bool :=
  containsSubList needle.toList haystack.toList

/-- The relations serving a pipeline line label: `ref` or `name` CONTAINS the
label's base token, case-insensitively. Empty when nothing matches — including
compound labels and labels that strip to an empty base. -/
def railRelationsForLine (relations : Array RailStopRelation) (lineName : String) :
    Array RailStopRelation :=
  let base := (lineBaseToken lineName).toLower
  if base.isEmpty then #[] else
  relations.filter fun r =>
    (match r.lineRef with | none => false | some s => containsSub s.toLower base) ||
    (match r.lineName with | none => false | some s => containsSub s.toLower base)

/-- Where a station sits in a relation's ordered stop list, or `-1`. -/
private def indexOfStop (rel : RailStopRelation) (station : String) : Int :=
  let target := normalizeStationName station
  match rel.stops.findIdx? (fun s =>
      match s.name with
      | none => false
      | some n => normalizeStationName n == target) with
  | none => -1
  | some i => Int.ofNat i

/-! ## `intermediateStopCount` -/

/--
How many stations this line calls at BETWEEN the two named ones — `0` for a
non-stop hop — or `none` when the mirror cannot say (no relation for the line,
or none that stops at both endpoints).

A relation is one DIRECTION of a service, so the endpoints may appear in either
order and the hop count is the absolute distance between them. Where a line has
several relations the FEWEST hops wins: a semi-fast variant that skips stations
is still that line, and the question is what the observed train COULD have been.
-/
def intermediateStopCount (line board alight : String)
    (relations : Array RailStopRelation) : Option Float :=
  let fewest := (railRelationsForLine relations line).foldl (init := (none : Option Nat))
    fun acc rel =>
      let b := indexOfStop rel board
      let a := indexOfStop rel alight
      if b < 0 || a < 0 then acc
      else
        let hops := (a - b).natAbs
        if hops == 0 then acc
        else match acc with
          | none => some hops
          | some f => if hops < f then some hops else acc
  fewest.map fun f => Float.ofNat f - 1

/-! ## `stopBounds` -/

/-- The range of intermediate station stops the ride's fix stream allows. -/
structure StopBounds where
  /-- Pauses actually observed between the first and last running fix. -/
  atLeast : Float
  /-- …plus every stop that could have hidden where nobody was looking. -/
  atMost : Float
  deriving Inhabited, BEq, Repr

/-- How many station stops could fit unseen in a `gapS`-second stretch between
fixes at `fromKmh` and `toKmh` — brake, dwell, regain speed, repeat. -/
private def stopsThatFit (gapS fromKmh toKmh : Float) : Float :=
  let perStopS := (fromKmh * KMH_TO_MS) / BRAKE_MS2 + DWELL_MIN_S + (toKmh * KMH_TO_MS) / BRAKE_MS2
  Float.floor (gapS / perStopS)

/-- A pair with the train standing at BOTH ends contributes nothing: those two
observations bracket ONE pause, not a sequence of them, and crediting a platform
wait with four hidden stops is how this bound stops discriminating anything. One
standing end still counts — it just costs no braking or acceleration time. -/
private def hiddenBetween (gapS : Float) (a b : FilteredPoint) : Float :=
  if a.speedKmh <= DWELL_KMH && b.speedKmh <= DWELL_KMH then 0
  else stopsThatFit gapS a.speedKmh b.speedKmh

/--
How many times the train could have stood still between pulling away and
arriving, given what was observed — or `none` when it was never seen running,
which leaves nothing to bound.

The interior is delimited by the train's own motion rather than by a guard band
on the clock: from the first fix at running speed to the last, which excludes
the platform wait at the near end and the deceleration at the far end without
having to guess how long either was. A pause inside that span has the train
running on both sides of it, which is what makes it a station stop rather than
an endpoint.

Unobserved time is treated the same wherever it falls, INCLUDING before the
first running fix and after the last — the head of a ride whose GPS only came
back halfway is exactly such a stretch, and that is what keeps a sparse ride
from masquerading as a confidently non-stop one.

`Array#sort` is TimSort and `List.mergeSort` merges left-biased, so fixes
sharing a timestamp keep their input order in both.
-/
def stopBounds (points : Array FilteredPoint) (boardTs alightTs : Int) : Option StopBounds :=
  let ride := ((points.toList.filter fun p => p.ts >= boardTs && p.ts <= alightTs).mergeSort
    fun a b => a.ts ≤ b.ts).toArray
  match ride.findIdx? (fun p => p.speedKmh >= RUNNING_KMH) with
  | none => none
  | some first =>
    -- The `while` in the TS cannot run past `first`, which qualifies by construction.
    let last := ((List.range ride.size).reverse.find? fun i =>
      ride[i]!.speedKmh >= RUNNING_KMH).getD first
    if last == first then none  -- one running fix is a glimpse, not a ride
    else
      let span := ((ride.toList.drop first).take (last + 1 - first))
      let atLeast := (span.foldl (init := ((0 : Nat), false)) fun acc p =>
        let isStanding := p.speedKmh <= DWELL_KMH
        (if isStanding && !acc.2 then acc.1 + 1 else acc.1, isStanding)).1
      let p0 := ride[0]!
      let lastFix := ride[ride.size - 1]!
      let seed := hiddenBetween (Float.ofInt (p0.ts - boardTs)) p0 p0
        + hiddenBetween (Float.ofInt (alightTs - lastFix.ts)) lastFix lastFix
      let hidden := (List.range (ride.size - 1)).foldl (init := seed) fun acc i =>
        acc + hiddenBetween (Float.ofInt (ride[i + 1]!.ts - ride[i]!.ts)) ride[i]! ride[i + 1]!
      some { atLeast := Float.ofNat atLeast, atMost := Float.ofNat atLeast + hidden }

/-! ## `pickLineByStoppingPattern` -/

/--
Which candidate line's stopping pattern the ride does not rule out, or `none`
when it rules out fewer or more than exactly one.

Deliberately willing to name a line on incomplete information — a ride that
demonstrably ran past four stations was not the service that calls at all four.
What it will NOT do is choose between candidates the ride leaves both possible;
that is a coin toss, and a coin toss belongs in the caller's bare station-pair
label, not in a line name.
-/
def pickLineByStoppingPattern (candidates : Array String) (board alight : String)
    (relations : Array RailStopRelation) (points : Array FilteredPoint)
    (boardTs alightTs : Int) : Option String :=
  match stopBounds points boardTs alightTs with
  | none => none
  | some bounds =>
    let scored := candidates.map fun line => (line, intermediateStopCount line board alight relations)
    -- A candidate the mirror has no stop list for is not ruled out by anything —
    -- it is UNMEASURED, and an unmeasured rival means the survivor below would be
    -- an artefact of missing data rather than of the ride.
    if scored.any (fun c => c.2.isNone) then none
    else
      let possible := scored.filter fun c =>
        match c.2 with
        | none => false
        | some v => v >= bounds.atLeast && v <= bounds.atMost
      if possible.size == 1 then some possible[0]!.1 else none

/-! ## Guards -/

/-! ### `lineBaseToken` -/

#guard lineBaseToken "Metropolitan Line" == "Metropolitan"
#guard lineBaseToken "Jubilee line: Stanmore → Stratford" == "Jubilee"
#guard lineBaseToken "Circle and District lines" == "Circle and District"
#guard lineBaseToken "Bakerloo" == "Bakerloo"
-- `\s+` is REQUIRED, so a label that IS the word keeps it.
#guard lineBaseToken "Lines" == "Lines"
#guard lineBaseToken "Line" == "Line"
-- `\b` after `lines?`: neither the greedy nor the backtracked arm reaches a boundary.
#guard lineBaseToken "Northern linesman" == "Northern linesman"
-- Not `line` at all — the shared prefix `li` must not be enough.
#guard lineBaseToken "Docklands Light Railway" == "Docklands Light Railway"
-- Greedy `\s+` spans the whole run; the FIRST match wins and `.*$` eats the rest.
#guard lineBaseToken "Metropolitan   Line" == "Metropolitan"
#guard lineBaseToken "A Line B Line" == "A"
#guard lineBaseToken "   Metropolitan Line   " == "Metropolitan"
-- A label that strips to nothing — `railRelationsForLine` must then match nobody.
#guard lineBaseToken " Line" == ""
#guard lineBaseToken "" == ""

/-! ### `normalizeStationName` -/

#guard normalizeStationName "King's Cross St. Pancras" == "kingscrossstpancras"
#guard normalizeStationName "Kings Cross St Pancras" == "kingscrossstpancras"
#guard normalizeStationName "Euston Square" == "eustonsquare"
#guard normalizeStationName "  " == ""

/-! ### Fixture: the Wembley Park → Finchley Road stretch

The Metropolitan runs fast past Neasden, Dollis Hill, Willesden Green and
Kilburn; the Jubilee calls at all four. Same rails, same fixes.
-/

private def stop (n : String) : RouteStop := { name := some n }

private def metRel : RailStopRelation :=
  { lineName := some "Metropolitan Line: Aldgate → Amersham"
  , lineRef := some "Metropolitan"
  , stops := #[stop "Wembley Park", stop "Finchley Road", stop "Baker Street"] }

private def jubRel : RailStopRelation :=
  { lineName := some "Jubilee Line: Stanmore → Stratford"
  , lineRef := some "Jubilee"
  , stops := #[stop "Wembley Park", stop "Neasden", stop "Dollis Hill",
               stop "Willesden Green", stop "Kilburn", stop "Finchley Road"] }

/-- The same Metropolitan service mapped in the other direction, plus a
semi-fast variant that skips Baker Street. FEWEST hops must win. -/
private def metReverse : RailStopRelation :=
  { lineName := some "Metropolitan Line: Amersham → Aldgate"
  , stops := #[stop "Baker Street", stop "Finchley Road", stop "Wembley Park"] }

private def rels : Array RailStopRelation := #[metRel, jubRel, metReverse]

#guard (railRelationsForLine rels "Metropolitan Line").size == 2
#guard (railRelationsForLine rels "Jubilee Line").size == 1
-- A compound label matches no single-line relation: "no data", not "no stations".
#guard (railRelationsForLine rels "Circle and District lines").size == 0
-- An empty base must not become a `'%%'` that matches everything.
#guard (railRelationsForLine rels " Line").size == 0

/-! ### `intermediateStopCount` -/

#guard intermediateStopCount "Metropolitan Line" "Wembley Park" "Finchley Road" rels == some 0
#guard intermediateStopCount "Jubilee Line" "Wembley Park" "Finchley Road" rels == some 4
-- Either direction, same count.
#guard intermediateStopCount "Metropolitan Line" "Finchley Road" "Wembley Park" rels == some 0
#guard intermediateStopCount "Jubilee Line" "Finchley Road" "Wembley Park" rels == some 4
-- Normalization runs on both endpoints.
#guard intermediateStopCount "Jubilee Line" "wembley  park!" "FINCHLEY ROAD" rels == some 4
-- No relation for the line, and a relation that misses an endpoint: both `none`.
#guard intermediateStopCount "Victoria Line" "Wembley Park" "Finchley Road" rels == none
#guard intermediateStopCount "Metropolitan Line" "Wembley Park" "Chesham" rels == none
-- Same station twice: `hops === 0` is skipped, not reported as a 0-hop ride.
#guard intermediateStopCount "Jubilee Line" "Neasden" "Neasden" rels == none
-- Three relations name Baker Street ↔ Finchley Road at 1 hop; the fewest wins.
#guard intermediateStopCount "Metropolitan Line" "Baker Street" "Finchley Road" rels == some 0

/-! ### `stopBounds`

The observed 2026-06-23 shape: a platform wait, an unbroken run with one 64 s
gap, then arrival.
-/

private def fix (ts : Int) (kmh : Float) : FilteredPoint := { ts := ts, speedKmh := kmh }

/-- Wembley Park → Finchley Road, the ride from the module header, at the ~15 s
sampling the real day had: a platform wait, 18.7 then 52-76 km/h unbroken with
ONE 64 s gap, a deceleration, then arrival. `t = 0` is 07:42:28. -/
private def ride0623 : Array FilteredPoint :=
  #[ fix 0 1.1, fix 15 0.6, fix 30 0.8, fix 45 0.9, fix 60 3.4
   , fix 75 1.0, fix 90 0.8, fix 105 2.0, fix 112 2.0                   -- platform wait
   , fix 142 18.7                                                       -- pulling away
   , fix 157 52, fix 172 60, fix 187 68, fix 202 74, fix 217 76
   , fix 232 74, fix 247 72, fix 262 70, fix 277 70, fix 292 72
   , fix 307 74, fix 322 72
   , fix 386 68                                                         -- the 64 s gap
   , fix 401 66, fix 416 64, fix 431 62, fix 446 60, fix 461 60
   , fix 476 58, fix 491 58, fix 506 56, fix 521 56
   , fix 536 30, fix 551 12                                             -- braking in
   , fix 566 0, fix 581 0, fix 596 0, fix 611 0, fix 626 0 ]            -- arrived

/-- Twelve fixes 5 s apart at a steady 60 km/h: no gap anywhere, so nothing can
hide and `atMost` collapses onto `atLeast`. -/
private def dense : Array FilteredPoint :=
  ((List.range 12).map fun i => fix (Int.ofNat (5 * i)) 60).toArray

-- The ride is bounded to two possible stops — the 64 s gap and the pull-away.
#guard stopBounds ride0623 0 631 == some { atLeast := 0, atMost := 2 }
-- `Array#sort` and `List.mergeSort` agree, so input order cannot matter.
#guard stopBounds ride0623.reverse 0 631 == some { atLeast := 0, atMost := 2 }
-- Never seen running at all: nothing to bound.
#guard stopBounds #[fix 0 1.0, fix 60 2.0] 0 60 == none
-- A single running fix is a glimpse, not a ride.
#guard stopBounds #[fix 0 1.0, fix 30 40.0, fix 60 2.0] 0 60 == none
-- A visible mid-ride pause, running on both sides of it, IS a station stop.
#guard stopBounds #[fix 0 40, fix 30 40, fix 60 2, fix 90 1, fix 120 40, fix 150 40] 0 150
  == some { atLeast := 1, atMost := 3 }
-- Watched throughout: `atMost` collapses onto `atLeast`.
#guard stopBounds dense 0 55 == some { atLeast := 0, atMost := 0 }
-- THE SPARSE-RIDE GUARD. The same fixes in a window that starts half an hour
-- earlier: unobserved time before the first fix counts, so a ride whose GPS only
-- came back halfway cannot pose as a confidently non-stop one.
#guard stopBounds dense (-1800) 55 == some { atLeast := 0, atMost := 39 }

/-! ### `pickLineByStoppingPattern` -/

-- The module's headline case: five Jubilee stops cannot fit in what was
-- observed, so the one surviving candidate is named.
#guard pickLineByStoppingPattern #["Metropolitan Line", "Jubilee Line"]
  "Wembley Park" "Finchley Road" rels ride0623 0 631 == some "Metropolitan Line"
#guard pickLineByStoppingPattern #["Metropolitan Line", "Jubilee Line"]
  "Wembley Park" "Finchley Road" rels dense 0 55 == some "Metropolitan Line"
-- An unmeasured rival forbids a verdict even when the ride excludes the other.
#guard pickLineByStoppingPattern #["Metropolitan Line", "Victoria Line"]
  "Wembley Park" "Finchley Road" rels ride0623 0 631 == none
-- A dark ride excludes nobody.
#guard pickLineByStoppingPattern #["Metropolitan Line", "Jubilee Line"]
  "Wembley Park" "Finchley Road" rels #[fix 0 1.0, fix 631 1.0] 0 631 == none
-- Sparse enough that BOTH survive: a coin toss belongs in the caller's bare
-- station-pair label, not in a line name.
#guard pickLineByStoppingPattern #["Metropolitan Line", "Jubilee Line"]
  "Wembley Park" "Finchley Road" rels dense (-1800) 55 == none
-- A LONE candidate is still tested, not waved through: the Jubilee's four stops
-- do not fit, so nothing survives and the answer is silence.
#guard pickLineByStoppingPattern #["Jubilee Line"]
  "Wembley Park" "Finchley Road" rels ride0623 0 631 == none

end Verified.Geo.LineStoppingPattern
