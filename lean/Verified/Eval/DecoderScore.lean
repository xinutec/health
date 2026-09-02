import Verified.Eval.GroundTruth
import Verified.Eval.Journeys

/-!
# Decoder scoreboard — the ten per-day journey-structure counts (#1048)

Port of the scoring half of `src/eval/journey-score.ts` (`statesToMinutes`,
`decoderJourneys`, `scoreJourneys`'s counters) and the whole of
`src/eval/decoder-scoreboard.ts` (`scoreStations`, `countPhantomRides`),
recovered from `06346bd^`. The oracle is `tests/golden/decoder-scoreboard.json`
— dates and counts a human blessed from the TypeScript before it went.

The GT journey builder and its leg/journey types are `Verified.Eval.Journeys`;
this module adds the DECODER side and the counters that compare the two.

⚠ `modeShape` and `bestOverlap` exist in `Verified.Eval.JourneyShape` over ITS
journey type (the pipeline referee's). The pair below operates on
`Verified.Eval.Journeys.Journey` and mirrors the TS `journey-score.ts` pair the
scoreboard was blessed from. Two small copies beat one shared abstraction that
would let one gate's semantics drift the other's.

⚠ Station equality is ASCII-case-insensitive (`String.toLower`); the TS used
Unicode `toLowerCase`. Every station name in the corpus is ASCII, and a
non-ASCII one arriving would fail the parity harness loudly rather than
silently scoring differently.
-/

namespace Verified.Eval.DecoderScore

open Verified.Eval.GroundTruth (Status Provenance Mode trusted Truth)
open Verified.Eval.Journeys (Leg Journey JRow groundTruthJourneys)

/-- One decoded minute. `mode` is the decoder's string spelling. -/
structure DecoderMinute where
  ts : Int
  mode : String
  lineName : Option String := none
  board : Option String := none
  alight : Option String := none
  deriving BEq, Repr, Inhabited

/-- One decoded segment, the fixture's `expected` row. -/
structure Seg where
  startTs : Int
  endTs : Int
  mode : String
  lineName : Option String := none
  board : Option String := none
  alight : Option String := none
  deriving BEq, Repr, Inhabited

/-- `sleeping` folds to `stationary`; everything else is itself. -/
def canonicalModeStr (m : String) : String :=
  if m == "sleeping" then "stationary" else m

def isMovementModeStr (m : String) : Bool :=
  let c := canonicalModeStr m
  c == "walking" || c == "cycling" || c == "driving" || c == "bus"
    || c == "train" || c == "plane"

/-- A vehicle mode for the phantom count — walking is not a ride. -/
def isVehicleModeStr (m : String) : Bool :=
  m == "train" || m == "bus" || m == "driving" || m == "cycling" || m == "plane"

/-- A stay shorter than this is an in-journey pause; `journey-score.ts`. -/
def JOURNEY_PAUSE_MAX_S : Int := 5 * 60

/-- Decoded segments to minutes — `t` steps from the RAW `startTs`, not a
minute-aligned one (`segmentsToMinutes`, `score-decoder-golden.ts:117`). -/
def segmentsToMinutes (segs : Array Seg) : Array DecoderMinute := Id.run do
  let mut out : Array DecoderMinute := #[]
  for s in segs do
    let mut t := s.startTs
    while t < s.endTs do
      out := out.push { ts := t, mode := s.mode, lineName := s.lineName,
                        board := s.board, alight := s.alight }
      t := t + 60
  return out

/-- A coarse state timeline to minutes — one entry per TOP-OF-MINUTE inside
each window (`statesToMinutes`, `journey-score.ts:129`); line/place/stations
are not carried. -/
def statesToMinutes (states : Array (Int × Int × String)) : Array DecoderMinute := Id.run do
  let mut out : Array DecoderMinute := #[]
  for (startTs, endTs, mode) in states do
    let mut t := ((startTs + 59) / 60) * 60
    -- ⚠ Int division truncates toward zero; `Math.ceil` on a NEGATIVE start
    -- would differ, but no timestamp in this system is negative.
    while t < endTs do
      out := out.push { ts := t, mode := mode }
      t := t + 60
  return out

/-- Decoder minutes to journeys: movement minutes collapse into legs (same
canonical mode + same line, contiguous-or-overlapping), and a gap longer than
the tolerance starts a new journey. A merged leg boards where its first minute
boards and alights where its LAST minute alights — the TS overwrites `alight`
unconditionally on every merged minute, including to null. -/
def decoderJourneys (minutes : Array DecoderMinute)
    (gapToleranceS : Int := JOURNEY_PAUSE_MAX_S) : Array Journey := Id.run do
  let sorted := minutes.qsort (fun a b => a.ts < b.ts)
  let mut legs : Array Leg := #[]
  for m in sorted do
    if !isMovementModeStr m.mode then
      continue
    let mode := canonicalModeStr m.mode
    let line := if mode == "train" || mode == "bus" then m.lineName else none
    match legs.back? with
    | some last =>
      if last.mode == mode && last.line == line && m.ts ≤ last.endTs then
        legs := legs.set! (legs.size - 1)
          { last with endTs := m.ts + 60, alight := m.alight }
      else
        legs := legs.push { startTs := m.ts, endTs := m.ts + 60, mode, line,
                            board := m.board, alight := m.alight }
    | none =>
      legs := legs.push { startTs := m.ts, endTs := m.ts + 60, mode, line,
                          board := m.board, alight := m.alight }
  let mut journeys : Array Journey := #[]
  let mut current : Array Leg := #[]
  for leg in legs do
    match current.back? with
    | some last =>
      if leg.startTs - last.endTs > gapToleranceS then
        journeys := journeys.push
          { startTs := current[0]!.startTs, endTs := last.endTs, legs := current }
        current := #[]
    | none => pure ()
    current := current.push leg
  if current.size > 0 then
    journeys := journeys.push
      { startTs := current[0]!.startTs, endTs := current.back!.endTs, legs := current }
  return journeys

/-- Insertion-ordered tally bump — mirrors JS `Map` iteration order, which is
what breaks `argmax` ties in the TS. -/
private def bump (tally : Array (String × Nat)) (k : String) : Array (String × Nat) :=
  match tally.findIdx? (·.1 == k) with
  | some i => tally.set! i (k, tally[i]!.2 + 1)
  | none => tally.push (k, 1)

/-- Key with the strictly highest count; first insertion wins a tie. -/
private def argmax (tally : Array (String × Nat)) : Option String := Id.run do
  let mut best : Option String := none
  let mut bestN := 0
  for (k, n) in tally do
    if n > bestN then
      bestN := n
      best := some k
  return best

/-- Dominant canonical mode over `[startTs, endTs)`, and the dominant line
among the minutes whose mode matches `expectedMode`. -/
def dominantOverWindow (minutes : Array DecoderMinute) (startTs endTs : Int)
    (expectedMode : String) : Option String × Option String := Id.run do
  let mut modeTally : Array (String × Nat) := #[]
  let mut lineTally : Array (String × Nat) := #[]
  let mut t := startTs
  while t < endTs do
    match minutes.find? (·.ts == t) with
    | some dm =>
      let c := canonicalModeStr dm.mode
      modeTally := bump modeTally c
      if c == expectedMode then
        match dm.lineName with
        | some l => lineTally := bump lineTally l
        | none => pure ()
    | none => pure ()
    t := t + 60
  return (argmax modeTally, argmax lineTally)

/-- Deduped ordered mode sequence with same-vehicle interchange walks smoothed
away — `journey-score.ts`'s `modeShape`, on the Journeys types. -/
def modeShape (j : Journey) : Array String := Id.run do
  let legs := j.legs
  let mut kept : Array String := #[]
  for i in [0:legs.size] do
    let m := legs[i]!.mode
    if m == "walking" && i > 0 && i + 1 < legs.size then
      let prev := legs[i-1]!.mode
      let next := legs[i+1]!.mode
      if prev == next && (prev == "train" || prev == "bus") then
        continue
    kept := kept.push m
  let mut shape : Array String := #[]
  for m in kept do
    if shape.back? != some m then
      shape := shape.push m
  return shape

/-- The decoder journey with the most temporal overlap, or none. Strict `>`
keeps the FIRST on a tie, like the TS. -/
def bestOverlap (gt : Journey) (dec : Array Journey) : Option Journey := Id.run do
  let mut best : Option Journey := none
  let mut bestOv : Int := 0
  for d in dec do
    let ov := max 0 (min gt.endTs d.endTs - max gt.startTs d.startTs)
    if ov > bestOv then
      bestOv := ov
      best := some d
  return best

/-- The six `scoreJourneys` counters the scoreboard keeps. -/
structure JourneyCounts where
  journeysExpected : Nat
  journeysMatched : Nat
  legModeScorable : Nat
  legModeMatching : Nat
  legLineScorable : Nat
  legLineMatching : Nat
  deriving BEq, Repr, Inhabited

def scoreJourneyCounts (gtJourneys : Array Journey) (decJourneys : Array Journey)
    (minutes : Array DecoderMinute) : JourneyCounts := Id.run do
  let mut c : JourneyCounts :=
    { journeysExpected := gtJourneys.size, journeysMatched := 0,
      legModeScorable := 0, legModeMatching := 0,
      legLineScorable := 0, legLineMatching := 0 }
  for gtJ in gtJourneys do
    for leg in gtJ.legs do
      c := { c with legModeScorable := c.legModeScorable + 1 }
      let (domMode, domLine) := dominantOverWindow minutes leg.startTs leg.endTs leg.mode
      let modeMatch := domMode == some leg.mode
      if modeMatch then
        c := { c with legModeMatching := c.legModeMatching + 1 }
      -- Line is only scorable on a mode-matched leg.
      if leg.line.isSome && modeMatch then
        c := { c with legLineScorable := c.legLineScorable + 1 }
        if domLine == leg.line then
          c := { c with legLineMatching := c.legLineMatching + 1 }
    let matched := match bestOverlap gtJ decJourneys with
      | some m => modeShape m == modeShape gtJ
      | none => false
    if matched then
      c := { c with journeysMatched := c.journeysMatched + 1 }
  return c

/-- ASCII lowercase, the parity caveat in the header. -/
private def lower (s : String) : String := s.toLower

/-- The same-mode decoder leg with the most overlap — accepted only when the
overlap covers a MAJORITY of the truth leg. -/
private def bestOverlappingLeg (gt : Leg) (decLegs : Array Leg) : Option Leg := Id.run do
  let mut best : Option Leg := none
  let mut bestOv : Int := 0
  for d in decLegs do
    if d.mode != gt.mode then
      continue
    let ov := max 0 (min gt.endTs d.endTs - max gt.startTs d.startTs)
    if ov > bestOv then
      bestOv := ov
      best := some d
  return if bestOv * 2 > gt.endTs - gt.startTs then best else none

structure StationCounts where
  stationsAsserted : Nat
  stationsMatching : Nat
  stationsMissing : Nat
  deriving BEq, Repr, Inhabited

/-- `decoder-scoreboard.ts`'s `scoreStations`. -/
def scoreStations (gtJourneys decJourneys : Array Journey) : StationCounts := Id.run do
  let decLegs := decJourneys.flatMap (·.legs)
  let mut c : StationCounts := ⟨0, 0, 0⟩
  for gtJ in gtJourneys do
    for leg in gtJ.legs do
      match leg.board, leg.alight with
      | some b, some a =>
        c := { c with stationsAsserted := c.stationsAsserted + 1 }
        match bestOverlappingLeg leg decLegs with
        | some m =>
          match m.board, m.alight with
          | some mb, some ma =>
            if lower mb == lower b && lower ma == lower a then
              c := { c with stationsMatching := c.stationsMatching + 1 }
          | _, _ => c := { c with stationsMissing := c.stationsMissing + 1 }
        | none => c := { c with stationsMissing := c.stationsMissing + 1 }
      | _, _ => pure ()
  return c

/-- An enforceable-truth span asserting a NON-vehicle mode — what convicts a
phantom ride. -/
structure ContradictingSpan where
  startTs : Int
  endTs : Int
  deriving Repr, Inhabited

/-- `countPhantomRides`: decoder vehicle legs whose MAJORITY lies inside
enforceable non-vehicle truth. -/
def countPhantomRides (contradicting : Array ContradictingSpan)
    (decJourneys : Array Journey) : Nat := Id.run do
  let mut phantoms := 0
  for j in decJourneys do
    for leg in j.legs do
      if !isVehicleModeStr leg.mode then
        continue
      let mut contradictedS : Int := 0
      for r in contradicting do
        contradictedS := contradictedS
          + max 0 (min leg.endTs r.endTs - max leg.startTs r.startTs)
      if contradictedS * 2 > leg.endTs - leg.startTs then
        phantoms := phantoms + 1
  return phantoms

/-- Whether a row's truth convicts — enforceable and non-vehicle. The MODE
string is the canonical one. -/
def contradicts (status : Status) (provenance : Provenance) (mode : Mode) : Bool :=
  ((status == .correct) || (status == .wrong)) && trusted provenance
    && !isVehicleModeStr (canonicalModeStr (Verified.Eval.Journeys.canonicalMode mode))

/-! ## Guards — every branch that could silently drift -/

private def dm (t : Int) (m : String) (l : Option String := none)
    (b : Option String := none) (a : Option String := none) : DecoderMinute :=
  { ts := t, mode := m, lineName := l, board := b, alight := a }

-- segmentsToMinutes steps from the RAW start; 90..210 yields 90 and 150.
#guard (segmentsToMinutes #[⟨90, 210, "walking", none, none, none⟩]).map (·.ts) == #[90, 150]
-- statesToMinutes ceils to the top of minute: 90..210 yields 120 and 180.
#guard (statesToMinutes #[(90, 210, "walking")]).map (·.ts) == #[120, 180]

-- Contiguous same-mode same-line minutes merge into one leg; board keeps the
-- FIRST minute's, alight the LAST's (overwritten even to none).
#guard (decoderJourneys #[dm 0 "train" (some "L") (some "A") (some "B"),
                          dm 60 "train" (some "L") none (some "C")]).size == 1
