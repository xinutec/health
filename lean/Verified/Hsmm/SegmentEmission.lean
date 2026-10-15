import Verified.Hsmm.Emissions
import Verified.Hsmm.Observation
import Verified.Hsmm.Duration
import Verified.Hsmm.SegmentEvidence
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
  deriving Inhabited

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
def withPositions (p : Prefix) (obs : Array ObsRow) (ref : Float × Float)
    (sigmaM accDefaultM : Float) : Prefix := Id.run do
  let mut w := #[ZERO]
  let mut wx := #[ZERO]
  let mut wy := #[ZERO]
  let mut wrr := #[ZERO]
  for o in obs do
    let (dw, dx, dy, drr) := match o.gps with
      | some g =>
        let (x, y) := localXY ref g.lat g.lon
        let acc := g.accuracyM.getD accDefaultM
        let k := ONE / (sigmaM * sigmaM + acc * acc)
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
  for o in obs do
    let (n, s, q, bn, bs, bq) := match o.hr with
      | some h => if o.inBed then (ZERO, ZERO, ZERO, ONE, h, h * h) else (ONE, h, h * h, ZERO, ZERO, ZERO)
      | none => (ZERO, ZERO, ZERO, ZERO, ZERO, ZERO)
    p := { p with
           hrN := p.hrN.push (p.hrN.back?.getD 0 + n), hrSum := p.hrSum.push (p.hrSum.back?.getD 0 + s),
           hrSq := p.hrSq.push (p.hrSq.back?.getD 0 + q),
           fixN := p.fixN.push (p.fixN.back?.getD 0 + (if o.gps.isSome then ONE else ZERO)),
           bedN := p.bedN.push (p.bedN.back?.getD 0 + bn), bedSum := p.bedSum.push (p.bedSum.back?.getD 0 + bs),
           bedSq := p.bedSq.push (p.bedSq.back?.getD 0 + bq) }
  return p

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
   outside p.posW lo hi, outside p.posWX lo hi, outside p.posWY lo hi, lo, hi⟩

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

/-- The segment's asleep heart-rate marginal, the same for every state
    (`Params.asleep`); `0` without it. -/
def sleepScore (p : Params) (st : Stats) : Float :=
  match p.asleep with
  | some sp => hrMarginal sp.sigmaW sp.rho sp.hrMean sp.hrTau st.bedN st.bedSum st.bedSq
  | none => ZERO

/-- The segment's fix-presence sequence log-probability under one mode. -/
def fixScore (m : ModeParams) (st : Stats) : Float :=
  logBeta (st.fixN + m.fixA) (st.n - st.fixN + m.fixB) - logBeta m.fixA m.fixB

private def SQRT_TWO_PI : Float := 2.5066282746310002

private def logNormalDensity (x mu sigma : Float) : Float :=
  let z := (Float.log x - mu) / sigma
  Float.exp (-HALF * z * z) / (x * sigma * SQRT_TWO_PI)

/-- The density, per metre, of the segment's net displacement under one mode;
    `0` without bracketing fixes. `d` is the segment's length in minutes. -/
def dispScore (p : Params) (mode : Mode) (d : Nat) (w : Option SegmentEvidence.Window) : Float :=
  match w, p.disp.find? (·.1 == mode) with
  | some w, some (_, q) =>
    let slopMin := Float.sqrt w.slopVar / SegmentEvidence.SLOP_SPEED_M_PER_MIN
    let hours := (Verified.FloatConst.natToFloat d + slopMin) / MIN_PER_H
    let dist := max w.dispM ONE
    let main := if mode == .stationary then logNormalDensity dist q.mu q.sigma
      else logNormalDensity (dist / KM_M / hours) q.mu q.sigma / (hours * KM_M)
    Float.log ((ONE - q.eps) * main + q.eps / (p.uMaxKmh * hours * KM_M))
  | _, _ => ZERO

/-- `log f_mode(D) − log Σ_m f_m(D)` over the modes with a fitted displacement:
    the posterior of the mode given the segment's net displacement under a flat
    prior over those modes. A density per segment is about `−log(scale)` for
    any displacement, so every extra segment paid for existing; this is at most
    `0` and about `0` for a displacement typical of the mode; a mode with no
    fit votes as the flat component. `0` without bracketing fixes. -/
