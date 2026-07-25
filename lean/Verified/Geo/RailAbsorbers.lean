/-!
# Rail absorbers (port of the pure passes in `src/geo/passes/rail-absorbers.ts`)

Three list rewrites that clean up the segments around a rail journey, plus the
label parser one of them depends on.

* `absorbDriveStops` — a `driving → short stationary → driving` sandwich with
  almost no steps in the middle never opened the vehicle's doors. Absorb it.
* `absorbInterchanges` — a run of short stationary segments right after a train,
  with the journey continuing past it, is the platform change, not a stay.
  Extend the train over it.
* `relabelWalkingInterchanges` — a short walk between two train legs that share a
  station is the platform-to-platform change, so name it after the station
  rather than whatever street the GPS happened to see.

## `parseRailWayName` is deliberately NOT reused from `Verified.Geo.Worldline`

`Board → Alight · Line` is parsed by THREE different functions in the TS and
they disagree. `Worldline.parseRailWayName` mirrors **rail-snap's**: strip the
` · Line` suffix FIRST, then find the arrow, trimming both endpoints and
rejecting either when empty. The one `relabelWalkingInterchanges` calls lives in
**rail-reconcile.ts** and does none of that — it finds the ARROW first and looks
for the line separator only in what follows, without trimming and without
rejecting empties:

| input         | rail-snap / `Worldline`    | rail-reconcile (here)          |
|---------------|----------------------------|--------------------------------|
| `"A · X → B"` | `none` (no arrow left)     | board `"A · X"`, alight `"B"`  |
| `" → B"`      | `none` (empty board)       | board `""`, alight `"B"`       |
| `"A → "`      | `none` (empty alight)      | board `"A"`, alight `""`       |
| `" A → B "`   | trimmed                    | NOT trimmed                    |

`relabelWalkingInterchanges` compares `prevRail.alight == nextRail.board`, so
the difference reaches the output — two of the guards below are exactly that
discriminator. Reusing the Lean parser already in the tree would have been a
silent wrong port.

Wholly EXACT — no Float arithmetic anywhere in this module. UNPROVEN; pinned
against Node/V8 (`lean/experiments/rail-absorbers-refs.mts`).
-/

namespace Verified.Geo.RailAbsorbers

abbrev Mode := String

/-- The `EnrichedSegment` fields these passes read and rewrite. -/
structure Seg where
  startTs : Int
  endTs : Int
  mode : Mode
  refinedMode : Option Mode := none
  wayName : Option String := none
  refinedReason : Option String := none
  pointCount : Int := 10
  deriving Inhabited, BEq, Repr

/-- A per-minute step count. -/
structure StepPoint where
  ts : Int
  steps : Int
  deriving Inhabited, BEq, Repr

def effectiveMode (s : Seg) : Mode := s.refinedMode.getD s.mode

/-! ## `parseRailWayName` (rail-reconcile's) -/

def RAIL_STATION_SEP : String := " → "
def RAIL_LINE_SEP : String := " · "

/-- `board`, `alight`, and the line when a ` · ` suffix is present.

`line` is an `Option` because the TS field is optional — but note it is
`some ""` for a label ending in a bare separator (`"A → B · "`), which is
PRESENT-but-falsy in JS. `relabelWalkingInterchanges` tests it for truthiness,
not presence, so the distinction is load-bearing and is guarded. -/
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

/-! ## `absorbDriveStops` -/

/-- Longest a phantom drive-stop can be and still be absorbed. Real brief stops
(drop-off, ATM, quick errand) run a few minutes; longer ones are genuine even if
the user happened not to step out. -/
def DRIVE_STOP_ABSORB_MAX_S : Int := 15 * 60
/-- Even briefly getting out of a car generates a handful of steps, so near-zero
is the biometric tell for "stayed in the vehicle". -/
def DRIVE_STOP_ABSORB_MAX_STEPS : Int := 5
/-- Fixpoint bound, mirroring the TS's `guard < 10`. Also what makes this
structurally recursive rather than `partial`. -/
def DRIVE_STOP_MAX_PASSES : Nat := 10

