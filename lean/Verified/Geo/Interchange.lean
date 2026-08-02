import Verified.Hsmm.FloatScore
/-!
# Interchange decomposition kernels (port of the pure exports of `src/geo/interchange-split.ts`)

A train leg whose board/alight share no line is two rides; these leaves find the
watch-timed change and the station it happened at, and the orchestrator carves
the leg in three. The whole module ports — `spliceInterchanges` is `async` only
because its two line lookups are injected, so they appear here as plain
functions and the splice becomes ordinary code:

* `findInterchangeBurst` — the single mid-leg walking-cadence burst (grouped
  across short pauses, edge-guarded, duration-bounded), or `none` when absent /
  ambiguous. Discrete over integer minutes ⇒ exact.
* `pickInterchange` — among stations on both a board-end and an alight-end line,
  the one whose distance-derived arrival best fits the burst (forward half-plane
  only, endpoints excluded, within the timing-slop cap). Reuses the shared
  `haversineMeters` and `cos` ⇒ ≤1 ULP; the argmin pick is well-separated on
  real data. UNPROVEN; pinned by the `#guard`s against Node/V8.
* `spliceInterchanges` — the leg filter, the `wayName` arrow split, the
  endpoint-fix selection, the DISJOINT-line test, and the three-way splice with
  its recomputed point counts. Exact apart from the leaves it calls.

The station name in the rewritten `wayName` comes from the OSM line's station
list, not from `pickBestStation`, so it inherits that list's naming (the
known "London King's Cross" reading). Reproduced deliberately: the twin's job
is to agree with the TS, and a quietly-better name here would read as a Lean
divergence.
-/

namespace Verified.Geo.Interchange

open Verified.Hsmm.FloatScore (haversineMeters)

private def pi : Float := 3.141592653589793

/-! ## Burst detection -/
def BURST_MIN_CADENCE : Int := 40
def BURST_JOIN_GAP_MIN : Int := 2
def BURST_MIN_MIN : Float := 2
def BURST_MAX_MIN : Float := 8
def BURST_EDGE_GUARD_S : Int := 3 * 60

structure StepPoint where
  ts : Int
  steps : Int
  deriving Inhabited

structure InterchangeBurst where
  startTs : Int
  endTs : Int
  deriving Inhabited, BEq, Repr

/-- The single watch-timed interchange burst inside a train leg, or `none` when
    there is none / it is ambiguous / it hugs a leg edge. -/
def findInterchangeBurst (steps : List StepPoint) (legStartTs legEndTs : Int) :
    Option InterchangeBurst := Id.run do
  let walk := (steps.filter (fun s =>
    decide (s.ts > legStartTs) && decide (s.ts < legEndTs) && decide (s.steps ≥ BURST_MIN_CADENCE))).map (·.ts)
  let sorted := (walk.toArray.qsort (fun a b => decide (a < b))).toList
  match sorted with
  | [] => return none
  | first :: restTs =>
    let mut bursts : Array InterchangeBurst := #[]
    let mut start := first
    let mut prev := first
    for ts in restTs do
      if decide (ts - prev > BURST_JOIN_GAP_MIN * 60 + 60) then
        bursts := bursts.push ⟨start, prev + 60⟩
        start := ts
      prev := ts
    bursts := bursts.push ⟨start, prev + 60⟩
    let mid := bursts.toList.filter (fun b =>
      decide (b.startTs ≥ legStartTs + BURST_EDGE_GUARD_S) && decide (b.endTs ≤ legEndTs - BURST_EDGE_GUARD_S))
    match mid with
    | [b] =>
      let durMin := Float.ofInt (b.endTs - b.startTs) / 60
      if decide (durMin < BURST_MIN_MIN) || decide (durMin > BURST_MAX_MIN) then return none
      return some b
    | _ => return none

/-! ## Candidate scoring -/
def BOARD_WAIT_S : Float := 3 * 60
def AVG_INTERSTATION_M : Float := 1100
def PER_STOP_S : Float := 120
def MAX_TIMING_SLOP_S : Float := 6 * 60
def ENDPOINT_EXCLUSION_M : Float := 400

structure Station where
  name : String
  lat : Float
  lon : Float
  deriving Inhabited

