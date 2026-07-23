/-!
# Per-minute observation tensor (implementation-first port of `observation.ts`)

Stitches the GPS / HR / step / sleep streams into one 1440-row day: per-minute
median lat/lon + mean speed, mean HR, summed cadence, sleep-overlap `inBed`,
watch-liveness cadence imputation, reacquire-age after GPS gaps, and the
forward/backward nearest-fix scans.

The one thing Lean cannot do — IANA-timezone resolution (`Intl.DateTimeFormat`
for hour/day-of-week, and the day's UTC bounds) — stays in the thin caller: this
module takes `startUtc` and a per-minute `localCtx` lookup as inputs. Everything
else is pure array logic over `median`/`mean`/sums, so it is BIT-EXACT with TS
(no transcendentals; float sums fold in the same order V8 uses). UNPROVEN;
pinned by the `#guard`s.
-/

namespace Verified.Hsmm.Observation

def MINUTES_PER_DAY : Nat := 1440
def SECONDS_PER_MINUTE : Int := 60
def WATCH_LIVENESS_WINDOW_MIN : Nat := 5
def REACQUIRE_GAP_MIN : Nat := 5

structure GpsPoint where
  ts : Int
  lat : Float
  lon : Float
  speedKmh : Float

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
  deriving BEq

/-- A nearest GPS fix (top-of-minute ts + coordinates). -/
structure Fix where
  ts : Int
  lat : Float
  lon : Float
  deriving BEq

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
  reacquireAgeMin : Option Int
  prevGpsFix : Option Fix
  nextGpsFix : Option Fix
  deriving Inhabited

/-- `median` — JS `sort((a,b)=>a-b)` then middle (even length averages the two
    central values, in ascending order, exactly as TS does). Empty → 0. -/
def median (values : List Float) : Float :=
  if values.isEmpty then 0 else
  let sorted := (values.mergeSort (fun a b => decide (a ≤ b))).toArray
  let n := sorted.size
  let mid := n / 2
  if n % 2 == 0 then (sorted[mid-1]! + sorted[mid]!) / 2 else sorted[mid]!

/-- `mean` — sum in original (insertion) order / length. Empty → 0. Order is
    load-bearing: float addition is not associative. -/
def mean (values : List Float) : Float :=
  if values.isEmpty then 0 else (values.foldl (· + ·) 0.0) / values.length.toFloat

/-- Minute index of a ts within the local day, or none when outside `[start, end)`. -/
def bucketIndex (startUtc endUtc ts : Int) : Option Nat :=
  if ts < startUtc || ts ≥ endUtc then none
  else
    let m := ((ts - startUtc) / SECONDS_PER_MINUTE).toNat
    if m ≥ MINUTES_PER_DAY then none else some m

private def emptyBuckets {α : Type} : Array (Array α) :=
  (List.replicate MINUTES_PER_DAY (#[] : Array α)).toArray

/-- Bucket a stream into per-minute arrays, preserving input order within each
    minute (so downstream `mean` folds match V8's iteration order). -/
def bucketize {α : Type} (startUtc endUtc : Int) (tsOf : α → Int) (xs : List α) : Array (Array α) :=
  xs.foldl (fun buckets x =>
    match bucketIndex startUtc endUtc (tsOf x) with
    | none => buckets
    | some m => buckets.modify m (·.push x)) emptyBuckets

private def ceilDiv (a b : Int) : Int := (a + b - 1) / b

/-- Per-minute `inBed`: true when any sleep record overlaps the minute. -/
def markInBed (startUtc : Int) (sleep : List SleepRec) : Array Bool :=
  sleep.foldl (fun flags rec =>
    let startMin := max 0 ((rec.startTs - startUtc) / SECONDS_PER_MINUTE)
    let endMin := min (Int.ofNat MINUTES_PER_DAY) (ceilDiv (rec.endTs - startUtc) SECONDS_PER_MINUTE)
    (List.range MINUTES_PER_DAY).foldl (fun fs m =>
      if startMin ≤ (Int.ofNat m) && (Int.ofNat m) < endMin then fs.set! m true else fs) flags)
    ((List.replicate MINUTES_PER_DAY false).toArray)

/-- Distance to the nearest alive minute at-or-before each index (0 if the
    minute itself is alive), or none when no alive minute precedes it. -/
private def prevAliveDist (alive : Array Bool) : Array (Option Nat) :=
  (List.range MINUTES_PER_DAY).foldl
    (fun (st : (Option Nat) × Array (Option Nat)) m =>
      let last := if alive[m]! then some m else st.1
      (last, st.2.push (last.map (fun l => m - l))))
    (none, #[]) |>.2

private def nextAliveDist (alive : Array Bool) : Array (Option Nat) :=
  ((List.range MINUTES_PER_DAY).reverse.foldl
    (fun (st : (Option Nat) × Array (Option Nat)) m =>
      let next := if alive[m]! then some m else st.1
      (next, st.2.push (next.map (fun nx => nx - m))))
    (none, #[]) |>.2).reverse

/-- Reacquire age per minute: a bright run following a ≥`REACQUIRE_GAP_MIN`
    fixless gap gets 0,1,2,… from its first fix; shorter-gap runs and fixless
    minutes stay none. Day start counts as being in a gap. -/
def reacquireAges (gpsPresent : Array Bool) : Array (Option Int) :=
  (List.range MINUTES_PER_DAY).foldl
    (fun (st : (Nat × Bool × Nat) × Array (Option Int)) m =>
      let (gapLen, runQualifies, ageInRun) := st.1
      if !gpsPresent[m]! then
        ((gapLen + 1, runQualifies, ageInRun), st.2.push none)
      else if gapLen > 0 then
        let q := gapLen ≥ REACQUIRE_GAP_MIN
        ((0, q, 0), st.2.push (if q then some 0 else none))
      else
        let age := ageInRun + 1
        ((0, runQualifies, age), st.2.push (if runQualifies then some (Int.ofNat age) else none)))
    ((REACQUIRE_GAP_MIN, false, 0), #[]) |>.2

/-- Build the observation tensor. `localCtx m = (hourLocal, dayOfWeek)` and
    `proximityAt ts = (roadDistM?, railDistM?)` are caller-resolved (tz / OSM);
    everything else is computed here. -/
def buildObservationTensor
    (startUtc : Int)
    (points : List GpsPoint) (hr : List HrPoint) (steps : List StepPoint)
    (sleep : List SleepRec)
    (localCtx : Nat → Nat × Nat)
    (proximityAt : Int → Option Float × Option Float)
    (imputeCadence : Bool) : Array ObsRow :=
  let endUtc := startUtc + (Int.ofNat MINUTES_PER_DAY) * SECONDS_PER_MINUTE
  let gpsB := bucketize startUtc endUtc GpsPoint.ts points
  let hrB := bucketize startUtc endUtc HrPoint.ts hr
  let stepB := bucketize startUtc endUtc StepPoint.ts steps
  let inBed := markInBed startUtc sleep
  -- Pass 1: per-minute aggregates.
  let gpsArr : Array (Option GpsAgg) := (List.range MINUTES_PER_DAY).foldl (fun a m =>
    let rows := gpsB[m]!
    a.push (if rows.isEmpty then none else
      some ⟨median (rows.toList.map GpsPoint.lat), median (rows.toList.map GpsPoint.lon),
            mean (rows.toList.map GpsPoint.speedKmh)⟩)) #[]
  let hrArr : Array (Option Float) := (List.range MINUTES_PER_DAY).foldl (fun a m =>
    let rows := hrB[m]!
    a.push (if rows.isEmpty then none else some (mean (rows.toList.map HrPoint.bpm)))) #[]
  let cad0 : Array (Option Float) := (List.range MINUTES_PER_DAY).foldl (fun a m =>
    let rows := stepB[m]!
    a.push (if rows.isEmpty then none else some (rows.foldl (fun s x => s + x.steps) 0.0))) #[]
  -- Pass 2: watch-liveness cadence imputation.
  let alive : Array Bool := (List.range MINUTES_PER_DAY).foldl (fun a m =>
    a.push (!stepB[m]!.isEmpty || !hrB[m]!.isEmpty)) #[]
  let dayHasStepRows := (List.range MINUTES_PER_DAY).any (fun m => !stepB[m]!.isEmpty)
  let cad : Array (Option Float) :=
    if imputeCadence && dayHasStepRows then
      let pd := prevAliveDist alive
      let nd := nextAliveDist alive
      (List.range MINUTES_PER_DAY).foldl (fun a m =>
        let impute := cad0[m]!.isNone
          && (match pd[m]! with | some d => d ≤ WATCH_LIVENESS_WINDOW_MIN | none => false)
          && (match nd[m]! with | some d => d ≤ WATCH_LIVENESS_WINDOW_MIN | none => false)
        a.push (if impute then some 0 else cad0[m]!)) #[]
    else cad0
  -- Pass 3: reacquire age.
  let gpsPresent : Array Bool := gpsArr.map Option.isSome
  let reacq := reacquireAges gpsPresent
  -- Pass 4: forward prev-fix, backward next-fix.
  let prevArr : Array (Option Fix) := (List.range MINUTES_PER_DAY).foldl
    (fun (st : (Option Fix) × Array (Option Fix)) m =>
      let ts := startUtc + (Int.ofNat m) * SECONDS_PER_MINUTE
      let running := match gpsArr[m]! with | some g => some ⟨ts, g.lat, g.lon⟩ | none => st.1
      (running, st.2.push running)) (none, #[]) |>.2
  let nextArr : Array (Option Fix) := ((List.range MINUTES_PER_DAY).reverse.foldl
    (fun (st : (Option Fix) × Array (Option Fix)) m =>
      let ts := startUtc + (Int.ofNat m) * SECONDS_PER_MINUTE
      let running := match gpsArr[m]! with | some g => some ⟨ts, g.lat, g.lon⟩ | none => st.1
      (running, st.2.push running)) (none, #[]) |>.2).reverse
  -- Assemble.
  (List.range MINUTES_PER_DAY).foldl (fun a m =>
    let ts := startUtc + (Int.ofNat m) * SECONDS_PER_MINUTE
    let (hour, dow) := localCtx m
    let (road, rail) := proximityAt ts
    a.push {
      ts, gps := gpsArr[m]!, hr := hrArr[m]!, cadence := cad[m]!,
      hourLocal := hour, dayOfWeekLocal := dow, inBed := inBed[m]!,
      roadDistM := road, railDistM := rail, reacquireAgeMin := reacq[m]!,
      prevGpsFix := prevArr[m]!, nextGpsFix := nextArr[m]! }) #[]

-- Parity with the real `buildObservationTensor` (values from Node/V8).
private def gp (relTs : Int) (lat lon spd : Float) : GpsPoint := ⟨1784156400 + relTs, lat, lon, spd⟩
private def hp (relTs : Int) (bpm : Float) : HrPoint := ⟨1784156400 + relTs, bpm⟩
private def sp (relTs : Int) (n : Float) : StepPoint := ⟨1784156400 + relTs, n⟩

private def pts : List GpsPoint :=
  [gp 5 51.5 (-0.1) 4, gp 40 51.52 (-0.12) 6, gp 70 51.53 (-0.13) 5,
   gp 430 51.6 (-0.2) 3, gp 490 51.61 (-0.21) 2]
private def hrs : List HrPoint := [hp 20 60, hp 50 70, hp 210 80, hp 425 72]
private def stps : List StepPoint := [sp 60 50, sp 480 30]

private def tensor : Array ObsRow :=
  buildObservationTensor 1784156400 pts hrs stps [] (fun _ => (0, 0)) (fun _ => (none, none)) true

/-- Project a minute to the fields the reference pins (fix ts shown relative to
    startUtc). -/
private def proj (o : ObsRow) :
    Option (Float × Float × Float) × Option Float × Option Float × Option Int
      × Option (Int × Float × Float) × Option (Int × Float × Float) :=
  (o.gps.map (fun g => (g.lat, g.lon, g.speedKmh)), o.hr, o.cadence, o.reacquireAgeMin,
   o.prevGpsFix.map (fun f => (f.ts - 1784156400, f.lat, f.lon)),
   o.nextGpsFix.map (fun f => (f.ts - 1784156400, f.lat, f.lon)))

#guard proj tensor[0]! ==
  (some (51.510000000000005, -0.11, 5), some 65, some 0, some 0,
   some (0, 51.510000000000005, -0.11), some (0, 51.510000000000005, -0.11))
#guard proj tensor[1]! ==
  (some (51.53, -0.13, 5), none, some 50, some 1, some (60, 51.53, -0.13), some (60, 51.53, -0.13))
#guard proj tensor[2]! ==
  (none, none, some 0, none, some (60, 51.53, -0.13), some (420, 51.6, -0.2))
#guard proj tensor[3]! ==
  (none, some 80, some 0, none, some (60, 51.53, -0.13), some (420, 51.6, -0.2))
#guard proj tensor[6]! ==
  (none, none, some 0, none, some (60, 51.53, -0.13), some (420, 51.6, -0.2))
#guard proj tensor[7]! ==
  (some (51.6, -0.2, 3), some 72, some 0, some 0, some (420, 51.6, -0.2), some (420, 51.6, -0.2))
#guard proj tensor[8]! ==
  (some (51.61, -0.21, 2), none, some 30, some 1, some (480, 51.61, -0.21), some (480, 51.61, -0.21))
#guard proj tensor[9]! ==
  (none, none, none, none, some (480, 51.61, -0.21), none)

-- inBed marking: a record covering [start+90s, start+150s] marks minutes 1 and 2.
#guard (markInBed 1784156400 [⟨1784156400 + 90, 1784156400 + 150⟩])[1]! == true
#guard (markInBed 1784156400 [⟨1784156400 + 90, 1784156400 + 150⟩])[2]! == true
#guard (markInBed 1784156400 [⟨1784156400 + 90, 1784156400 + 150⟩])[0]! == false
#guard (markInBed 1784156400 [⟨1784156400 + 90, 1784156400 + 150⟩])[3]! == false

end Verified.Hsmm.Observation