private def stepsBetween (steps : Array StepPoint) (startTs endTs : Int) : Int :=
  steps.foldl (fun acc p => if p.ts ≥ startTs && p.ts ≤ endTs then acc + p.steps else acc) 0

/-- One left-to-right sweep; also reports whether anything changed. -/
private def driveStopsPass (steps : Array StepPoint) (input : Array Seg) : Array Seg × Bool := Id.run do
  let mut out : Array Seg := #[]
  let mut changed := false
  let mut i := 0
  while h : i < input.size do
    let seg := input[i]
    if effectiveMode seg != "driving" || i + 2 ≥ input.size then
      out := out.push seg
      i := i + 1
    else
      let middle := input[i + 1]!
      let next := input[i + 2]!
      let isPhantomStop :=
        effectiveMode middle == "stationary"
          && effectiveMode next == "driving"
          && middle.endTs - middle.startTs ≤ DRIVE_STOP_ABSORB_MAX_S
          && stepsBetween steps middle.startTs middle.endTs ≤ DRIVE_STOP_ABSORB_MAX_STEPS
      if isPhantomStop then
        out := out.push
          { seg with
            endTs := next.endTs
            pointCount := seg.pointCount + middle.pointCount + next.pointCount }
        i := i + 3
        changed := true
      else
        out := out.push seg
        i := i + 1
  return (out, changed)

/-- Absorb a phantom in-car stop into the drive around it.

If the user actually got out, the watch records steps almost immediately — even
three, from the seat to the kerb. Zero steps over a 5-15 minute "stop" is the
unambiguous tell that the doors never opened.

Run to a FIXPOINT (bounded at 10 passes, as the TS is), because one sweep
consumes three segments at a time: `drive → stop → drive → stop → drive` needs a
second pass to collapse fully. Only fires on the full sandwich, so a stop at the
start or end of a day, or before a longer stay, is left alone. -/
def absorbDriveStops (segments : Array Seg) (steps : Array StepPoint) : Array Seg :=
  go DRIVE_STOP_MAX_PASSES segments
where
  go : Nat → Array Seg → Array Seg
    | 0, current => current
    | n + 1, current =>
      let (out, changed) := driveStopsPass steps current
      if !changed then out else go n out

/-! ## `absorbInterchanges` -/

/-- Longest a single stationary segment can be and still count as part of an
interchange rather than a genuine stay. A platform change or a wait for the next
train runs minutes; a real stay would also have coalesced with its neighbours in
`mergeAdjacentStays` by now. -/
def INTERCHANGE_SEGMENT_MAX_S : Int := 8 * 60

/-- Absorb a transit interchange into the train it follows.

A run of short stationary segments straight after a train, with further movement
after it, is not a stay — it is the platform-to-platform walk, the wait, or an
underground hop the classifier read as stationary because the scattered fixes
barely displaced. Left alone each picks up a spurious place label from whatever
OSM venue is nearest the noisy centroid.

Only fires when the run is non-empty AND the journey continues past it with a
MOVING segment: a run that ends the day, or is stopped by a longer stay, is
where the journey actually finished. -/
def absorbInterchanges (segments : Array Seg) : Array Seg := Id.run do
  let mut out : Array Seg := #[]
  let mut i := 0
  while h : i < segments.size do
    let seg := segments[i]
    if effectiveMode seg != "train" then
      out := out.push seg
      i := i + 1
    else
      let mut runEnd := i + 1
      while hr : runEnd < segments.size do
        let s := segments[runEnd]
        if effectiveMode s != "stationary" || s.endTs - s.startTs > INTERCHANGE_SEGMENT_MAX_S then break
        runEnd := runEnd + 1
      let continues := runEnd < segments.size && effectiveMode segments[runEnd]! != "stationary"
      -- `runEnd > i + 1` (a NON-EMPTY run) rather than `≥`. The two are in fact
      -- equivalent — at `runEnd == i + 1` the absorb branch sets
      -- `endTs := segments[i].endTs`, which is `seg`'s own, and advances by one,
      -- exactly what the else branch does — so no guard can tell them apart.
      -- Kept as the TS has it; noted so nobody "simplifies" it later.
      if runEnd > i + 1 && continues then
        out := out.push { seg with endTs := segments[runEnd - 1]!.endTs }
        i := runEnd
      else
        out := out.push seg
        i := i + 1
  return out

