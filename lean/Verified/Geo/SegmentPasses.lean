import Verified.Geo.SegmentMerge
import Verified.Geo.PathPoint
/-!
# Vehicle identity (port of `src/geo/passes/vehicle-identity.ts`)

`resolveVehicleIdentity` demotes the trailing `driving` leg to `vehicle` when no
pass has claimed it. `driving` doubles as the placeholder for "a vehicle-speed
run I have not identified yet", and an *unfinished* ride reaches the UI wearing
the name of a car. The rule keys on incompleteness (last segment, nothing after
it), NOT on absence of evidence — two user-confirmed taxis carry no road match
either. It keys on `effectiveMode`, so a leg some earlier pass refined is judged
by what it now is.

Wholly pure, no Float arithmetic ⇒ EXACT. UNPROVEN; pinned against Node/V8
(`lean/experiments/small-leaves-refs.mts`).
-/

namespace Verified.Geo.SegmentPasses

abbrev Mode := String

/-- A matched-path vertex. Only the path's LENGTH is read here, but it is
carried as the real array so this projection stores what the TS record does. -/
abbrev SPt := Verified.Geo.PathPt

/-- The pipeline's segment record. This pass reads and rewrites a subset of
it; it names the whole thing so that `Verified.Geo.PassFold` can hand the same
value to every pass in the cascade without a lossy projection at each hop. -/
abbrev Seg := Verified.Geo.SegmentMerge.Seg

-- `refinedMode ?? mode`: `SegmentMerge.effectiveMode`, the one definition. Never
-- read `refinedMode` directly; a forgotten fallback ignores every refinement.
export Verified.Geo.SegmentMerge (effectiveMode)

/-! ## `resolveVehicleIdentity` -/

def UNIDENTIFIED_VEHICLE_REASON : String :=
  "unidentified vehicle: a ride still in progress — vehicle speed, but no pass has yet placed it on a road, a bus route or a rail line, so a car cannot be asserted"

/-- Whether SOME pass has placed this ride: a matched road, a named street, or
an identified bus route. All three are read for TRUTHINESS in the TS, so an
empty `matchedPath` and an empty `wayName` are both "no claim". -/
def hasVehicleClaim (s : Seg) : Bool :=
  (s.matchedPath.getD #[]).size > 0 || s.wayName.any (· != "") || s.vehicleKind.isSome

/-- Demote the trailing unclaimed `driving` leg to `vehicle`. Anything with a
segment after it has finished, and its label is the cascade's final word rather
than a placeholder awaiting more data — so a finished ride, however thinly
evidenced, keeps whatever the pipeline concluded. Pure (no clock), so a
completed day replays byte-identically: its final segment is a stay or a sleep
and this pass does nothing at all. -/
def resolveVehicleIdentity (segments : Array Seg) : Array Seg :=
  if segments.isEmpty then segments else
  let lastIdx := segments.size - 1
  segments.mapIdx fun i s =>
    if i != lastIdx then s
    else if effectiveMode s != "driving" then s
    else if hasVehicleClaim s then s
    else { s with refinedMode := some "vehicle", refinedReason := some UNIDENTIFIED_VEHICLE_REASON }

/-! ## Guards (V8 reference values) -/

private def TRAIN : String := "Euston Square → Wembley Park · Metropolitan Line"

private def sg (startTs endTs : Int) (mode : Mode) (wayName : Option String := none)
    (refinedMode : Option Mode := none) (refinedReason : Option String := none)
    (vehicleKind : Option String := none) (matchedPath : Option (Array SPt) := none)
    (pointCount : Int := 5) : Seg :=
  { startTs, endTs, mode, refinedMode, wayName, vehicleKind, refinedReason, pointCount, matchedPath }

private def iview (out : Array Seg) : Array (Int × Mode × Option Mode × Option String) :=
  out.map fun s => (s.startTs, s.mode, s.refinedMode, s.refinedReason)

private def DEMOTED (startTs : Int) (mode : Mode) : Int × Mode × Option Mode × Option String :=
  (startTs, mode, some "vehicle", some UNIDENTIFIED_VEHICLE_REASON)

-- The 2026-07-12 bug: the trailing unclaimed placeholder is demoted.
#guard iview (resolveVehicleIdentity #[sg 0 100 "stationary", sg 100 200 "driving"])
  == #[(0, "stationary", none, none), DEMOTED 100 "driving"]
-- A FINISHED ride keeps what the cascade concluded — the two confirmed taxis.
#guard iview (resolveVehicleIdentity #[sg 100 200 "driving", sg 200 300 "stationary"])
  == #[(100, "driving", none, none), (200, "stationary", none, none)]
-- Any claim at all exempts it: a matched road, a named street, a bus route.
#guard iview (resolveVehicleIdentity #[sg 100 200 "driving" (matchedPath := some #[⟨51.52, -38.13, 100⟩])])
  == #[(100, "driving", none, none)]
#guard iview (resolveVehicleIdentity #[sg 100 200 "driving" (some "Euston Road")])
  == #[(100, "driving", none, none)]
#guard iview (resolveVehicleIdentity #[sg 100 200 "driving" (vehicleKind := some "bus")])
  == #[(100, "driving", none, none)]
-- An EMPTY path or way name is not a claim (both are falsy in the TS), and an
-- ABSENT path is the shape the matcher actually leaves behind when it declines
-- a leg — `undefined`, which `?.length ?? 0` collapses to the same answer.
#guard iview (resolveVehicleIdentity #[sg 100 200 "driving" (matchedPath := some #[])]) == #[DEMOTED 100 "driving"]
#guard iview (resolveVehicleIdentity #[sg 100 200 "driving" (matchedPath := none)]) == #[DEMOTED 100 "driving"]
#guard iview (resolveVehicleIdentity #[sg 100 200 "driving" (some "")]) == #[DEMOTED 100 "driving"]
-- Only the `driving` placeholder is doubted.
#guard iview (resolveVehicleIdentity #[sg 100 200 "train" (some TRAIN)]) == #[(100, "train", none, none)]
#guard iview (resolveVehicleIdentity #[sg 100 200 "walking"]) == #[(100, "walking", none, none)]
-- `effectiveMode` again: refined TO driving is a candidate…
#guard iview (resolveVehicleIdentity #[sg 100 200 "stationary" (refinedMode := some "driving")])
  == #[DEMOTED 100 "stationary"]
-- …refined AWAY from driving is not.
#guard iview (resolveVehicleIdentity #[sg 100 200 "driving" (refinedMode := some "train")])
  == #[(100, "driving", some "train", none)]
-- Unlike the hand-off pass, an existing reason is REPLACED, not appended to.
#guard iview (resolveVehicleIdentity #[sg 100 200 "driving" (refinedReason := some "earlier note")])
  == #[DEMOTED 100 "driving"]
#guard resolveVehicleIdentity #[] == #[]

end Verified.Geo.SegmentPasses