structure InterchangePick where
  station : String
  lat : Float
  lon : Float
  lineA : String
  lineB : String
  timingSlopS : Float
  deriving Inhabited, BEq, Repr

/-- Pick the interchange station for a board→alight pair with no common line:
    on both a board-end and an alight-end line, forward of the board, off the
    endpoints, arrival-time best matching the burst. `none` when none fits
    within `MAX_TIMING_SLOP_S`. -/
def pickInterchange (boardLat boardLon alightLat alightLon : Float) (legStartTs burstStartTs : Int)
    (burstEndTs : Option Int) (trailFix : Option (Int × Float × Float))
    (linesA linesB : List String) (stationsByLine : List (String × List Station)) :
    Option InterchangePick := Id.run do
  let stationsFor := fun (line : String) => ((stationsByLine.find? (fun p => p.1 == line)).map (·.2)).getD []
  let mut best : Option InterchangePick := none
  for lineA in linesA do
    let aStations := stationsFor lineA
    for lineB in linesB do
      if lineB == lineA then pure ()
      else
        for sb in stationsFor lineB do
          match (aStations.filter (fun s => s.name == sb.name)).getLast? with
          | none => pure ()
          | some sa =>
            if decide (haversineMeters sa.lat sa.lon boardLat boardLon < ENDPOINT_EXCLUSION_M)
              || decide (haversineMeters sa.lat sa.lon alightLat alightLon < ENDPOINT_EXCLUSION_M) then pure ()
            else
              let dot := (sa.lat - boardLat) * (alightLat - boardLat)
                + (sa.lon - boardLon) * (alightLon - boardLon) * (Float.cos (boardLat * pi / 180)) ^ 2
              if decide (dot ≤ 0) then pure ()
              else
                let rideM := haversineMeters boardLat boardLon sa.lat sa.lon
                let expectedTs := Float.ofInt legStartTs + BOARD_WAIT_S + (rideM / AVG_INTERSTATION_M) * PER_STOP_S
                let slop0 := Float.abs (expectedTs - Float.ofInt burstStartTs)
                if decide (slop0 > MAX_TIMING_SLOP_S) then pure ()
                else
                  let slop := match trailFix, burstEndTs with
                    | some (tfTs, tfLat, tfLon), some bEnd =>
                      let ride2M := haversineMeters sa.lat sa.lon tfLat tfLon
                      let expected2 := Float.ofInt bEnd + BOARD_WAIT_S + (ride2M / AVG_INTERSTATION_M) * PER_STOP_S
                      slop0 + Float.abs (expected2 - Float.ofInt tfTs)
                    | _, _ => slop0
                  if best.isNone || decide (slop < (best.getD default).timingSlopS) then
                    best := some ⟨sb.name, sa.lat, sa.lon, lineA, lineB, slop⟩
  return best

/-! ## The orchestrator -/

/-- Matches the underground reconstruction's `UNDERGROUND_LINES_RADIUS_M`. -/
def ENDPOINT_LINES_RADIUS_M : Float := 300

/-- Legs shorter than this can't hide a change worth carving. -/
def MIN_LEG_FOR_SPLIT_S : Int := 10 * 60

structure Fix where
  ts : Int
  lat : Float
  lon : Float
  deriving Inhabited, BEq, Repr

structure Seg where
  startTs : Int
  endTs : Int
  mode : String
  refinedMode : Option String := none
  wayName : Option String := none
  pointCount : Int := 0
  confidence : Float := 0
  confidenceMargin : Float := 0
  avgSpeed : Float := 0
  maxSpeed : Float := 0
  linearity : Float := 0
  refinedReason : Option String := none
  deriving Inhabited, BEq, Repr

/-- `refinedMode ?? mode`. -/
private def effectiveMode (s : Seg) : String := s.refinedMode.getD s.mode

/-- `samplesInWindow` — inclusive on both ends. -/
private def samplesInWindow (points : Array Fix) (startTs endTs : Int) : Array Fix :=
  points.filter (fun p => decide (p.ts ≥ startTs) && decide (p.ts ≤ endTs))

/-- `Math.round` — halves go UP, towards +∞. The slop is a sum of absolute
    values, so the negative half of the rule is unreachable here. -/
