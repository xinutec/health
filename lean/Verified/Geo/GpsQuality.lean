import Verified.Geo.Kalman
/-!
# GPS quality-control pre-filter (implementation-first port of `src/geo/gps-quality.ts`)

Runs BEFORE the Kalman filter: drop physically-incoherent runs of GPS fixes
(underground / cell-tower garbage) so downstream gap-inference sees an honest
temporal gap. An anchor walk — keep the last trusted fix as an anchor; a
candidate reachable from it at a plausible speed is kept and becomes the new
anchor; an unreachable-or-inaccurate-moving candidate starts a suspected garbage
run, and a forward bridge scan finds the surfacing fix on the far side (dropping
the run) unless the run is genuine sustained fast travel (no bridge) or
poor-accuracy jitter that never travelled (kept).

Pure over the track; the only transcendental is `cos` in `distanceM` (≤1 ULP),
and every decision is a threshold well clear of the boundary on real data, so the
KEPT SET is exact (a subset of the input, coords unchanged — like `dropGpsOutliers`).
WHICH fixes it keeps is pinned by the `#guard`s below; THAT it can only keep — it
never invents or moves a fix — is a theorem, `mem_of_mem_qualityFilterGps`.
-/

namespace Verified.Geo.GpsQuality

open Verified.Geo.Kalman (GpsPoint)

def SPEED_CEILING_KMH : Float := 150
def BRIDGE_WINDOW_S : Int := 1800
def ACCURACY_CEILING_M : Float := 80
def GARBAGE_MIN_SPEED_KMH : Float := 15
def MIN_TRANSIT_DISPLACEMENT_M : Float := 800
/-- Accuracy (m) above which a fix is not a position at all, and is dropped
whether or not it moved. `inaccurateMotion` keeps a poor-accuracy fix that is
going nowhere on purpose — an indoor sit reports the same cell-tower grade as a
tube ride — but that trade holds only while the fix still says roughly WHERE you
are. Beyond the distance at which this module distinguishes "here" from "a
station away" (`MIN_TRANSIT_DISPLACEMENT_M`, the resolution of its own
decision), the measurement cannot inform any question asked of it. -/
def ACCURACY_UNINFORMATIVE_M : Float := MIN_TRANSIT_DISPLACEMENT_M
private def pi : Float := 3.141592653589793

def distanceM (a b : GpsPoint) : Float :=
  let dLatM := (b.lat - a.lat) * 111320
  let dLonM := (b.lon - a.lon) * 111320 * Float.cos (a.lat * pi / 180)
  Float.sqrt (dLatM ^ 2 + dLonM ^ 2)

/-- Point-to-point speed (km/h); duplicate/out-of-order ts ⇒ 0 (treated reachable). -/
def impliedSpeedKmh (a b : GpsPoint) : Float :=
  let dt := b.ts - a.ts
  if decide (dt ≤ 0) then 0 else distanceM a b / dt.toNat.toFloat * 3.6

/-- Unreachable from the anchor at any plausible ground speed — always garbage. -/
def speedUnreachable (anchor cand : GpsPoint) : Bool := decide (impliedSpeedKmh anchor cand > SPEED_CEILING_KMH)

/-- Cell-tower-grade movement: poor-accuracy AND moved at non-pedestrian speed. -/
def inaccurateMotion (anchor cand : GpsPoint) : Bool :=
  match cand.accuracy with
  | some acc => decide (acc > ACCURACY_CEILING_M) && decide (impliedSpeedKmh anchor cand > GARBAGE_MIN_SPEED_KMH)
  | none => false

def isGarbage (anchor cand : GpsPoint) : Bool := speedUnreachable anchor cand || inaccurateMotion anchor cand

/-- Position trustworthy enough to anchor / bridge from (good accuracy). -/
def trustworthy (p : GpsPoint) : Bool :=
  match p.accuracy with | some acc => decide (acc ≤ ACCURACY_CEILING_M) | none => true

/-- An index into `points` at or after `j`: what a bridge scan from `j` finds.
    Carrying both bounds is what lets the walk resume after the bridge and
    still be seen to move forward. -/
