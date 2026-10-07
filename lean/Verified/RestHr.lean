import Std.Data.HashMap
import Std.Data.HashSet
import Verified.FloatConst
/-!
# Heart rate awake and at rest, compared like with like

A raw heart-rate line mixes effort, posture, food, heat and stress. This is the
first context view: the minutes he is awake and not stepping, read as a day's
distribution rather than a single number. Never a single reading:

* a sample more than `SPIKE_BPM` off the median of the samples within 30 s of
  it is dropped (a wrist sensor spikes on movement, strap and cold);
* a minute's heart rate is the median of its kept samples;
* a minute is AT REST when it has heart rate (the watch is worn), no steps,
  and is not inside a sleep stage other than wake;
* runs of at least `MIN_RUN` rest minutes count, minus their first `SETTLE`
  minutes (still settling after sitting down);
* what is left is cut into `BLOCK`-minute blocks, each block's median taken;
  the day is the median of its blocks, with the 25th–75th and 5th–95th
  percentiles so a noisy day reads noisy rather than high.

A day with no sleep record is not measured: its night would read as rest.

The rules and constants are the prototype's (`hr_context.py` in the case file),
with one input changed: movement is the watch's per-minute steps here, where the
prototype had to infer stillness from location fixes.
-/

namespace Verified.RestHr

def SPIKE_BPM : Nat := 25
def SPIKE_WINDOW_S : Int := 30
def MIN_RUN : Nat := 15
def SETTLE : Nat := 5
def BLOCK : Nat := 5