private def jsRoundInt (x : Float) : Int := (Float.floor (x + 0.5)).toInt64.toInt

/-- `[...new Set(xs)]` — first occurrence wins, insertion order preserved. -/
private def dedup (xs : List String) : List String :=
  xs.foldl (fun acc x => if acc.contains x then acc else acc ++ [x]) []

/-- The fixes in `[from, to)`. Note the HALF-OPEN window: the first leg's count
    excludes a fix landing exactly on the burst start, and the caller passes
    `segEnd + 1` for the second leg so a fix on the segment end is counted. -/
private def countIn (points : Array Fix) (fromTs toTs : Int) : Int :=
  Int.ofNat (points.filter (fun p => decide (p.ts ≥ fromTs) && decide (p.ts < toTs))).size

/-- The pieces one segment splices into: itself, or the three-way carve. -/
private def spliceOne (seg : Seg) (points : Array Fix) (steps : List StepPoint)
    (linesAtPoint : Float → Float → Float → List String)
    (stationsOnLine : String → List Station) : Array Seg :=
  -- The mode/duration/wayName rejections are one condition in the TS, so the
  -- order among them is not observable; the split is only for readability.
  if effectiveMode seg != "train" || decide (seg.endTs - seg.startTs < MIN_LEG_FOR_SPLIT_S) then #[seg]
  else match (seg.wayName.filter (· != "")).map (·.splitOn " → ") with
  | some [boardName, alightName] =>
    let inLeg := samplesInWindow points seg.startTs seg.endTs
    if inLeg.size < 2 then #[seg]
    else
      -- Burst first: it is free (pure step data) and most train legs have none.
      -- Those make NO lookup calls at all.
      match findInterchangeBurst steps seg.startTs seg.endTs with
      | none => #[seg]
      | some burst =>
        let boardFix := inLeg[0]!
        let alightFix := inLeg[inLeg.size - 1]!
        let linesA := linesAtPoint boardFix.lat boardFix.lon ENDPOINT_LINES_RADIUS_M
        let linesB := linesAtPoint alightFix.lat alightFix.lon ENDPOINT_LINES_RADIUS_M
        -- A shared line means the triple is valid — not ours to split. No line
        -- data at either end means we cannot tell, which is the same answer.
        if linesA.any (linesB.contains ·) || linesA.isEmpty || linesB.isEmpty then #[seg]
        else
          -- `[...new Set([...linesA, ...linesB])]`. The dedup is provably a
          -- no-op HERE: each list is already a set, and a name in both would
          -- have returned above as a shared line. Kept to mirror the TS.
          let stationsByLine := (dedup (linesA ++ linesB)).map (fun l => (l, stationsOnLine l))
          let trailFix := (inLeg.toList.find? (fun p => decide (p.ts > burst.endTs + 60))).map
            (fun p => (p.ts, p.lat, p.lon))
          match pickInterchange boardFix.lat boardFix.lon alightFix.lat alightFix.lon
              seg.startTs burst.startTs (some burst.endTs) trailFix linesA linesB stationsByLine with
          | none => #[seg]
          | some pick =>
            let reason := s!"invalid one-line triple split at the watch-timed interchange \
              (step burst; timing slop {jsRoundInt pick.timingSlopS}s)"
            let carried := match seg.refinedReason with
              | some r => s!"{r}; {reason}"
              | none => reason
            #[{ seg with
                  endTs := burst.startTs
                  wayName := some s!"{boardName} → {pick.station} · {pick.lineA}"
                  pointCount := countIn points seg.startTs burst.startTs
                  refinedReason := some carried },
              { seg with
                  startTs := burst.startTs
                  endTs := burst.endTs
                  mode := "walking"
                  refinedMode := none
                  wayName := none
                  avgSpeed := 0
                  maxSpeed := 0
                  linearity := 0
                  pointCount := 0
                  refinedReason := some s!"interchange at {pick.station} (watch-timed step burst)" },
              { seg with
                  startTs := burst.endTs
                  wayName := some s!"{pick.station} → {alightName} · {pick.lineB}"
                  pointCount := countIn points burst.endTs (seg.endTs + 1)
                  refinedReason := some carried }]
  | _ => #[seg]