abbrev BridgeAt (points : Array GpsPoint) (j : Nat) := { b : Nat // j ≤ b ∧ b < points.size }

/-- First fix `≥ j` that can bridge the garbage run: reachable, trustworthy, and
    the start of a coherent run (its own successor reachable). Stops at the
    `BRIDGE_WINDOW_S` horizon. -/
def findBridge (points : Array GpsPoint) (anchor : GpsPoint) (j : Nat) : Option (BridgeAt points j) :=
  if h : j < points.size then
    if decide (points[j].ts - anchor.ts > BRIDGE_WINDOW_S) then none
    else if isGarbage anchor points[j] || !trustworthy points[j] then
      (findBridge points anchor (j + 1)).map fun ⟨b, hb⟩ => ⟨b, by omega⟩
    else
      let coherentSuccessor :=
        if h1 : j + 1 < points.size then decide (impliedSpeedKmh points[j] points[j + 1] ≤ SPEED_CEILING_KMH)
        else true
      if coherentSuccessor then some ⟨j, by omega⟩
      else (findBridge points anchor (j + 1)).map fun ⟨b, hb⟩ => ⟨b, by omega⟩
  else none
termination_by points.size - j

/-- The anchor walk over the remaining track. `anchor` is the last fix kept. -/
def walk (points : Array GpsPoint) (anchor : GpsPoint) (kept : Array GpsPoint) (i : Nat) : Array GpsPoint :=
  if h : i < points.size then
    let cand := points[i]
    if !isGarbage anchor cand then walk points cand (kept.push cand) (i + 1)
    else match findBridge points anchor (i + 1) with
      | some ⟨b, hb⟩ =>
        let bridge := points[b]
        let travelled := decide (distanceM anchor bridge > MIN_TRANSIT_DISPLACEMENT_M)
        if speedUnreachable anchor cand || travelled then walk points bridge (kept.push bridge) (b + 1)
        else walk points cand (kept.push cand) (i + 1)
      | none => walk points cand (kept.push cand) (i + 1)
  else kept
termination_by points.size - i

/-! ### Frozen fixes — a position the phone kept while the person moved

Underground, a phone with no sky re-reports its LAST position, identical to
centimetres, while the accuracy it attaches to it swings. 2026-07-16 07:41: five
fixes 270 m from Finchley Road, 20 → 122 m accuracy, entered from 1.5 km away a
hundred seconds earlier and left for Baker Street 3.2 km away a minute later;
read as positions they surfaced a Jubilee ride at Finchley Road and invented an
alight there. Accuracy cannot tell the run from a stay — an indoor sit reports
the same shape — but the jumps can: nobody is still somewhere they reached and
left at 60 km/h. Indoor frozen runs (measured across 45 days: the library, Work,
the hospital) are entered and left by metres.

The run is dropped BEFORE the anchor walk, with the accuracy-disclaimed fixes:
kept, it would anchor the walk itself. Identity of coordinates is the test here,
not a still radius — a café stop varies by metres, a re-report does not — so no
cadence is needed at this stage. -/

/-- Fixes within this of the run's first fix are the same re-reported position. -/
def FROZEN_RADIUS_M : Float := 2
/-- A run this long or longer; two fixes half a minute apart already say it. -/
def FROZEN_MIN_S : Int := 30
/-- The step into and out of the run: this far… -/
def FROZEN_JUMP_M : Float := 500
/-- …at least this fast. The tube-hop blackout floor, restated here so this
    module judges by its own constants ([[TubeHop]] is downstream of it). -/
def FROZEN_JUMP_KMH : Float := 25

private def isJump (a b : GpsPoint) : Bool :=
  decide (distanceM a b ≥ FROZEN_JUMP_M) && decide (impliedSpeedKmh a b ≥ FROZEN_JUMP_KMH)

/-- Timestamps of every frozen run entered and left by a jump. Time order is
    taken from the input, as the walk takes it. -/
def frozenJumpRunTs (points : Array GpsPoint) : Array Int := Id.run do
  let mut out : Array Int := #[]
  let mut i := 0
  -- `i` only advances, so `points.size` is the exact trip count.
  for _ in [0:points.size] do
    if hi : i < points.size then
      let a := points[i]
      let mut j := i
      for _ in [0:points.size] do
        if hj : j + 1 < points.size then
          if decide (distanceM a points[j + 1] ≤ FROZEN_RADIUS_M) then j := j + 1 else break
        else break
      if hj : j < points.size then
        let last := points[j]
        let enteredBy := if h0 : 0 < i then isJump (points[i - 1]'(by omega)) a else false
        let leftBy := if h1 : j + 1 < points.size then isJump last points[j + 1] else false
        if j > i && decide (last.ts - a.ts ≥ FROZEN_MIN_S) && enteredBy && leftBy then
          out := out ++ (points.extract i (j + 1)).map (·.ts)
      i := j + 1
    else break
  return out

/-- Drop incoherent GPS runs; surviving fixes in input order. Fixes the phone
itself disclaims go first, before anything reasons from them — including before
the walk can make one an anchor, a bridge, or the thing a later fix is judged
"unreachable" from; then the frozen runs it kept while moving (above). -/
def qualityFilterGps (input : Array GpsPoint) : Array GpsPoint :=
  let informative := input.filter fun p =>
    match p.accuracy with | some acc => decide (acc ≤ ACCURACY_UNINFORMATIVE_M) | none => true
  let frozen := frozenJumpRunTs informative
  let points := informative.filter fun p => !frozen.contains p.ts
  if h : points.size ≤ 2 then points else walk points points[0] #[points[0]] 1

/-! ### What the filter can never do

Every element of the output is an element of the input. The guards below pin
what the filter keeps on particular tracks; this holds on every track, and no
finite set of tracks could show it. The walk only ever pushes `points[i]` or
`points[b]`, so it is an induction over the walk's own measure. -/

theorem mem_of_mem_walk {points : Array GpsPoint} {anchor : GpsPoint} {kept : Array GpsPoint}
    {i : Nat} {p : GpsPoint} (hp : p ∈ walk points anchor kept i) : p ∈ kept ∨ p ∈ points := by
  rw [walk.eq_def] at hp
  split at hp
  · rename_i h
    simp only at hp
    split at hp
    · rcases mem_of_mem_walk hp with hk | hpts
      · rcases Array.mem_push.1 hk with hk | rfl
        · exact .inl hk
        · exact .inr (Array.getElem_mem h)
      · exact .inr hpts
    · split at hp
      · rename_i b hb _
        split at hp
        · rcases mem_of_mem_walk hp with hk | hpts
          · rcases Array.mem_push.1 hk with hk | rfl
            · exact .inl hk
            · exact .inr (Array.getElem_mem hb.2)
          · exact .inr hpts
        · rcases mem_of_mem_walk hp with hk | hpts
          · rcases Array.mem_push.1 hk with hk | rfl
            · exact .inl hk
            · exact .inr (Array.getElem_mem h)
          · exact .inr hpts
      · rcases mem_of_mem_walk hp with hk | hpts
        · rcases Array.mem_push.1 hk with hk | rfl
          · exact .inl hk
          · exact .inr (Array.getElem_mem h)
        · exact .inr hpts
  · exact .inl hp
termination_by points.size - i

theorem mem_of_mem_qualityFilterGps {input : Array GpsPoint} {p : GpsPoint}
    (hp : p ∈ qualityFilterGps input) : p ∈ input := by
  unfold qualityFilterGps at hp
  simp only at hp
  split at hp
  · exact (Array.mem_filter.1 (Array.mem_filter.1 hp).1).1
  · rcases mem_of_mem_walk hp with hk | hpts
    · simp only [Array.mem_singleton] at hk
      subst hk
      exact (Array.mem_filter.1 (Array.mem_filter.1 (Array.getElem_mem _)).1).1
    · exact (Array.mem_filter.1 (Array.mem_filter.1 hpts).1).1

-- Parity with the real `qualityFilterGps` (kept-set ts from Node/V8): teleport
-- (t=20) and a poor-accuracy tube run (t=100) dropped; poor-accuracy jitter
-- (t=180, net < 800 m) kept.
private def gp (ts : Int) (lat lon : Float) (acc : Float) : GpsPoint := ⟨ts, lat, lon, some acc⟩
private def track : Array GpsPoint := #[
  gp 0 51.50 (-38.10) 20, gp 10 51.501 (-38.10) 20,
  gp 20 51.60 (-38.10) 20,            -- teleport
  gp 30 51.502 (-38.10) 20, gp 40 51.503 (-38.10) 20,
  gp 100 51.52 (-38.10) 100,          -- poor-accuracy tube run (travelled)
  gp 160 51.53 (-38.10) 20, gp 170 51.531 (-38.10) 20,
  gp 180 51.5315 (-38.10) 100,        -- poor-accuracy jitter (kept)
  gp 190 51.5312 (-38.10) 20]

#guard (qualityFilterGps track).map (·.ts) == #[0, 10, 30, 40, 160, 170, 180, 190]
#guard (qualityFilterGps #[gp 0 51.5 (-38.1) 20, gp 10 51.5 (-38.1) 20]).size == 2  -- ≤2 pass through

-- A frozen run — three identical fixes over 60 s, accuracy 20 → 122 — entered
-- from 1.7 km away in 100 s and left for 2.2 km away in 40 s: not a position.
private def frozenBracketed : Array GpsPoint := #[
  gp 0 51.5 (-38.1) 10, gp 100 51.505 (-38.1) 15,
  gp 200 51.52 (-38.1) 20, gp 230 51.52 (-38.1) 60, gp 260 51.52 (-38.1) 122,
  gp 300 51.54 (-38.1) 30, gp 400 51.541 (-38.1) 20]