/-! ## `relabelWalkingInterchanges` -/

/-- A walk longer than this between two trains is a genuine out-of-station
errand, not a platform change: a line change inside one station is short, going
out to do something and coming back to the same station is not. -/
def INTERCHANGE_WALK_MAX_S : Int := 300

/-- Relabel a short walk sandwiched between two train legs that share a station.

Changing lines is a walk between platforms INSIDE the station. GPS often
resurfaces mid-change, so the segment is correctly `walking` but gets named after
the nearest street the fix happened to see — "Allsop Place" for the 2026-06-16
Baker Street change — which reads as if the user left the station. The two
bounding legs already share a station (A alights where B boards), so a short walk
between them can only be the interchange.

Only the `wayName` and `refinedReason` change: the walk is real, only its
LOCATION was wrong. The line parenthetical is emitted only when BOTH sides carry
a non-empty line, matching the TS's truthiness test — an empty line suffix
parses to `some ""` and is falsy. -/
def relabelWalkingInterchanges (segments : Array Seg) : Array Seg :=
  segments.mapIdx fun i seg =>
    if effectiveMode seg != "walking" then seg
    else if seg.endTs - seg.startTs > INTERCHANGE_WALK_MAX_S then seg
    else if i == 0 then seg
    else match segments[i - 1]?, segments[i + 1]? with
      | some prev, some next =>
        if effectiveMode prev != "train" || effectiveMode next != "train" then seg
        else match parseRailWayName prev.wayName, parseRailWayName next.wayName with
          | some prevRail, some nextRail =>
            if prevRail.alight != nextRail.board then seg
            else
              let station := prevRail.alight
              let lineChange :=
                match prevRail.line, nextRail.line with
                | some p, some n => if p != "" && n != "" then s!" ({p} → {n})" else ""
                | _, _ => ""
              { seg with
                wayName := some s!"{station} (interchange)"
                refinedReason := some s!"walking interchange at {station}{lineChange}" }
          | _, _ => seg
      | _, _ => seg

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

private def d (a b : Int) (mode : Mode) (pointCount : Int := 10) (refinedMode : Option Mode := none) : Seg :=
  { startTs := a, endTs := b, mode, pointCount, refinedMode }
private def dview (out : Array Seg) : Array (Int × Int × Mode × Int) :=
  out.map fun s => (s.startTs, s.endTs, s.mode, s.pointCount)

-- The sandwich collapses to one drive carrying all three point counts.
#guard dview (absorbDriveStops #[d 0 600 "driving", d 600 900 "stationary" 3, d 900 1500 "driving"] #[])
  == #[(0, 1500, "driving", 23)]
-- Six steps inside the stop mean the user got out; five exactly still absorbs.
#guard (absorbDriveStops #[d 0 600 "driving", d 600 900 "stationary" 3, d 900 1500 "driving"] #[⟨650, 6⟩]).size == 3
#guard (absorbDriveStops #[d 0 600 "driving", d 600 900 "stationary" 3, d 900 1500 "driving"] #[⟨650, 5⟩]).size == 1
-- The step window is INCLUSIVE at both ends, so a bucket sitting exactly on
-- either boundary counts and six steps there veto the absorb.
#guard (absorbDriveStops #[d 0 600 "driving", d 600 900 "stationary" 3, d 900 1500 "driving"] #[⟨900, 6⟩]).size == 3
#guard (absorbDriveStops #[d 0 600 "driving", d 600 900 "stationary" 3, d 900 1500 "driving"] #[⟨600, 6⟩]).size == 3
-- Steps OUTSIDE the stop window do not count.
#guard (absorbDriveStops #[d 0 600 "driving", d 600 900 "stationary" 3, d 900 1500 "driving"]
    #[⟨0, 60⟩, ⟨300, 60⟩, ⟨599, 60⟩]).size == 1
