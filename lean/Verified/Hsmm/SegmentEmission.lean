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
  minute), so it is a two-state chain per mode (`fixMinute`): a regime change
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

structure Params where
  sigmaW : Float
  rho : Float
  byMode : List (Mode × ModeParams)
  disp : List (Mode × DispParams) := []
  uMaxKmh : Float := DEFAULT_U_MAX_KMH
  /-- Fix presence as a two-state chain per mode: `P(fix | fix a minute ago)`,
      `P(fix | none a minute ago)`. A mode listed here is scored per minute
      (`fixMinute`) and not by the segment's beta-binomial. -/
  fixMarkov : List (Mode × (Float × Float)) := []
  /-- A minute's speed is the mode's Gaussian with this share of outliers spread
      evenly over 0–`uMaxKmh` (a fix that jumped): one bad fix must not outvote
      the steps and the minutes around it. -/
  speedEps : List (Mode × Float) := []
  deriving Inhabited

/-- Prefix sums over the day's minutes: awake heart-rate count, sum and sum of
    squares, and the count of minutes with a fix. Index `i` covers `[0, i)`. -/
structure Prefix where
  hrN : Array Float
  hrSum : Array Float
  hrSq : Array Float
  fixN : Array Float
  deriving Inhabited

def prefixOf (obs : Array ObsRow) : Prefix := Id.run do
  let mut p : Prefix := ⟨#[ZERO], #[ZERO], #[ZERO], #[ZERO]⟩
  for o in obs do
    let (n, s, q) := match o.hr with
      | some h => if o.inBed then (ZERO, ZERO, ZERO) else (ONE, h, h * h)
      | none => (ZERO, ZERO, ZERO)
    p := ⟨p.hrN.push (p.hrN.back?.getD 0 + n), p.hrSum.push (p.hrSum.back?.getD 0 + s),
          p.hrSq.push (p.hrSq.back?.getD 0 + q),
          p.fixN.push (p.fixN.back?.getD 0 + (if o.gps.isSome then ONE else ZERO))⟩
  return p

/-- A segment's sufficient statistics. -/
structure Stats where
  n : Float
  hrN : Float
  hrSum : Float
  hrSq : Float
  fixN : Float

/-- The segment of length `d` ending at minute `e`. -/
def statsAt (p : Prefix) (d e : Nat) : Stats :=
  let hi := e + 1
  let lo := hi - d
  let get := fun (a : Array Float) (i : Nat) => a[i]?.getD ZERO
  ⟨Verified.FloatConst.natToFloat d,
   get p.hrN hi - get p.hrN lo, get p.hrSum hi - get p.hrSum lo,
   get p.hrSq hi - get p.hrSq lo, get p.fixN hi - get p.fixN lo⟩

private def TWO_PI : Float := 6.283185307179586

def logBeta (a b : Float) : Float :=
  Duration.logGamma a + Duration.logGamma b - Duration.logGamma (a + b)

/-- The segment's heart-rate marginal log-likelihood under one mode. -/
def hrScore (p : Params) (m : ModeParams) (st : Stats) : Float :=
  if st.hrN < ONE then ZERO
  else
    let n := st.hrN
    let mean := st.hrSum / n
    let ssw := max ZERO (st.hrSq - n * mean * mean)
    let w := (ONE - p.rho) / (ONE + p.rho)
    let nEff := max ONE (n * w)
    let s2 := p.sigmaW * p.sigmaW
    let within := -HALF * (nEff - ONE) * Float.log (TWO_PI * s2) - w * ssw / (TWO * s2)
    let v := m.hrTau * m.hrTau + s2 / nEff
    let between := -HALF * Float.log (TWO_PI * v) - (mean - m.hrMean) * (mean - m.hrMean) / (TWO * v)
    within + between

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

/-- A minute's fix presence under the mode's chain, given the minute before
    (`none` at the day's first minute: the chain's stationary share). `none`
    when the mode has no chain. -/
def fixMinute (p : Params) (mode : Mode) (lit : Bool) (prevLit : Option Bool) : Option Float :=
  (p.fixMarkov.find? (·.1 == mode)).map fun (_, (p11, p01)) =>
    let pFix := match prevLit with
      | some true => p11
      | some false => p01
      | none => p01 / (ONE - p11 + p01)
    Float.log (if lit then pFix else ONE - pFix)

/-- What the speed outlier share adds to a minute whose Gaussian speed term is
    `gauss`: `log((1−ε)·e^gauss + ε/uMax) − gauss`. `0` without a share. -/
def speedRobust (p : Params) (mode : Mode) (gauss : Float) : Float :=
  match p.speedEps.find? (·.1 == mode) with
  | some (_, eps) => Float.log ((ONE - eps) * Float.exp gauss + eps / p.uMaxKmh) - gauss
  | none => ZERO

def score (p : Params) (mode : Mode) (st : Stats) : Float :=
  match p.byMode.find? (·.1 == mode) with
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
  match q.tables.find? (·.mode == mode) with
  | none => ZERO
  | some t =>
    let n := idx st.n
    let k := idx st.fixN
    let fix := if q.p.fixMarkov.any (·.1 == mode) then ZERO
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
#guard score pTest .stationary ⟨300, 0, 0, 0, 0⟩ > score pTest .train ⟨300, 0, 0, 0, 0⟩ + 10
#guard score pTest .stationary ⟨300, 0, 0, 0, 300⟩ > score pTest .train ⟨300, 0, 0, 0, 300⟩ - 1
#guard score pTest .walking ⟨300, 0, 0, 0, 0⟩ == 0
-- The tables agree with the closed form.
private def stT : Stats := ⟨120, 90, 7650, 652000, 40⟩
#guard Float.abs (scorePrepared (prepare pTest 400) .train stT - score pTest .train stT) < 1e-6
#guard Float.abs (scorePrepared (prepare pTest 400) .stationary stT - score pTest .stationary stT) < 1e-6

end Verified.Hsmm.SegmentEmission
