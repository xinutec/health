import Verified.Hsmm.Emissions
import Verified.Hsmm.Observation
import Verified.Hsmm.Duration
import Verified.Hsmm.SegmentEvidence
import Verified.Hsmm.StopCalls
import Verified.Hsmm.Packed
/-!
# Segment-level emissions

Heart rate and fix presence are properties of a stretch, not of a minute:
on the narrated days a minute's heart rate correlates 0.8 with the next one's,
and a stay's fix share is almost all or nothing (indoors none, outdoors all).
Scored minute by minute as independent draws, a small bias in either compounds
with a segment's length without bound, and a long stay at a heart rate a few
beats nearer a vehicle's mean decodes as a ride.

Here each is scored under a model of how it is generated:

* **Heart rate.** The segment's mean is a draw around the mode's mean (spread
  `hrTau`), the minutes scatter around the segment's mean (`sigmaW`), and
  neighbouring minutes are correlated (`rho`), which shrinks the minutes to
  `nEff = n·(1−ρ)/(1+ρ)` independent ones. The marginal likelihood of the
  segment's minutes has a closed form in their count, sum and sum of squares.
  Asleep minutes keep the per-minute term (`Emissions`).
* **Fix presence** switches between regimes (indoors none, outdoors every
  minute), so it is part of a chain per mode (`obsMinute`): a regime change
  costs one switch, not the segment. Without a chain for the mode, the
  segment's fix share is a draw from Beta(`fixA`, `fixB`) and its sequence
  scores the beta-binomial's `B(k+a, n−k+b) / B(a, b)` — which reads a stay
  that goes from dark to lit as two stays, and splits it.
* **Net displacement** between the fixes bracketing the segment: a ride's net
  speed is lognormal, a stay's displacement in metres is lognormal, and every
  mode keeps a share `eps` spread evenly over net speeds up to `uMaxKmh` (a
  round trip, a bad fix), so the term is evidence and never a veto. It takes
  the place of `SegmentEvidence` for the modes it has parameters for.

Parameters are fitted on the narrated runs. A mode with none asserts nothing.
-/

namespace Verified.Hsmm.SegmentEmission

open Verified.Hsmm.Emissions (Mode)
open Verified.Hsmm.Observation (ObsRow)

private def ZERO : Float := 0
private def ONE : Float := 1
private def HALF : Float := 0.5
private def TWO : Float := 2
/-- The top of the outlier share's even spread of net speeds (km/h). -/
def DEFAULT_U_MAX_KMH : Float := 300
private def KM_M : Float := 1000
private def MIN_PER_H : Float := 60

structure ModeParams where
  hrMean : Float
  hrTau : Float
  fixA : Float
  fixB : Float
  deriving Inhabited

/-- A mode's net displacement: lognormal `(mu, sigma)` in log-space — of net
    speed in km/h for a ride, of displacement in metres for a stay — and the
    share `eps` outside it. -/
structure DispParams where
  mu : Float
  sigma : Float
  eps : Float
  deriving Inhabited

/-- Asleep heart rate as a segment-level random effect (`Params.asleep`). -/
structure SleepParams where
  hrMean : Float
  hrTau : Float
  sigmaW : Float
  rho : Float
  /-- The spread of a night's lag-1 heart-rate differences. Set, the night's
      level DRIFTS: the term is the night mean's prior and the differences'
      likelihood, and a night is not cheaper split. Zero: one constant level
      per segment, the form before. -/
  diffSd : Float := ZERO
  deriving Inhabited

/-- The journey state's parameters (`Params.journey`). -/
structure JourneyParams where
  /-- The longest journey the inner pass considers, in minutes; a longer one
      decodes as two with a stay between. A table size, not a behaviour: a
      journey's length is priced by its fitted duration prior, and this bound
      is set so that no decoded journey reaches it — the decode corpus checks
      the longest decoded journey against it, so a binding bound is a loud
      failure there, never a trip silently scored in pieces. The sweep's cost
      grows with its square, which is why it is not simply large. -/
  maxJ : Nat
  /-- `log P(mode)` of a journey's first leg, per leg mode. -/
  firstLeg : List (Mode × Float)
  /-- `log P(mode)` of a journey's last leg, per leg mode. -/
  lastLeg : List (Mode × Float)
  /-- `log P(a journey continues into another)`: a journey longer than `maxJ`
      decodes as two back to back at this price; `−∞` forbids it. -/
  continueLog : Float := Verified.FloatConst.negInf
  /-- The platform wait as a leg (S1): on when the record fits a wait
      duration (`durationFits.wait`). -/
  wait : Bool := false
  /-- A train leg's evidence at the stations it passes (`StopCalls`): on when
      the record fits it (`journey.stops`). -/
  stops : Option Verified.Hsmm.StopCalls.Params := none
  deriving Inhabited

/-- The train generator's evidence at a train leg's first minute, fitted
    (`fitTrainLine`) at the narrated legs' first minutes:

* `vouchedShare`: `P(the generator vouches the ride's own line)`; a vouched
  line scores `log vouchedShare`, the others share the rest evenly. Vouched
  lines share the station pair the generator found, so the decode tells them
  apart by their own evidence and the chain names the line — a best path sees
  one line, where a split among them would charge it `log v`.
* `covered` / `uncovered`: `log P(covered | a train leg starts) − log
  P(covered | a leg of another mode starts)`, and the same uncovered — the
  generator's coverage as evidence of the mode, once per leg (per minute it
  would count one window many times). -/
structure TrainLine where
  vouchedShare : Float
  covered : Float
  uncovered : Float
  deriving Inhabited

/-- `Params.position`: one observation model of a fix for every state, fitted
    on the narrated stays (`tests/golden/fits/instruments/hr-level/strays3.py`,
    `spotfit.py`). A fix is the true position plus noise, per axis a Gaussian
    scale mixture: the core at `lam·(7² + accuracy²)`; a share `e1` of local
    scatter (another desk, indoor multipath: uniform within `r1` metres, here
    the Gaussian of its variance `r1²/4`); a share `e2` of far strays within
    `r2`; a share `e3` anywhere within `r3`, so one wild reading lowers every
    hypothesis and rules none out. A stay's spot moves with chance `rho` a
    minute, by a 2-D Gaussian of `tm` metres. -/
structure PositionParams where
  lam : Float
  e1 : Float
  r1 : Float
  e2 : Float
  r2 : Float
  e3 : Float
  r3 : Float
  rho : Float
  tm : Float
  deriving Inhabited

/-- Where a stay's spot is expected before its first fix: around a listed
    place's pin at variance `v0`, or where the last fix before left him. -/
inductive SpotStart where
  | pin (x y v0 : Float)
  | placeless
  deriving Inhabited
/-- `Params.hrLevel`: `x = m + β·a + L + u` — the heart rate follows the
    recent steps `a` (each minute's steps over the last `ACTIVITY_LAGS`,
    weighted `e^{−k/ta}`), the level `L` an AR(1) of stationary spread `tau`
    and lag-1 `rl`, the noise `u` one of `su` and `phi`. With the steps
    explaining it, a walk's level is a stay's (the narrated runs: 80.6 bpm
    against 81.2), so the heart rate no longer counts the steps the cadence
    already does. -/
structure HrLevel where
  tau : Float
  rl : Float
  su : Float
  phi : Float
  beta : Float := 0
  ta : Float := 1
  deriving Inhabited

/-- The minutes of steps a heart rate answers to, this one included. -/
def ACTIVITY_LAGS : Nat := 6

