import Verified.Hsmm.FloatScore
/-!
# Telling a phone how hard to look for itself (port of `src/routes/owntracks.ts`)

The Owntracks Android app posts each GPS fix here on its way to PhoneTrack, and
the response carries a configuration patch. So this decides, on every fix, how
often that phone should take the next one — which is a direct trade of the
user's battery against the fidelity of their timeline.

⚠ THIS NEVER DEMOTES. Pippijn's decision, 2026-09-23: a missing journey is a
hole in the record and a flat battery is an inconvenience, and the two are not
symmetric — so the phone is never told to drop to Significant. A demotion rule
existed until that day, gated on sustained standstill at a place he lingers,
and it still cost a walk: 2026-06-07 (three hours at home, a fourteen-minute
gap walking out) and 2026-09-23 (a twelve-minute standstill on a walk, a
fourteen-and-a-half-minute gap walking on). He sets Move mode himself each
morning; this decides only how OFTEN to locate inside it, and escalates a
phone that reports itself in Significant.

## The cascade, in priority order

1. **High speed wins everywhere.** Boarding a train should not wait for history
   to accumulate; a single fix above the transit threshold escalates.
2. **Significant → Move**, on any evidence of motion. Only fires when the phone
   is actually in Significant — there is nothing to escalate from Move. With no
   evidence the answer is still a Move profile, because every answer is one.
3. **Refinement inside Move**, once there is enough trajectory to tell walking
   from a bus.
4. **Night.** Between `NIGHT_START_H` and `NIGHT_END_H` local time a phone
   that is not moving locates once an hour — still Move mode, so a night walk
   is seen at the next fix and escalates like any other. The interval is what
   spares the unnecessary data, which is what it is for; it is not a battery
   measure and it is not a pause.

Pure and total. UNPROVEN; the thresholds are the TypeScript's, the night
window Pippijn's (2026-09-23).
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

/-- In Significant mode Android schedules a fix roughly every 15 minutes and
emits extras when its motion sensor fires. Two fixes closer together than this
therefore MEAN motion, without any speed being reported. -/
def SIGNIFICANT_MODE_MOTION_GAP_SEC : Float := 300

/-- A motion regime inside Move mode: how often to locate. `none` is "no
opinion". There is no stationary profile: the backend never demotes. -/
inductive Profile where
  | transitFast
  | transit
  | walking
  /-- Not moving, at night: once an hour. -/
  | night
  deriving Repr, BEq, DecidableEq

/-- The wire name. These strings are the interface to the host. -/
def Profile.name : Profile → String
  | .transitFast => "transit-fast"
  | .transit => "transit"
  | .walking => "walking"
  | .night => "night"

/-- Local hours inside which a still phone locates hourly: from 23:00 up to
    but not including 06:00. The window ends early on purpose — precision
    should be back before he goes out, and the last hourly fix can land up to
    an hour after the window closes. -/
def NIGHT_START_H : Int := 23
def NIGHT_END_H : Int := 6

def isNightHour (h : Int) : Bool := h ≥ NIGHT_START_H || h < NIGHT_END_H

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
  /-- The hour of the day where the phone is, 0–23 local; `none` when the host
      could not resolve a zone, which reads as daytime. -/
  localHour : Option Int := none
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
nothing do we fall back to what we know: a device we have decided for was
pushed a Move profile, a device we have never seen may be anywhere. -/
def isPhoneInSignificant (monitoringMode : Option Int) (prev : Option Profile) : Bool :=
  match monitoringMode with
  | some 1 => true
  | some 2 => false
  | _ => prev == none

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

/-- Predicate 4: at night, a still phone locates hourly; a moving one walks.

⚠ Reads the max of every speed the signals carry, so a phone that omits `vel`
still counts as moving on displacement, and a night walk seen at an hourly
fix is answered with the walking cadence at once. -/
def nightProfile (s : Signals) : Option Profile :=
  match s.localHour with
  | some h =>
    if !isNightHour h then none
    else
      let speed := max (max s.reportedVelKmh s.computedVelKmh) s.effectiveSpeedKmh
      if speed ≥ WALKING_MIN_KMH then some .walking else some .night
  | none => none

/-- The outcome of the cascade. `keep` means no transition this fix. -/
inductive Transition where
  | to (p : Profile)
  | keep
  deriving Repr, BEq

