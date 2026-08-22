import Verified.Hsmm.FloatScore
/-!
# Telling a phone how hard to look for itself (port of `src/routes/owntracks.ts`)

The Owntracks Android app posts each GPS fix here on its way to PhoneTrack, and
the response carries a configuration patch. So this decides, on every fix, how
often that phone should take the next one — which is a direct trade of the
user's battery against the fidelity of their timeline.

⚠ BOTH DIRECTIONS OF ERROR COST THE USER SOMETHING REAL, and they are not
symmetric. Staying in Move mode too long drains a battery. Dropping to
Significant too early loses the walk that was about to start, and that walk
cannot be recovered afterwards — a flat battery is an inconvenience, a missing
journey is a hole in the record. Every threshold below leans accordingly.

## The cascade, in priority order

1. **High speed wins everywhere.** Boarding a train should not wait for history
   to accumulate; a single fix above the transit threshold escalates.
2. **Significant → Move**, on any evidence of motion. Only fires when the phone
   is actually in Significant — there is nothing to escalate from Move.
3. **Refinement inside Move**, once there is enough trajectory to tell walking
   from a bus.
4. **Move → Significant**, and ONLY after sustained evidence. This is the
   expensive transition: the phone gives up its warm GPS.

## Two guards on demotion that exist because of real days

⚠ Demotion is gated on being at a place the user HISTORICALLY LINGERS. Without
that, a thirty-minute supermarket visit flips the phone to Significant just as
they are about to walk out, and the walk home is lost.

⚠ A manual user-action push SUPPRESSES demotion for its hold window. The person
has just said "I am about to do something" — reverting them on stale
"been-here-for-hours" history contradicts the one explicit instruction the
system ever gets from them.

Pure and total. UNPROVEN; the thresholds are the TypeScript's.
-/
namespace Verified.Owntracks

open Verified.Hsmm.FloatScore (haversineMeters)

/-- Fewest fixes before a walking claim is allowed. -/
def MIN_WALKING_FIXES : Nat := 3
def WALKING_MIN_KMH : Float := 2
def WALKING_MAX_KMH : Float := 8
/-- Net displacement over path length. Below this the trace is wandering, which
is a stationary phone's GPS noise rather than someone walking somewhere. -/
def WALKING_MIN_STRAIGHTNESS : Float := 0.5
def TRANSIT_KMH : Float := 30
def TRANSIT_FAST_KMH : Float := 80

/-- How far back the history window reaches: long enough to gather
Significant-mode fixes, which can be minutes apart, short enough that
yesterday's walk cannot leak in. -/
def HISTORY_MAX_AGE_SEC : Int := 600

/-- Trajectory needed before in-Move refinement engages. A short burst right
after escalation cannot support a confident profile. -/
def MIN_HISTORY_SPAN_FOR_REFINE_SEC : Float := 120

/-- Sustained low-speed evidence needed before demoting.

⚠ MUST be strictly less than [`HISTORY_MAX_AGE_SEC`]. The pruner caps history at
that age, so a threshold equal to it is unreachable in practice — the oldest
surviving fix always sits a few seconds inside the window — and demotion would
silently never happen. -/
def MIN_STATIONARY_DEMOTE_SEC : Float := 540

/-- In Significant mode Android schedules a fix roughly every 15 minutes and
emits extras when its motion sensor fires. Two fixes closer together than this
therefore MEAN motion, without any speed being reported. -/
def SIGNIFICANT_MODE_MOTION_GAP_SEC : Float := 300

/-- A coarse motion regime. `none` is "no opinion", not "stationary". -/
inductive Profile where
  | transitFast
  | transit
  | walking
  | stationary
  deriving Repr, BEq, DecidableEq

/-- The wire name. These strings are the interface to the host. -/
def Profile.name : Profile → String
  | .transitFast => "transit-fast"
  | .transit => "transit"
  | .walking => "walking"
  | .stationary => "stationary"

