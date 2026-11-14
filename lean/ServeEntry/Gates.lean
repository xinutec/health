import Verified
import DayEntry
import BackendEntry
import Lean.Data.Json
import ServeEntry.Wire

/-!
# `ServeEntry.Gates` — the referee modes

`walkgate`, `groundtruth`, `journeys`, `decoderscore`, `truthcheck`,
`floorgate`, `journeyshape`, `feasibility` and the ceiling gates: modes that
serve nothing, each measuring a corpus against a blessed file.
-/

open Lean (Json)
open Wire
open Verified.Hsmm

/-! ## Walk-gate mode (`verified_cli walkgate`)

`Verified.Eval.WalkMetrics` and `WalkGate` over a corpus in one call: measure
every drawn walk against its floor (`tests/golden/walk-baseline.json`) and
return the current metrics (ready to re-bless) and the verdict.

Coordinates cross as plain JSON numbers, not `match`'s 1e-7 grid: the floor was
blessed from raw doubles, and shortest round-trip decimals are exact. Metrics
return as bit patterns: `Lean.toJson` prints six decimals.

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
"unmatched": […], "added": […], "unmeasured": […] }`, `current` in request
order, the rest sorted by date. -/

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
pipeline's cleaned GPS for the leg — a fold input, which is why the harness can
supply it and a frozen fixture cannot. -/
private structure WalkIn where
  startTs : Int
  endTs : Int
  drawn : Array LatLon
  raw : Array LatLon
  acceptedNames : Array String
  /-- The matcher's identity report for this leg: named ways and their
  metres, longest first. A diagnostic — nothing here scores it. -/
  wayUm : Array (String × Nat) := #[]
  /-- Does the mirror hold building outlines for the ground this leg ran over?
  An `offPathBuildingCrossingM` of 0.0 is ambiguous without it, and coverage
  varies within a day. Copied from the fold's `Seg.walkBuildingsMeasured`.

  Defaults true: false would let a dropped field silently switch the wall lens
  off; the gate prints the tally every run instead. -/
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

/-- Resolve a day's geometry: inline arrays, or indices into request-level
tables, which keep repeated ways from multiplying the request's size in memory.
Inline stays supported. An out-of-range index is an error, never a dropped way. -/
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

/-- A floor entry. Floats read as bit patterns or plain numbers
(`walk-baseline.json` holds blessed decimals, the fold sends bits); written as
bits only (`entryJson`). An absent column is `none`: never measured. -/
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

/-- How far from the drawn line a raw fix counts as uncovered (m), of the order
of the display gate's `WALK_MATCH_MAX_STRAY_M`. Not tuned; the share should
move smoothly with it. -/
private def UNCOVERED_RADIUS_M : Float := 30

/-- Measure one drawn walk into the floor's shape. Each `none` is a different
unanswered question, never a zero: no buildings → `offPathM`, no confirmed
street → `routeCorr`, no steps → no budget.

`scoreWalk` gets no steps: its pedometer term differs from `stepBudgetM`'s. -/

private def measure (d : DayIn) (wantP90 : Bool) (w : WalkIn) : WalkEntry :=
  let sc := scoreWalk w.drawn (Float.ofInt w.startTs) (Float.ofInt w.endTs) #[] (some d.ways)
              0.72 35 wantP90
  let span := (Float.ofInt w.endTs) - (Float.ofInt w.startTs)
  { startTs := w.startTs
    p90M := sc.offWalkableP90M
    stallM := maxCorridorStall w.raw w.drawn
    speedKmh := if span > 0 then (sc.drawnLengthM / span) * 3.6 else 0
    routeCorr := onNamedWayFraction w.drawn w.acceptedNames d.ways
    -- Unmeasured is not clean. `none` when the day holds no outlines
    -- at all, and now also when none were fetched for this leg's ground — the
    -- distinction coverage actually varies along.
    offPathM := if d.buildings.isEmpty || !w.buildingsMeasured then none
                else some (offPathBuildingCrossingM w.drawn d.buildings d.ways)
    lenM := sc.drawnLengthM
    budgetM := stepBudgetM d.steps (Float.ofInt w.startTs) (Float.ofInt w.endTs)
    wayUm := w.wayUm
    -- Coverage, recorded, not scored: the maximum, since a quantile cannot see
    -- a line abandoning part of a walk.
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
    -- Passed through, never scored. It rides the referee's wire so
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
  -- Off by default: `p90M` is most of this mode's cost and nothing gates on
  -- it. A floor refresh asks for it; absent means not asked.
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

/-! ## Ground-truth mode (`verified_cli groundtruth`)

`Verified.Eval.GroundTruth.parseGroundTruth` over one narrative. The reply is
civil time: Rust resolves `(day, hh, mm)` with `timezone.rs`'s
`wall_clock_to_unix`.

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

`Verified.Eval.Journeys.groundTruthJourneys` over resolved audit rows (unix
seconds).

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
              -- The place bounds journeys (a visit); the referee never compares it.
              place := (t.getObjVal? "place" >>= (·.getStr?)).toOption,
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

/-! ## Decoder-scoreboard mode (`verified_cli decoderscore`)

The `journeys` rows plus `provenance`, and the decoded segments:

  { "mode": "decoderscore",
    "rows": [ { "startTs", "endTs", "status", "provenance",
                "truth": { "mode", "lineName", "from", "to" } | null } ],
    "segs": [ { "startTs", "endTs", "mode", "lineName", "board", "alight" } ] }

Output: the ten counts, spelled as `decoder-scoreboard.json` spells them. -/

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
      -- Per truth journey, for reading which journeys fail and how: the scorer's
      -- own `bestOverlap` and `modeShape`, so the detail cannot disagree with
      -- the count.
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

`Verified.Eval.TruthCheck.classifyDay`, grading the drawn legs (`states`)
against resolved narrative rows.

  { "mode": "truthcheck",
    "rows": [ { "startTs": n, "endTs": n, "status": "correct|wrong|partial|unclear",
                "provenance": "corroborated|user|derived|inferred|unspecified",
                "truth": { "mode", "place", "wayName", "placeQualifier",
                           "from", "to", "lineName" } | null } ],
    "states": [ { "startTs": n, "endTs": n, "mode": s,
                  "place": s|null, "wayName": s|null } ] }

Output: `{ "verdicts": [s], "verified": n, "regressed": n, "knownError": n,
"cleared": n, "unverified": n, "hasRegression": b, "covering": [n] }`.
`verdicts` is positional; `covering` is the index of the state that answered
each row, or `-1`. -/

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
    wayName := optStr j "wayName"
    roads := ← (← optArr j "roads").mapM (·.getStr?) }

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

`Verified.Eval.FloorGate`, the ratchet behind the truth and journey floors.
Floors arrive as arrays, not date-keyed objects; Rust converts the files.
`described` is optional: given, the reply adds the ratcheted `floor` and the
`dropped` keys, never computed as a side effect of gating.

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

`Verified.Eval.JourneyShape`: builds the pipeline's journeys here from the raw
drawn states (so the merge rules stay checked) and grades each ground-truth
journey, as the `journeys` mode returned it.

  { "mode": "journeyshape",
    "gt": [ { "startTs": n, "endTs": n,
              "legs": [ { "startTs": n, "endTs": n, "mode": s } ] } ],
    "states": [ { "startTs": n, "endTs": n, "mode": s } ] }

Output: `{ "pipelineJourneys": [ { "startTs", "endTs", "legs": [s] } ],
"results": [ { "startTs", "endTs", "expectedShape", "actualShape", "matched",
"uncoveredS", "slackS", "matchStartTs", "matchEndTs",
"clippedLegs": [ { "mode", "overlapS", "durationS" } ] } ] }`.
`pipelineJourneys` shows a trip the pipeline split, which `bestOverlap` scores
on its larger half. -/

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

private def parseState (j : Json) : Except String Verified.Eval.JourneyShape.Drawn := do
  return { startTs := ← (← j.getObjVal? "startTs").getInt?
           endTs := ← (← j.getObjVal? "endTs").getInt?
           mode := ← (← j.getObjVal? "mode").getStr? }

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

`Verified.Eval.Feasibility`, the worldline invariants on the drawn timeline.
Every input is optional, and a missing one silences its invariant (`points`,
`steps`, `lineStations`, `accFixes`): missing data never makes a label
impossible.

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

`Verified.Eval.CeilingGate`. ⚠ `measured` (days that produced a count) and
`attempted` (days the run covered) are both required, or a zero-ceiling day
that stopped replaying is named nowhere.

  { "mode": "ceilinggate",
    "committed": [ { "date": s, "count": n } ],
    "current":   [ { "date": s, "count": n } ],
    "measured": [s], "attempted": [s] }

Output: `{ "regressed": [{ "date", "was", "now" }], "improvedDays": n,
"unmeasured": [s] }`.

  { "mode": "ceilingbless", "committed": … | null, "current": …, "measured": [s] }

Output: `{ "ceiling": [ { "date", "count" } ] }`, the per-day minimum; `null`
committed bootstraps. -/

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
    -- ⚠ `null` and absent both mean bootstrap; an empty array does not. A
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