/-- Run the cascade in priority order. Nothing here ever demotes. -/
def decideTransition (s : Signals) (prev : Option Profile) : Transition :=
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
        match nightProfile s with
        | some p => .to p
        | none => .keep

/-- What we decide for a device we have never seen, or one with no evidence
either way: the gentlest Move profile.

⚠ Move, not the phone's factory default of Significant. Every answer is a
push, so the first fix after a restart used to push Significant onto a phone
that was walking (2026-09-23, after a deploy); now the first fix puts it in
Move, which is where Pippijn wants it whenever it reports at all. -/
def DEFAULT_PROFILE : Profile := .walking

/-- The Owntracks settings for a profile: monitoring mode (always 2, Move), and
how often to locate. -/
def configFor : Profile → (Int × Option Int)
  | .transitFast => (2, some 10)
  | .transit => (2, some 15)
  | .walking => (2, some 30)
  | .night => (2, some 3600)

/-- The whole decision: signals in, a concrete profile out.

⚠ ALWAYS a concrete profile, never "no change". The proxy pushes the full config
on every fix and the phone treats it as idempotent, which is what removes the
need for an anti-flap timer, a per-device push memory, and any state that could
be lost — a transient failure on either side recovers on the very next fix. -/
def decideRemoteConfig (s : Signals) (prev : Option Profile) : Profile :=
  match decideTransition s prev with
  | .to p => p
  | .keep =>
    match prev with
    -- ⚠ Night EXPIRES WITH THE WINDOW, not with motion: the morning's cadence
    -- comes back on the first fix after 06:00 whether or not anything moved,
    -- because the hourly fix is the one that would otherwise miss him going out.
    | some .night => if s.localHour.any isNightHour then .night else DEFAULT_PROFILE
    | some p => p
    | none => DEFAULT_PROFILE

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
#guard isPhoneInSignificant (some 2) (some Profile.walking) == false
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

-- The cascade's priority: speed beats everything.
#guard decideTransition { reportedVelKmh := 100, monitoringMode := some 1 } none
       == Transition.to Profile.transitFast
-- No evidence at all: keep whatever we had.
#guard decideTransition { monitoringMode := some 1 } (some Profile.walking) == Transition.keep
-- ⚠ A first-ever fix is put in Move, never left in Significant.
#guard decideRemoteConfig {} none == Profile.walking
#guard (configFor (decideRemoteConfig {} none)).1 == 2
#guard decideRemoteConfig { monitoringMode := some 2 } (some Profile.walking) == Profile.walking
-- ⚠ NEVER DEMOTES: ten minutes of standstill in Move, at any place, with any
-- history, answers a Move profile.
#guard decideRemoteConfig { historySpanSec := 600, effectiveSpeedKmh := 0, monitoringMode := some 2 }
         (some Profile.walking) == Profile.walking
-- A phone reporting itself in Significant with no motion evidence is still
-- answered with Move: every answer is a push.
#guard (configFor (decideRemoteConfig { monitoringMode := some 1, gapSinceLastFixSec := 900 } none)).1 == 2

-- The patches: monitoring is Move on every profile.
#guard configFor Profile.transitFast == (2, some 10)
#guard (configFor Profile.walking).1 == 2
#guard configFor Profile.night == (2, some 3600)

-- Night: a still phone at 02:00 locates hourly; the same phone at 06:00 does
-- not, and a night fix that shows motion is walking cadence at once.
#guard isNightHour 23 && isNightHour 2 && !isNightHour 6 && !isNightHour 12
#guard decideRemoteConfig { localHour := some 2, monitoringMode := some 2 } (some Profile.walking)
       == Profile.night
#guard decideRemoteConfig { localHour := some 6, monitoringMode := some 2 } (some Profile.night)
       == Profile.walking   -- the window closed: the day's cadence, moving or not
#guard decideRemoteConfig { localHour := some 2, monitoringMode := some 2, computedVelKmh := 4 }
         (some Profile.night) == Profile.walking
-- A train at night is still a train: speed wins everywhere.
#guard decideRemoteConfig { localHour := some 2, monitoringMode := some 2, reportedVelKmh := 60 }
         (some Profile.night) == Profile.transit


end Verified.Owntracks