/-- One retained fix. -/
structure Fix where
  ts : Int
  lat : Float
  lon : Float
  vel : Option Float := none
  trigger : Option String := none
  monitoringMode : Option Int := none
  deriving Inhabited, Repr

/-- What the predicates read. Every numeric signal is 0 when there is too little
data; `historySpanSec` is what says whether that 0 means anything. -/
structure Signals where
  reportedVelKmh : Float := 0
  computedVelKmh : Float := 0
  gapSinceLastFixSec : Float := 0
  effectiveSpeedKmh : Float := 0
  straightness : Float := 0
  historySpanSec : Float := 0
  trigger : Option String := none
  monitoringMode : Option Int := none
  deriving Inhabited, Repr

/-- Drop fixes older than `nowSec - maxAgeSec`. Inclusive at the boundary. -/
def pruneFixHistory (history : List Fix) (maxAgeSec nowSec : Int) : List Fix :=
  history.filter (fun f => f.ts ≥ nowSec - maxAgeSec)

private def pathDistanceM (history : List Fix) : Float :=
  match history with
  | [] => 0
  | first :: rest =>
    (rest.foldl (fun (acc, prev) f =>
      (acc + haversineMeters prev.lat prev.lon f.lat f.lon, f)) (0.0, first)).1

private def netDisplacementM (history : List Fix) : Float :=
  match history, history.getLast? with
  | first :: _ :: _, some last => haversineMeters first.lat first.lon last.lat last.lon
  | _, _ => 0

/-- Path distance over elapsed time. -/
def effectiveSpeedKmh (history : List Fix) : Float :=
  match history, history.getLast? with
  | first :: _ :: _, some last =>
    let dt := Float.ofInt (last.ts - first.ts)
    if dt ≤ 0 then 0 else (pathDistanceM history / dt) * 3.6
  | _, _ => 0

/-- Net displacement over path length, 0..1. -/
def straightnessRatio (history : List Fix) : Float :=
  match history with
  | _ :: _ :: _ =>
    let path := pathDistanceM history
    if path == 0 then 0 else netDisplacementM history / path
  | _ => 0

/-- Seconds covered by the history. -/
def historySpanSec (history : List Fix) : Float :=
  match history, history.getLast? with
  | first :: _ :: _, some last => Float.ofInt (last.ts - first.ts)
  | _, _ => 0

/-- Reduce a history to the signals the cascade consumes. -/
def computeSignals (history : List Fix) : Signals :=
  match history.getLast?, history.dropLast.getLast? with
  | none, _ => {}
  | some last, none =>
    -- ⚠ One fix: the reported velocity is all there is. Every derived signal
    -- stays 0, and `historySpanSec = 0` is what stops a predicate trusting them.
    { reportedVelKmh := last.vel.getD 0
      trigger := last.trigger
      monitoringMode := last.monitoringMode }
  | some last, some prev =>
    let gap := Float.ofInt (last.ts - prev.ts)
    let distM := haversineMeters prev.lat prev.lon last.lat last.lon
    { reportedVelKmh := last.vel.getD 0
      -- ⚠ Computed from displacement, so a missing `vel` field — which is
      -- common in Significant mode — does not read as "not moving".
      computedVelKmh := if gap > 0 then (distM / gap) * 3.6 else 0
      gapSinceLastFixSec := gap
      effectiveSpeedKmh := effectiveSpeedKmh history
      straightness := straightnessRatio history
      historySpanSec := historySpanSec history
      trigger := last.trigger
      monitoringMode := last.monitoringMode }

/-- Is the phone in Significant mode?

⚠ The phone's own `m` field is ground truth and beats our memory of what we last
pushed — the phone may have been changed underneath us. Only when it says
nothing do we fall back to the last profile we decided. -/
def isPhoneInSignificant (monitoringMode : Option Int) (prev : Option Profile) : Bool :=
  match monitoringMode with
  | some 1 => true
  | some 2 => false
  | _ => prev == some Profile.stationary || prev == none

/-- Predicate 1: a single fast reading escalates immediately.

