import Verified.Geo.Kalman
import Verified.FloatConst
/-!
# GPS quality-control pre-filter

Before the Kalman filter, drop physically incoherent runs (underground or
cell-tower garbage) so gap inference sees an honest gap. An anchor walk: a
fix reachable from the anchor at a plausible speed becomes the anchor; an
unreachable or inaccurate moving one starts a suspect run, dropped when a
forward scan finds the fix that surfaces past it, unless it is sustained fast
travel (no bridge) or jitter that never travelled.

The only transcendental is `cos` (≤1 ULP), clear of every threshold on real
data. That it only removes fixes is a theorem, `mem_of_mem_qualityFilterGps`.
-/

namespace Verified.Geo.GpsQuality

open Verified.Geo.Kalman (GpsPoint)

def SPEED_CEILING_KMH : Float := 150
def BRIDGE_WINDOW_S : Int := 1800
def ACCURACY_CEILING_M : Float := 80
def GARBAGE_MIN_SPEED_KMH : Float := 15
def MIN_TRANSIT_DISPLACEMENT_M : Float := 800
/-- Accuracy (m) above which a fix is dropped whether or not it moved. A poor
fix going nowhere is otherwise kept (an indoor sit looks like a tube ride), but
beyond `MIN_TRANSIT_DISPLACEMENT_M` it no longer says where you are. -/
def ACCURACY_UNINFORMATIVE_M : Float := MIN_TRANSIT_DISPLACEMENT_M
open Verified.FloatConst (pi)

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

/-- Cell-tower-grade movement: poor-accuracy and moved at non-pedestrian speed. -/
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

Underground, a phone re-reports its last position to the centimetre while the
accuracy swings; read as positions, such a run invents an alight. Accuracy
cannot tell it from an indoor stay, but the jumps can: nobody stays at a place
reached and left at 60 km/h, while an indoor run is entered and left by metres.

Dropped before the anchor walk, or it would anchor it. Identical coordinates
are the test: a real stop varies by metres, a re-report does not. -/

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

/-- Drop incoherent GPS runs, keeping input order. Fixes the phone disclaims go
first, before the walk can use one, then frozen runs, then the walk. -/
def qualityFilterGps (input : Array GpsPoint) : Array GpsPoint :=
  let informative := input.filter fun p =>
    match p.accuracy with | some acc => decide (acc ≤ ACCURACY_UNINFORMATIVE_M) | none => true
  let frozen := frozenJumpRunTs informative
  let points := informative.filter fun p => !frozen.contains p.ts
  if h : points.size ≤ 2 then points else walk points points[0] #[points[0]] 1

/-! ### What the filter can never do

Every output element is an input element, on every track. The walk only pushes
`points[i]` or `points[b]`: induction over its measure. -/

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

-- Teleport (t=20) and a poor-accuracy tube run (t=100) dropped; poor-accuracy
-- jitter (t=180, net < 800 m) kept.
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

Edges real days rarely reach: null accuracy, duplicate timestamps, a bridge scan
past its horizon. Expectations are recorded answers. -/

private def gpn (ts : Int) (lat lon : Float) : GpsPoint := ⟨ts, lat, lon, none⟩

-- `inaccurateMotion` → `none ⇒ false`, `trustworthy` → `none ⇒ true`. With no
-- accuracy anywhere only the speed ceiling can condemn a fix: the t=20 teleport
-- must still go, and t=30 must be trusted as its bridge with nothing to judge
-- its accuracy by.
private def nullAccuracy : Array GpsPoint := #[
  gpn 0 51.5 (-38.1), gpn 10 51.501 (-38.1), gpn 20 51.6 (-38.1), gpn 30 51.502 (-38.1), gpn 40 51.503 (-38.1)]
#guard (qualityFilterGps nullAccuracy).map (·.ts) == #[0, 10, 30, 40]