#guard ((decoderJourneys #[dm 0 "train" (some "L") (some "A") (some "B"),
                           dm 60 "train" (some "L") none (some "C")])[0]!.legs[0]!.board) == some "A"
#guard ((decoderJourneys #[dm 0 "train" (some "L") (some "A") (some "B"),
                           dm 60 "train" (some "L") none none])[0]!.legs[0]!.alight) == none
-- A line change splits the leg but not the journey.
#guard ((decoderJourneys #[dm 0 "train" (some "L1"), dm 60 "train" (some "L2")])[0]!.legs.size) == 2
-- A gap over the tolerance splits the journey.
#guard (decoderJourneys #[dm 0 "walking", dm 600 "walking"]).size == 2
-- ... and a gap of exactly the tolerance does NOT (`>` in the TS).
#guard (decoderJourneys #[dm 0 "walking", dm 360 "walking"]).size == 1
-- sleeping folds to stationary and is not movement.
#guard (decoderJourneys #[dm 0 "sleeping"]).size == 0

-- Dominant mode: ties break to first insertion (JS Map order).
#guard (dominantOverWindow #[dm 0 "walking", dm 60 "train" (some "L")] 0 120 "train").1 == some "walking"
-- The dominant line counts only mode-matching minutes.
#guard (dominantOverWindow #[dm 0 "train" (some "L1"), dm 60 "train" (some "L1"),
                             dm 120 "bus" (some "R")] 0 180 "train").2 == some "L1"