-- 901 s is past the 15-minute bar; 900 exactly still absorbs.
#guard (absorbDriveStops #[d 0 600 "driving", d 600 1501 "stationary", d 1501 2000 "driving"] #[]).size == 3
#guard (absorbDriveStops #[d 0 600 "driving", d 600 1500 "stationary", d 1500 2000 "driving"] #[]).size == 1
-- Not bracketed by two drives, and a stop that ENDS the day.
#guard (absorbDriveStops #[d 0 600 "driving", d 600 900 "stationary", d 900 1500 "walking"] #[]).size == 3
#guard (absorbDriveStops #[d 0 600 "driving", d 600 900 "stationary"] #[]).size == 2
-- TWO stops in a row: the FIXPOINT loop collapses all five into one drive. A
-- single sweep would leave two, since it consumes three segments at a time.
#guard dview (absorbDriveStops
    #[d 0 600 "driving", d 600 900 "stationary" 3, d 900 1500 "driving",
      d 1500 1800 "stationary" 2, d 1800 2400 "driving"] #[])
  == #[(0, 2400, "driving", 35)]
-- effectiveMode: a leg refined to driving participates, and keeps its raw mode.
#guard dview (absorbDriveStops
    #[d 0 600 "train" 10 (some "driving"), d 600 900 "stationary" 3, d 900 1500 "driving"] #[])
  == #[(0, 1500, "train", 23)]
#guard absorbDriveStops #[] #[] == #[]

private def iview (out : Array Seg) : Array (Int × Int × Mode) :=
  out.map fun s => (s.startTs, s.endTs, s.mode)

-- Train, short stationary run, then movement: the train is extended over the
-- run and the run's segments are dropped.
#guard iview (absorbInterchanges
    #[d 0 600 "train", d 600 700 "stationary", d 700 800 "stationary", d 800 1400 "walking"])
  == #[(0, 800, "train"), (800, 1400, "walking")]
-- A run that ENDS the day is where the journey stopped, not an interchange…
#guard (absorbInterchanges #[d 0 600 "train", d 600 700 "stationary"]).size == 2
-- …and neither is one stopped by a longer stay.
#guard (absorbInterchanges
    #[d 0 600 "train", d 600 700 "stationary", d 700 2000 "stationary", d 2000 2400 "walking"]).size == 4
-- 481 s exceeds the per-segment bar so the run is empty; 480 exactly counts.
#guard (absorbInterchanges #[d 0 600 "train", d 600 1081 "stationary", d 1081 1600 "walking"]).size == 3
#guard iview (absorbInterchanges #[d 0 600 "train", d 600 1080 "stationary", d 1080 1600 "walking"])
  == #[(0, 1080, "train"), (1080, 1600, "walking")]
-- No run, and a non-train head: nothing happens.
#guard (absorbInterchanges #[d 0 600 "train", d 600 1200 "walking"]).size == 2
#guard (absorbInterchanges #[d 0 600 "walking", d 600 700 "stationary", d 700 1300 "walking"]).size == 3
-- A platform run BETWEEN two trains is absorbed into the first.
#guard iview (absorbInterchanges #[d 0 600 "train", d 600 700 "stationary", d 700 1300 "train"])
  == #[(0, 700, "train"), (700, 1300, "train")]
#guard absorbInterchanges #[] == #[]

private def MET : String := "Euston Square → Baker Street · Metropolitan Line"
private def JUB : String := "Baker Street → Wembley Park · Jubilee Line"