-- `impliedSpeedKmh` → `dt ≤ 0 ⇒ 0`: a fix at or before its anchor's timestamp
-- has no speed and is reachable, so every fix survives. Dividing would give
-- `inf` and drop them.
private def duplicateTs : Array GpsPoint := #[
  gp 0 51.5 (-38.1) 20, gp 0 51.6 (-38.1) 20, gp 10 51.501 (-38.1) 20, gp 5 51.7 (-38.1) 20, gp 20 51.502 (-38.1) 20]
#guard (qualityFilterGps duplicateTs).map (·.ts) == #[0, 0, 10, 5, 20]

-- `findBridge` → `none` at the `BRIDGE_WINDOW_S` horizon. The garbage fix at
-- t=100 has no surfacing fix within 1800 s (the next is t=2000), so the scan
-- gives up and the candidate is kept rather than bridged across half an hour.
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

-- `walk` → `speedUnreachable ∨ travelled`, only the left true: a teleport that
-- returns has no net displacement and is bridged on unreachability alone.
private def unreachableNotTravelled : Array GpsPoint := #[
  gp 0 51.5 (-38.1) 20, gp 10 51.5005 (-38.1) 20, gp 20 51.9 (-38.1) 20, gp 30 51.501 (-38.1) 20, gp 40 51.5015 (-38.1) 20]
#guard (qualityFilterGps unreachableNotTravelled).map (·.ts) == #[0, 10, 30, 40]

-- ACCURACY_CEILING_M, both sides. These two tracks differ only in 80 → 80.001
-- and must not agree: `>` keeps the fix at exactly the ceiling and drops the
-- one a thousandth over. `≥` in either comparison collapses them.
private def accuracyAtCeiling : Array GpsPoint := #[
  gp 0 51.5 (-38.1) 20, gp 10 51.501 (-38.1) 20, gp 100 51.52 (-38.1) 80, gp 160 51.53 (-38.1) 20, gp 170 51.531 (-38.1) 20]
#guard (qualityFilterGps accuracyAtCeiling).map (·.ts) == #[0, 10, 100, 160, 170]

private def accuracyOverCeiling : Array GpsPoint := #[
  gp 0 51.5 (-38.1) 20, gp 10 51.501 (-38.1) 20, gp 100 51.52 (-38.1) 80.001, gp 160 51.53 (-38.1) 20, gp 170 51.531 (-38.1) 20]
#guard (qualityFilterGps accuracyOverCeiling).map (·.ts) == #[0, 10, 160, 170]

-- ACCURACY_UNINFORMATIVE_M: the pre-filter. Same geometry as the jitter kept in
-- `track` above; only the stated accuracy differs. A train phone repeating one
-- coordinate at 37,880 m accuracy would let the Kalman coast and draw 29 km of
-- travel that never happened.
private def gpf (ts : Int) (acc : Float) : GpsPoint := ⟨ts, 50, 5, some acc⟩
private def disclaimed : Array GpsPoint := #[
  gpf 1000 10, gpf 1015 10, gpf 1030 10, gpf 1045 10,
  gpf 1060 835, gpf 1090 1500, gpf 1120 2136, gpf 1150 6045, gpf 1180 9365,
  gpf 1210 10660, gpf 1240 11963, gpf 1270 13265, gpf 1300 14564, gpf 1330 15865,
  gpf 1360 17162, gpf 1390 18462, gpf 1420 19762, gpf 1450 21060, gpf 1480 37880,
  gpf 1510 10, gpf 1525 10, gpf 1540 10, gpf 1555 10]
#guard (qualityFilterGps disclaimed).map (·.ts) == #[1000, 1015, 1030, 1045, 1510, 1525, 1540, 1555]

-- The pre-filter runs before the ≤2 pass-through, so a track that is short only
-- because most of it is disclaimed does not get waved past. A port that filters
-- after the size check keeps all three.
#guard (qualityFilterGps #[gpf 0 10, gpf 10 5000, gpf 20 10]).map (·.ts) == #[0, 20]

end Verified.Geo.GpsQuality
