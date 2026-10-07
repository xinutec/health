import Verified
import DayEntry
import BackendEntry
import Lean.Data.Json
import ServeEntry.Wire

/-!
# `ServeEntry.Gates` — the referee modes

`walkgate`, `groundtruth`, `journeys`, `decoderscore`, `truthcheck`,
`floorgate`, `journeyshape`, `feasibility` and the ceiling gates: the modes
`verified_cli serve` dispatches on that nothing SERVES — each measures a
corpus against a blessed file and returns a verdict. They lived beside the
serving modes in `ServeEntry.lean` (3.7k lines) until 2026-10-06; the mode
table there still names each of them, so this is a move, not a change.
-/

open Lean (Json)
open Wire
open Verified.Hsmm

/-! ## Walk-gate mode (`verified_cli walkgate`) — a REFEREE, not a serving path

`Verified.Eval.WalkMetrics` and `Verified.Eval.WalkGate` over a corpus in one
call: measure every drawn walk, compare each against its blessed floor, and
return BOTH the current metrics (ready to re-bless) and the verdict. This is
#1048's Group B — the oracle is `tests/golden/walk-baseline.json`, a FILE, so
replacing the code under it loses nothing, unlike the parity gates whose oracle
was the TypeScript itself.

⚠ It sits in the mode table beside `coverage` and `gpsoutliers`, which nothing
serves either. A separate entry point was the alternative, and #982 exists
precisely because handlers that lived beside `main` could not be linked at all.

⚠ COORDINATES CROSS AS PLAIN JSON NUMBERS, NOT ON THE 1e-7 GRID `match` uses.
That mode quantises because its matcher is integer-exact by design. The referee
is not, and the floor was blessed from raw doubles, so quantising here would
move every metric away from the very file it is compared against. It is safe
for the reason `parsesTo` measures above: both ends write the shortest decimal
that round-trips.

⚠ METRICS COME BACK AS BIT PATTERNS. `Lean.toJson` on a `Float` emits six
decimal places, and this port has to demonstrate agreement with a baseline
recorded to seventeen significant digits — six would hide exactly the
divergence the harness exists to find.

    { "mode": "walkgate",
      "baseline": [ { "date": "2026-05-15", "walks": [ <entry>, … ] }, … ],
      "days":     [ { "date": "2026-05-15",
                      "ways":      [ { "name": "…"|null, "coords": [[lat,lon], …] }, … ],
                      "buildings": [ [[lat,lon], …], … ],
                      "steps":     [ [ts, steps], … ],
                      "walks":     [ { "startTs": n, "endTs": n,
                                       "drawn": [[lat,lon], …],
                                       "raw":   [[lat,lon], …],
                                       "acceptedNames": ["…", …] }, … ] }, … ] }

    <entry> = { "startTs": n, "p90M": bits|null, "stallM": bits,
                "speedKmh": bits, "routeCorr": bits|null, "offPathM": bits|null,
                "lenM": bits, "budgetM": bits|null }

Output: `{ "current": [ … ], "passes": bool, "regressed": […], "improved": […],
"unmatched": […], "added": […], "unmeasured": […] }` — `current` in the request
order, everything else in the gate's own sorted-by-date order. -/

namespace WalkGate

open Verified.Eval.WalkMetrics
open Verified.Eval.WalkGate

private def parseLL (j : Json) : Except String LatLon := do
  let a ← j.getArr?
  return ⟨← jFloat (← nth a 0), ← jFloat (← nth a 1)⟩

private def parsePts (j : Json) : Except String (Array LatLon) := do
  (← j.getArr?).mapM parseLL

private def parseWay (j : Json) : Except String Way := do
  let coords ← (← optArr j "coords").mapM fun c => do
    let a ← c.getArr?
    return ((← jFloat (← nth a 0)), (← jFloat (← nth a 1)))
  return { name := ← optStr j "name", coords }

private def parseStep (j : Json) : Except String PedStep := do
  let a ← j.getArr?
  return ⟨← jFloat (← nth a 0), ← jFloat (← nth a 1)⟩