#guard frozenJumpRunTs frozenBracketed == #[200, 230, 260]
#guard (qualityFilterGps frozenBracketed).map (·.ts) == #[0, 100, 300, 400]
-- The same run walked into (110 m in the 100 s before it) is a stop: kept whole.
private def frozenWalkedInto : Array GpsPoint :=
  frozenBracketed.set! 1 (gp 100 51.519 (-38.1) 15)
#guard frozenJumpRunTs frozenWalkedInto == #[]
-- (the exit jump at t=300 is still the walk's own teleport to condemn; what this
-- pins is that the run itself is kept)
#guard [200, 230, 260].all fun t => ((qualityFilterGps frozenWalkedInto).map (·.ts)).contains t
-- Indoors: identical fixes with swinging accuracy and no jump either side — a sit.
private def frozenIndoors : Array GpsPoint := #[
  gp 0 51.52 (-38.1) 10, gp 200 51.52 (-38.1) 20, gp 230 51.52 (-38.1) 60, gp 260 51.52 (-38.1) 122,
  gp 300 51.5201 (-38.1) 30]
#guard frozenJumpRunTs frozenIndoors == #[]
-- Two identical fixes 30 s apart already say it; one alone never does.
#guard frozenJumpRunTs (frozenBracketed.eraseIdx! 4) == #[200, 230]
#guard frozenJumpRunTs ((frozenBracketed.eraseIdx! 4).eraseIdx! 3) == #[]

