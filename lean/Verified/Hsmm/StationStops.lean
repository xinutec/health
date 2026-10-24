import Verified.Hsmm.StationChain
import Verified.Hsmm.StopCalls

/-!
# The stations a day's fixes pass

A minute's position is the median of its fixes, and at speed a minute covers a
kilometre, so a station a train runs through is seldom within reach of any one
minute: it is passed where it lies within `StationChain.STATION_PASS_M` of the
straight path between two consecutive minutes' positions (06-12: four of the
five Jubilee-only stations between Wembley Park and Finchley Road were within
reach of no minute of a Metropolitan ride, all five of its path). A pass is a
run of consecutive such minutes; its observation is the slowest minute whose own
position is within reach — a train calling there stands in it — else the speed
between the two positions either side, at which the train went by. A minute
without a fix of its own has no position and ends a run.
-/

namespace Verified.Hsmm.StationStops

open Verified.Hsmm

structure Pass where
  station : String
  /-- The pass's minute (its slowest within reach, else its first), and its speed. -/
  t : Nat
  speedKmh : Float
  /-- The run's first and last minute: a leg is scored on the passes wholly
      inside it, so the wait at its board station and the arrival at its
      alight station, which touch its ends, are not calls. -/
  first : Nat
  last : Nat
  deriving Inhabited, Repr, BEq

/-- Metres per degree of latitude (`FloatScore.haversineMeters`' sphere). -/
def M_PER_DEG : Float := 111194.92664455873
def SECONDS_PER_HOUR : Float := 3600
def M_PER_KM : Float := 1000
def DEG_TO_RAD : Float := 0.017453292519943295
def ZERO : Float := 0
def ONE : Float := 1

/-- The distance from `p` to the segment `a`–`b` in metres, on the local plane
    at `a` (a minute's path is a kilometre or two). -/
def segmentDistM (pLat pLon aLat aLon bLat bLon : Float) : Float :=
  let k := Float.cos (aLat * DEG_TO_RAD)
  let bx := (bLon - aLon) * k * M_PER_DEG
  let by_ := (bLat - aLat) * M_PER_DEG
  let px := (pLon - aLon) * k * M_PER_DEG
  let py := (pLat - aLat) * M_PER_DEG
  let len2 := bx * bx + by_ * by_
  let u := if len2 > ZERO then max ZERO (min ONE ((px * bx + py * by_) / len2)) else ZERO
  let dx := px - u * bx
  let dy := py - u * by_
  Float.sqrt (dx * dx + dy * dy)

/-- Every pass of the day, in minute order. -/
def passes (g : StationChain.ChainGraph) (obs : Array Observation.ObsRow) : Array Pass := Id.run do
  let R := StationChain.STATION_PASS_M
  -- Per station, per minute near it: the minute's own speed when its position
  -- is within reach, and the speed of its path to the next minute.
  let mut names : Array String := #[]
  let mut near : Std.HashMap String (Array (Nat × Option Float × Option Float)) := {}
  for t in [0:obs.size] do
    let some o := obs[t]? | continue
    let some a := o.gps | continue
    let nxt := (obs[t + 1]?).bind fun o2 => o2.gps.map fun b => (b, o2.ts - o.ts)
    let pairKmh := nxt.map fun (b, dt) =>
      FloatScore.haversineMeters a.lat a.lon b.lat b.lon / Float.ofInt dt * SECONDS_PER_HOUR / M_PER_KM
    let mut seen : Array String := #[]
    for n in g.nodes do
      let some nm := n.stationName | continue
      if seen.contains nm then continue
      let own := FloatScore.haversineMeters a.lat a.lon n.lat n.lon ≤ R
      let onPath := match nxt with
        | some (b, _) => segmentDistM n.lat n.lon a.lat a.lon b.lat b.lon ≤ R
        | none => false
      if !own && !onPath then continue
      seen := seen.push nm
      if !near.contains nm then names := names.push nm
      near := near.insert nm ((near.getD nm #[]).push
        (t, (if own then some a.speedKmh else none), (if onPath then pairKmh else none)))
  let mut out : Array Pass := #[]
  for nm in names do
    let ms := near.getD nm #[]
    let mut i := 0
    while i < ms.size do
      let mut j := i
      while j + 1 < ms.size && ms[j + 1]!.1 == ms[j]!.1 + 1 do j := j + 1
      -- The slowest minute within reach, else the slowest path past it.
      let mut own : Option (Nat × Float) := none
      let mut path : Option (Nat × Float) := none
      for k in [i : j + 1] do
        let (t, sv, pv) := ms[k]!
        if let some v := sv then
          if own.all (v < ·.2) then own := some (t, v)
        if let some v := pv then
          if path.all (v < ·.2) then path := some (t, v)
      match own.orElse fun _ => path with
      | some (t, v) => out := out.push { station := nm, t, speedKmh := v, first := ms[i]!.1, last := ms[j]!.1 }
      | none => pure ()
      i := j + 1
  return out.qsort fun a b => a.t < b.t || (a.t == b.t && a.station < b.station)

-- A station 50 m off the path between two minutes a kilometre apart is passed;
-- one 500 m off is not.
#guard segmentDistM 51.505 (-0.1) 51.5 (-0.1) 51.51 (-0.1) < 1
#guard segmentDistM 51.505 (-0.0928) 51.5 (-0.1) 51.51 (-0.1) > 450
#guard segmentDistM 51.505 (-0.0928) 51.5 (-0.1) 51.51 (-0.1) < 550

/-- Per minute, the calling evidence for `line` at the passes whose run begins
    in that minute, leaving out the passes at `skip` (a leg's own board
    station): `calls` answers whether the line calls at a station. -/
def lineEvidence (p : StopCalls.Params) (ps : Array Pass) (T : Nat)
    (calls : String → Bool) (skip : Option String := none) : FloatArray := Id.run do
  let mut out := FloatArray.mk (Array.replicate T 0)
  for q in ps do
    if skip == some q.station then continue
    if q.first < T && calls q.station then
      out := out.set! q.first (out.get! q.first + StopCalls.callRatio p q.speedKmh)
  return out

/-- Per minute `e`, the evidence of the passes whose run is under way at `e`
    (begun before it, not yet over), and the earliest such run's first minute:
    what a leg ending at `e` takes back from `lineEvidence`'s sum. -/
def activeEvidence (p : StopCalls.Params) (ps : Array Pass) (T : Nat)
    (calls : String → Bool) (skip : Option String := none) : FloatArray × Array Nat := Id.run do
  let mut sum := FloatArray.mk (Array.replicate T 0)
  let mut first := Array.replicate T T
  for q in ps do
    if skip == some q.station || !calls q.station then continue
    for e in [q.first + 1 : min T (q.last + 1)] do
      sum := sum.set! e (sum.get! e + StopCalls.callRatio p q.speedKmh)
      first := first.set! e (min first[e]! q.first)
  return (sum, first)

/-- A prefix sum: `pre[t]` sums the minutes before `t`. -/
def prefixSum (xs : FloatArray) : FloatArray := Id.run do
  let mut out := FloatArray.mk (Array.replicate (xs.size + 1) 0)
  let mut acc : Float := 0
  for t in [0:xs.size] do
    acc := acc + xs.get! t
    out := out.set! (t + 1) acc
  return out

end Verified.Hsmm.StationStops