/-- Split physically impossible single-train legs at the watch-timed
    interchange. A leg qualifies when its two endpoint line sets are DISJOINT,
    a single mid-leg step burst exists, and a both-lines station fits the
    burst's timing. Everything else passes through untouched. -/
def spliceInterchanges (segments : Array Seg) (points : Array Fix) (steps : List StepPoint)
    (linesAtPoint : Float → Float → Float → List String)
    (stationsOnLine : String → List Station) : Array Seg :=
  segments.foldl (init := #[]) fun out seg =>
    out ++ spliceOne seg points steps linesAtPoint stationsOnLine

/-! ## Parity with Node/V8 (`lean/experiments/interchange-refs.mts`) -/

private def cleanSteps : List StepPoint :=
  [⟨60, 5⟩, ⟨300, 112⟩, ⟨360, 113⟩, ⟨420, 110⟩, ⟨600, 4⟩, ⟨1140, 8⟩]
#guard findInterchangeBurst cleanSteps 0 1200 == some ⟨300, 480⟩
private def twoSteps : List StepPoint := [⟨300, 112⟩, ⟨360, 113⟩, ⟨700, 110⟩, ⟨760, 111⟩]
#guard findInterchangeBurst twoSteps 0 1200 == none
private def edgeSteps : List StepPoint := [⟨60, 112⟩, ⟨120, 113⟩, ⟨180, 110⟩]
#guard findInterchangeBurst edgeSteps 0 1200 == none
#guard findInterchangeBurst [⟨300, 5⟩] 0 1200 == none

private def change : Station := ⟨"Change", 51.52, -0.06⟩
private def wrong : Station := ⟨"Wrong", 51.49, -0.12⟩
private def sbl : List (String × List Station) := [("A", [change, wrong]), ("B", [change, wrong])]
private def approxI (a b : Float) : Bool := Float.abs (a - b) < 1e-9

#guard match pickInterchange 51.5 (-0.1) 51.54 (-0.02) 0 600 none none ["A"] ["B"] sbl with
  | some p => p.station == "Change" && p.lineA == "A" && p.lineB == "B"
      && approxI p.lat 51.52 && approxI p.lon (-0.06) && approxI p.timingSlopS 32.63175599173667
  | none => false
#guard match pickInterchange 51.5 (-0.1) 51.54 (-0.02) 0 600 (some 780) (some (1000, 51.535, -0.03)) ["A"] ["B"] sbl with
  | some p => p.station == "Change" && approxI p.timingSlopS 283.0901158349367
  | none => false
#guard pickInterchange 51.5 (-0.1) 51.54 (-0.02) 0 600 none none ["A"] ["B"]
  [("A", [change]), ("B", [wrong])] == none

/-! ## Parity with Node/V8 (`lean/experiments/splice-interchanges-refs.mts`)

The geometry is the one the `pickInterchange` guards above already pin, so the
timing arithmetic in the reason strings is arithmetic that was checked before.
What is new here is everything around it: which legs are eligible, which fixes
become the endpoints, and what the three pieces carry. -/

private def refPoints : Array Fix :=
  #[⟨0, 51.5, -0.1⟩, ⟨300, 51.51, -0.08⟩, ⟨900, 51.53, -0.04⟩,
    ⟨1200, 51.535, -0.03⟩, ⟨1800, 51.54, -0.02⟩]
/-- Walking-cadence minutes at 600/660/720 ⇒ one burst 600–780. -/
private def refSteps : List StepPoint := [⟨60, 5⟩, ⟨600, 112⟩, ⟨660, 113⟩, ⟨720, 110⟩, ⟨1500, 4⟩]
/-- No minute clears the cadence bar. -/
private def quietSteps : List StepPoint := [⟨600, 5⟩, ⟨660, 8⟩]
/-- A leg exactly at `MIN_LEG_FOR_SPLIT_S`, with its burst inside the guards. -/
private def shortPoints : Array Fix := #[⟨0, 51.5, -0.1⟩, ⟨200, 51.51, -0.08⟩, ⟨600, 51.54, -0.02⟩]
private def shortSteps : List StepPoint := [⟨240, 112⟩, ⟨300, 113⟩]

