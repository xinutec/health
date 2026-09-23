import Verified.Hsmm.Observation
import Verified.Hsmm.FloatScore
/-!
# Train-window detection (implementation-first port of `findTrainWindows`)

The observation-only core of the train-candidate generator: from the per-minute
GPS speeds and the bracketing fixes, find the disjoint `[start, end]` windows the
user was plausibly on a train — via observed train speed OR a bracketed GPS-null
displacement implying train velocity. Pure over the observation tensor; the
station/line matching (`enumerateTrainCandidates`) is the graph-dependent
follow-on that consumes these windows.

The TS is heavily imperative (tag array + in-place bracketed-displacement pass +
while-loop window extraction), so this uses `Id.run do` (mutable arrays, `for`)
for the passes. The scans are total: each one walks towards an edge of the
tensor and Lean checks that the distance to that edge shrinks. `haversine` makes
the velocity tests ULP-close, but they compare against thresholds far from the
boundary in the tested cases, so the windows are exact. Correctness UNPROVEN;
pinned by the `#guard`s.
-/

namespace Verified.Hsmm.TrainWindows

open Verified.Hsmm.Observation (ObsRow Fix)
open Verified.Hsmm.FloatScore (haversineMeters)

def V_TRAIN_PEAK_KMH : Float := 25
def V_TRAIN_AVG_KMH : Float := 12
def MIN_WINDOW_MIN : Nat := 2
def STATION_HOP_MIN_DISPLACEMENT_M : Float := 400
def MAX_WINDOW_MIN : Nat := 90

inductive Tag | train | unknown | notTrain
  deriving BEq, Inhabited

private def fge (a b : Float) : Bool := decide (a ≥ b)

/-- Which way a boundary scan walks from a window's edge. -/
inductive Side | back | fwd

/-- The fix recorded at minute `t`, if the minute was GPS-observed. -/
private def fixAt (obs : Array ObsRow) (t : Nat) (h : t < obs.size) : Option (Float × Float × Int) :=
  obs[t].gps.map fun g => (g.lat, g.lon, obs[t].ts)

/-- Scan forward from `t` for the first GPS-observed minute; `none` if the scan
    runs off the end of the tensor first. -/
def scanFwd (obs : Array ObsRow) (t : Nat) : Option (Float × Float × Int) :=
  if h : t < obs.size then
    match fixAt obs t h with
    | some r => some r
    | none => scanFwd obs (t + 1)
  else none
termination_by obs.size - t

/-- Scan backward from `t` for the last GPS-observed minute; `none` if the scan
    runs off the start of the tensor first. A `t` at or past the end finds nothing. -/
def scanBack (obs : Array ObsRow) (t : Nat) : Option (Float × Float × Int) :=
  if h : t < obs.size then
    match fixAt obs t h with
    | some r => some r
    | none => if h0 : t = 0 then none else scanBack obs (t - 1)
  else none
termination_by t

/-- Last/first observed fix at/beyond `idx` on `side`, falling back to the
    prev/next-fix bookend recorded on the (clamped) edge minute. `idx` is an
    `Int` because a window at the tensor's start asks for minute `-1`, which
    scans nothing and goes straight to the bookend. -/
def boundaryFix (obs : Array ObsRow) (idx : Int) (side : Side) : Option (Float × Float × Int) :=
  let scanned := if decide (idx < 0) then none else
    match side with
    | .fwd => scanFwd obs idx.toNat
    | .back => scanBack obs idx.toNat
  match scanned with
  | some r => some r
  | none =>
    let clamped := (max 0 (min ((obs.size : Int) - 1) idx)).toNat
    let book := match side with
      | .back => obs[clamped]!.prevGpsFix
      | .fwd => obs[clamped]!.nextGpsFix
    book.map (fun f => (f.lat, f.lon, f.ts))

/-- Whether a sub-floor run carries the one-stop-hop reacquisition signature:
    the bracketing fixes show ≥`STATION_HOP_MIN_DISPLACEMENT_M` at train speed. -/