⚠ Takes the MAX of reported and computed speed, so a phone that omits `vel`
still escalates on displacement. -/
def escalateOnHighSpeed (s : Signals) : Option Profile :=
  let speed := max s.reportedVelKmh s.computedVelKmh
  if speed > TRANSIT_FAST_KMH then some .transitFast
  else if speed > TRANSIT_KMH then some .transit
  else none

/-- The refinement shared by predicates 2 and 3: what the trajectory says. -/
private def refineFromTrajectory (s : Signals) : Option Profile :=
  if s.effectiveSpeedKmh > TRANSIT_FAST_KMH then some .transitFast
  else if s.effectiveSpeedKmh > TRANSIT_KMH then some .transit
  else if s.effectiveSpeedKmh ≥ WALKING_MIN_KMH
       && s.effectiveSpeedKmh ≤ WALKING_MAX_KMH
       && s.straightness ≥ WALKING_MIN_STRAIGHTNESS then some .walking
  else none

/-- Predicate 2: in Significant mode, any evidence of motion escalates.

Three independent sources, any one enough: the user pressed the button, a fix
arrived sooner than the Significant cadence allows (the motion sensor fired), or
there is visible displacement above walking pace.

⚠ Self-gates on `m = 2`. The cascade only calls this inside the Significant
branch, but the function is reachable on its own and a contract that quietly
depended on its caller would invite a regression.

⚠ Falls back to `transit` rather than to nothing: the point is to get Move mode
going. Guessing a slightly-too-eager profile costs battery; guessing nothing
costs the journey. -/
def escalateFromSignificant (s : Signals) : Option Profile :=
  if s.monitoringMode == some 2 then none
  else
    let speed := max s.reportedVelKmh s.computedVelKmh
    let motionEvidence :=
      s.trigger == some "u"
      || (s.gapSinceLastFixSec > 0 && s.gapSinceLastFixSec < SIGNIFICANT_MODE_MOTION_GAP_SEC)
      || speed > WALKING_MIN_KMH
    if !motionEvidence then none
    else if s.historySpanSec ≥ MIN_HISTORY_SPAN_FOR_REFINE_SEC then
      (refineFromTrajectory s).getD Profile.transit |> some
    else some .transit

/-- Predicate 3: inside Move, pick the precise profile once there is enough
trajectory. `none` when history is too thin, or when a mid-range speed has no
walking signature. -/
def refineInMove (s : Signals) : Option Profile :=
  if s.historySpanSec < MIN_HISTORY_SPAN_FOR_REFINE_SEC then none
  else refineFromTrajectory s

/-- Predicate 4: demote, but only on sustained evidence AND at a place the user
lingers.

⚠ Three independent guards, and each one exists because of a way this goes
wrong. The manual hold honours an explicit instruction. The long-stay gate stops
a supermarket visit from costing the walk home. The span and speed thresholds
stop a tube tunnel or a ping message reading as a stop. -/
def demoteAfterStop (s : Signals) (atLongStayLocation manualHoldActive : Bool) : Option Profile :=
  if manualHoldActive then none
  else if !atLongStayLocation then none
  else if s.historySpanSec < MIN_STATIONARY_DEMOTE_SEC then none
  else if s.effectiveSpeedKmh ≥ WALKING_MIN_KMH then none
  else some .stationary

/-! ## The long-stay gate

Which places may a demotion happen at. See [`demoteAfterStop`] for why this
exists at all: without it, a supermarket visit costs the walk home.
-/

/-- Loose enough to absorb GPS jitter at a known centroid, tight enough that the
cluster next door does not gate the user. -/
def LONG_STAY_RADIUS_M : Float := 100
/-- Captures workplaces and other day-spend locations. -/
def LONG_STAY_AVG_DWELL_SEC : Float := 2 * 3600
/-- Captures residences: anywhere they routinely sleep is somewhere they linger.

⚠ EITHER signal qualifies a place, not both. A home may have a short average
dwell because of many brief in-and-out visits, and a workplace is not slept at. -/
def LONG_STAY_SLEEP_HOURS : Float := 4