private def bothLines : List (String × List Station) := [("A", [change, wrong]), ("B", [change, wrong])]
/-- A and B share no station ⇒ `pickInterchange` returns `none`. -/
private def noOverlap : List (String × List Station) := [("A", [change]), ("B", [wrong])]

/-- The board end is the SOUTHERN fix; anything else is the alight end. The
    stub REFUSES any radius but 300 — the one V8 was observed to ask for — so
    the constant is pinned instead of ignored. -/
private def osmLines (atBoard atAlight : List String) : Float → Float → Float → List String :=
  fun lat _ r =>
    if r != 300 then [] else if decide (lat ≤ 51.505) then atBoard else atAlight
private def onLine (byLine : List (String × List Station)) : String → List Station :=
  fun l => ((byLine.find? (·.1 == l)).map (·.2)).getD []

private def sp (segs : Array Seg)
    (pts : Array Fix := refPoints) (stp : List StepPoint := refSteps)
    (atBoard : List String := ["A"]) (atAlight : List String := ["B"])
    (byLine : List (String × List Station) := bothLines) : Array Seg :=
  spliceInterchanges segs pts stp (osmLines atBoard atAlight) (onLine byLine)

private def baseSeg : Seg :=
  { startTs := 0, endTs := 1800, mode := "train", wayName := some "Board → Alight",
    pointCount := 5, confidence := 0.7, confidenceMargin := 0.2,
    avgSpeed := 12, maxSpeed := 20, linearity := 0.9 }

private def splitReason (slop : Int) : String :=
  s!"invalid one-line triple split at the watch-timed interchange \
    (step burst; timing slop {slop}s)"
private def midOf (seg : Seg) (s e : Int) : Seg :=
  { seg with
      startTs := s
      endTs := e
      mode := "walking"
      refinedMode := none
      wayName := none
      avgSpeed := 0
      maxSpeed := 0
      linearity := 0
      pointCount := 0
      refinedReason := some "interchange at Change (watch-timed step burst)" }
/-- The first of the three pieces: the ride up to the burst. -/
private def headOf (seg : Seg) (e pc : Int) (reason : String) : Seg :=
  { seg with
      endTs := e
      wayName := some "Board → Change · A"
      pointCount := pc
      refinedReason := some reason }
/-- The third: the ride from the burst onward. -/
private def tailOf (seg : Seg) (s pc : Int) (reason : String) : Seg :=
  { seg with
      startTs := s
      wayName := some "Change → Alight · B"
      pointCount := pc
      refinedReason := some reason }

-- The split itself: three pieces, the middle a bare walk, the outer two
-- relabelled through the picked station and re-counted.
#guard sp #[baseSeg]
  == #[headOf baseSeg 600 2 (splitReason 286), midOf baseSeg 600 780,
       tailOf baseSeg 780 3 (splitReason 286)]

-- `effectiveMode`: a leg refined TO train splits, and one refined AWAY from
-- train does not, whatever the raw mode says.
private def refinedTrain : Seg := { baseSeg with mode := "driving", refinedMode := some "train" }
#guard sp #[refinedTrain]
  == #[headOf refinedTrain 600 2 (splitReason 286), midOf refinedTrain 600 780,
       tailOf refinedTrain 780 3 (splitReason 286)]
#guard sp #[{ baseSeg with mode := "driving" }] == #[{ baseSeg with mode := "driving" }]
#guard sp #[{ baseSeg with refinedMode := some "driving" }]
  == #[{ baseSeg with refinedMode := some "driving" }]

-- The duration bar is EXCLUSIVE: a leg exactly at the minimum still splits.
#guard sp #[{ baseSeg with endTs := 599 }] shortPoints shortSteps
  == #[{ baseSeg with endTs := 599 }]
private def shortSeg : Seg := { baseSeg with endTs := 600 }
#guard sp #[shortSeg] shortPoints shortSteps
  == #[headOf shortSeg 240 2 (splitReason 655), midOf shortSeg 240 360,
       tailOf shortSeg 360 1 (splitReason 655)]