/-- The median of a non-empty list of floats: the middle one, or the mean of
the two middles (Python's `statistics.median`). `0` for an empty list, which
no caller passes. -/
def median (xs : Array Float) : Float :=
  let s := xs.qsort (· < ·)
  let n := s.size
  if n == 0 then 0
  else if n % 2 == 1 then s[n / 2]!
  else (s[n / 2 - 1]! + s[n / 2]!) / 2

/-- Round half to even, as Python's `round` on a float that is an exact half. -/
private def roundHalfEven (x : Float) : Nat :=
  let f := x.floor
  let d := x - f
  let n := f.toUInt64.toNat
  if d > 0.5 then n + 1 else if d < 0.5 then n
  else if n % 2 == 0 then n else n + 1

/-- The prototype's percentile: the element at `round(q · (n − 1))` of the
sorted values. -/
def pct (xs : Array Float) (q : Float) : Float :=
  let s := xs.qsort (· < ·)
  if s.isEmpty then 0
  else s[min (s.size - 1) (roundHalfEven (q * Verified.FloatConst.natToFloat (s.size - 1)))]!

/-- Samples `(unix seconds, bpm)` with spikes removed: each is kept when it is
within `SPIKE_BPM` of the median of every sample within `SPIKE_WINDOW_S` of it
(itself included). Expects `samples` sorted by time. -/
def despike (samples : Array (Int × Nat)) : Array (Int × Nat) := Id.run do
  let mut out : Array (Int × Nat) := #[]
  let mut lo := 0
  let mut hi := 0
  for i in [0:samples.size] do
    let (t, v) := samples[i]!
    while lo < samples.size && samples[lo]!.1 < t - SPIKE_WINDOW_S do lo := lo + 1
    while hi < samples.size && samples[hi]!.1 ≤ t + SPIKE_WINDOW_S do hi := hi + 1
    let window := (samples.extract lo hi).map fun (_, b) => Verified.FloatConst.natToFloat b
    if (Verified.FloatConst.natToFloat v - median window).abs ≤ Verified.FloatConst.natToFloat SPIKE_BPM then out := out.push (t, v)
  return out

/-- Consecutive runs of an ascending list of minute indices. -/
def runs (minutes : Array Int) : Array (Array Int) := Id.run do
  let mut out : Array (Array Int) := #[]
  for m in minutes do
    match out.back? with
    | some r =>
      if r.back? == some (m - 1) then out := out.set! (out.size - 1) (r.push m)
      else out := out.push #[m]
    | none => out := out.push #[m]
  return out

structure Day where
  medianBpm : Float
  p25 : Float
  p75 : Float
  p05 : Float
  p95 : Float
  /-- Minutes behind the figure: blocks × `BLOCK`. -/
  restMinutes : Nat
  deriving Repr, BEq

/-- The day's awake-at-rest heart rate, or `none` when the day has no sleep
record or no settled run long enough to measure.

`samples` are `(unix seconds, bpm)` sorted by time; `stepMinutes` the minute
indices (unix seconds ÷ 60) with steps; `sleep` the `[start, end)` spans in
unix seconds of every sleep stage but wake; `dayStart`/`dayEnd` the local day's
bounds in unix seconds. -/
def restDay (samples : Array (Int × Nat)) (stepMinutes : Array Int)
    (sleep : Array (Int × Int)) (dayStart dayEnd : Int) : Option Day := Id.run do
  if sleep.isEmpty then return none
  let kept := despike samples
  -- Per-minute median, minutes inside the day only.
  let mut byMinute : Std.HashMap Int (Array Float) := {}
  for (t, v) in kept do
    if t < dayStart || t ≥ dayEnd then continue
    let m := t.fdiv 60
    byMinute := byMinute.insert m ((byMinute.getD m #[]).push (Verified.FloatConst.natToFloat v))
  let steps : Std.HashSet Int := stepMinutes.foldl (·.insert ·) {}
  let asleepAt := fun (m : Int) =>
    sleep.any fun (s, e) => s.fdiv 60 ≤ m && m < e.fdiv 60
  let rest := ((byMinute.toArray.map (·.1)).qsort (· < ·)).filter fun m =>
    !steps.contains m && !asleepAt m
  let mut blocks : Array Float := #[]
  for r in runs rest do
    if r.size < MIN_RUN then continue
    let r := r.extract SETTLE r.size
    let mut i := 0
    while i + BLOCK ≤ r.size do
      blocks := blocks.push (median ((r.extract i (i + BLOCK)).map fun m =>
        median (byMinute.getD m #[])))
      i := i + BLOCK
  if blocks.isEmpty then return none
  return some { medianBpm := median blocks, p25 := pct blocks 0.25, p75 := pct blocks 0.75
                p05 := pct blocks 0.05, p95 := pct blocks 0.95
                restMinutes := blocks.size * BLOCK }

/-! ## Guards -/

#guard median #[3, 1, 2] == 2
#guard median #[4, 1, 3, 2] == 2.5
#guard pct #[1, 2, 3, 4, 5] 0.25 == 2       -- round(1.0) = 1 → 2
#guard pct #[1, 2, 3, 4] 0.5 == 3           -- round(1.5) = 2 (half to even) → 3
#guard pct #[1, 2, 3, 4, 5, 6] 0.5 == 3     -- round(2.5) = 2 (half to even) → 3
#guard runs #[1, 2, 3, 7, 8, 10] == #[#[1, 2, 3], #[7, 8], #[10]]

-- A 120-bpm spike among 60s is dropped; its 61 neighbour stays.
#guard despike #[(0, 60), (5, 61), (10, 120), (15, 60), (20, 62)]
  == #[(0, 60), (5, 61), (15, 60), (20, 62)]

/-- One sample a minute at `bpm` for minutes `[a, b)`. -/
private def flat (a b : Nat) (bpm : Nat) : Array (Int × Nat) :=
  (Array.range (b - a)).map fun k => (Int.ofNat ((a + k) * 60), bpm)

-- 25 still minutes at 60: settle 5, then four blocks of 5 → 60, 20 minutes.
#guard restDay (flat 0 25 60) #[] #[(100000, 100060)] 0 100000
  == some { medianBpm := 60, p25 := 60, p75 := 60, p05 := 60, p95 := 60, restMinutes := 20 }
-- The first 5 settling minutes are dropped: 70 there does not count.
#guard (restDay (flat 0 5 70 ++ flat 5 25 60) #[] #[(100000, 100060)] 0 100000).map (·.medianBpm)
  == some 60
-- A step at minute 10 splits the run into 10 + 14 — both under 15: nothing.
#guard restDay (flat 0 25 60) #[10] #[(100000, 100060)] 0 100000 == none
-- Sleep over minutes 0–9 leaves 15 awake minutes: settle 5, two blocks.
#guard (restDay (flat 0 25 60) #[] #[(0, 600)] 0 100000).map (·.restMinutes) == some 10
-- No sleep record: not measured.
#guard restDay (flat 0 25 60) #[] #[] 0 100000 == none

end Verified.RestHr