def dispPosteriorScore (p : Params) (mode : Mode) (d : Nat) (w : Option SegmentEvidence.Window) : Float :=
  match w with
  | none => ZERO
  | some w' =>
    -- A mode with no fitted displacement (a plane, a bicycle) is the flat
    -- component alone: anywhere within `uMaxKmh` over the segment's span, so
    -- a one-minute "flight" that went nowhere is not a free bridge between
    -- two stays.
    let flat := Float.log (ONE / (p.uMaxKmh * (Verified.FloatConst.natToFloat d / MIN_PER_H) * KM_M))
    let own := if p.disp.any (·.1 == mode) then dispScore p mode d w else flat
    let all := (p.disp.map fun (m, _) => dispScore p m d w) ++ [flat]
    let mx := all.foldl max own
    own - (mx + Float.log (all.foldl (fun acc v => acc + Float.exp (v - mx)) ZERO))

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
      | some (_, m) => hrScore p m st + fixScore m st
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

structure Prepared where
  p : Params
  /-- Per heart-rate count: the within-segment term's constant part. -/
  withinConst : Array Float
  tables : List ModeTable

def prepare (p : Params) (N : Nat) : Prepared :=
  let w := (ONE - p.rho) / (ONE + p.rho)
  let s2 := p.sigmaW * p.sigmaW
  let nEffAt := fun (k : Nat) => max ONE (Verified.FloatConst.natToFloat k * w)
  let ks := Array.range (N + 1)
  { p
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

private def idx (x : Float) : Nat := (x + HALF).toUInt64.toNat

def scorePrepared (q : Prepared) (mode : Mode) (st : Stats) : Float :=
  sleepScore q.p st
    + match q.tables.find? (·.mode == mode) with
  | none => ZERO
  | some t =>
    let n := idx st.n
    let k := idx st.fixN
    let fix := if q.p.obsChain.any (·.1 == mode) then ZERO
      else t.lgA.getD k ZERO + t.lgB.getD (n - k) ZERO - t.lgAB.getD n ZERO - t.lbAB
    let hn := idx st.hrN
    let hr := if hn == 0 then ZERO else
      let mean := st.hrSum / st.hrN
      let ssw := max ZERO (st.hrSq - st.hrN * mean * mean)
      let w := (1 - q.p.rho) / (1 + q.p.rho)
      let s2 := q.p.sigmaW * q.p.sigmaW
      q.withinConst.getD hn ZERO - w * ssw / (TWO * s2)
        - HALF * t.logTwoPiV.getD hn ZERO - (mean - t.m.hrMean) * (mean - t.m.hrMean) * t.invTwoV.getD hn ZERO
    fix + hr

-- A dark five-hour stretch is a stay's, not a ride's; a lit one a walk's.
private def pTest : Params :=
  { sigmaW := 8, rho := 0.8
    byMode := [(.stationary, ⟨84, 9, 0.09, 0.064⟩), (.train, ⟨89, 9, 2.55, 1.04⟩)]
    disp := [(.stationary, ⟨3.5, 1.5, 0.006⟩), (.train, ⟨3.4, 0.6, 0.025⟩)] }
-- Two hours that end 50 m from where they began are a stay; 8 km in twenty minutes a ride.
#guard dispScore pTest .stationary 109 (some ⟨50, 0, 0⟩) > dispScore pTest .train 109 (some ⟨50, 0, 0⟩) + 10
#guard dispScore pTest .train 20 (some ⟨8000, 0, 0⟩) > dispScore pTest .stationary 20 (some ⟨8000, 0, 0⟩) + 3
#guard dispScore pTest .walking 20 (some ⟨8000, 0, 0⟩) == 0
#guard score pTest .stationary ⟨300, 0, 0, 0, 0, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, 0, 0⟩ > score pTest .train ⟨300, 0, 0, 0, 0, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, 0, 0⟩ + 10
#guard score pTest .stationary ⟨300, 0, 0, 0, 300, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, 0, 0⟩ > score pTest .train ⟨300, 0, 0, 0, 300, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, 0, 0⟩ - 1
#guard score pTest .walking ⟨300, 0, 0, 0, 0, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, 0, 0⟩ == 0
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
private def stT : Stats := ⟨120, 90, 7650, 652000, 40, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO, 0, 0⟩
#guard Float.abs (scorePrepared (prepare pTest 400) .train stT - score pTest .train stT) < 1e-6
#guard Float.abs (scorePrepared (prepare pTest 400) .stationary stT - score pTest .stationary stT) < 1e-6

end Verified.Hsmm.SegmentEmission