private def walkBetween (prevWay nextWay : Option String) (walkEnd : Int := 900) : Array Seg :=
  #[{ startTs := 0, endTs := 600, mode := "train", wayName := prevWay },
    { startTs := 600, endTs := walkEnd, mode := "walking", wayName := some "Allsop Place" },
    { startTs := walkEnd, endTs := walkEnd + 600, mode := "train", wayName := nextWay }]

private def rview (out : Array Seg) : Option String × Option String :=
  (out[1]!.wayName, out[1]!.refinedReason)

-- The 2026-06-16 Baker Street case: leg A alights where leg B boards, so the
-- walk between them is the platform change.
#guard rview (relabelWalkingInterchanges (walkBetween (some MET) (some JUB)))
  == (some "Baker Street (interchange)", some "walking interchange at Baker Street (Metropolitan Line → Jubilee Line)")
-- The parenthetical needs BOTH lines; with either missing it is dropped.
#guard rview (relabelWalkingInterchanges (walkBetween (some "Euston Square → Baker Street") (some JUB)))
  == (some "Baker Street (interchange)", some "walking interchange at Baker Street")
#guard rview (relabelWalkingInterchanges
    (walkBetween (some "Euston Square → Baker Street") (some "Baker Street → Wembley Park")))
  == (some "Baker Street (interchange)", some "walking interchange at Baker Street")
-- An EMPTY line suffix parses to `some ""` — present but falsy — so it is
-- dropped too. This is the guard that separates truthiness from presence.
#guard rview (relabelWalkingInterchanges (walkBetween (some "Euston Square → Baker Street · ") (some JUB)))
  == (some "Baker Street (interchange)", some "walking interchange at Baker Street")
-- The legs do not share a station: the user really did leave and come back.
#guard rview (relabelWalkingInterchanges
    (walkBetween (some MET) (some "Bond Street → Wembley Park · Jubilee Line")))
  == (some "Allsop Place", none)
-- 301 s is past the bar; 300 exactly still counts.
#guard rview (relabelWalkingInterchanges (walkBetween (some MET) (some JUB) 901)) == (some "Allsop Place", none)
#guard (relabelWalkingInterchanges (walkBetween (some MET) (some JUB) 900))[1]!.wayName
  == some "Baker Street (interchange)"
-- An unparseable or missing label on either side.
#guard rview (relabelWalkingInterchanges (walkBetween (some "Metropolitan Line") (some JUB)))
  == (some "Allsop Place", none)
#guard rview (relabelWalkingInterchanges (walkBetween none (some JUB))) == (some "Allsop Place", none)
-- THE PARSER DISCRIMINATORS. rail-reconcile's parser accepts an empty board, so
-- `" → Baker Street"` alights at Baker Street and pairs with a leg boarding
-- there; and it leaves a pre-arrow line separator inside `board`, so the alight
-- is still clean. rail-snap's parser returns `none` for BOTH, which would leave
-- the walk untouched. These two guards are why this module has its own parser.
#guard (relabelWalkingInterchanges (walkBetween (some " → Baker Street") (some JUB)))[1]!.wayName
  == some "Baker Street (interchange)"
#guard (relabelWalkingInterchanges (walkBetween (some "A · X → Baker Street") (some JUB)))[1]!.wayName
  == some "Baker Street (interchange)"
-- Not sandwiched by two trains, and a walk at index 0 with no previous segment.
#guard (relabelWalkingInterchanges
    #[{ startTs := 0, endTs := 600, mode := "walking" },
      { startTs := 600, endTs := 900, mode := "walking" },
      { startTs := 900, endTs := 1500, mode := "train", wayName := some "Baker Street → Wembley Park" }])[1]!.wayName
  == none
#guard (relabelWalkingInterchanges
    #[{ startTs := 0, endTs := 300, mode := "walking" },
      { startTs := 300, endTs := 900, mode := "train", wayName := some "Baker Street → Wembley Park" }])[0]!.wayName
  == none
#guard relabelWalkingInterchanges #[] == #[]

end Verified.Geo.RailAbsorbers
