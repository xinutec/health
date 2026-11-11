import Verified.Fix
/-!
# Per-minute observation tensor

Stitches the GPS / HR / step / sleep streams into one row per minute of a
local day (1440, or 1380 and 1500 on DST days): per-minute median lat/lon +
mean speed, mean HR, summed cadence, sleep-overlap `inBed`, watch-liveness
cadence imputation, and the forward/backward nearest-fix scans.

The one thing Lean cannot do, IANA-timezone resolution (hour/day-of-week, and
the day's UTC bounds), stays in the thin caller: this module takes `startUtc`,
the day's length in minutes, and a per-minute `localCtx` lookup as inputs.
Everything else is pure array logic over `median`/`mean`/sums, so it is bit-exact (no transcendentals; float
sums fold in a fixed order). UNPROVEN; pinned by the `#guard`s.
-/

namespace Verified.Hsmm.Observation

def SECONDS_PER_MINUTE : Int := 60
def WATCH_LIVENESS_WINDOW_MIN : Nat := 5

structure GpsPoint where
  ts : Int
  lat : Float
  lon : Float
  speedKmh : Float
  /-- The fix's reported horizontal accuracy in metres, when the capture
      carries it. -/
  accuracyM : Option Float := none

structure HrPoint where
  ts : Int
  bpm : Float

structure StepPoint where
  ts : Int
  steps : Float

/-- A sleep-stage interval; the stage label is irrelevant to `inBed` (any
    overlap marks the minute). -/
structure SleepRec where
  startTs : Int
  endTs : Int

structure GpsAgg where
  lat : Float
  lon : Float
  speedKmh : Float
  /-- The median reported accuracy of the minute's fixes, when any carries one. -/
  accuracyM : Option Float := none
  deriving BEq

/-- A nearest GPS fix (top-of-minute ts + coordinates). -/
abbrev Fix := Verified.GeoFix

structure ObsRow where
  ts : Int
  gps : Option GpsAgg
  hr : Option Float
  cadence : Option Float
  hourLocal : Nat
  dayOfWeekLocal : Nat
  inBed : Bool
  roadDistM : Option Float
  railDistM : Option Float
  prevGpsFix : Option Fix
  nextGpsFix : Option Fix
  /-- The minute's own first and last raw fix. `gps` is the minute's median,
      and on a minute straddling a ride's end that is a point between two
      stations; a boundary is read from the fix at it. -/
  firstFix : Option Fix := none
  lastFix : Option Fix := none
  deriving Inhabited, BEq

/-- `median`: sort ascending, then the middle (even length averages the two
    central values, in ascending order). Empty → 0. -/
def median (values : List Float) : Float :=
  if h0 : values.length = 0 then 0 else
  let sorted := (values.mergeSort (fun a b => decide (a ≤ b))).toArray
  have hs : sorted.size = values.length := by simp [sorted]
  let mid := sorted.size / 2
  have hmid : mid < sorted.size := by omega
  if h2 : sorted.size % 2 = 0 then
    have hm1 : mid - 1 < sorted.size := by omega
    (sorted[mid-1] + sorted[mid]) / 2
  else sorted[mid]

/-- `mean` — sum in original (insertion) order / length. Empty → 0. Order is
    load-bearing: float addition is not associative. -/
def mean (values : List Float) : Float :=
  if values.isEmpty then 0 else (values.foldl (· + ·) 0.0) / values.length.toFloat

/-- Minute index of a ts within the local day, or none when outside `[start, end)`. -/
def bucketIndex (startUtc endUtc ts : Int) : Option Nat :=
  if ts < startUtc || ts ≥ endUtc then none
  else some ((ts - startUtc) / SECONDS_PER_MINUTE).toNat

/-- Bucket a stream into `minutes` per-minute arrays, preserving input order
    within each minute (so downstream `mean` folds are order-fixed). -/
def bucketize {α : Type} (startUtc : Int) (minutes : Nat) (tsOf : α → Int) (xs : List α) :
    Array (Array α) :=
  let endUtc := startUtc + Int.ofNat minutes * SECONDS_PER_MINUTE
  xs.foldl (fun buckets x =>
    match bucketIndex startUtc endUtc (tsOf x) with
    | none => buckets
    | some m => buckets.modify m (·.push x)) (Array.replicate minutes #[])

private def ceilDiv (a b : Int) : Int := (a + b - 1) / b

/-- Per-minute `inBed`: true when any sleep record overlaps the minute. -/
def markInBed (startUtc : Int) (minutes : Nat) (sleep : List SleepRec) : Array Bool :=
  sleep.foldl (fun flags rec =>
    let startMin := max 0 ((rec.startTs - startUtc) / SECONDS_PER_MINUTE)
    let endMin := min (Int.ofNat minutes) (ceilDiv (rec.endTs - startUtc) SECONDS_PER_MINUTE)
    (List.range minutes).foldl (fun fs m =>
      if startMin ≤ (Int.ofNat m) && (Int.ofNat m) < endMin then fs.set! m true else fs) flags)
    (Array.replicate minutes false)

/-- Distance to the nearest alive minute at-or-before each index (0 if the
    minute itself is alive), or none when no alive minute precedes it. -/
private def prevAliveDist (alive : Array Bool) : Array (Option Nat) :=
  (List.range alive.size).foldl
    (fun (st : (Option Nat) × Array (Option Nat)) m =>
      let last := if alive[m]?.getD false then some m else st.1
      (last, st.2.push (last.map (fun l => m - l))))
    (none, #[]) |>.2

private def nextAliveDist (alive : Array Bool) : Array (Option Nat) :=
  ((List.range alive.size).reverse.foldl
    (fun (st : (Option Nat) × Array (Option Nat)) m =>
      let next := if alive[m]?.getD false then some m else st.1
      (next, st.2.push (next.map (fun nx => nx - m))))
    (none, #[]) |>.2).reverse

/-- Build the observation tensor, one row for each of the day's `minutes`.
    `localCtx m = (hourLocal, dayOfWeek)` and
    `proximityAt ts = (roadDistM?, railDistM?)` are caller-resolved (tz / OSM);
    everything else is computed here. -/
def buildObservationTensor
    (startUtc : Int) (minutes : Nat)
    (points : List GpsPoint) (hr : List HrPoint) (steps : List StepPoint)
    (sleep : List SleepRec)
    (localCtx : Nat → Nat × Nat)
    (proximityAt : Int → Option Float × Option Float) : Array ObsRow :=
  let gpsB := bucketize startUtc minutes GpsPoint.ts points
  let hrB := bucketize startUtc minutes HrPoint.ts hr
  let stepB := bucketize startUtc minutes StepPoint.ts steps
  let inBed := markInBed startUtc minutes sleep
  -- Pass 1: per-minute aggregates.
  let gpsArr : Array (Option GpsAgg) := (List.range minutes).foldl (fun a m =>
    let rows := gpsB[m]?.getD #[]
    a.push (if rows.isEmpty then none else
      let accs := rows.toList.filterMap GpsPoint.accuracyM
      some ⟨median (rows.toList.map GpsPoint.lat), median (rows.toList.map GpsPoint.lon),
            mean (rows.toList.map GpsPoint.speedKmh),
            if accs.isEmpty then none else some (median accs)⟩)) #[]
  let hrArr : Array (Option Float) := (List.range minutes).foldl (fun a m =>
    let rows := hrB[m]?.getD #[]
    a.push (if rows.isEmpty then none else some (mean (rows.toList.map HrPoint.bpm)))) #[]
  let cad0 : Array (Option Float) := (List.range minutes).foldl (fun a m =>
    let rows := stepB[m]?.getD #[]
    a.push (if rows.isEmpty then none else some (rows.foldl (fun s x => s + x.steps) 0.0))) #[]
  -- Pass 2: watch-liveness cadence imputation.
  let alive : Array Bool := (List.range minutes).foldl (fun a m =>
    a.push (!(stepB[m]?.getD #[]).isEmpty || !(hrB[m]?.getD #[]).isEmpty)) #[]
  let dayHasStepRows := (List.range minutes).any (fun m => !(stepB[m]?.getD #[]).isEmpty)
  let cad : Array (Option Float) :=
    if dayHasStepRows then
      let pd := prevAliveDist alive
      let nd := nextAliveDist alive
      (List.range minutes).foldl (fun a m =>
        let c0 := cad0[m]?.getD none
        let impute := c0.isNone
          && (match pd[m]?.getD none with | some d => d ≤ WATCH_LIVENESS_WINDOW_MIN | none => false)
          && (match nd[m]?.getD none with | some d => d ≤ WATCH_LIVENESS_WINDOW_MIN | none => false)
        a.push (if impute then some 0 else c0)) #[]
    else cad0
  -- Pass 3: forward prev-fix, backward next-fix.
  let prevArr : Array (Option Fix) := (List.range minutes).foldl
    (fun (st : (Option Fix) × Array (Option Fix)) m =>
      let ts := startUtc + (Int.ofNat m) * SECONDS_PER_MINUTE
      let running := match gpsArr[m]?.getD none with | some g => some ⟨ts, g.lat, g.lon⟩ | none => st.1
      (running, st.2.push running)) (none, #[]) |>.2
  let nextArr : Array (Option Fix) := ((List.range minutes).reverse.foldl
    (fun (st : (Option Fix) × Array (Option Fix)) m =>
      let ts := startUtc + (Int.ofNat m) * SECONDS_PER_MINUTE
      let running := match gpsArr[m]?.getD none with | some g => some ⟨ts, g.lat, g.lon⟩ | none => st.1
      (running, st.2.push running)) (none, #[]) |>.2).reverse
  -- Assemble.
  (List.range minutes).foldl (fun a m =>
    let ts := startUtc + (Int.ofNat m) * SECONDS_PER_MINUTE
    let (hour, dow) := localCtx m
    let (road, rail) := proximityAt ts
    a.push {
      ts, gps := gpsArr[m]?.getD none, hr := hrArr[m]?.getD none, cadence := cad[m]?.getD none,
      hourLocal := hour, dayOfWeekLocal := dow, inBed := inBed[m]?.getD false,
      roadDistM := road, railDistM := rail,
      prevGpsFix := prevArr[m]?.getD none, nextGpsFix := nextArr[m]?.getD none,
      firstFix := (gpsB[m]?.getD #[]).foldl (fun (acc : Option Fix) p =>
        match acc with
        | some f => if p.ts < f.ts then some ⟨p.ts, p.lat, p.lon⟩ else acc
        | none => some ⟨p.ts, p.lat, p.lon⟩) none,
      lastFix := (gpsB[m]?.getD #[]).foldl (fun (acc : Option Fix) p =>
        match acc with
        | some f => if p.ts > f.ts then some ⟨p.ts, p.lat, p.lon⟩ else acc
        | none => some ⟨p.ts, p.lat, p.lon⟩) none }) #[]

/-- The first minute whose row differs between two tensors, `none` when every
    row agrees: where a decode of the later one stops matching the earlier. -/
def firstDiff (a b : Array ObsRow) : Option Nat :=
  (List.range (max a.size b.size)).find? fun m => a[m]? != b[m]?

-- `buildObservationTensor`'s reference values.
private def gp (relTs : Int) (lat lon spd : Float) : GpsPoint := ⟨1784156400 + relTs, lat, lon, spd, none⟩
private def hp (relTs : Int) (bpm : Float) : HrPoint := ⟨1784156400 + relTs, bpm⟩
private def sp (relTs : Int) (n : Float) : StepPoint := ⟨1784156400 + relTs, n⟩

private def pts : List GpsPoint :=
  [gp 5 51.5 (-0.1) 4, gp 40 51.52 (-0.12) 6, gp 70 51.53 (-0.13) 5,
   gp 430 51.6 (-0.2) 3, gp 490 51.61 (-0.21) 2]
private def hrs : List HrPoint := [hp 20 60, hp 50 70, hp 210 80, hp 425 72]
private def stps : List StepPoint := [sp 60 50, sp 480 30]

private def tensor : Array ObsRow :=
  buildObservationTensor 1784156400 1440 pts hrs stps [] (fun _ => (0, 0)) (fun _ => (none, none))

/-- Project a minute to the fields the reference pins (fix ts shown relative to
    startUtc). -/
private def proj (o : ObsRow) :
    Option (Float × Float × Float) × Option Float × Option Float
      × Option (Int × Float × Float) × Option (Int × Float × Float) :=
  (o.gps.map (fun g => (g.lat, g.lon, g.speedKmh)), o.hr, o.cadence,
   o.prevGpsFix.map (fun f => (f.ts - 1784156400, f.lat, f.lon)),
   o.nextGpsFix.map (fun f => (f.ts - 1784156400, f.lat, f.lon)))

#guard proj tensor[0]! ==
  (some (51.510000000000005, -0.11, 5), some 65, some 0,
   some (0, 51.510000000000005, -0.11), some (0, 51.510000000000005, -0.11))
#guard proj tensor[1]! ==
  (some (51.53, -0.13, 5), none, some 50, some (60, 51.53, -0.13), some (60, 51.53, -0.13))
#guard proj tensor[2]! ==
  (none, none, some 0, some (60, 51.53, -0.13), some (420, 51.6, -0.2))
#guard proj tensor[3]! ==
  (none, some 80, some 0, some (60, 51.53, -0.13), some (420, 51.6, -0.2))
#guard proj tensor[6]! ==
  (none, none, some 0, some (60, 51.53, -0.13), some (420, 51.6, -0.2))
#guard proj tensor[7]! ==
  (some (51.6, -0.2, 3), some 72, some 0, some (420, 51.6, -0.2), some (420, 51.6, -0.2))
#guard proj tensor[8]! ==
  (some (51.61, -0.21, 2), none, some 30, some (480, 51.61, -0.21), some (480, 51.61, -0.21))
#guard proj tensor[9]! ==
  (none, none, none, some (480, 51.61, -0.21), none)

-- The same day before its last two fixes arrived: the fix at minute 7 reaches
-- back over the dark minutes 2–6 (`nextGpsFix`), so they are the first to move.
private def tensorEarly : Array ObsRow :=
  buildObservationTensor 1784156400 1440 (pts.take 3) hrs stps [] (fun _ => (0, 0)) (fun _ => (none, none))
#guard firstDiff tensor tensor == none
#guard firstDiff tensorEarly tensor == some 2

-- inBed marking: a record covering [start+90s, start+150s] marks minutes 1 and 2.
#guard (markInBed 1784156400 1440 [⟨1784156400 + 90, 1784156400 + 150⟩])[1]! == true
#guard (markInBed 1784156400 1440 [⟨1784156400 + 90, 1784156400 + 150⟩])[2]! == true
#guard (markInBed 1784156400 1440 [⟨1784156400 + 90, 1784156400 + 150⟩])[0]! == false
#guard (markInBed 1784156400 1440 [⟨1784156400 + 90, 1784156400 + 150⟩])[3]! == false

-- A DST day's tensor is as long as the day: a 25-hour day keeps its last hour.
#guard (buildObservationTensor 1784156400 1500 [gp 89940 51.5 (-0.1) 4] [] [] []
          (fun _ => (0, 0)) (fun _ => (none, none))).size == 1500
#guard ((buildObservationTensor 1784156400 1500 [gp 89940 51.5 (-0.1) 4] [] [] []
          (fun _ => (0, 0)) (fun _ => (none, none)))[1499]!.gps).isSome

end Verified.Hsmm.Observation