/-- A mined place, in the shape this gate needs. -/
structure GatingPlace where
  centroidLat : Float
  centroidLon : Float
  avgDwellSec : Float
  sleepHours : Float
  deriving Inhabited, Repr

/-- Is this fix inside a place that historically holds the user for hours? -/
def isLongStayLocation (lat lon : Float) (places : List GatingPlace) : Bool :=
  places.any fun fp =>
    haversineMeters lat lon fp.centroidLat fp.centroidLon ≤ LONG_STAY_RADIUS_M
    && (fp.sleepHours ≥ LONG_STAY_SLEEP_HOURS || fp.avgDwellSec ≥ LONG_STAY_AVG_DWELL_SEC)

/-- The outcome of the cascade. `keep` means no transition this fix. -/
inductive Transition where
  | to (p : Profile)
  | keep
  deriving Repr, BEq

/-- Run the cascade in priority order. -/
def decideTransition (s : Signals) (prev : Option Profile)
    (atLongStayLocation manualHoldActive : Bool) : Transition :=
  match escalateOnHighSpeed s with
  | some p => .to p
  | none =>
    if isPhoneInSignificant s.monitoringMode prev then
      match escalateFromSignificant s with
      | some p => .to p
      | none => .keep
    else
      match refineInMove s with
      | some p => .to p
      | none =>
        match demoteAfterStop s atLongStayLocation manualHoldActive with
        | some p => .to p
        | none => .keep

/-- What we decide for a device we have never seen.

⚠ Matches the phone's FACTORY DEFAULT, so the first fix's pushed config is a
no-op on the phone rather than a change it did not need. -/
def DEFAULT_PROFILE : Profile := .stationary

/-- The Owntracks settings for a profile: monitoring mode, and how often to
locate while in Move. -/
def configFor : Profile → (Int × Option Int)
  | .transitFast => (2, some 10)
  | .transit => (2, some 15)
  | .walking => (2, some 30)
  | .stationary => (1, none)

/-- The whole decision: signals in, a concrete profile out.

⚠ ALWAYS a concrete profile, never "no change". The proxy pushes the full config
on every fix and the phone treats it as idempotent, which is what removes the
need for an anti-flap timer, a per-device push memory, and any state that could
be lost — a transient failure on either side recovers on the very next fix. -/
def decideRemoteConfig (s : Signals) (prev : Option Profile)
    (atLongStayLocation manualHoldActive : Bool) : Profile :=
  match decideTransition s prev atLongStayLocation manualHoldActive with
  | .to p => p
  | .keep => prev.getD DEFAULT_PROFILE

/-! ## Guards -/

private def fix (ts : Int) (lat lon : Float) : Fix := { ts, lat, lon }

-- Pruning is inclusive at the cutoff.
#guard (pruneFixHistory [fix 100 0 0, fix 500 0 0] 600 700).length == 2
#guard (pruneFixHistory [fix 99 0 0, fix 500 0 0] 600 700).length == 1

-- ⚠ A single fast reading escalates with no history at all.
#guard escalateOnHighSpeed { reportedVelKmh := 100 } == some Profile.transitFast
#guard escalateOnHighSpeed { reportedVelKmh := 50 } == some Profile.transit
#guard escalateOnHighSpeed { reportedVelKmh := 10 } == none
-- ⚠ …and it escalates on COMPUTED speed too, so a missing `vel` does not read
-- as standing still.
#guard escalateOnHighSpeed { computedVelKmh := 100 } == some Profile.transitFast

-- The phone's own report beats our memory.
#guard isPhoneInSignificant (some 1) (some Profile.walking) == true
#guard isPhoneInSignificant (some 2) (some Profile.stationary) == false
#guard isPhoneInSignificant none (some Profile.stationary) == true
#guard isPhoneInSignificant none none == true
#guard isPhoneInSignificant none (some Profile.walking) == false