def bracketedStationHop (obs : Array ObsRow) (start endN : Nat) : Bool :=
  match boundaryFix obs ((start : Int) - 1) .back, boundaryFix obs ((endN : Int) + 1) .fwd with
  | some (blat, blon, bts), some (alat, alon, ats) =>
    let distM := haversineMeters blat blon alat alon
    if distM < STATION_HOP_MIN_DISPLACEMENT_M then false
    else
      let hrs := (ats.toNat.toFloat - bts.toNat.toFloat) / 3600
      fge (distM / 1000 / max hrs (1.0 / 3600)) V_TRAIN_AVG_KMH
  | _, _ => false

/-- Length of the run of not-`notTrain` minutes starting at `i` (`0` at the end
    of the tensor). `i + runLen tag i` is the first `notTrain` index at or after
    `i`, or `tag.size`; it is written as a length so a caller stepping past the
    run can show its index grew. -/
def runLen (tag : Array Tag) (i : Nat) : Nat :=
  if h : i < tag.size then
    if tag[i] == Tag.notTrain then 0 else runLen tag (i + 1) + 1
  else 0
termination_by tag.size - i

/-- Advance past leading `unknown` minutes, not beyond `endI`. -/
def trimLead (tag : Array Tag) (start endI : Nat) : Nat :=
  if h : start ≤ endI ∧ start < tag.size then
    if tag[start] == Tag.unknown then trimLead tag (start + 1) endI else start
  else start
termination_by endI + 1 - start

/-- Retreat from `e` past trailing `unknown` minutes, not below `start`; `none`
    when every minute back to `start` is `unknown`, so the window is empty. -/
def trimTrail (tag : Array Tag) (start e : Nat) : Option Nat :=
  if h : start ≤ e ∧ e < tag.size then
    if tag[e] == Tag.unknown then
      if h0 : e = 0 then none else trimTrail tag start (e - 1)
    else some e
  else if e < start then none else some e
termination_by e

/-- Verify a trimmed `[start, endN]` window meets the train-velocity thresholds
    (observed peak/avg OR implied inter-fix displacement), returning the emitted
    (possibly `MAX_WINDOW_MIN`-capped) window. -/
def windowIfValid (obs : Array ObsRow) (start endN : Nat) : Option (Nat × Nat) := Id.run do
  let longEnough := decide (endN - start + 1 ≥ MIN_WINDOW_MIN)
  let isStationHop := !longEnough && bracketedStationHop obs start endN
  if !(longEnough || isStationHop) then return none
  let mut peak : Float := 0
  let mut sumSpeed : Float := 0
  let mut nObs : Nat := 0
  let mut firstObs : Option (Float × Float × Nat) := none
  let mut lastObs : Option (Float × Float × Nat) := none
  for t in [start:endN + 1] do
    match obs[t]!.gps with
    | none => pure ()
    | some g =>
      if g.speedKmh > peak then peak := g.speedKmh
      sumSpeed := sumSpeed + g.speedKmh
      nObs := nObs + 1
      if firstObs.isNone then firstObs := some (g.lat, g.lon, t)
      lastObs := some (g.lat, g.lon, t)
  let avg := if nObs > 0 then sumSpeed / nObs.toFloat else 0
  let mut implicitKmh : Float := 0
  match firstObs, lastObs with
  | some (flat, flon, ft), some (llat, llon, lt) =>
    if lt > ft then
      let distKm := haversineMeters flat flon llat llon / 1000
      let hrs := ((lt : Nat).toFloat - (ft : Nat).toFloat) / 60
      implicitKmh := distKm / max hrs (1.0 / 3600)
  | none, _ =>
    match obs[start]!.prevGpsFix, obs[endN]!.nextGpsFix with
    | some sp, some en =>
      if en.ts > sp.ts then
        let distKm := haversineMeters sp.lat sp.lon en.lat en.lon / 1000
        let hrs := (en.ts.toNat.toFloat - sp.ts.toNat.toFloat) / 3600
        implicitKmh := distKm / max hrs (1.0 / 3600)
    | _, _ => pure ()
  | _, _ => pure ()
  let meetsPeak := fge peak V_TRAIN_PEAK_KMH || fge implicitKmh V_TRAIN_AVG_KMH
  let meetsAvg := fge avg V_TRAIN_AVG_KMH || fge implicitKmh V_TRAIN_AVG_KMH
  if meetsPeak && meetsAvg then
    let windowLen := min (endN - start + 1) MAX_WINDOW_MIN
    return some (start, start + windowLen - 1)
  return none