-- The `wayName` has to be a two-name arrow string. Absent, empty (falsy in the
-- TS, which is why the guard is `filter (· != "")` and not `isSome`), one name,
-- or three all pass through. The empty case is UNPINNABLE on its own: `""`
-- splits to a one-element list, so the arity test rejects it even without the
-- falsy guard. The guard is kept because the TS has it, not because it decides
-- anything the next line would not.
#guard sp #[{ baseSeg with wayName := none }] == #[{ baseSeg with wayName := none }]
#guard sp #[{ baseSeg with wayName := some "" }] == #[{ baseSeg with wayName := some "" }]
#guard sp #[{ baseSeg with wayName := some "Board" }] == #[{ baseSeg with wayName := some "Board" }]
#guard sp #[{ baseSeg with wayName := some "Board → Mid → Alight" }]
  == #[{ baseSeg with wayName := some "Board → Mid → Alight" }]

-- One fix in the leg gives no board/alight pair. The `< 2` bar itself is
-- UNPINNABLE through the entry point, and provably so: with a single fix the
-- board and alight ends are the same coordinate, so the two lookups answer the
-- same set — which is either shared (passthrough) or empty (passthrough). The
-- bar only guards the index.
#guard sp #[baseSeg] #[⟨0, 51.5, -0.1⟩] == #[baseSeg]
-- No burst, so no lookup ever happens.
#guard sp #[baseSeg] refPoints quietSteps == #[baseSeg]
-- A line serving BOTH ends means the triple is valid — not ours to split.
#guard sp #[baseSeg] (atAlight := ["A", "B"]) == #[baseSeg]
-- No line data at either end is the same answer: we cannot tell. Also
-- UNPINNABLE, and for the same kind of reason: an empty line list makes
-- `pickInterchange`'s loop body unreachable, so it returns `none` and the leg
-- passes through anyway. The two `isEmpty` tests buy a skipped fetch, not a
-- decision.
#guard sp #[baseSeg] (atBoard := []) == #[baseSeg]
#guard sp #[baseSeg] (atAlight := []) == #[baseSeg]
-- Lines are disjoint but share no station, so no candidate fits.
#guard sp #[baseSeg] (byLine := noOverlap) == #[baseSeg]

-- The trail anchor is the first in-leg fix more than a MINUTE past the burst,
-- not the first one past it: the fix 20 s after the burst end is skipped and
-- the anchor stays the one at 900, so the slop is unchanged from `refPoints`.
private def trailGapPoints : Array Fix :=
  #[⟨0, 51.5, -0.1⟩, ⟨800, 51.525, -0.055⟩, ⟨900, 51.53, -0.04⟩, ⟨1800, 51.54, -0.02⟩]
#guard sp #[baseSeg] trailGapPoints
  == #[headOf baseSeg 600 1 (splitReason 286), midOf baseSeg 600 780,
       tailOf baseSeg 780 3 (splitReason 286)]

-- An existing `refinedReason` is PREPENDED to, not replaced — but the middle
-- walk's reason replaces it outright.
private def priorReason : Seg := { baseSeg with refinedReason := some "earlier" }
private def carried : String := s!"earlier; {splitReason 286}"
#guard sp #[priorReason]
  == #[headOf priorReason 600 2 carried, midOf priorReason 600 780,
       tailOf priorReason 780 3 carried]

-- A non-splitting neighbour keeps its place after the three pieces.
private def tailWalk : Seg := { baseSeg with startTs := 1800, endTs := 3600, mode := "walking" }
#guard (sp #[baseSeg, tailWalk]).size == 4
#guard (sp #[baseSeg, tailWalk])[3]! == tailWalk

-- The recomputed counts are HALF-OPEN at the burst start and INCLUSIVE at the
-- leg end: with fixes landing exactly on 600 and on 1800, the first leg counts
-- only the fix at 0 and the second counts both 780 and 1800.
private def boundaryPoints : Array Fix :=
  #[⟨0, 51.5, -0.1⟩, ⟨600, 51.51, -0.08⟩, ⟨780, 51.53, -0.04⟩, ⟨1800, 51.54, -0.02⟩]
#guard sp #[baseSeg] boundaryPoints
  == #[headOf baseSeg 600 1 (splitReason 485), midOf baseSeg 600 780,
       tailOf baseSeg 780 2 (splitReason 485)]

end Verified.Geo.Interchange