-- The user pressed the button: escalate even with no speed at all.
#guard escalateFromSignificant { trigger := some "u" } == some Profile.transit
-- A fix sooner than the Significant cadence MEANS motion.
#guard escalateFromSignificant { gapSinceLastFixSec := 60 } == some Profile.transit
-- ⚠ A gap of 0 is "no previous fix", NOT "arrived instantly" — it must not read
-- as motion evidence.
#guard escalateFromSignificant { gapSinceLastFixSec := 0 } == none
#guard escalateFromSignificant { gapSinceLastFixSec := 900 } == none
-- Already in Move: nothing to escalate.
#guard escalateFromSignificant { trigger := some "u", monitoringMode := some 2 } == none
-- With enough trajectory, the profile is refined rather than guessed.
#guard escalateFromSignificant
  { trigger := some "u", historySpanSec := 200, effectiveSpeedKmh := 5, straightness := 0.9 }
  == some Profile.walking

-- Refinement needs trajectory.
#guard refineInMove { historySpanSec := 60, effectiveSpeedKmh := 5, straightness := 0.9 } == none
#guard refineInMove { historySpanSec := 200, effectiveSpeedKmh := 5, straightness := 0.9 }
       == some Profile.walking
-- ⚠ Walking pace WITHOUT straightness is GPS noise at a desk, not a walk.
#guard refineInMove { historySpanSec := 200, effectiveSpeedKmh := 5, straightness := 0.1 } == none
#guard refineInMove { historySpanSec := 200, effectiveSpeedKmh := 50 } == some Profile.transit
#guard refineInMove { historySpanSec := 200, effectiveSpeedKmh := 100 } == some Profile.transitFast

-- ⚠ Demotion needs BOTH sustained evidence AND a place they linger.
#guard demoteAfterStop { historySpanSec := 600, effectiveSpeedKmh := 0 } true false
       == some Profile.stationary
#guard demoteAfterStop { historySpanSec := 600, effectiveSpeedKmh := 0 } false false == none
#guard demoteAfterStop { historySpanSec := 100, effectiveSpeedKmh := 0 } true false == none
#guard demoteAfterStop { historySpanSec := 600, effectiveSpeedKmh := 5 } true false == none
-- ⚠ A manual push suppresses it: the person just said what they want.
#guard demoteAfterStop { historySpanSec := 600, effectiveSpeedKmh := 0 } true true == none

-- The cascade's priority: speed beats everything.
#guard decideTransition { reportedVelKmh := 100, monitoringMode := some 1 } none true false
       == Transition.to Profile.transitFast
-- No evidence at all: keep whatever we had.
#guard decideTransition { monitoringMode := some 1 } (some Profile.walking) false false
       == Transition.keep
-- ⚠ A first-ever fix resolves to the factory default, so the pushed config is a
-- no-op on the phone.
#guard decideRemoteConfig {} none false false == Profile.stationary
#guard decideRemoteConfig { monitoringMode := some 2 } (some Profile.walking) false false
       == Profile.walking

-- The patches.
#guard configFor Profile.transitFast == (2, some 10)
#guard configFor Profile.stationary == (1, none)

-- The long-stay gate: either signal qualifies, and distance rules first.
private def home : GatingPlace :=
  { centroidLat := 51.5, centroidLon := -0.1, avgDwellSec := 0, sleepHours := 8 }
private def work : GatingPlace :=
  { centroidLat := 51.5, centroidLon := -0.1, avgDwellSec := 3 * 3600, sleepHours := 0 }
private def shop : GatingPlace :=
  { centroidLat := 51.5, centroidLon := -0.1, avgDwellSec := 1800, sleepHours := 0 }

#guard isLongStayLocation 51.5 (-0.1) [home] == true
#guard isLongStayLocation 51.5 (-0.1) [work] == true
-- ⚠ A shop is NOT a long-stay place, which is the whole point of the gate.
#guard isLongStayLocation 51.5 (-0.1) [shop] == false
#guard isLongStayLocation 51.5 (-0.1) [] == false
-- Far away from a qualifying place does not qualify.
#guard isLongStayLocation 52.0 (-0.1) [home] == false

end Verified.Owntracks