structure Params where
  sigmaW : Float
  rho : Float
  byMode : List (Mode × ModeParams)
  disp : List (Mode × DispParams) := []
  uMaxKmh : Float := DEFAULT_U_MAX_KMH
  /-- A minute's speed is the mode's Gaussian with this share of outliers spread
      evenly over 0–`uMaxKmh` (a fix that jumped): one bad fix must not outvote
      the steps and the minutes around it. -/
  speedEps : List (Mode × Float) := []
  /-- The spread of a stay's fixes about its centre, metres, fitted on the
      narrated stays; `none` keeps `PLACE_RADIUS_M`. -/
  centreSigmaM : Option Float := none
  /-- A stay's minute about its LISTED place (`Emissions.placeTermWith`): the
      width, metres, and the share of minutes anywhere, both fitted on the
      narrated stays' minutes; `none` keeps `placeTerm`'s hand width and floor. -/
  placeSigmaM : Option Float := none
  placeEps : Option Float := none
  /-- The pair across a boundary as an exponential of
      this mean (km/h, fitted on the narrated boundaries) instead of uniform. -/
  pairBoundaryMeanKmh : Option Float := none
  /-- The boundary pair's outlier share, uniform over 0–`uMaxKmh`. -/
  pairBoundaryEps : Option Float := none
  /-- A minute as one of three classes — no fix, a fix within `RAIL_NEAR_M` of a
      railway, a fix elsewhere — scored given the minute before by a 3×3 chain
      per mode (rows: the class before). It carries fix presence and rail
      adjacency together; a mode it lists is not scored by the segment's
      beta-binomial. -/
  obsChain : List (Mode × Array (Array Float)) := []
  /-- Asleep minutes' heart rate per segment, one physiology for every state:
      the night's mean a draw around `hrMean` (spread `hrTau`), the minutes
      around it (`sigmaW`, lag-1 `rho`). Replaces the per-minute asleep term,
      whose mean depended on the state (a known place's 58, any other's own),
      so a night at Home wanted to become a placeless stay at waking. -/
  asleep : Option SleepParams := none
  /-- A stay at no listed place has a centre: a latent with a prior from where
      the listed places are — a Gaussian of this bandwidth (metres) around each
      — integrated out once per segment (`centreScore`). Replaces the
      per-minute off-network term, which charged a per-segment fact on every
      lit minute and so grew with the stay's length. -/
  unlistedCentre : Option Float := none
  /-- Moving about inside the listed place a stay is at
      (`Assemble.stayMoveTable`): the chance a still minute is followed by a
      moving one, and a moving one by another. A spell comes back (the stay
      begins and ends still); a moving minute's steps are scored as a walk's;
      the place, the position and the levels stay the stay's. -/
  stayMove : Option (Float × Float) := none
  /-- A minute's fix may be a far stray (`strayShares`): the spread a fix
      keeps from the line between its lit neighbours, `λ·(7² + accuracy²)`
      plus `κ`·their speed·the gap, the share of strays and the range they
      fall in — fitted on the narrated minutes. A stray carries no position:
      the position sums weigh each fix by its share of not being one. -/
  strayFix : Option (Float × Float × Float × Float) := none
  /-- A stay at a LISTED place has a centre too, drawn around the place's pin
      (`listedCentreScore`): the spread a visit's centre sits off it is
      scaled-inverse-χ² with these `(ν₀, t₀ metres)`, fitted over the mined
      places' visits, and updated by the place's own (`visitSpread`).
      Replaces the per-minute place term's hand width. -/
  listedCentre : Option (Float × Float) := none
  /-- Every state scores every fix as a density of it, under one noise model
      (`PositionParams`), given the fix before: a stay from its spot
      (`spotTable`), a moving state from the fix before at its speed in any
      direction (`ringLog`). Replaces, for every state, the pair speeds, the
      boundary pair, the stay's integrated centre, the listed place's
      per-minute term, the dark minutes' gap and feasibility terms and the
      net displacement, which each score the same fixes again. Needs
      `listedCentre` (where a listed place's visits are). -/
  position : Option PositionParams := none
  /-- The awake heart rate as a level that drifts and returns to the mode's
      own (`hrLevelTable`): the level's spread about the mode's mean `τ` and
      its lag-1 correlation, and the minute's own noise about the level `σu`
      and its lag-1 correlation — fitted by maximum likelihood on the
      narrated runs. Replaces one constant level per segment, under which
      a long stay's drift (first half against second over 38 narrated stays
      of four hours or more: sd 6.3 bpm, where a constant allows 2–3) paid
      for splitting it. -/
  hrLevel : Option HrLevel := none
  /-- A segment's first and last minute are shared with the segments beside
      it, so their steps are a part-minute's: per mode, the zero-step share
      and the stepped minutes' mean and spread of the narrated segments' edge
      minutes, scored there in place of the mode's interior cadence
      (`Assemble.edgeCadenceAt`). A mode not listed keeps its interior. -/
  edgeCadence : List (Mode × (Float × Float × Float)) := []
  /-- A walk's pauses (`Assemble.walkPauseTable`): the chance a walking minute
      is followed by a still one, and a still one by another; a walk begins
      and ends walking. -/
  walkPause : Option (Float × Float) := none
  /-- What the train generator knows at a train's start (`TrainLine`): with it
      a transition into a train gives the even split over train states back,
      and the entry scores the line and the coverage. Without it a train's
      line is the even split alone. -/
  trainLine : Option TrainLine := none
  /-- The journey state (`Assemble` adds one when this is set): a journey is
      one segment of the outer trellis whose cell is the best leg path over
      its window (`Journey`), with the heart-rate and fix-presence level drawn
      once per journey (`byMode`'s `unknown` entry) and its duration from the
      `unknown` duration fit. `firstLeg`/`lastLeg`: `log P(mode)` of a
      journey's first and last leg, narrated. -/
  journey : Option JourneyParams := none
  deriving Inhabited

/-- Prefix sums over the day's minutes: awake heart-rate count, sum and sum of
    squares, and the count of minutes with a fix. Index `i` covers `[0, i)`. -/
structure Prefix where
  hrN : Array Float
  hrSum : Array Float
  hrSq : Array Float
  fixN : Array Float
  /-- The same three for the asleep minutes. -/
  bedN : Array Float := #[ZERO]
  bedSum : Array Float := #[ZERO]
  bedSq : Array Float := #[ZERO]
  /-- The lit minutes' positions in local metres, each weighted by the inverse
      of its variance (`withPositions`): the weights, the weighted x and y,
      and the weighted squared radius. -/
  posW : Array Float := #[ZERO]
  posWX : Array Float := #[ZERO]
  posWY : Array Float := #[ZERO]
  posWRR : Array Float := #[ZERO]
  /-- The awake runs — maximal stretches of minutes not in bed — as
      `[runStart, runEnd)` minute indices, and per minute the run holding it
      (for a minute in bed, the run after). A sleep resets the awake
      heart-rate level: a segment's level term is one per run it spans
      (`Stats.runs`), not one over them all. -/
  runStart : Array Nat := #[]
  runEnd : Array Nat := #[]
  runOf : Array Nat := #[]
  /-- The asleep minutes' squared lag-1 heart-rate differences and their
      count, cumulative over the pair ending at each minute. -/
  bedDiffSq : Array Float := #[ZERO]
  bedDiffN : Array Float := #[ZERO]
  /-- With `hrLevel`: per segment `(d, e)` at `triOff maxD e + d − 1`, the
      awake heart rate's likelihood as a Gaussian in the mode's mean `m` —
      `R − (m − μ̂)² / (2V)` — as `R`, `μ̂` and `V` (`V = 0`: no awake minute
      with a heart rate). Empty without it. -/
  hrMaxD : Nat := 0
  hrR : FloatArray := FloatArray.empty
  hrMu : FloatArray := FloatArray.empty
  hrV : FloatArray := FloatArray.empty
  deriving Inhabited

private def METRES_PER_DEGREE : Float := 111320
private def RADIANS_PER_DEGREE : Float := 0.017453292519943295

/-- A point in metres east and north of `ref`, flat around it. -/
def localXY (ref : Float × Float) (lat lon : Float) : Float × Float :=
  ((lon - ref.2) * METRES_PER_DEGREE * Float.cos (ref.1 * RADIANS_PER_DEGREE),
   (lat - ref.1) * METRES_PER_DEGREE)

/-- The position prefix sums: each lit minute's aggregate at weight
    `1 / (sigmaM² + accuracy²)`, the accuracy its own reported one or
    `accDefaultM`. -/
private def STRAY_BASE_M : Float := 7
/-- How far apart in minutes a fix's neighbours may be to judge it. -/
private def STRAY_GAP_MIN : Nat := 10

/-- Per minute, the share of its fix that is not a far stray: judged against
    the line between the nearest lit minutes either side (within
    `STRAY_GAP_MIN`), its residual scored under the fitted inlier spread
    against the strays' uniform range. `1` without the record's `strayFix`,
    without a fix, or without a neighbour on both sides. -/
def strayShares (obs : Array ObsRow) (ref : Float × Float) (accDefaultM : Float)
    (h : Option (Float × Float × Float × Float)) : Array Float := Id.run do
  let T := obs.size
  let some (lam, kap, eps, range) := h | return Array.replicate T ONE
  let xy : Array (Option (Float × Float × Float)) := obs.map fun o =>
    o.gps.map fun g => let (x, y) := localXY ref g.lat g.lon; (x, y, g.accuracyM.getD accDefaultM)
  let mut prev : Array (Option Nat) := Array.replicate T none
  let mut last : Option Nat := none
  for t in [0:T] do
    prev := prev.set! t last
    if (xy[t]!).isSome then last := some t
  let mut next : Array (Option Nat) := Array.replicate T none
  last := none
  for i in [0:T] do
    let t := T - 1 - i
    next := next.set! t last
    if (xy[t]!).isSome then last := some t
  let mut out := Array.replicate T ONE
  for t in [0:T] do
    match xy[t]!, prev[t]!, next[t]! with
    | some (x, y, acc), some tp, some tn =>
      if t - tp > STRAY_GAP_MIN || tn - t > STRAY_GAP_MIN then continue
      match xy[tp]!, xy[tn]! with
      | some (xp, yp, _), some (xn, yn, _) =>
        let span := Verified.FloatConst.natToFloat (tn - tp)
        let u := Verified.FloatConst.natToFloat (t - tp) / span
        let px := xp + u * (xn - xp)
        let py := yp + u * (yn - yp)
        let r := Float.sqrt ((x - px) * (x - px) + (y - py) * (y - py))
        let speed := Float.sqrt ((xn - xp) * (xn - xp) + (yn - yp) * (yn - yp)) / span
        let gap := Verified.FloatConst.natToFloat (max (t - tp) (tn - t))
        let v := lam * (STRAY_BASE_M * STRAY_BASE_M + acc * acc) + (kap * speed * gap) * (kap * speed * gap)
        let fin := (ONE - eps) * r / v * Float.exp (ZERO - r * r / (TWO * v))
        let fout := if r < range then eps * TWO * r / (range * range) else ZERO
        if fin + fout > ZERO then out := out.set! t (fin / (fin + fout))
      | _, _ => pure ()
    | _, _, _ => pure ()
  return out

def withPositions (p : Prefix) (obs : Array ObsRow) (ref : Float × Float)
    (sigmaM accDefaultM : Float) (keep : Array Float := #[]) : Prefix := Id.run do
  let mut w := #[ZERO]
  let mut wx := #[ZERO]
  let mut wy := #[ZERO]
  let mut wrr := #[ZERO]
  for (o, t) in obs.zipIdx do
    let (dw, dx, dy, drr) := match o.gps with
      | some g =>
        let (x, y) := localXY ref g.lat g.lon
        let acc := g.accuracyM.getD accDefaultM
        let k := keep.getD t ONE / (sigmaM * sigmaM + acc * acc)
        (k, k * x, k * y, k * (x * x + y * y))
      | none => (ZERO, ZERO, ZERO, ZERO)
    w := w.push (w.back?.getD ZERO + dw)
    wx := wx.push (wx.back?.getD ZERO + dx)
    wy := wy.push (wy.back?.getD ZERO + dy)
    wrr := wrr.push (wrr.back?.getD ZERO + drr)
  return { p with posW := w, posWX := wx, posWY := wy, posWRR := wrr }

/-- The listed places in local metres: the centres of the unlisted place's
    prior (`centreScore`). -/
def placesLocal (ref : Float × Float) (coords : List (Float × Float)) : Array (Float × Float) :=
  (coords.map fun (lat, lon) => localXY ref lat lon).toArray

/-- The day's first fix, the origin of the local metres. -/
def refOf (obs : Array ObsRow) : Float × Float :=
  (obs.findSome? (·.gps.map fun g => (g.lat, g.lon))).getD (ZERO, ZERO)

def prefixOf (obs : Array ObsRow) : Prefix := Id.run do
  let mut p : Prefix := { hrN := #[ZERO], hrSum := #[ZERO], hrSq := #[ZERO], fixN := #[ZERO] }
  let mut prevBed : Option Float := none
  for o in obs do
    let (n, s, q, bn, bs, bq) := match o.hr with
      | some h => if o.inBed then (ZERO, ZERO, ZERO, ONE, h, h * h) else (ONE, h, h * h, ZERO, ZERO, ZERO)
      | none => (ZERO, ZERO, ZERO, ZERO, ZERO, ZERO)
    let (dq, dn) := match o.hr, prevBed with
      | some h, some hp => if o.inBed then ((h - hp) * (h - hp), ONE) else (ZERO, ZERO)
      | _, _ => (ZERO, ZERO)
    prevBed := match o.hr with | some h => if o.inBed then some h else none | none => none
    p := { p with
           bedDiffSq := p.bedDiffSq.push (p.bedDiffSq.back?.getD 0 + dq),
           bedDiffN := p.bedDiffN.push (p.bedDiffN.back?.getD 0 + dn),
           hrN := p.hrN.push (p.hrN.back?.getD 0 + n), hrSum := p.hrSum.push (p.hrSum.back?.getD 0 + s),
           hrSq := p.hrSq.push (p.hrSq.back?.getD 0 + q),
           fixN := p.fixN.push (p.fixN.back?.getD 0 + (if o.gps.isSome then ONE else ZERO)),
           bedN := p.bedN.push (p.bedN.back?.getD 0 + bn), bedSum := p.bedSum.push (p.bedSum.back?.getD 0 + bs),
           bedSq := p.bedSq.push (p.bedSq.back?.getD 0 + bq) }
  -- The awake runs.
  let mut runStart : Array Nat := #[]
  let mut runEnd : Array Nat := #[]
  let mut runOf : Array Nat := #[]
  let mut open_ := false
  for (o, t) in obs.zipIdx do
    if o.inBed then
      if open_ then
        runEnd := runEnd.push t
        open_ := false
      runOf := runOf.push runStart.size
    else
      if !open_ then
        runStart := runStart.push t
        open_ := true
      runOf := runOf.push (runStart.size - 1)
  if open_ then runEnd := runEnd.push obs.size
  return { p with runStart, runEnd, runOf }

private def SPOT_BASE_M : Float := 7
private def PI_F : Float := 3.141592653589793
private def FOUR : Float := 4
/-- Metres a minute in a km/h. -/
private def M_PER_MIN_PER_KMH : Float := 1000 / 60

/-- A fix's core noise variance per axis: `lam·(7² + accuracy²)`. -/
def coreVar (pp : PositionParams) (acc : Float) : Float :=
  pp.lam * (SPOT_BASE_M * SPOT_BASE_M + acc * acc)

/-- The noise mixture's components, `(share, variance per axis beyond the
    core)`, the core first. -/
def noiseComps (pp : PositionParams) : Array (Float × Float) :=
  #[(ONE - pp.e1 - pp.e2 - pp.e3, ZERO), (pp.e1, pp.r1 * pp.r1 / FOUR),
    (pp.e2, pp.r2 * pp.r2 / FOUR), (pp.e3, pp.r3 * pp.r3 / FOUR)]

/-- `log Σ exp xs`, from the largest so nothing underflows. -/
def logSumExp (xs : Array Float) : Float :=
  let m := xs.foldl max Verified.FloatConst.negInf
  if m == Verified.FloatConst.negInf then m else
  m + Float.log (xs.foldl (fun a x => a + Float.exp (x - m)) ZERO)

/-- An isotropic 2-D Gaussian's log density at squared distance `d2`, per-axis
    variance `v`. -/
@[inline] def logN2 (d2 v : Float) : Float :=
  ZERO - Float.log (TWO * PI_F * v) - d2 / (TWO * v)

private def I0_KNEE : Float := 3.75
private def I0_A : Array Float := #[1.0, 3.5156229, 3.0899424, 1.2067492, 0.2659732, 0.0360768, 0.0045813]
private def I0_B : Array Float :=
  #[0.39894228, 0.01328592, 0.00225319, -0.00157565, 0.00916281, -0.02057706, 0.02635537, -0.01647633, 0.00392377]

/-- `Σ cᵢ uⁱ` by Horner's rule. -/
private def horner (c : Array Float) (u : Float) : Float :=
  c.foldr (fun ci acc => ci + u * acc) ZERO

/-- `e^(−x)·I₀(x)` for `x ≥ 0`, the modified Bessel function scaled: Abramowitz
    and Stegun 9.8.1 and 9.8.2, error below 2·10⁻⁷. -/
def i0e (x : Float) : Float :=
  if x < I0_KNEE then
    let t := x / I0_KNEE
    Float.exp (ZERO - x) * horner I0_A (t * t)
  else horner I0_B (I0_KNEE / x) / Float.sqrt x

#guard (i0e 0 - 1).abs < 1e-9
#guard (i0e 1 - 0.4657596).abs < 1e-6
#guard (i0e 10 - 0.1278333).abs < 1e-6

/-- A speed density over metres a minute as a quadrature: midpoints and their
    weights (density × width), the weights summing to one. -/
structure SpeedQuad where
  s : FloatArray
  w : FloatArray
  deriving Inhabited

private def QUAD_FINE_TOP : Float := 20
private def QUAD_FINE : Nat := 40
private def QUAD_COARSE : Nat := 160

/-- A speed density from its unnormalised shape `f` over metres a minute,
    with a share `eps` spread evenly up to `uMaxKmh`: fine near a standstill,
    log-spaced above. -/
def speedQuadOf (f : Float → Float) (eps uMaxKmh : Float) : SpeedQuad := Id.run do
  let top := uMaxKmh * M_PER_MIN_PER_KMH
  let mut edges : Array Float := #[]
  for i in [0:QUAD_FINE] do
    edges := edges.push (QUAD_FINE_TOP * Verified.FloatConst.natToFloat i / Verified.FloatConst.natToFloat QUAD_FINE)
  let ratio := Float.log (top / QUAD_FINE_TOP) / Verified.FloatConst.natToFloat QUAD_COARSE
  for i in [0:QUAD_COARSE + 1] do
    edges := edges.push (QUAD_FINE_TOP * Float.exp (ratio * Verified.FloatConst.natToFloat i))
  let mut mids := FloatArray.empty
  let mut raw := FloatArray.empty
  let mut widths := FloatArray.empty
  for i in [0:edges.size - 1] do
    let lo := edges[i]!
    let hi := edges[i + 1]!
    let mid := (lo + hi) / TWO
    mids := mids.push mid
    widths := widths.push (hi - lo)
    raw := raw.push (f mid * (hi - lo))
  let tot := raw.foldl (· + ·) ZERO
  let mut w := FloatArray.empty
  for i in [0:mids.size] do
    w := w.push ((ONE - eps) * (if tot > ZERO then raw[i]! / tot else ZERO) + eps * widths[i]! / top)
  return { s := mids, w }

/-- A mode's speed: a moving Gaussian (`meanKmh`, `sdKmh`) cut at zero, a
    share `stop` standing still (half-normal, `stopSdKmh`), and the share
    `eps` of outliers. -/
def modeSpeedQuad (meanKmh sdKmh stop stopSdKmh eps uMaxKmh : Float) : SpeedQuad :=
  let m := meanKmh * M_PER_MIN_PER_KMH
  let sd := max (sdKmh * M_PER_MIN_PER_KMH) ONE
  let ssd := max (stopSdKmh * M_PER_MIN_PER_KMH) ONE
  speedQuadOf (fun s =>
    (ONE - stop) * Float.exp (ZERO - (s - m) * (s - m) / (TWO * sd * sd)) / sd
      + stop * TWO * Float.exp (ZERO - s * s / (TWO * ssd * ssd)) / ssd) eps uMaxKmh

/-- The log density (per m²) of a 2-D displacement of length `r` over `g`
    minutes, the noise `v` per axis: a ring of radius speed × `g` in any
    direction, blurred, over the speed density `q`. -/
def ringLog (q : SpeedQuad) (r g v : Float) : Float := Id.run do
  let lead := ZERO - Float.log (TWO * PI_F * v)
  let mut best := Verified.FloatConst.negInf
  let n := q.s.size
  let mut lg := FloatArray.emptyWithCapacity n
  for i in [0:n] do
    let rho := q.s[i]! * g
    let z := r * rho / v
    let x := Float.log q.w[i]! + lead - (r - rho) * (r - rho) / (TWO * v) + Float.log (i0e z)
    lg := lg.push x
    best := max best x
  if best == Verified.FloatConst.negInf then return best
  let mut acc := ZERO
  for i in [0:n] do
    acc := acc + Float.exp (lg[i]! - best)
  return best + Float.log acc

/-- A fix moved `r` metres over `g` minutes from the fix before, at the speed
    density `q`: the ring under both fixes' core noise (`vA`, `vB`), each
    share of the mixture widening it. -/
def moveLog (pp : PositionParams) (q : SpeedQuad) (r g vA vB : Float) : Float :=
  logSumExp ((noiseComps pp).map fun (w, ex) => Float.log w + ringLog q r g (vA + vB + ex))

/-- A fix's log density about a spot expected at squared distance `d2`, the
    spot's own spread `V` per axis, the fix's core `R`. -/
def fixLog (pp : PositionParams) (d2 V R : Float) : Float :=
  logSumExp ((noiseComps pp).map fun (w, ex) => Float.log w + logN2 d2 (V + R + ex))

/-- Per minute, the last lit minute before it. -/
def prevLit (obs : Array ObsRow) : Array (Option Nat) := Id.run do
  let mut out : Array (Option Nat) := #[]
  let mut last : Option Nat := none
  for (o, t) in obs.zipIdx do
    out := out.push last
    if o.gps.isSome then last := some t
  return out

/-- The lit minutes in local metres, with each fix's core noise. -/
def fixesLocal (obs : Array ObsRow) (ref : Float × Float) (accDefaultM : Float) (pp : PositionParams) :
    Array (Option (Float × Float × Float)) :=
  obs.map fun o => o.gps.map fun g =>
    let (x, y) := localXY ref g.lat g.lon; (x, y, coreVar pp (g.accuracyM.getD accDefaultM))

/-- The log density of a displacement of squared length `d2` over `g` minutes
    for a phone that stayed: the spot still, or moved at least once in the
    `g` minutes (a stay's rare move, which redraws the spot inside the
    place, so its spread does not grow with the gap), under both fixes'
    noise. -/
def stillLog (pp : PositionParams) (d2 g vA vB : Float) : Float :=
  let still := Float.exp (g * Float.log (ONE - pp.rho))
  -- A move redraws the spot inside the place: however many, one spread.
  let moved := pp.tm * pp.tm
  logSumExp ((noiseComps pp).foldl (fun acc (w, ex) =>
    acc.push (Float.log (still * w) + logN2 d2 (vA + vB + ex))
      |>.push (if still < ONE then Float.log ((ONE - still) * w) + logN2 d2 (moved + vA + vB + ex)
               else Verified.FloatConst.negInf)) #[])

/-- Per minute, a moving state's log density of its fix given the fix before
    (any gap), at speed `q`: the ring over the whole gap, as if the state had
    moved through all of it; the day's first fix at `broad`, an unlit minute
    `0`. A segment that does not own all of a gap at its edge corrects it
    (`gapTables`, `Assemble.gapEdge`). -/
def moveIncrements (xy : Array (Option (Float × Float × Float))) (prev : Array (Option Nat))
    (pp : PositionParams) (q : SpeedQuad) (broad : Array Float) : Array Float :=
  (Array.range xy.size).map fun t =>
    match xy[t]!, prev[t]! with
    | none, _ => ZERO
    | some _, none => broad.getD t ZERO
    | some (x, y, R), some tp => match xy[tp]! with
      | some (xp, yp, Rp) =>
        moveLog pp q (Float.sqrt ((x - xp) * (x - xp) + (y - yp) * (y - yp)))
          (Verified.FloatConst.natToFloat (t - tp)) R Rp
      | none => broad.getD t ZERO

/-- Per lit minute `n` whose fix follows a gap (`g = n − prev n > 1`): the
    ring of its displacement over `k` minutes of motion, `k = 1 … g`
    (`ring[k]`), and its density had he stayed through the gap (`still`).
    A moving segment that owns only `k` of a gap's minutes scores its
    displacement over those: the motion was in its own minutes. -/
structure GapTable where
  ring : FloatArray := FloatArray.empty
  still : Float := 0
  deriving Inhabited

def gapTables (xy : Array (Option (Float × Float × Float))) (prev : Array (Option Nat))
    (pp : PositionParams) (q : SpeedQuad) : Array GapTable :=
  (Array.range xy.size).map fun n =>
    match xy[n]!, prev[n]! with
    | some (x, y, R), some tp =>
      if n - tp ≤ 1 then default else
      match xy[tp]! with
      | some (xp, yp, Rp) =>
        let d2 := (x - xp) * (x - xp) + (y - yp) * (y - yp)
        let r := Float.sqrt d2
        let g := n - tp
        let ring := (List.range (g + 1)).foldl (fun acc k =>
          acc.push (if k == 0 then ZERO else moveLog pp q r (Verified.FloatConst.natToFloat k) R Rp)) FloatArray.empty
        { ring, still := stillLog pp d2 (Verified.FloatConst.natToFloat g) R Rp }
      | none => default
    | _, _ => default

/-- Per stay segment `(d, e)` at `triOff maxD e + d − 1`, the log density of
    its fixes: from each start, an assumed-density filter over the spot,
    collapsed to one Gaussian per minute. A fix is the spot plus the noise
    mixture; since the last lit minute the spot stayed or moved at least once.
    Every stay's spot starts given the last fix before: reached from it at
    the boundary's mean speed `reachM` (metres a minute), and for a listed
    place inside its footprint as well; with the boundary's outlier share
    `reachEps` from anywhere (the footprint alone, or the broad prior
    `broad`). So a listed and a placeless stay are compared on the same
    question: where is the first fix, given where he was. -/
def spotTable (xy : Array (Option (Float × Float × Float))) (prev : Array (Option Nat))
    (pp : PositionParams) (start : SpotStart) (reachM reachEps : Float) (broad : Array Float)
    (maxD : Nat) : FloatArray := Id.run do
  let T := xy.size
  let mut out := Verified.FloatConst.floats (Verified.Hsmm.triOff maxD T) ZERO
  let tm2 := pp.tm * pp.tm
  let comps := noiseComps pp
  for s0 in [0:T] do
    let mut mx := ZERO
    let mut my := ZERO
    let mut V := ZERO
    let mut seen := false
    let mut dark := 0
    let mut tot := ZERO
    for d in [1:maxD + 1] do
      let e := s0 + d - 1
      if e ≥ T then break
      match xy[e]! with
      | none => dark := dark + 1
      | some (x, y, R) =>
        if !seen then
          -- Where the spot starts, given the last fix before: reached from it
          -- across the boundary (a 2-D Gaussian of the boundary's mean speed
          -- over the gap), and for a listed place inside its footprint too —
          -- the two together, normalised. With the boundary's outlier share
          -- he came from anywhere: the footprint alone, or the broad prior.
          let before : Option (Float × Float × Float) := match prev[s0]! with
            | some tp => match xy[tp]! with
              | some (xp, yp, Rp) =>
                let g := Verified.FloatConst.natToFloat (e - tp)
                some (xp, yp, Rp + reachM * reachM * g * g)
              | none => none
            | none => none
          -- Gaussian starts `(log weight, mean, variance)`, and the broad
          -- prior's share for a placeless spot (the fix where it is).
          let (starts, flat) : Array (Float × Float × Float × Float) × Option Float :=
            match start, before with
            | .pin px py v0, some (xp, yp, vr) =>
              let vs := ONE / (ONE / v0 + ONE / vr)
              (#[(Float.log (ONE - reachEps), vs * (px / v0 + xp / vr), vs * (py / v0 + yp / vr), vs),
                 (Float.log reachEps, px, py, v0)], none)
            | .pin px py v0, none => (#[(ZERO, px, py, v0)], none)
            | .placeless, some (xp, yp, vr) =>
              (#[(Float.log (ONE - reachEps), xp, yp, vr)], some (Float.log reachEps + broad.getD e ZERO))
            | .placeless, none => (#[], some (broad.getD e ZERO))
          let mut m := Verified.FloatConst.negInf
          let mut sw := ZERO
          let mut sx := ZERO
          let mut sy := ZERO
          let mut sq := ZERO
          -- Offsets from the fix itself; the broad share's spot is the fix.
          let parts : Array (Float × Float × Float × Float) := Id.run do
            let mut acc : Array (Float × Float × Float × Float) := #[]
            for (lw, cx, cy, vc) in starts do
              for (w, ex) in comps do
                let kk := vc / (vc + R + ex)
                let d2 := (x - cx) * (x - cx) + (y - cy) * (y - cy)
                acc := acc.push (lw + Float.log w + logN2 d2 (vc + R + ex),
                  (cx - x) * (ONE - kk), (cy - y) * (ONE - kk), vc * (ONE - kk))
            match flat with
            | some lf => acc := acc.push (lf, ZERO, ZERO, R)
            | none => pure ()
            return acc
          for (lm, ax, ay, vv) in parts do
            if lm > m then
              let r := Float.exp (m - lm)
              sw := sw * r + ONE
              sx := sx * r + ax
              sy := sy * r + ay
              sq := sq * r + (vv + (ax * ax + ay * ay) / TWO)
              m := lm
            else
              let wgt := Float.exp (lm - m)
              sw := sw + wgt
              sx := sx + wgt * ax
              sy := sy + wgt * ay
              sq := sq + wgt * (vv + (ax * ax + ay * ay) / TWO)
          tot := tot + m + Float.log sw
          let ox := sx / sw
          let oy := sy / sw
          V := max (sq / sw - (ox * ox + oy * oy) / TWO) ZERO
          mx := x + ox
          my := y + oy
          seen := true
        else
          let d2 := (x - mx) * (x - mx) + (y - my) * (y - my)
          -- The spot since the last lit minute: stayed, or moved.
          let k := Verified.FloatConst.natToFloat (dark + 1)
          let still := Float.exp (k * Float.log (ONE - pp.rho))
          let twoMoves := still < ONE
          -- A move redraws the spot inside the place: however many moves
          -- since the last lit minute, one spread.
          let vMove := V + tm2
          -- One pass over the components (stayed or moved, × the noise
          -- mixture): the log-sum-exp from a running maximum, and the
          -- posterior's moments, each weight taken relative to it.
          let mut m := Verified.FloatConst.negInf
          let mut sw := ZERO
          let mut sx := ZERO
          let mut sy := ZERO
          let mut sq := ZERO
          for j in [0:(if twoMoves then 2 else 1)] do
            let (pm, Vp) := if j == 0 then ((if twoMoves then still else ONE), V) else (ONE - still, vMove)
            for (w, ex) in comps do
              let lm := Float.log (pm * w) + logN2 d2 (Vp + R + ex)
              let kk := Vp / (Vp + R + ex)
              -- The component's posterior mean as an offset from the spot.
              let ax := kk * (x - mx)
              let ay := kk * (y - my)
              let vv := Vp * (ONE - kk)
              if lm > m then
                let r := Float.exp (m - lm)
                sw := sw * r + ONE
                sx := sx * r + ax
                sy := sy * r + ay
                sq := sq * r + (vv + (ax * ax + ay * ay) / TWO)
                m := lm
              else
                let wgt := Float.exp (lm - m)
                sw := sw + wgt
                sx := sx + wgt * ax
                sy := sy + wgt * ay
                sq := sq + wgt * (vv + (ax * ax + ay * ay) / TWO)
          tot := tot + m + Float.log sw
          -- The spot's posterior, collapsed to one Gaussian: its mean, and its
          -- per-axis variance as the mixture's second moment less the mean's.
          let ox := sx / sw
          let oy := sy / sw
          V := max (sq / sw - (ox * ox + oy * oy) / TWO) ZERO
          mx := mx + ox
          my := my + oy
          seen := true
        dark := 0
      out := out.set! (Verified.Hsmm.triOff maxD e + (d - 1)) tot
  return out

-- A still minute is likelier still than walked, a walked one the reverse.
private def ppT : PositionParams := { lam := 0.02, e1 := 0.16, r1 := 60, e2 := 0.02, r2 := 5000, e3 := 0.001, r3 := 600000, rho := 0.03, tm := 30 }
private def walkQ : SpeedQuad := modeSpeedQuad 3.64 1.9 0 1 0.0094 300
#guard fixLog ppT 4 1 1.5 > moveLog ppT walkQ 2 1 1.5 1.5 + 2
#guard moveLog ppT walkQ 70 1 1.5 1.5 > fixLog ppT 4900 1 1.5 + 2
-- A ring is a density: over the plane it integrates to one (a coarse sum).
#guard
  let s := (List.range 400).foldl (fun a i =>
    let r := (Verified.FloatConst.natToFloat i + HALF) * 1
    a + Float.exp (ringLog walkQ r 1 10) * TWO * PI_F * r) ZERO
  (s - 1).abs < 0.05

/-- Per minute, the log density of the placeless stay's prior at its fix:
    a Gaussian of bandwidth `h` around each listed place, averaged — the
    prior `centreScore` integrates. `0` for a minute without a fix. -/
def placelessLogAt (obs : Array ObsRow) (ref : Float × Float) (h : Float)
    (places : Array (Float × Float)) : Array Float :=
  obs.map fun o => match o.gps with
    | none => ZERO
    | some g =>
      if places.isEmpty then ZERO else
      let (x, y) := localXY ref g.lat g.lon
      let v := h * h
      let r2 := fun (p : Float × Float) => (x - p.1) * (x - p.1) + (y - p.2) * (y - p.2)
      let near := places.foldl (fun a p => min a (r2 p)) (r2 places[0]!)
      Float.log (places.foldl (fun a p => a + Float.exp ((near - r2 p) / (TWO * v))) ZERO)
        - near / (TWO * v) - Float.log (TWO * PI_F * v) - Float.log (Verified.FloatConst.natToFloat places.size)
private def LOG_TWO_PI : Float := 1.8378770664093453

/-- `Prefix.hrR`, `hrMu`, `hrV` for every segment of at most `maxD` minutes:
    from each start, a Kalman filter over the level and the noise (`HrLevel`;
    an asleep or unlit minute is unobserved, so a night lets the level wander
    back to its prior), the mode's mean `m` carried as a regression effect —
    every prediction is affine in `m`, so the likelihood is a Gaussian in it
    and one sweep serves every mode. One sweep forward from each start. -/
def hrLevelTable (obs : Array ObsRow) (h : HrLevel) (maxD : Nat) : FloatArray × FloatArray × FloatArray := Id.run do
  let T := obs.size
  let n := Verified.Hsmm.triOff maxD T
  let mut tR := Verified.FloatConst.floats n ZERO
  let mut tMu := Verified.FloatConst.floats n ZERO
  let mut tV := Verified.FloatConst.floats n ZERO
  let tau2 := h.tau * h.tau
  let su2 := h.su * h.su
  let qL := tau2 * (ONE - h.rl * h.rl)
  let qU := su2 * (ONE - h.phi * h.phi)
  -- Each minute's heart rate less what its recent steps explain.
  let wts := (Array.range ACTIVITY_LAGS).map fun k =>
    Float.exp (ZERO - Verified.FloatConst.natToFloat k / h.ta)
  let wSum := wts.foldl (· + ·) ZERO
  let xAdj : Array (Option Float) := (Array.range T).map fun t =>
    match obs[t]? with
    | some o =>
      if o.inBed then none else o.hr.map fun x =>
        let a := (Array.range ACTIVITY_LAGS).foldl (fun acc k =>
          if k > t then acc else
          acc + wts[k]! * (((obs[t - k]?).bind (·.cadence)).getD ZERO)) ZERO
        x - h.beta * a / wSum
    | none => none
  for s0 in [0:T] do
    -- The state's mean `c + g·m`, its covariance `P`, and the sums the
    -- likelihood is read from.
    let mut c0 := ZERO
    let mut c1 := ZERO
    let mut g0 := ZERO
    let mut g1 := ZERO
    let mut p00 := tau2
    let mut p01 := ZERO
    let mut p11 := su2
    let mut sLogF := ZERO
    let mut sAA := ZERO
    let mut sAB := ZERO
    let mut sBB := ZERO
    let mut nObs := ZERO
    for d in [1:maxD + 1] do
      let e := s0 + d - 1
      if e ≥ T then break
      if d > 1 then
        c0 := h.rl * c0
        c1 := h.phi * c1
        g0 := h.rl * g0
        g1 := h.phi * g1
        p00 := h.rl * h.rl * p00 + qL
        p01 := h.rl * h.phi * p01
        p11 := h.phi * h.phi * p11 + qU
      match xAdj[e]? with
      | some (some x) =>
            let f := p00 + TWO * p01 + p11
            let a := x - (c0 + c1)
            let b := ONE + (g0 + g1)
            let k0 := (p00 + p01) / f
            let k1 := (p01 + p11) / f
            sLogF := sLogF + Float.log f
            sAA := sAA + a * a / f
            sAB := sAB + a * b / f
            sBB := sBB + b * b / f
            nObs := nObs + ONE
            c0 := c0 + k0 * a
            c1 := c1 + k1 * a
            g0 := g0 - k0 * b
            g1 := g1 - k1 * b
            let h0 := p00 + p01
            let h1 := p01 + p11
            p00 := p00 - k0 * h0
            p01 := p01 - k0 * h1
            p11 := p11 - k1 * h1
      | _ => pure ()
      if sBB > ZERO then
        let i := Verified.Hsmm.triOff maxD e + (d - 1)
        tR := tR.set! i (ZERO - HALF * (sLogF + nObs * LOG_TWO_PI + sAA - sAB * sAB / sBB))
        tMu := tMu.set! i (sAB / sBB)
        tV := tV.set! i (ONE / sBB)
  return (tR, tMu, tV)

/-- The prefix with its level tables (`hrLevelTable`). -/
def withHrLevel (p : Prefix) (obs : Array ObsRow) (h : HrLevel) (maxD : Nat) : Prefix :=
  let (hrR, hrMu, hrV) := hrLevelTable obs h maxD
  { p with hrMaxD := maxD, hrR, hrMu, hrV }

/-- A segment's sufficient statistics. -/
structure Stats where
  n : Float
  hrN : Float
  hrSum : Float
  hrSq : Float
  fixN : Float
  /-- The asleep minutes' heart-rate count, sum and sum of squares. -/
  bedN : Float := ZERO
  bedSum : Float := ZERO
  bedSq : Float := ZERO
  /-- The lit minutes' weighted positions (`Prefix.posW` and the rest). -/
  posW : Float := ZERO
  posWX : Float := ZERO
  posWY : Float := ZERO
  posWRR : Float := ZERO
  /-- The same weighted sums over the lit minutes just outside the segment
      (the one before it and the one after): where the neighbouring segments
      left the wearer, the anchor. -/
  anchorW : Float := ZERO
  anchorWX : Float := ZERO
  anchorWY : Float := ZERO
  /-- The segment's minutes `[lo, hi)`, for the terms tabulated per state
      (the pair tables). -/
  lo : Nat := 0
  hi : Nat := 0
  /-- The awake heart-rate count, sum and sum of squares of each awake run
      the segment spans, when it spans more than one (`Prefix.runStart`);
      empty otherwise, and the level is one over the segment. -/
  runs : Array (Float × Float × Float) := #[]
  /-- The asleep minutes' squared lag-1 differences and their count, over
      the pairs inside the segment. -/
  bedDiffSq : Float := ZERO
  bedDiffN : Float := ZERO
  /-- `Prefix.hrR`, `hrMu`, `hrV` at the segment; `hrV = 0` without them. -/
  hrR : Float := ZERO
  hrMu : Float := ZERO
  hrV : Float := ZERO
  /-- The same asleep differences with the pair across the segment's start:
      every pair belongs to the segment it ends in, so a boundary hides none
      (`sleepScore` under `position`). -/
  bedDiffSqB : Float := ZERO
  bedDiffNB : Float := ZERO

/-- A prefix array's share of the minute before `[lo, hi)` and the minute
    after it; a minute off the day adds nothing. -/
private def outside (a : Array Float) (lo hi : Nat) : Float :=
  let one := fun (i : Nat) => match a[i]?, a[i + 1]? with
    | some x, some y => y - x
    | _, _ => ZERO
  (if lo == 0 then ZERO else one (lo - 1)) + one hi

/-- The segment of length `d` ending at minute `e`. -/
def statsAt (p : Prefix) (d e : Nat) : Stats :=
  let hi := e + 1
  let lo := hi - d
  let get := fun (a : Array Float) (i : Nat) => a[i]?.getD ZERO
  ⟨Verified.FloatConst.natToFloat d,
   get p.hrN hi - get p.hrN lo, get p.hrSum hi - get p.hrSum lo,
   get p.hrSq hi - get p.hrSq lo, get p.fixN hi - get p.fixN lo,
   get p.bedN hi - get p.bedN lo, get p.bedSum hi - get p.bedSum lo,
   get p.bedSq hi - get p.bedSq lo,
   get p.posW hi - get p.posW lo, get p.posWX hi - get p.posWX lo,
   get p.posWY hi - get p.posWY lo, get p.posWRR hi - get p.posWRR lo,
   -- Minute `lo - 1` and minute `hi`, each `0` when dark or off the day.
   outside p.posW lo hi, outside p.posWX lo hi, outside p.posWY lo hi, lo, hi,
   awakeRuns p lo hi,
   -- The pairs ending inside the segment: the prefix at `hi` less the one
   -- at `lo + 1`.
   get p.bedDiffSq hi - get p.bedDiffSq (lo + 1), get p.bedDiffN hi - get p.bedDiffN (lo + 1),
   hrAt p.hrR, hrAt p.hrMu, hrAt p.hrV,
   get p.bedDiffSq hi - get p.bedDiffSq lo, get p.bedDiffN hi - get p.bedDiffN lo⟩
where
  /-- A level table's cell for this segment, `0` off the table. -/
  hrAt (a : FloatArray) : Float :=
    if p.hrMaxD == 0 || d == 0 || d > p.hrMaxD then ZERO
    else (a[Verified.Hsmm.triOff p.hrMaxD e + (d - 1)]?).getD ZERO
  /-- The awake runs `[lo, hi)` spans, each's heart-rate statistics, when
      there are two or more. -/
  awakeRuns (p : Prefix) (lo hi : Nat) : Array (Float × Float × Float) := Id.run do
    if p.runStart.isEmpty then return #[]
    let get := fun (a : Array Float) (i : Nat) => a[i]?.getD ZERO
    let mut k := p.runOf[lo]?.getD p.runStart.size
    let mut pieces : Array (Float × Float × Float) := #[]
    while k < p.runStart.size && p.runStart[k]! < hi do
      let a := max lo p.runStart[k]!
      let b := min hi (p.runEnd[k]?.getD hi)
      if b > a then
        pieces := pieces.push (get p.hrN b - get p.hrN a, get p.hrSum b - get p.hrSum a, get p.hrSq b - get p.hrSq a)
      k := k + 1
    return if pieces.size ≥ 2 then pieces else #[]

private def TWO_PI : Float := 6.283185307179586

def logBeta (a b : Float) : Float :=
  Duration.logGamma a + Duration.logGamma b - Duration.logGamma (a + b)

/-- The marginal log-likelihood of `n` correlated minutes (sum `sum`, sum of
    squares `sq`) whose mean is a draw around `hrMean` with spread `hrTau`,
    scattering with `sigmaW` and lag-1 `rho`. -/
def hrMarginal (sigmaW rho hrMean hrTau n sum sq : Float) : Float :=
  if n < ONE then ZERO
  else
    let mean := sum / n
    let ssw := max ZERO (sq - n * mean * mean)
    let w := (ONE - rho) / (ONE + rho)
    let nEff := max ONE (n * w)
    let s2 := sigmaW * sigmaW
    let within := -HALF * (nEff - ONE) * Float.log (TWO_PI * s2) - w * ssw / (TWO * s2)
    let v := hrTau * hrTau + s2 / nEff
    let between := -HALF * Float.log (TWO_PI * v) - (mean - hrMean) * (mean - hrMean) / (TWO * v)
    within + between

/-- The awake heart rate under the drifting level at the mode's mean `m`. -/
@[inline] def hrLevelScore (st : Stats) (m : Float) : Float :=
  if st.hrV ≤ ZERO then ZERO else st.hrR - (m - st.hrMu) * (m - st.hrMu) / (TWO * st.hrV)

/-- The segment's awake heart-rate marginal under one mode. -/
def hrScore (p : Params) (m : ModeParams) (st : Stats) : Float :=
  hrMarginal p.sigmaW p.rho m.hrMean m.hrTau st.hrN st.hrSum st.hrSq

/-- A stay at no listed place, its centre integrated out: the fixes scatter
    around a centre `μ` (each at its own weight `w = 1/σ²`), `μ` a draw from
    the prior — an unlisted place is near a listed one, a Gaussian of
    bandwidth `h` around each of the `K` places (on the narrated days every
    lit stay beyond 150 m of a listed place lies within 700 m of one; `h` is
    their root-mean-square in the fit artefact). With `W = Σw`, `x̄` the
    weighted centroid and `S` the weighted scatter about it,
    `∫ Π N(x; μ, 1/w) (1/K) Σ_k N(μ; P_k, h²) dμ
       = e^{−S/2} · (2π/W) · (1/K) Σ_k N(x̄; P_k, h² + 1/W)`,
    in the same frame as the listed place's per-minute term (the per-fix
    normalisers dropped). A long stay pays its scatter and one Occam factor;
    a short stop pays about what the per-minute term charged it. `0` with no
    lit minute or no listed place.

    The tail: each fix is an outlier with the listed place's per-minute floor
    (`PLACE_DISTANCE_FLOOR`), so the segment is at least the floor times its
    lit minutes — the mixture's lower bound with every fix an outlier. Without
    it a stay hypothesis spanning a day's travel is quadratic in the distance
    and overflows the packed trellis. -/
def centreScore (st : Stats) (h : Float) (places : Array (Float × Float))
    (anchored : Bool := false) : Float :=
  if st.posW ≤ ZERO || places.isEmpty then ZERO else
  let xb := st.posWX / st.posW
  let yb := st.posWY / st.posW
  let scatter := max ZERO (st.posWRR - (st.posWX * st.posWX + st.posWY * st.posWY) / st.posW)
  if anchored && st.anchorW > ZERO then
    -- `∫ Π N(x; μ, 1/w) N(μ; a, 1/Wa) dμ = e^{−S/2}·(2π/W)·N(x̄; a, 1/Wa + 1/W)`.
    let ax := st.anchorWX / st.anchorW
    let ay := st.anchorWY / st.anchorW
    let va := ONE / st.anchorW + ONE / st.posW
    let g := ZERO - HALF * scatter + Float.log (TWO_PI / st.posW) - Float.log (TWO_PI * va)
      - ((xb - ax) * (xb - ax) + (yb - ay) * (yb - ay)) / (TWO * va)
    max g (Verified.Hsmm.Emissions.PLACE_DISTANCE_FLOOR * st.fixN)
  else
  let v := h * h + ONE / st.posW
  let r2 := fun (p : Float × Float) => (xb - p.1) * (xb - p.1) + (yb - p.2) * (yb - p.2)
  let near := places.foldl (fun a p => min a (r2 p)) (r2 places[0]!)
  -- log Σ_k exp(−r_k²/2v), taken from the nearest place so nothing underflows.
  let lse := Float.log (places.foldl (fun a p => a + Float.exp ((near - r2 p) / (TWO * v))) ZERO)
    - near / (TWO * v)
  let gauss := ZERO - HALF * scatter + Float.log (TWO_PI / st.posW)
    - Float.log (Verified.FloatConst.natToFloat places.size) - Float.log (TWO_PI * v) + lse
  max gauss (Verified.Hsmm.Emissions.PLACE_DISTANCE_FLOOR * st.fixN)

/-- Where a listed place's visits are centred: its pin in local metres and
    the 2-D Student-t its visits teach (`pinPriorOf`), with the t's constant,
    truncated at the radius the miner gathers a place's visits within. -/
structure PinPrior where
  x : Float
  y : Float
  nu : Float
  s2 : Float
  logC : Float
  /-- The truncation radius, squared, and the log of the t's mass inside it. -/
  r2Max : Float
  logMass : Float
  deriving Inhabited

private def PI : Float := 3.141592653589793

/-- A place's pin prior from the record's `(ν₀, t₀)` and its mined visits:
    `n` visits whose centres sit `ss` m² (summed) off the pin. The pin is
    their dwell-weighted mean, so `n` visits teach about `2(n − 1)` squared
    coordinates: `ν = ν₀ + 2(n − 1)`, `s² = (ν₀t₀² + ss) / ν`. A visit is
    one within `rMax` of the pin (the miner's cluster radius), so the t is
    cut there: its mass inside is `1 − (1 + rMax²/(νs²))^(−ν/2)`. -/
def pinPriorOf (pin : Float × Float) (nu0 t0 n ss rMax : Float) : PinPrior :=
  let k := TWO * max ZERO (n - ONE)
  let nu := nu0 + k
  let s2 := (nu0 * t0 * t0 + ss) / nu
  let r2Max := rMax * rMax
  { x := pin.1, y := pin.2, nu, s2, r2Max
    logC := Duration.logGamma ((nu + TWO) / TWO) - Duration.logGamma (nu / TWO)
    logMass := Float.log (ONE - Float.exp (ZERO - nu / TWO * Float.log (ONE + r2Max / (nu * s2)))) }

/-- A stay at a listed place, its centre integrated out as `centreScore`
    does for a placeless one, its prior the place's pin prior: the 2-D
    Student-t of `pp`, its scale widened by the segment centre's own `1/W`
    (exact for a Gaussian, the t's scale mixture taken at its mode). The same
    frame and floor as `centreScore`, so a listed and a placeless stay over
    the same minutes differ only in where their centre is expected; a centre
    beyond the truncation is the floor's, every fix an outlier. -/
def listedCentreScore (st : Stats) (pp : PinPrior) : Float :=
  if st.posW ≤ ZERO then ZERO else
  let floor := Verified.Hsmm.Emissions.PLACE_DISTANCE_FLOOR * st.fixN
  let xb := st.posWX / st.posW
  let yb := st.posWY / st.posW
  let r2 := (xb - pp.x) * (xb - pp.x) + (yb - pp.y) * (yb - pp.y)
  if r2 > pp.r2Max then floor else
  let scatter := max ZERO (st.posWRR - (st.posWX * st.posWX + st.posWY * st.posWY) / st.posW)
  let s2 := pp.s2 + ONE / st.posW
  let logT := pp.logC - Float.log (pp.nu * PI * s2)
    - (pp.nu + TWO) / TWO * Float.log (ONE + r2 / (pp.nu * s2)) - pp.logMass
  max (ZERO - HALF * scatter + Float.log (TWO_PI / st.posW) + logT) floor

-- A wide t is close to the Gaussian of the same scale: at the pin the two
-- agree (ten fixes keep it off the floor).
#guard
  let pp := pinPriorOf (0, 0) 1000 10 0 0 1000
  let st : Stats := { n := 1, hrN := 0, hrSum := 0, hrSq := 0, fixN := 10,
                      posW := 1, posWX := 0, posWY := 0, posWRR := 0 }
  (listedCentreScore st pp - (Float.log TWO_PI - Float.log (TWO_PI * 101))).abs < 0.01

/-- The segment's asleep heart-rate marginal, the same for every state
    (`Params.asleep`); `0` without it. -/
def sleepScore (p : Params) (st : Stats) : Float :=
  match p.asleep with
  | some sp =>
    if sp.diffSd > ZERO then
      -- A drifting level: the night mean's prior, and each lag-1 difference
      -- a draw of spread `diffSd`; nothing charges the drift itself.
      if st.bedN < ONE then ZERO else
      let mean := st.bedSum / st.bedN
      let v := sp.hrTau * sp.hrTau
      let between := -HALF * Float.log (TWO_PI * v) - (mean - sp.hrMean) * (mean - sp.hrMean) / (TWO * v)
      let d2 := sp.diffSd * sp.diffSd
      -- Under `position` the pair across the segment's start is the
      -- segment's: splitting a night at a jump no longer hides the jump.
      let (dq, dn) := if p.position.isSome then (st.bedDiffSqB, st.bedDiffNB) else (st.bedDiffSq, st.bedDiffN)
      between + dn * (-HALF * Float.log (TWO_PI * d2)) - dq / (TWO * d2)
    else hrMarginal sp.sigmaW sp.rho sp.hrMean sp.hrTau st.bedN st.bedSum st.bedSq
  | none => ZERO

/-- The segment's fix-presence sequence log-probability under one mode. -/
def fixScore (m : ModeParams) (st : Stats) : Float :=
  logBeta (st.fixN + m.fixA) (st.n - st.fixN + m.fixB) - logBeta m.fixA m.fixB

private def SQRT_TWO_PI : Float := 2.5066282746310002

private def logNormalDensity (x mu sigma : Float) : Float :=
  let z := (Float.log x - mu) / sigma
  Float.exp (-HALF * z * z) / (x * sigma * SQRT_TWO_PI)

/-- The net-displacement score of a window under mode `mode`'s fitted
parameters `q`. -/
@[inline] def dispScoreWith (p : Params) (mode : Mode) (q : DispParams) (d : Nat)
    (w : SegmentEvidence.Window) : Float :=
  let slopMin := Float.sqrt w.slopVar / SegmentEvidence.SLOP_SPEED_M_PER_MIN
  let hours := (Verified.FloatConst.natToFloat d + slopMin) / MIN_PER_H
  let dist := max w.dispM ONE
  let main := if mode == .stationary then logNormalDensity dist q.mu q.sigma
    else logNormalDensity (dist / KM_M / hours) q.mu q.sigma / (hours * KM_M)
  Float.log ((ONE - q.eps) * main + q.eps / (p.uMaxKmh * hours * KM_M))

/-- Every fitted mode's displacement density of a window, in `p.disp`'s
    order, and the flat component: what `dispPosteriorScore` normalises over.
    It depends on the window and the length alone, so the duration cells
    build it once per `(d, e)` for every class (`dispPosteriorFrom`). -/
def dispVector (p : Params) (d : Nat) (w : SegmentEvidence.Window) : FloatArray × Float := Id.run do
  -- A mode with no fitted displacement (a plane, a bicycle) is the flat
  -- component alone: anywhere within `uMaxKmh` over the segment's span, so
  -- a one-minute "flight" that went nowhere is not a free bridge between
  -- two stays.
  let flat := Float.log (ONE / (p.uMaxKmh * (Verified.FloatConst.natToFloat d / MIN_PER_H) * KM_M))
  let mut vals := FloatArray.emptyWithCapacity p.disp.length
  for (m, q) in p.disp do
    vals := vals.push (dispScoreWith p m q d w)
  return (vals, flat)

/-- The posterior of `mode` from a built `dispVector`: the state's own
    density (the first entry of its mode, else the flat component) against
    the log-sum over the fitted modes and the flat component, summed in the
    same order every time. -/
def dispPosteriorFrom (p : Params) (mode : Mode) (v : FloatArray × Float) : Float := Id.run do
  let (vals, flat) := v
  let n := vals.size
  let mut own := flat
  let mut found := false
  let mut i := 0
  for (m, _) in p.disp do
    if !found && m == mode then
      own := vals.get! i
      found := true
    i := i + 1
  let mut mx := own
  for k in [0:n] do
    mx := max mx (vals.get! k)
  mx := max mx flat
  let mut acc := ZERO
  for k in [0:n] do
    acc := acc + Float.exp (vals.get! k - mx)
  acc := acc + Float.exp (flat - mx)
  return own - (mx + Float.log acc)

/-- A `dispVector` with its log-sum, which no mode changes: built once per
    `(d, e)`, so each class pays only for its own entry. -/
structure DispVec where
  vals : FloatArray
  flat : Float
  /-- `mx + log Σ exp (· − mx)` as `dispPosteriorFrom` sums it. NaN when an
      entry is NaN or every entry is `−∞`; then the posterior is taken the
      long way. -/
  lse : Float

/-- The log-sum of `v`, in `dispPosteriorFrom`'s order. Its maximum starts
    from `−∞` where that one starts from the mode's own entry, which is one of
    the entries, so without a NaN the two maxima are the same double. -/
def dispPrep (v : FloatArray × Float) : DispVec := Id.run do
  let (vals, flat) := v
  let n := vals.size
  let mut mx := Verified.FloatConst.negInf
  for k in [0:n] do
    mx := max mx (vals.get! k)
  mx := max mx flat
  let mut acc := ZERO
  for k in [0:n] do
    acc := acc + Float.exp (vals.get! k - mx)
  acc := acc + Float.exp (flat - mx)
  return { vals, flat, lse := mx + Float.log acc }

/-- `dispPosteriorFrom` over a prepared vector. -/
def dispPosteriorPrep (p : Params) (mode : Mode) (v : DispVec) : Float :=
  if v.lse.isNaN then dispPosteriorFrom p mode (v.vals, v.flat) else
  let i := dispIdx mode p.disp 0
  (if i < v.vals.size then v.vals.get! i else v.flat) - v.lse
where
  /-- The position of `mode`'s first entry in `p.disp`, past the end for none. -/
  dispIdx (mode : Mode) : List (Mode × DispParams) → Nat → Nat
    | [], i => i + p.disp.length
    | (m, _) :: rest, i => if m == mode then i else dispIdx mode rest (i + 1)

private def dvT : FloatArray × Float := (⟨#[-3.5, -0.25, -7]⟩, -2)
private def dvInf : FloatArray × Float := (⟨#[Verified.FloatConst.negInf]⟩, Verified.FloatConst.negInf)
private def dvNaN : FloatArray × Float := (⟨#[0.0 / 0.0, -1]⟩, -2)
private def pDispT : Params :=
  { (default : Params) with disp := [(.walking, default), (.train, default), (.walking, default)] }
#guard [Mode.walking, .train, .stationary].all fun m =>
  dispPosteriorPrep pDispT m (dispPrep dvT) == dispPosteriorFrom pDispT m dvT
#guard [Mode.walking, .stationary].all fun m =>
  let a := dispPosteriorPrep pDispT m (dispPrep dvInf)
  let b := dispPosteriorFrom pDispT m dvInf
  a.isNaN && b.isNaN
#guard [Mode.walking, .train, .stationary].all fun m =>
  let a := dispPosteriorPrep pDispT m (dispPrep dvNaN)
  let b := dispPosteriorFrom pDispT m dvNaN
  (a.isNaN && b.isNaN) || a == b

/-- `log f_mode(D) − log Σ_m f_m(D)` over the modes with a fitted displacement:
    the posterior of the mode given the segment's net displacement under a flat
    prior over those modes. A density per segment is about `−log(scale)` for
    any displacement, so every extra segment paid for existing; this is at most
    `0` and about `0` for a displacement typical of the mode; a mode with no
    fit votes as the flat component. `0` without bracketing fixes. -/
def dispPosteriorScore (p : Params) (mode : Mode) (d : Nat) (w : Option SegmentEvidence.Window) : Float :=
  match w with
  | none => ZERO
  | some w' => dispPosteriorFrom p mode (dispVector p d w')

/-- Within GPS noise of a railway: 99% of fixes fall within 31 m of the truth. -/
def RAIL_NEAR_M : Float := 30
private def ONE_THIRD : Float := 1 / 3

/-- A minute's class for `obsChain`: 0 no fix, 1 a fix near a railway, 2 a fix elsewhere. -/
def obsClass (o : ObsRow) : Nat :=
  match o.gps with
  | none => 0
  | some _ => match o.railDistM with
    | some d => if d < RAIL_NEAR_M then 1 else 2
    | none => 2

/-- A minute's class under the mode's chain, given the minute before (`none` at
    the day's first minute: a third). `none` when the mode has no chain. -/
def obsMinute (p : Params) (mode : Mode) (cls : Nat) (prev : Option Nat) : Option Float :=
  (p.obsChain.find? (·.1 == mode)).map fun (_, m) =>
    match prev with
    | some i => Float.log (((m[i]?).bind (·[cls]?)).getD ONE_THIRD)
    | none => Float.log ONE_THIRD

/-- What the speed outlier share adds to a minute whose Gaussian speed term is
    `gauss`: `log((1−ε)·e^gauss + ε/uMax) − gauss`. `0` without a share. -/
def speedRobust (p : Params) (mode : Mode) (gauss : Float) : Float :=
  match p.speedEps.find? (·.1 == mode) with
  | some (_, eps) => Float.log ((ONE - eps) * Float.exp gauss + eps / p.uMaxKmh) - gauss
  | none => ZERO

def score (p : Params) (mode : Mode) (st : Stats) : Float :=
  sleepScore p st
    + match p.byMode.find? (·.1 == mode) with
      | some (_, m) => (if p.hrLevel.isSome then hrLevelScore st m.hrMean else hrScore p m st) + fixScore m st
      | none => ZERO

/-! ### Tabulated

Every count in a segment's statistics is a whole number no larger than the
day, so the log-gamma and logarithm terms are tabulated once per day per mode;
a cell then costs a few lookups. `scorePrepared` equals `score` (guarded). -/

structure ModeTable where
  mode : Mode
  m : ModeParams
  /-- `logGamma (k + a)`, `logGamma (k + b)`, `logGamma (k + a + b)` for `k ≤ N`. -/
  lgA : Array Float
  lgB : Array Float
  lgAB : Array Float
  lbAB : Float
  /-- Per heart-rate count: `log (2π·v)` and `1 / (2v)` of the segment mean's variance. -/
  logTwoPiV : Array Float
  invTwoV : Array Float

/-- A mode's slot in the per-mode arrays below. -/
def modeSlot : Mode → Nat
  | .stationary => 0 | .walking => 1 | .cycling => 2 | .driving => 3
  | .train => 4 | .plane => 5 | .unknown => 6
def MODE_SLOTS : Nat := 7

structure Prepared where
  p : Params
  /-- Per heart-rate count: the within-segment term's constant part. -/
  withinConst : Array Float
  tables : List ModeTable
  /-- `tables` by `modeSlot`: the first table of each mode, read per cell
      without walking the list. -/
  tableOf : Array (Option ModeTable) := Array.replicate MODE_SLOTS none
  /-- Whether `p.obsChain` has a chain for the mode, by `modeSlot`. -/
  chainOf : Array Bool := Array.replicate MODE_SLOTS false

def prepare (p : Params) (N : Nat) : Prepared :=
  let w := (ONE - p.rho) / (ONE + p.rho)
  let s2 := p.sigmaW * p.sigmaW
  let nEffAt := fun (k : Nat) => max ONE (Verified.FloatConst.natToFloat k * w)
  let ks := Array.range (N + 1)
  let base : Prepared := {
    p := p
    withinConst := ks.map fun k => -HALF * (nEffAt k - ONE) * Float.log (TWO_PI * s2)
    tables := p.byMode.map fun (mode, m) =>
      let vAt := fun (k : Nat) => m.hrTau * m.hrTau + s2 / nEffAt k
      { mode, m
        lgA := ks.map fun k => Duration.logGamma (Verified.FloatConst.natToFloat k + m.fixA)
        lgB := ks.map fun k => Duration.logGamma (Verified.FloatConst.natToFloat k + m.fixB)
        lgAB := ks.map fun k => Duration.logGamma (Verified.FloatConst.natToFloat k + m.fixA + m.fixB)
        lbAB := logBeta m.fixA m.fixB
        logTwoPiV := ks.map fun k => Float.log (TWO_PI * vAt k)
        invTwoV := ks.map fun k => ONE / (TWO * vAt k) } }
  { base with
    tableOf := base.tables.foldl (fun acc t =>
      let i := modeSlot t.mode
      if (acc[i]!).isSome then acc else acc.set! i (some t)) (Array.replicate MODE_SLOTS none)
    chainOf := p.obsChain.foldl (fun acc (m, _) => acc.set! (modeSlot m) true) (Array.replicate MODE_SLOTS false) }

private def idx (x : Float) : Nat := (x + HALF).toUInt64.toNat

/-- `scorePrepared`'s two mode-table terms apart: the fix-presence term and
    the heart-rate level. A journey's legs keep the first (a ride is dark, a
    walk lit — the leg's own fact) and the journey draws the second once. -/
@[inline] def scorePreparedParts (q : Prepared) (mode : Mode) (st : Stats) : Float × Float :=
  match q.tableOf[modeSlot mode]! with
  | none => (ZERO, ZERO)
  | some t =>
    let n := idx st.n
    let k := idx st.fixN
    let fix := if q.chainOf[modeSlot mode]! then ZERO
      else t.lgA.getD k ZERO + t.lgB.getD (n - k) ZERO - t.lgAB.getD n ZERO - t.lbAB
    let level := fun (hrN hrSum hrSq : Float) =>
      let hn := idx hrN
      if hn == 0 then ZERO else
      let mean := hrSum / hrN
      let ssw := max ZERO (hrSq - hrN * mean * mean)
      let w := (ONE - q.p.rho) / (ONE + q.p.rho)
      let s2 := q.p.sigmaW * q.p.sigmaW
      q.withinConst.getD hn ZERO - w * ssw / (TWO * s2)
        - HALF * t.logTwoPiV.getD hn ZERO - (mean - t.m.hrMean) * (mean - t.m.hrMean) * t.invTwoV.getD hn ZERO
    -- One level per awake run the segment spans: a sleep resets it. Under
    -- `hrLevel` the level drifts instead, and a night is unobserved minutes.
    let hr := if q.p.hrLevel.isSome then hrLevelScore st t.m.hrMean
      else if st.runs.isEmpty then level st.hrN st.hrSum st.hrSq
      else st.runs.foldl (fun acc (n, sm, sq) => acc + level n sm sq) ZERO
    (fix, hr)

def scorePrepared (q : Prepared) (mode : Mode) (st : Stats) : Float :=
  let (fix, hr) := scorePreparedParts q mode st
  sleepScore q.p st + fix + hr

-- A dark five-hour stretch is a stay's, not a ride's; a lit one a walk's.
private def pTest : Params :=
  { sigmaW := 8, rho := 0.8
    byMode := [(.stationary, ⟨84, 9, 0.09, 0.064⟩), (.train, ⟨89, 9, 2.55, 1.04⟩)]
    disp := [(.stationary, ⟨3.5, 1.5, 0.006⟩), (.train, ⟨3.4, 0.6, 0.025⟩)] }
#guard score pTest .stationary ⟨300, 0, 0, 0, 0, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, 0, 0, #[], ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO⟩ > score pTest .train ⟨300, 0, 0, 0, 0, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, 0, 0, #[], ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO⟩ + 10
#guard score pTest .stationary ⟨300, 0, 0, 0, 300, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, 0, 0, #[], ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO⟩ > score pTest .train ⟨300, 0, 0, 0, 300, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, 0, 0, #[], ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO⟩ - 1
#guard score pTest .walking ⟨300, 0, 0, 0, 0, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, 0, 0, #[], ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO⟩ == 0
-- An 84-minute café at 30 m scatter, 150 m place radius, 300 m from the
-- nearest of three listed places at a 300 m bandwidth: a few nats of scatter
-- and one Occam factor, not 168.
private def cafe : Stats :=
  { n := 84, hrN := 0, hrSum := 0, hrSq := 0, fixN := 84,
    posW := 84 / 22500, posWX := 0, posWY := 0, posWRR := 84 * 1800 / 22500 }
private def threePlaces : Array (Float × Float) := #[(300, 0), (5000, 5000), (-8000, 2000)]
#guard centreScore cafe 300 threePlaces > -20
#guard centreScore cafe 300 threePlaces < -5
-- The same stay 20 km from every listed place pays more.
#guard centreScore cafe 300 #[(20000, 0)] < centreScore cafe 300 threePlaces - 5
-- A "stay" whose fixes span 100 km is floored at every fix an outlier.
#guard centreScore { cafe with posWRR := 84 * 10000000000 / 22500 } 300 threePlaces
  == Verified.Hsmm.Emissions.PLACE_DISTANCE_FLOOR * 84
-- A five-minute stop where the walk left him: about the log of n+1, not the
-- price of a location among all his places.
private def stop5 : Stats :=
  { n := 5, hrN := 0, hrSum := 0, hrSq := 0, fixN := 5,
    posW := 5 / 22500, posWX := 0, posWY := 0, posWRR := 5 * 1800 / 22500,
    anchorW := 2 / 22500, anchorWX := 0, anchorWY := 0 }
#guard centreScore stop5 300 threePlaces true > -3
-- The tables agree with the closed form.
private def stT : Stats := ⟨120, 90, 7650, 652000, 40, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, 0, 0, #[], ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO⟩
#guard Float.abs (scorePrepared (prepare pTest 400) .train stT - score pTest .train stT) < 1e-6
#guard Float.abs (scorePrepared (prepare pTest 400) .stationary stT - score pTest .stationary stT) < 1e-6

end Verified.Hsmm.SegmentEmission