private def jleg (s e : Int) (m : String) (l : Option String := none)
    (b : Option String := none) (a : Option String := none) : Leg :=
  { startTs := s, endTs := e, mode := m, line := l, board := b, alight := a }
private def jj (s e : Int) (legs : Array Leg) : Journey := ⟨s, e, legs⟩

-- Interchange smoothing: train, walking, train (same vehicle) reads "train".
#guard modeShape (jj 0 300 #[jleg 0 100 "train", jleg 100 200 "walking", jleg 200 300 "train"])
  == #["train"]
-- A walk between DIFFERENT vehicles is kept.
#guard modeShape (jj 0 300 #[jleg 0 100 "train", jleg 100 200 "walking", jleg 200 300 "bus"])
  == #["train", "walking", "bus"]
-- Leading and trailing walks are kept.
#guard modeShape (jj 0 300 #[jleg 0 100 "walking", jleg 100 300 "train"])
  == #["walking", "train"]

-- Station scoring: the majority rule refuses a boundary brush.
#guard (scoreStations
    #[jj 0 600 #[jleg 0 600 "train" (some "L") (some "A") (some "B")]]
    #[jj 540 1200 #[jleg 540 1200 "train" (some "L") (some "A") (some "B")]]).stationsMissing == 1
-- Case-insensitive station match.
#guard (scoreStations
    #[jj 0 600 #[jleg 0 600 "train" (some "L") (some "Kings Cross") (some "Oval")]]
    #[jj 0 600 #[jleg 0 600 "train" (some "L") (some "KINGS CROSS") (some "oval")]]).stationsMatching == 1
-- A same-mode overlapping leg with NO stations is `missing`, not wrong.
#guard (scoreStations
    #[jj 0 600 #[jleg 0 600 "train" (some "L") (some "A") (some "B")]]
    #[jj 0 600 #[jleg 0 600 "train" (some "L")]]).stationsMissing == 1

-- Phantom rides: majority conviction; exactly half does not convict.
#guard countPhantomRides #[⟨0, 301⟩] #[jj 0 600 #[jleg 0 600 "bus" (some "R")]] == 1
#guard countPhantomRides #[⟨0, 300⟩] #[jj 0 600 #[jleg 0 600 "bus" (some "R")]] == 0
-- A phantom WALK is not a ride.
#guard countPhantomRides #[⟨0, 600⟩] #[jj 0 600 #[jleg 0 600 "walking"]] == 0

end Verified.Eval.DecoderScore