/-! ### Branch guards

The two guards above pin the shape a real day takes. They do not reach a null
accuracy, a duplicate timestamp, or a bridge scan that runs past its horizon —
and 32 days of real London track do not reach those either, so a port could get
any of them wrong and still measure 32/32 exact against TS.

Every expectation below is what `src/geo/gps-quality.ts` actually returned under
Node v24.18.0, not a value reasoned about here; regenerate with
`npx tsx lean/experiments/gpsquality-refs.mts` after any change to the filter.
A disagreement means the port and the original have diverged, which is the only
question these guards exist to answer. -/

private def gpn (ts : Int) (lat lon : Float) : GpsPoint := ⟨ts, lat, lon, none⟩

-- `inaccurateMotion` → `none ⇒ false`, `trustworthy` → `none ⇒ true`. With no
-- accuracy anywhere only the speed ceiling can condemn a fix: the t=20 teleport
-- must still go, and t=30 must be trusted as its bridge with nothing to judge
-- its accuracy by.
private def nullAccuracy : Array GpsPoint := #[
  gpn 0 51.5 (-38.1), gpn 10 51.501 (-38.1), gpn 20 51.6 (-38.1), gpn 30 51.502 (-38.1), gpn 40 51.503 (-38.1)]
#guard (qualityFilterGps nullAccuracy).map (·.ts) == #[0, 10, 30, 40]

-- `impliedSpeedKmh` → `dt ≤ 0 ⇒ 0`. Note what the expectation says: EVERY fix
-- survives, teleports included. A fix sharing or preceding its anchor's
-- timestamp has no defined speed, and the filter's documented choice is to
-- treat it as reachable rather than infinite — so it is invisible here. That is
-- the TS behaviour and the port must reproduce it; a port dividing by `dt`
-- would get `inf`, read it as unreachable, and drop fixes TS keeps.
private def duplicateTs : Array GpsPoint := #[
  gp 0 51.5 (-38.1) 20, gp 0 51.6 (-38.1) 20, gp 10 51.501 (-38.1) 20, gp 5 51.7 (-38.1) 20, gp 20 51.502 (-38.1) 20]
#guard (qualityFilterGps duplicateTs).map (·.ts) == #[0, 0, 10, 5, 20]

-- `findBridge` → `none` at the `BRIDGE_WINDOW_S` horizon. The garbage fix at
-- t=100 has no surfacing fix within 1800 s (the next is t=2000), so the scan
-- gives up and the candidate is KEPT rather than bridged across half an hour.
private def bridgeHorizon : Array GpsPoint := #[
  gp 0 51.5 (-38.1) 20, gp 10 51.501 (-38.1) 20, gp 100 51.52 (-38.1) 100, gp 2000 51.53 (-38.1) 20, gp 2010 51.531 (-38.1) 20]