/-- Outer window-extraction loop (the TS `while (i < T)`): each candidate run
    `[i, j)` of not-`notTrain` minutes is trimmed of `unknown` at both ends and
    validated; the loop resumes after the run. -/
def extractWindows (obs : Array ObsRow) (tag : Array Tag) (i : Nat) : Array (Nat × Nat) :=
  if h : i < tag.size then
    if tag[i] == Tag.notTrain then extractWindows obs tag (i + 1)
    else
      let j := i + runLen tag i
      let start := trimLead tag i (j - 1)
      let rest := extractWindows obs tag (j + 1)
      match trimTrail tag start (j - 1) with
      | some endI =>
        match windowIfValid obs start endI with
        | some w => #[w] ++ rest
        | none => rest
      | none => rest
  else #[]
termination_by tag.size - i

/-- Disjoint train windows over the observation tensor. -/
def findTrainWindows (obs : Array ObsRow) : Array (Nat × Nat) := Id.run do
  let T := obs.size
  if T == 0 then return #[]
  let mut tag : Array Tag := (List.replicate T Tag.unknown).toArray
  for t in [0:T] do
    match obs[t]!.gps with
    | none => pure ()
    | some g => tag := tag.set! t (if g.speedKmh ≥ V_TRAIN_AVG_KMH then Tag.train else Tag.notTrain)
  -- Bracketed-displacement pass: a gap between observed fixes implying train
  -- velocity marks the whole gap (and its boundaries) as train.
  let mut lastObs : Int := -1
  for t in [0:T] do
    match obs[t]!.gps with
    | none => pure ()
    | some right =>
      if lastObs == -1 || lastObs == (t : Int) - 1 then
        lastObs := (t : Int)
      else
        match obs[lastObs.toNat]!.gps with
        | none => lastObs := (t : Int)
        | some left =>
          let elapsedH := (t.toFloat - lastObs.toNat.toFloat) / 60
          let distKm := haversineMeters left.lat left.lon right.lat right.lon / 1000
          if fge (distKm / max elapsedH (1.0 / 3600)) V_TRAIN_AVG_KMH then
            for k in [lastObs.toNat:t + 1] do tag := tag.set! k Tag.train
          lastObs := (t : Int)
  return extractWindows obs tag 0

-- Parity with the real `findTrainWindows` (windows from Node/V8).
private def mk (i : Nat) (lat lon : Float) (spd : Option Float) : ObsRow :=
  { ts := 1000 + (i : Int) * 60, gps := spd.map (fun s => ⟨lat, lon, s⟩), hr := none, cadence := none,
    hourLocal := 0, dayOfWeekLocal := 0, inBed := false, roadDistM := none, railDistM := none,
    reacquireAgeMin := none, prevGpsFix := none, nextGpsFix := none }

private def obsA : Array ObsRow := #[
  mk 0 51.50 (-0.10) (some 3), mk 1 51.50 (-0.10) (some 4), mk 2 51.50 (-0.10) (some 5),
  mk 3 51.51 (-0.11) (some 30), mk 4 51.52 (-0.12) (some 35), mk 5 51.53 (-0.13) (some 32),
  mk 6 51.54 (-0.14) (some 28), mk 7 51.55 (-0.15) (some 26),
  mk 8 51.55 (-0.15) (some 4), mk 9 51.55 (-0.15) (some 3)]
private def obsB : Array ObsRow := #[
  mk 0 51.50 (-0.10) (some 2),
  mk 1 0 0 none, mk 2 0 0 none, mk 3 0 0 none, mk 4 0 0 none,
  mk 5 51.58 (-0.05) (some 2), mk 6 51.58 (-0.05) (some 3)]
private def obsC : Array ObsRow := #[
  mk 0 51.5 (-0.1) (some 3), mk 1 51.5 (-0.1) (some 4), mk 2 51.5 (-0.1) (some 2), mk 3 51.5 (-0.1) (some 5)]

#guard findTrainWindows obsA == #[(3, 7)]   -- observed train run mins 3–7
#guard findTrainWindows obsB == #[(0, 5)]   -- bracketed-displacement tube ride
#guard findTrainWindows obsC == #[]         -- all slow walking

end Verified.Hsmm.TrainWindows