/-- One drawn walk and the two tracks it is judged against. `raw` is the
pipeline's cleaned GPS for the leg — a fold INPUT, which is why the harness can
supply it and a frozen fixture cannot. -/
private structure WalkIn where
  startTs : Int
  endTs : Int
  drawn : Array LatLon
  raw : Array LatLon
  acceptedNames : Array String
  /-- The matcher's identity report for this leg (#1464): named ways and their
  metres, longest first. A DIAGNOSTIC — nothing here scores it. -/
  wayUm : Array (String × Nat) := #[]
  /-- Does the mirror hold building outlines for the ground THIS leg ran over
  (#1501)?

  ⚠ `offPathBuildingCrossingM` reads 0.0 for two different worlds — a line that
  crosses no wall, and a line over ground with no walls to cross. The day-level
  `buildings.isEmpty` test below cannot separate them, because coverage varies
  per LOCATION: 2026-09-06 answered three of its four `buildingsNear` keys and
  left one empty, so its Watford walks would have scored a clean 0.0 off
  outlines fetched 20 km away.

  The fold itself says so now: `Seg.walkBuildingsMeasured` (#1678) records
  whether the `buildingsNear` read for the leg's ground answered, and the
  harness copies it onto this row rather than reconstructing it from a trace.

  ⚠ **DEFAULTS TRUE, and the loudness lives in the GATE.** Defaulting false
  would be the conservative direction for one leg and a disaster for the metric:
  a wiring slip that dropped the field would turn the whole wall lens off while
  every day reported `none` and nothing failed. The gate prints the tally on
  every run instead, so a coverage number that collapses is visible. -/
  buildingsMeasured : Bool := true

private def parseWalkIn (j : Json) : Except String WalkIn := do
  return {
    startTs := ← (← j.getObjVal? "startTs").getInt?
    endTs := ← (← j.getObjVal? "endTs").getInt?
    drawn := ← (← optArr j "drawn").mapM parseLL
    raw := ← (← optArr j "raw").mapM parseLL
    acceptedNames := ← (← optArr j "acceptedNames").mapM (·.getStr?)
    buildingsMeasured := (j.getObjVal? "buildingsMeasured").toOption.bind (·.getBool?.toOption) |>.getD true
    wayUm := ← (← optArr j "wayUm").mapM fun e => do
      let a ← e.getArr?
      return (← (← nth a 0).getStr?, ← (← nth a 1).getNat?) }

private structure DayIn where
  date : String
  ways : RoadGeometry
  buildings : Array Ring
  steps : Array PedStep
  walks : Array WalkIn

/-- Resolve a day's geometry: either INLINE arrays, or indices into the
request-level tables.

⚠ The tables exist because 91% of this request was duplication — measured
2026-09-03 over the 42-day corpus: 713,183 way items but 59,606 distinct, so
each way crossed the wire ~12 times, and the request was 145 MiB (a 3.9 GB
`serde_json::Value` on the caller's side and ~2.9 GB of `Json` here). Indices
change nothing the referee computes; they change what has to be held in
memory at once, which is what made a gate run and a parallel build starve
each other.

⚠ INLINE STILL WORKS, and is not deprecated: a caller grading one day has
nothing to dedupe. An index that points past the end is an ERROR, never a
silently-dropped way — a short ways list would quietly move every metric on
that day. -/
private def resolveIdx {α : Type} (what : String) (table : Array α) (j : Json)
    (inlineKey idxKey : String) (parseOne : Json → Except String α)
    : Except String (Array α) := do
  match j.getObjVal? idxKey with
  | .error _ => (← optArr j inlineKey).mapM parseOne
  | .ok idxJson =>
    (← idxJson.getArr?).mapM fun e => do
      let i ← e.getNat?
      match table[i]? with
      | some v => pure v
      | none => throw s!"walkgate: {what} index {i} is outside the table of {table.size}"

private def parseDayIn (wayTable : Array Way) (buildingTable : Array Ring)
    (j : Json) : Except String DayIn := do
  return {
    date := ← (← j.getObjVal? "date").getStr?
    ways := { ways := ← resolveIdx "way" wayTable j "ways" "wayIdx" parseWay }
    buildings := ← resolveIdx "building" buildingTable j "buildings" "buildingIdx" parsePts
    steps := ← (← optArr j "steps").mapM parseStep
    walks := ← (← optArr j "walks").mapM parseWalkIn }

private def oBits : Option Float → Json
  | some v => fBits v
  | none => Json.null

/-- A floor entry.

⚠ THE WIRE IS ASYMMETRIC ON PURPOSE, and this is the readable half.
`jFloatField`/`jOptFloat` accept EITHER a bit pattern or a plain JSON number,
because two different producers feed this side: `walk-baseline.json` holds
plain decimals a human blessed, and the fold's own episodes arrive as bits.
Both have to work without the host converting either one.

The WRITTEN half is bits only — see `entryJson`. `Lean.toJson` on a `Float`
emits six decimal places, which is coarser than the agreement this port exists
to demonstrate.

An ABSENT column reads as `none`, which is right: a floor that never recorded
an axis has not measured it. -/
private def parseEntry (j : Json) : Except String WalkEntry := do
  return {
    startTs := ← (← j.getObjVal? "startTs").getInt?
    p90M := ← jOptFloat j "p90M"
    stallM := ← jFloatField j "stallM"
    speedKmh := ← jFloatField j "speedKmh"
    routeCorr := ← jOptFloat j "routeCorr"
    offPathM := ← jOptFloat j "offPathM"
    lenM := ← jFloatField j "lenM"
    budgetM := ← jOptFloat j "budgetM" }

private def parseBaselineDay (j : Json) : Except String (String × Array WalkEntry) := do
  return ((← (← j.getObjVal? "date").getStr?), ← (← optArr j "walks").mapM parseEntry)

/-- How far from the drawn line a raw fix counts as UNCOVERED (m).

⚠ Not tuned: it is the display gate's own `WALK_MATCH_MAX_STRAY_M` order of
magnitude, chosen so the share asks the same "is this fix on the line" question
the gate already asks — and the whole point of the share is that its answer
moves smoothly with the radius rather than hinging on it. Re-read the
distribution before any bar is placed here. -/
private def UNCOVERED_RADIUS_M : Float := 30

/-- Measure one drawn walk into exactly the shape the floor records.

⚠ EVERY `none` HERE IS A DIFFERENT QUESTION GOING UNANSWERED, and not one of
them is a zero: no building footprints in the day → `offPathM` unmeasured; no
ground-truth-confirmed street over the leg → `routeCorr` unmeasured; no step
rows → no budget. The gate treats an unmeasured axis and a perfect score
completely differently, so collapsing any of these would be a silent pass.

⚠ `scoreWalk` is given NO steps on purpose. Its own pedometer term uses a
different stride and a different window from the budget the gate acts on; the
budget comes from `stepBudgetM` below, separately. Handing steps to both would
put two incompatible pedometer readings in one row. -/

private def measure (d : DayIn) (wantP90 : Bool) (w : WalkIn) : WalkEntry :=
  let sc := scoreWalk w.drawn (Float.ofInt w.startTs) (Float.ofInt w.endTs) #[] (some d.ways)
              0.72 35 wantP90
  let span := (Float.ofInt w.endTs) - (Float.ofInt w.startTs)
  { startTs := w.startTs
    p90M := sc.offWalkableP90M
    stallM := maxCorridorStall w.raw w.drawn
    speedKmh := if span > 0 then (sc.drawnLengthM / span) * 3.6 else 0
    routeCorr := onNamedWayFraction w.drawn w.acceptedNames d.ways
    -- ⚠ UNMEASURED IS NOT CLEAN (#1501). `none` when the day holds no outlines
    -- at all, and now also when none were fetched for THIS leg's ground — the
    -- distinction coverage actually varies along.
    offPathM := if d.buildings.isEmpty || !w.buildingsMeasured then none
                else some (offPathBuildingCrossingM w.drawn d.buildings d.ways)
    lenM := sc.drawnLengthM
    budgetM := stepBudgetM d.steps (Float.ofInt w.startTs) (Float.ofInt w.endTs)
    wayUm := w.wayUm
    -- ⚠ COVERAGE, recorded and not scored (#1501). `maxFixDistToLine` is the
    -- MAXIMUM on purpose: the display gate already asks a quantile of the same
    -- two tracks, and a quantile cannot see a line that abandons part of a
    -- walk. Cheap enough to take unconditionally — unlike `p90M`, nothing here
    -- touches the way network.
    rawLenM := pathLength w.raw
    coverMaxM := maxFixDistToLine w.raw w.drawn
    headGapM := (endpointGapsM w.raw w.drawn).1
    tailGapM := (endpointGapsM w.raw w.drawn).2
    cover90M := (fixCoverage w.raw w.drawn 0.9 UNCOVERED_RADIUS_M).1
    uncoveredFrac := (fixCoverage w.raw w.drawn 0.9 UNCOVERED_RADIUS_M).2 }

private def entryJson (e : WalkEntry) : Json :=
  Json.mkObj [
    ("startTs", Lean.toJson e.startTs), ("p90M", oBits e.p90M),
    ("stallM", fBits e.stallM), ("speedKmh", fBits e.speedKmh),
    ("routeCorr", oBits e.routeCorr), ("offPathM", oBits e.offPathM),
    ("lenM", fBits e.lenM), ("budgetM", oBits e.budgetM),
    -- ⚠ PASSED THROUGH, NEVER SCORED (#1464). It rides the referee's wire so
    -- `WALK_GATE_DUMP` can print it beside the metrics; no floor holds it and
    -- no delta is computed from it.
    ("wayUm", Json.arr (e.wayUm.map fun (n, um) =>
      Json.arr #[Json.str n, Lean.toJson um])),
    -- Same terms as `wayUm`: on the wire for the dump, held by no floor.
    ("rawLenM", fBits e.rawLenM), ("coverMaxM", fBits e.coverMaxM),
    ("headGapM", fBits e.headGapM), ("tailGapM", fBits e.tailGapM),
    ("cover90M", fBits e.cover90M), ("uncoveredFrac", fBits e.uncoveredFrac)]

private def metricName : Metric → String
  | .stall => "stall" | .speed => "speed" | .route => "route"
  | .offPath => "offPath" | .budget => "budget"

private def deltaJson (d : Delta) : Json :=
  Json.mkObj [("date", Json.str d.date), ("startTs", Lean.toJson d.startTs),
    ("metric", Json.str (metricName d.metric)),
    ("base", fBits d.base), ("now", fBits d.now)]

private def atJson (a : At) : Json :=
  Json.mkObj [("date", Json.str a.date), ("startTs", Lean.toJson a.startTs)]

private def metricAtJson (m : MetricAt) : Json :=
  Json.mkObj [("date", Json.str m.date), ("startTs", Lean.toJson m.startTs),
    ("metric", Json.str (metricName m.metric))]

private def parseReq (j : Json)
    : Except String (WalkBaseline × Array DayIn) := do
  let wayTable ← (← optArr j "wayTable").mapM parseWay
  let buildingTable ← (← optArr j "buildingTable").mapM parsePts
  return (← (← optArr j "baseline").mapM parseBaselineDay,
          ← (← optArr j "days").mapM (parseDayIn wayTable buildingTable))

def walkGateResult (j : Json) : Json :=
  -- ⚠ OFF BY DEFAULT, and that is the point. `p90M` is 83% of this mode's cost
  -- and the ratchet does not act on it — `Metric` has no `p90` case. A caller
  -- that is GATING does not need it; one that is REFRESHING THE FLOOR does, and
  -- asks. An absent `p90M` is therefore "not asked this run", not a lost
  -- measurement, and nothing downstream reads it as one.
  let wantP90 := (j.getObjVal? "wantP90" >>= (·.getBool?)).toOption.getD false
  match parseReq j with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok (baseline, days) =>
    let current : WalkBaseline := days.map fun d => (d.date, d.walks.map (measure d wantP90))
    let r := gateWalks baseline current
    Json.mkObj [
      ("current", Json.arr (current.map fun (date, ws) =>
        Json.mkObj [("date", Json.str date), ("walks", Json.arr (ws.map entryJson))])),
      ("passes", Json.bool (passes r)),
      ("regressed", Json.arr (r.regressed.map deltaJson)),
      ("improved", Json.arr (r.improved.map deltaJson)),
      ("unmatched", Json.arr (r.unmatched.map atJson)),
      ("added", Json.arr (r.added.map atJson)),
      ("unmeasured", Json.arr (r.unmeasured.map metricAtJson))]

end WalkGate

/-! ## Ground-truth mode (`verified_cli groundtruth`) — a REFEREE input

`Verified.Eval.GroundTruth.parseGroundTruth` over one narrative. #1290: the
audit tables are the only non-self-referential truth signal in the corpus, and
two consumers were blocked without them — `routeCorr` in the walk referee, and
`score-decoder`, whose oracle IS the narrative.

⚠ THE REPLY CARRIES CIVIL TIME, NOT UNIX. Resolving a wall clock in a named zone
needs the tz database, which is data and IO; the Lean side stops at the anchored
`(day, hh, mm)` and the shell resolves it with
`rust/backend/src/timezone.rs::wall_clock_to_unix`. That split is the whole
reason this mode exists rather than a `parseGroundTruth` that returns seconds.

  { "mode": "groundtruth", "markdown": "…", "date": "YYYY-MM-DD", "tz": "…" }

Output: `{ "tz": …, "rows": [ { "window", "startDay", "startHh", "startMm",
"endDay", "endHh", "endMm", "status", "provenance", "enforceable", "truthText",
"truth": {…}|null } ] }`. -/

namespace GroundTruth

open Verified.Eval.GroundTruth

private def statusStr : Status → String
  | .correct => "correct" | .wrong => "wrong"
  | .«partial» => "partial" | .unclear => "unclear"

private def provStr : Provenance → String
  | .corroborated => "corroborated" | .user => "user" | .derived => "derived"
  | .inferred => "inferred" | .unspecified => "unspecified"

private def modeStr : Mode → String
  | .sleeping => "sleeping" | .stationary => "stationary" | .walking => "walking"
  | .cycling => "cycling" | .driving => "driving" | .bus => "bus"
  | .train => "train" | .plane => "plane"

private def truthJson : Option Truth → Json
  | none => Json.null
  | some t => Json.mkObj [
      ("mode", Json.str (modeStr t.mode)),
      ("place", optStrJson t.place), ("wayName", optStrJson t.wayName),
      ("placeQualifier", optStrJson t.placeQualifier),
      ("from", optStrJson t.trainFrom), ("to", optStrJson t.trainTo),
      ("lineName", optStrJson t.lineName)]

private def rowJson (r : Row) : Json :=
  Json.mkObj [
    ("window", Json.str r.windowText),
    ("startDay", Json.str r.startDay), ("startHh", Lean.toJson r.startHh),
    ("startMm", Lean.toJson r.startMm),
    ("endDay", Json.str r.endDay), ("endHh", Lean.toJson r.endHh),
    ("endMm", Lean.toJson r.endMm),
    ("status", Json.str (statusStr r.status)),
    ("provenance", Json.str (provStr r.provenance)),
    ("enforceable", Json.bool (isEnforceable r)),
    ("truthText", Json.str r.truthText),
    ("truth", truthJson r.truth)]

def groundTruthResult (j : Json) : Json :=
  let parsed : Except String Json := do
    let md ← (← j.getObjVal? "markdown").getStr?
    let date ← (← j.getObjVal? "date").getStr?
    let tz ← (← j.getObjVal? "tz").getStr?
    let day := parseGroundTruth md date tz
    return Json.mkObj [("tz", Json.str day.tz),
                       ("rows", Json.arr (day.rows.map rowJson))]
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

end GroundTruth

/-! ## Journeys mode (`verified_cli journeys`)

`Verified.Eval.Journeys.groundTruthJourneys` over RESOLVED audit rows — the
ground-truth side of the `score-decoder` scoreboard (#1048). Rows arrive with
unix `startTs`/`endTs` because the zone resolution is the shell's (see the
`groundtruth` mode above).

  { "mode": "journeys",
    "rows": [ { "startTs": n, "endTs": n, "status": "correct|wrong|partial|unclear",
                "truth": { "mode": "...", "lineName": s|null,
                           "from": s|null, "to": s|null } | null } ] }

Output: `{ "journeys": [ { "startTs", "endTs",
  "legs": [ { "startTs", "endTs", "mode", "line", "board", "alight" } ] } ] }`. -/

namespace Journeys

open Verified.Eval.GroundTruth
open Verified.Eval.Journeys

private def parseStatus : String → Status
  | "correct" => .correct | "wrong" => .wrong
  | "partial" => .«partial» | _ => .unclear

private def parseMode : String → Option Mode
  | "sleeping" => some .sleeping | "stationary" => some .stationary
  | "walking" => some .walking | "cycling" => some .cycling
  | "driving" => some .driving | "bus" => some .bus
  | "train" => some .train | "plane" => some .plane
  | _ => none

def parseJRow (j : Json) : Except String JRow := do
  let truth : Option Truth :=
    match j.getObjVal? "truth" with
    | .ok t =>
      if t.isNull then none
      else match (t.getObjVal? "mode" >>= (·.getStr?)) with
        | .ok ms => (parseMode ms).map fun m =>
            { mode := m,
              lineName := (t.getObjVal? "lineName" >>= (·.getStr?)).toOption,
              trainFrom := (t.getObjVal? "from" >>= (·.getStr?)).toOption,
              trainTo := (t.getObjVal? "to" >>= (·.getStr?)).toOption }
        | .error _ => none
    | .error _ => none
  return {
    startTs := ← (← j.getObjVal? "startTs").getInt?
    endTs := ← (← j.getObjVal? "endTs").getInt?
    status := parseStatus ((j.getObjVal? "status" >>= (·.getStr?)).toOption.getD "unclear")
    truth }

private def legJson (l : Leg) : Json :=
  Json.mkObj [("startTs", Lean.toJson l.startTs), ("endTs", Lean.toJson l.endTs),
    ("mode", Json.str l.mode), ("line", optStrJson l.line),
    ("board", optStrJson l.board), ("alight", optStrJson l.alight)]

def journeysResult (j : Json) : Json :=
  let parsed : Except String Json := do
    let rows ← (← optArr j "rows").mapM parseJRow
    return Json.mkObj [("journeys", Json.arr ((groundTruthJourneys rows).map fun jr =>
      Json.mkObj [("startTs", Lean.toJson jr.startTs), ("endTs", Lean.toJson jr.endTs),
                  ("legs", Json.arr (jr.legs.map legJson))]))]
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

end Journeys

/-! ## Decoder-scoreboard mode (`verified_cli decoderscore`) — #1048

Input: the `journeys`-mode rows EXTENDED with `provenance`, plus the decoded
day's segments:

  { "mode": "decoderscore",
    "rows": [ { "startTs", "endTs", "status", "provenance",
                "truth": { "mode", "lineName", "from", "to" } | null } ],
    "segs": [ { "startTs", "endTs", "mode", "lineName", "board", "alight" } ] }

Output: the ten scoreboard counts, spelled as the blessed
`decoder-scoreboard.json` spells them. -/

namespace DecoderScore

open Verified.Eval.GroundTruth
open Verified.Eval.Journeys
open Verified.Eval.DecoderScore

private def parseProvenance : String → Provenance
  | "corroborated" => .corroborated | "user" => .user
  | "derived" => .derived | "inferred" => .inferred
  | _ => .unspecified

private def parseSeg (j : Json) : Except String Verified.Eval.DecoderScore.Seg := do
  return {
    startTs := ← (← j.getObjVal? "startTs").getInt?
    endTs := ← (← j.getObjVal? "endTs").getInt?
    mode := ← (← j.getObjVal? "mode").getStr?
    lineName := (j.getObjVal? "lineName" >>= (·.getStr?)).toOption
    board := (j.getObjVal? "board" >>= (·.getStr?)).toOption
    alight := (j.getObjVal? "alight" >>= (·.getStr?)).toOption }

def decoderScoreResult (j : Json) : Json :=
  let parsed : Except String Json := do
    let rowsJ ← optArr j "rows"
    let rows ← rowsJ.mapM Journeys.parseJRow
    let segs ← (← optArr j "segs").mapM parseSeg
    -- The contradicting spans need provenance, which JRow does not carry:
    -- re-read it beside each row.
    let mut contradicting : Array ContradictingSpan := #[]
    for (rj, row) in rowsJ.zip rows do
      let prov := parseProvenance ((rj.getObjVal? "provenance" >>= (·.getStr?)).toOption.getD "unspecified")
      match row.truth with
      | some t =>
        if contradicts row.status prov t.mode then
          contradicting := contradicting.push ⟨row.startTs, row.endTs⟩
      | none => pure ()
    let minutes := segmentsToMinutes segs
    let gtJ := groundTruthJourneys rows
    let decJ := decoderJourneys minutes
    let jc := scoreJourneyCounts gtJ decJ minutes
    let st := scoreStations gtJ decJ
    let phantoms := countPhantomRides contradicting decJ
    return Json.mkObj [
      ("journeysExpected", Lean.toJson jc.journeysExpected),
      ("journeysMatched", Lean.toJson jc.journeysMatched),
      ("legModeScorable", Lean.toJson jc.legModeScorable),
      ("legModeMatching", Lean.toJson jc.legModeMatching),
      ("legLineScorable", Lean.toJson jc.legLineScorable),
      ("legLineMatching", Lean.toJson jc.legLineMatching),
      ("stationsAsserted", Lean.toJson st.stationsAsserted),
      ("stationsMatching", Lean.toJson st.stationsMatching),
      ("stationsMissing", Lean.toJson st.stationsMissing),
      ("phantomRides", Lean.toJson phantoms),
      -- Per truth journey, for reading WHICH journeys fail and how: the scorer's
      -- own `bestOverlap` and `modeShape`, so the detail cannot disagree with
      -- the count (2026-09-30).
      ("journeys", Json.arr (gtJ.map fun g =>
        let d := bestOverlap g decJ
        let shp := fun (x : Verified.Eval.Journeys.Journey) => Json.arr ((modeShape x).map Json.str)
        Json.mkObj [
          ("startTs", Lean.toJson g.startTs), ("endTs", Lean.toJson g.endTs),
          ("truth", shp g),
          ("decoder", match d with | some x => shp x | none => Json.null),
          ("matched", Json.bool (match d with | some x => modeShape x == modeShape g | none => false))]))]
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

end DecoderScore

/-! ## Truth-check mode (`verified_cli truthcheck`)

`Verified.Eval.TruthCheck.classifyDay` — the provenance-aware truth report
(#1052). Rows arrive RESOLVED (unix seconds), as in `journeys` above, because
the zone resolution is the shell's; `states` are the drawn timeline legs.

This is the corpus's only NON-SELF-REFERENTIAL gate: every other check compares
the pipeline against itself or against previously blessed pipeline output. Here
a human wrote down what actually happened and the pipeline is graded against it.

  { "mode": "truthcheck",
    "rows": [ { "startTs": n, "endTs": n, "status": "correct|wrong|partial|unclear",
                "provenance": "corroborated|user|derived|inferred|unspecified",
                "truth": { "mode", "place", "wayName", "placeQualifier",
                           "from", "to", "lineName" } | null } ],
    "states": [ { "startTs": n, "endTs": n, "mode": s,
                  "place": s|null, "wayName": s|null } ] }

Output: `{ "verdicts": [s], "verified": n, "regressed": n, "knownError": n,
"cleared": n, "unverified": n, "hasRegression": b, "covering": [n] }`.
`covering` is the index of the state that answered each row, or `-1` — the
diagnosis a regressed row cannot give on its own. The `verdicts` array is
positional — one entry per input row, in order — so the caller can attribute a
regression to the row that caused it without a second lookup. -/

namespace TruthCheck

open Verified.Eval.GroundTruth
open Verified.Eval.TruthCheck

private def parseStatus : String -> Status
  | "correct" => .correct | "wrong" => .wrong
  | "partial" => .«partial» | _ => .unclear

private def parseProv : String -> Provenance
  | "corroborated" => .corroborated | "user" => .user | "derived" => .derived
  | "inferred" => .inferred | _ => .unspecified

private def parseMode : String -> Option Mode
  | "sleeping" => some .sleeping | "stationary" => some .stationary
  | "walking" => some .walking | "cycling" => some .cycling
  | "driving" => some .driving | "bus" => some .bus
  | "train" => some .train | "plane" => some .plane
  | _ => none

private def optStr (j : Json) (k : String) : Option String :=
  (j.getObjVal? k >>= (·.getStr?)).toOption

private def parseTruth (j : Json) : Option Truth :=
  match j.getObjVal? "truth" with
  | .error _ => none
  | .ok t =>
    if t.isNull then none
    else match (t.getObjVal? "mode" >>= (·.getStr?)) with
      | .error _ => none
      | .ok ms => (parseMode ms).map fun m =>
          { mode := m, place := optStr t "place", wayName := optStr t "wayName",
            placeQualifier := optStr t "placeQualifier",
            trainFrom := optStr t "from", trainTo := optStr t "to",
            lineName := optStr t "lineName" }

private def parseTRow (j : Json) : Except String TRow := do
  return {
    startTs := ← (← j.getObjVal? "startTs").getInt?
    endTs := ← (← j.getObjVal? "endTs").getInt?
    status := parseStatus ((optStr j "status").getD "unclear")
    provenance := parseProv ((optStr j "provenance").getD "unspecified")
    truth := parseTruth j }

private def parseState (j : Json) : Except String StateWindow := do
  return {
    startTs := ← (← j.getObjVal? "startTs").getInt?
    endTs := ← (← j.getObjVal? "endTs").getInt?
    mode := ← (← j.getObjVal? "mode").getStr?
    place := optStr j "place"
    wayName := optStr j "wayName" }

def truthCheckResult (j : Json) : Json :=
  let parsed : Except String Json := do
    let rows ← (← optArr j "rows").mapM parseTRow
    let states ← (← optArr j "states").mapM parseState
    let r := classifyDay rows states
    return Json.mkObj [
      ("verdicts", Json.arr (r.verdicts.map (Json.str ·.toString))),
      ("verified", Lean.toJson r.verified), ("regressed", Lean.toJson r.regressed),
      ("knownError", Lean.toJson r.knownError), ("cleared", Lean.toJson r.cleared),
      ("unverified", Lean.toJson r.unverified),
      ("hasRegression", Json.bool r.hasRegression),
      ("covering", Json.arr (r.covering.map Lean.toJson))]
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

end TruthCheck

/-! ## Floor-gate mode (`verified_cli floorgate`)

`Verified.Eval.FloorGate` — the one-way ratchet shared by the truth floor and
the journey floor (#1052).

⚠ THE FLOORS ARRIVE AS ARRAYS, NOT OBJECTS. A JSON object keyed by date is what
the baseline FILES hold, but the wire here takes `[{ "date", "keys" }]` like
every other mode, so the shell owns the map/array conversion and this side never
depends on key order.

`described` is OPTIONAL. Given, the reply also carries the ratcheted `floor` and
the `dropped` keys the narrative no longer describes; omitted, only the gate
runs. Dropping a key is the one way a red gate goes green without a fix, so it
is never computed silently as a side effect of gating.

  { "mode": "floorgate",
    "baseline": [ { "date": s, "keys": [n] } ],
    "current":  [ { "date": s, "keys": [n] } ],
    "described":[ { "date": s, "keys": [n] } ]   // optional
  }

Output: `{ "regressed": [{ "date", "startTs" }], "improved": [...],
"floor": [{ "date", "keys" }] | null, "dropped": [...] | null }`. -/

namespace FloorGate

open Verified.Eval.FloorGate

private def parseFloor (j : Json) (key : String) : Except String Floor := do
  let arr ← match j.getObjVal? key with
    | .error _ => pure #[]
    | .ok v => v.getArr?
  arr.mapM fun e => do
    let date ← (← e.getObjVal? "date").getStr?
    let keys ← (← (← e.getObjVal? "keys").getArr?).mapM (·.getInt?)
    return (date, keys)

private def keyJson (k : Key) : Json :=
  Json.mkObj [("date", Json.str k.date), ("startTs", Lean.toJson k.startTs)]

private def floorJson (f : Floor) : Json :=
  Json.arr (f.map fun (d, ks) =>
    Json.mkObj [("date", Json.str d), ("keys", Json.arr (ks.map Lean.toJson))])

def floorGateResult (j : Json) : Json :=
  let parsed : Except String Json := do
    let baseline ← parseFloor j "baseline"
    let current ← parseFloor j "current"
    let g := gateFloor baseline current
    let base := [("regressed", Json.arr (g.regressed.map keyJson)),
                 ("improved", Json.arr (g.improved.map keyJson))]
    match j.getObjVal? "described" with
    | .error _ => return Json.mkObj (base ++ [("floor", Json.null), ("dropped", Json.null)])
    | .ok _ =>
      let described ← parseFloor j "described"
      let r := ratchetUpFloor baseline current described
      return Json.mkObj (base ++ [("floor", floorJson r.floor),
                                  ("dropped", Json.arr (r.dropped.map keyJson))])
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

end FloorGate

/-! ## Journey-shape mode (`verified_cli journeyshape`)

`Verified.Eval.JourneyShape` — the journey referee (#1048). Builds the PIPELINE
side of the comparison from the drawn state legs and grades each ground-truth
journey against it.

⚠ THE STATES ARRIVE RAW, and the journey building happens HERE. Handing over
pre-built pipeline journeys would put `statesToJourneys` — the merge tolerance,
the pause split, which modes count as legs — on the shell's side of the line,
where it is not checked by anything. The shell passes what the fold produced.

`gt` is what the `journeys` mode returned, fed straight back.

  { "mode": "journeyshape",
    "gt": [ { "startTs": n, "endTs": n,
              "legs": [ { "startTs": n, "endTs": n, "mode": s } ] } ],
    "states": [ { "startTs": n, "endTs": n, "mode": s } ] }

Output: `{ "pipelineJourneys": [ { "startTs", "endTs", "legs": [s] } ],
"results": [ { "startTs", "endTs", "expectedShape", "actualShape", "matched",
"uncoveredS", "slackS", "matchStartTs", "matchEndTs",
"clippedLegs": [ { "mode", "overlapS", "durationS" } ] } ] }`.

`pipelineJourneys` comes back because a coverage failure cannot be read without
it: `bestOverlap` grades ONE journey, so a trip the pipeline split in two is
scored on the larger half with the other half counted as uncovered — a failure
that exists only in the comparison. More than one touching the window is the
tell, and the caller can only see that if it is told. -/

namespace JourneyShape

open Verified.Eval.Journeys
open Verified.Eval.JourneyShape

private def parseLeg (j : Json) : Except String Leg := do
  return { startTs := ← (← j.getObjVal? "startTs").getInt?
           endTs := ← (← j.getObjVal? "endTs").getInt?
           mode := ← (← j.getObjVal? "mode").getStr?
           line := none, board := none, alight := none }

private def parseJourney (j : Json) : Except String Journey := do
  return { startTs := ← (← j.getObjVal? "startTs").getInt?
           endTs := ← (← j.getObjVal? "endTs").getInt?
           legs := ← (← optArr j "legs").mapM parseLeg }

private def parseState (j : Json) : Except String (Int × Int × String) := do
  return (← (← j.getObjVal? "startTs").getInt?,
          ← (← j.getObjVal? "endTs").getInt?,
          ← (← j.getObjVal? "mode").getStr?)

private def shapeJson (a : Array String) : Json := Json.arr (a.map Json.str)

private def optIntJson : Option Int → Json
  | none => Json.null
  | some i => Lean.toJson i

private def resultJson (r : Result) : Json :=
  Json.mkObj [
    ("startTs", Lean.toJson r.startTs), ("endTs", Lean.toJson r.endTs),
    ("expectedShape", shapeJson r.expectedShape),
    ("actualShape", match r.actualShape with | none => Json.null | some a => shapeJson a),
    ("matched", Json.bool r.matched),
    ("uncoveredS", Lean.toJson r.uncoveredS), ("slackS", Lean.toJson r.slackS),
    ("matchStartTs", optIntJson r.matchStartTs), ("matchEndTs", optIntJson r.matchEndTs),
    ("clippedLegs", Json.arr (r.clippedLegs.map fun l =>
      Json.mkObj [("mode", Json.str l.mode), ("overlapS", Lean.toJson l.overlapS),
                  ("durationS", Lean.toJson l.durationS)]))]

def journeyShapeResult (j : Json) : Json :=
  let parsed : Except String Json := do
    let gt ← (← optArr j "gt").mapM parseJourney
    let states ← (← optArr j "states").mapM parseState
    let pipeline := statesToJourneys states
    return Json.mkObj [
      ("pipelineJourneys", Json.arr (pipeline.map fun p =>
        Json.mkObj [("startTs", Lean.toJson p.startTs), ("endTs", Lean.toJson p.endTs),
                    ("legs", Json.arr (p.legs.map (Json.str ·.mode)))])),
      ("results", Json.arr ((journeyShapeResults gt pipeline).map resultJson))]
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

end JourneyShape

/-! ## Feasibility mode (`verified_cli feasibility`)

`Verified.Eval.Feasibility` — the worldline invariants (#1048). A
model-independent assertion on the DRAWN timeline: some outputs are impossible
regardless of how the cascade produced them.

⚠ EVERY INPUT IS OPTIONAL AND THE ABSENCE OF ONE SILENCES ITS INVARIANT, on
purpose. No `points` and the kinematic checks do not run; no `steps` and the
pedestrian twin does not; no `stationsOnLine` and the triple check does not;
no `accFixes` and the teleport check does not.
That is the zero-false-positive rule applied to missing DATA rather than to
thresholds — a day whose fixture never recorded a line's stations must not have
its labels called impossible.

  { "mode": "feasibility",
    "legs": [ { "startTs": n, "endTs": n, "mode": s, "wayName": s|null,
                "place": s|null, "placeAt": [f, f]|null } ],
    "points": [ { "ts": n, "lat": f, "lon": f } ],
    "accFixes": [ { "ts": n, "lat": f, "lon": f, "accuracy": f } ],
    "steps": [ { "ts": n, "steps": f } ],
    "lineStations": [ { "line": s, "stations": [s] } ] }

Output: `{ "violations": [ { "kind", "startTs", "endTs", "detail" } ] }`. -/

namespace Feasibility

open Verified.Eval.Feasibility

private def parseLeg (j : Json) : Except String Leg := do
  return { startTs := ← (← j.getObjVal? "startTs").getInt?
           endTs := ← (← j.getObjVal? "endTs").getInt?
           mode := ← (← j.getObjVal? "mode").getStr?
           wayName := (j.getObjVal? "wayName" >>= (·.getStr?)).toOption
           place := (j.getObjVal? "place" >>= (·.getStr?)).toOption
           placeAt := ← match j.getObjVal? "placeAt" with
             | .ok (.arr #[la, lo]) => do return some (← jFloat la, ← jFloat lo)
             | _ => pure none }

private def parseAccFix (j : Json) : Except String AccFix := do
  return { ts := ← (← j.getObjVal? "ts").getInt?
           lat := ← jFloatField j "lat"
           lon := ← jFloatField j "lon"
           accuracyM := ← jFloatField j "accuracy" }

private def parseFix (j : Json) : Except String Fix := do
  return { ts := ← (← j.getObjVal? "ts").getInt?
           lat := ← jFloatField j "lat"
           lon := ← jFloatField j "lon" }

private def parseStep (j : Json) : Except String StepPoint := do
  return { ts := ← (← j.getObjVal? "ts").getInt?
           steps := ← jFloatField j "steps" }

private def parseMembership (j : Json) : Except String (String × Array String) := do
  let line ← (← j.getObjVal? "line").getStr?
  let stations ← (← (← j.getObjVal? "stations").getArr?).mapM (·.getStr?)
  return (line, stations)

def feasibilityResult (j : Json) : Json :=
  let parsed : Except String Json := do
    let legs ← (← optArr j "legs").mapM parseLeg
    let points ← (← optArr j "points").mapM parseFix
    let steps ← (← optArr j "steps").mapM parseStep
    let lineStations ← (← optArr j "lineStations").mapM parseMembership
    let accFixes ← (← optArr j "accFixes").mapM parseAccFix
    let vs := checkWorldlineFeasibility legs points steps lineStations accFixes
    return Json.mkObj [("violations", Json.arr (vs.map fun v =>
      Json.mkObj [("kind", Json.str v.kind.toString),
                  ("startTs", Lean.toJson v.startTs), ("endTs", Lean.toJson v.endTs),
                  ("detail", Json.str v.detail)]))]
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

end Feasibility

/-! ## Ceiling-gate modes (`ceilinggate`, `ceilingbless`)

`Verified.Eval.CeilingGate` — the count-shaped sibling of `floorgate`, for the
two standing-defect baselines (#1048).

⚠ `measured` AND `attempted` ARE BOTH REQUIRED and they are not the same list.
`measured` is the days that produced a count; `attempted` is every day the run
set out to cover. Without the second, a day whose ceiling is ZERO is in neither
baseline and so is named nowhere — which is where a new defect hides best, since
it cannot regress a ceiling it is no longer measured against.

  { "mode": "ceilinggate",
    "committed": [ { "date": s, "count": n } ],
    "current":   [ { "date": s, "count": n } ],
    "measured": [s], "attempted": [s] }

Output: `{ "regressed": [{ "date", "was", "now" }], "improvedDays": n,
"unmeasured": [s] }`.

  { "mode": "ceilingbless", "committed": … | null, "current": …, "measured": [s] }

Output: `{ "ceiling": [ { "date", "count" } ] }` — the MINIMUM per day, so
blessing a run that fixed some days cannot raise the ceiling on the others. A
`null` committed is the bootstrap case. -/

namespace CeilingGate

open Verified.Eval.CeilingGate

private def parseCeiling (j : Json) (key : String) : Except String Ceiling := do
  let arr ← match j.getObjVal? key with
    | .error _ => pure #[]
    | .ok v => if v.isNull then pure #[] else v.getArr?
  arr.mapM fun e => do
    let date ← (← e.getObjVal? "date").getStr?
    let count ← (← e.getObjVal? "count").getNat?
    return (date, count)

private def parseDates (j : Json) (key : String) : Except String (Array String) := do
  let arr ← match j.getObjVal? key with
    | .error _ => pure #[]
    | .ok v => v.getArr?
  arr.mapM (·.getStr?)

private def ceilingJson (c : Ceiling) : Json :=
  Json.arr (c.map fun (d, n) =>
    Json.mkObj [("date", Json.str d), ("count", Lean.toJson n)])

def ceilingGateResult (j : Json) : Json :=
  let parsed : Except String Json := do
    let committed ← parseCeiling j "committed"
    let current ← parseCeiling j "current"
    let measured ← parseDates j "measured"
    let attempted ← parseDates j "attempted"
    let r := gateCeiling committed current measured attempted
    return Json.mkObj [
      ("regressed", Json.arr (r.regressed.map fun x =>
        Json.mkObj [("date", Json.str x.date), ("was", Lean.toJson x.was),
                    ("now", Lean.toJson x.now)])),
      ("improvedDays", Lean.toJson r.improvedDays),
      ("unmeasured", Json.arr (r.unmeasured.map Json.str))]
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

def ceilingBlessResult (j : Json) : Json :=
  let parsed : Except String Json := do
    -- ⚠ `null` and ABSENT both mean bootstrap; an empty ARRAY does not. A
    -- committed baseline of `[]` is a real ceiling of zero everywhere.
    let committed : Option Ceiling ← match j.getObjVal? "committed" with
      | .error _ => pure none
      | .ok v => if v.isNull then pure none else some <$> parseCeiling j "committed"
    let current ← parseCeiling j "current"
    let measured ← parseDates j "measured"
    return Json.mkObj [("ceiling", ceilingJson (ratchetDownCounts committed current measured))]
  match parsed with
  | .error e => Json.mkObj [("error", Json.str e)]
  | .ok out => out

end CeilingGate