#guard (qualityFilterGps bridgeHorizon).map (·.ts) == #[0, 10, 100, 2000, 2010]

-- `findBridge` → `coherentSuccessor` false. t=60 is itself reachable and
-- trustworthy, so it looks like a bridge — but its own successor at t=70 is a
-- teleport, so it heads another garbage run and must be passed over for t=120.
private def incoherentSuccessor : Array GpsPoint := #[
  gp 0 51.5 (-38.1) 20, gp 10 51.501 (-38.1) 20, gp 20 51.7 (-38.1) 100, gp 60 51.502 (-38.1) 20,
  gp 70 51.9 (-38.1) 20, gp 120 51.503 (-38.1) 20, gp 130 51.504 (-38.1) 20]
#guard (qualityFilterGps incoherentSuccessor).map (·.ts) == #[0, 10, 120, 130]

-- `walk` → `speedUnreachable ∨ travelled`, with only the LEFT disjunct true. A
-- teleport that returns: net displacement across the run is far under
-- MIN_TRANSIT_DISPLACEMENT_M, so `travelled` is false and the run is bridged on
-- unreachability alone. A port testing only displacement would keep the
-- teleport.
private def unreachableNotTravelled : Array GpsPoint := #[
  gp 0 51.5 (-38.1) 20, gp 10 51.5005 (-38.1) 20, gp 20 51.9 (-38.1) 20, gp 30 51.501 (-38.1) 20, gp 40 51.5015 (-38.1) 20]
#guard (qualityFilterGps unreachableNotTravelled).map (·.ts) == #[0, 10, 30, 40]

-- ACCURACY_CEILING_M, both sides. These two tracks differ only in 80 → 80.001
-- and must NOT agree: `>` keeps the fix at exactly the ceiling and drops the
-- one a thousandth over. `≥` in either comparison collapses them.
private def accuracyAtCeiling : Array GpsPoint := #[
  gp 0 51.5 (-38.1) 20, gp 10 51.501 (-38.1) 20, gp 100 51.52 (-38.1) 80, gp 160 51.53 (-38.1) 20, gp 170 51.531 (-38.1) 20]
#guard (qualityFilterGps accuracyAtCeiling).map (·.ts) == #[0, 10, 100, 160, 170]

private def accuracyOverCeiling : Array GpsPoint := #[
  gp 0 51.5 (-38.1) 20, gp 10 51.501 (-38.1) 20, gp 100 51.52 (-38.1) 80.001, gp 160 51.53 (-38.1) 20, gp 170 51.531 (-38.1) 20]
#guard (qualityFilterGps accuracyOverCeiling).map (·.ts) == #[0, 10, 160, 170]

-- ACCURACY_UNINFORMATIVE_M — the pre-filter, which the anchor walk cannot
-- reach. Same geometry as the poor-accuracy jitter kept in `track` above (a run
-- bracketed by good fixes at one spot, going nowhere); the only difference is
-- the stated accuracy, and it decides. The 2026-05-11 evening train: the phone
-- stops solving, repeats one coordinate, and inflates its error bar 835 →
-- 37,880 m. Kept, the Kalman gives a ±37 km measurement no weight, coasts on
-- its last real velocity, and draws 29 km of travel that never happened.
private def gpf (ts : Int) (acc : Float) : GpsPoint := ⟨ts, 50, 5, some acc⟩
private def disclaimed : Array GpsPoint := #[
  gpf 1000 10, gpf 1015 10, gpf 1030 10, gpf 1045 10,
  gpf 1060 835, gpf 1090 1500, gpf 1120 2136, gpf 1150 6045, gpf 1180 9365,
  gpf 1210 10660, gpf 1240 11963, gpf 1270 13265, gpf 1300 14564, gpf 1330 15865,
  gpf 1360 17162, gpf 1390 18462, gpf 1420 19762, gpf 1450 21060, gpf 1480 37880,
  gpf 1510 10, gpf 1525 10, gpf 1540 10, gpf 1555 10]
#guard (qualityFilterGps disclaimed).map (·.ts) == #[1000, 1015, 1030, 1045, 1510, 1525, 1540, 1555]

-- The pre-filter runs BEFORE the ≤2 pass-through, so a track that is short only
-- because most of it is disclaimed does not get waved past. A port that filters
-- after the size check keeps all three.
#guard (qualityFilterGps #[gpf 0 10, gpf 10 5000, gpf 20 10]).map (·.ts) == #[0, 20]

end Verified.Geo.GpsQuality
