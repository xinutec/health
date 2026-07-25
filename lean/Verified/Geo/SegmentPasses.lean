/-!
# Vehicle-leg repair passes (port of `src/geo/passes/repair-handoff.ts` and
`src/geo/passes/vehicle-identity.ts`)

Two small critics the cascade runs over a finished segment list. Both are
wholly pure — no Float arithmetic at all, so both are EXACT — and both key on
`effectiveMode`, so a leg some earlier pass refined is judged by what it now is.

* **`repairVehicleHandoff`** enforces the day-grammar's law that two *different*
  vehicles cannot hand off directly. A contiguous vehicle leg flush against an
  *identified* train journey (a resolved `Board → Alight` pair) is not a second
  journey — it is part of the first, mislabelled. It gets absorbed.
* **`resolveVehicleIdentity`** demotes the trailing `driving` leg to `vehicle`
  when no pass has claimed it. `driving` doubles as the placeholder for "a
  vehicle-speed run I have not identified yet", and an *unfinished* ride reaches
  the UI wearing the name of a car. The rule keys on incompleteness (last
  segment, nothing after it), NOT on absence of evidence — two user-confirmed
  taxis carry no road match either.

Note this module's `VEHICLE_MODES` is `driving | train | cycling | plane` — it
excludes both `bus` (here a `vehicleKind` refinement of driving, not a base
mode) and `vehicle` (what `resolveVehicleIdentity` itself emits, so an
unidentified ride is never absorbed into a train). That is a DIFFERENT set from
`Verified.Geo.DayState`'s same-named constant, which runs at the day-state layer
where bus has been flattened into a mode. Both are pinned by `#guard`s.

UNPROVEN; pinned against Node/V8 (`lean/experiments/small-leaves-refs.mts`).
-/

namespace Verified.Geo.SegmentPasses

abbrev Mode := String

/-- A matched-path vertex. Only the path's LENGTH is read here, but it is
carried as the real array so this projection stores what the TS record does. -/
structure SPt where
  lat : Float
  lon : Float
  ts : Int
  deriving Inhabited, BEq, Repr

/-- The `EnrichedSegment` fields these two passes read. A different projection
of the same TS record than `Verified.Geo.DayState.Seg` (labelling fields) or
`Verified.Geo.EpisodeGeometry.Seg` (drawn-path fields). -/
structure Seg where
  startTs : Int
  endTs : Int
  mode : Mode
  refinedMode : Option Mode := none
  wayName : Option String := none
  vehicleKind : Option String := none
  refinedReason : Option String := none
  pointCount : Int := 0
  matchedPath : Array SPt := #[]
  deriving Inhabited, BEq

/-- `refinedMode ?? mode` — `segment-util.ts`'s `effectiveMode`. Never read
`refinedMode` directly; a forgotten fallback silently ignores every refinement
the cascade made. -/
def effectiveMode (s : Seg) : Mode := s.refinedMode.getD s.mode

/-! ## `repairVehicleHandoff` -/

/-- Modes in which the user is aboard a vehicle, at the SEGMENT layer. -/
def VEHICLE_MODES : List Mode := ["driving", "train", "cycling", "plane"]

/-- Max end→start gap for two legs to count as a contiguous hand-off. A wider
gap is unobserved time the alighting could have happened in — a real
park-and-ride always has a walk or a GPS gap between car and platform. -/
def CONTIGUITY_MAX_GAP_S : Int := 120

/-- The separator that marks a resolved board→alight journey label. -/
def STATION_PAIR_SEP : String := " → "

/-- A train leg with a resolved board→alight identity. `String.includes` on a
non-empty needle is exactly "splits into ≥ 2 parts". -/
def isIdentifiedTrain (s : Seg) : Bool :=
  effectiveMode s == "train" && ((s.wayName.getD "").splitOn STATION_PAIR_SEP).length ≥ 2

/-- Whether `a` immediately followed by `b` is an absorbable hand-off into a
rail journey: contiguous, both aboard a vehicle, and exactly ONE of them an
identified train. Two identified trains are a real interchange; two
un-identified legs have no journey to absorb into. -/
def isAbsorbableHandoff (a b : Seg) : Bool :=
  VEHICLE_MODES.contains (effectiveMode a)
    && VEHICLE_MODES.contains (effectiveMode b)
    && b.startTs - a.endTs ≤ CONTIGUITY_MAX_GAP_S
    && isIdentifiedTrain a != isIdentifiedTrain b

/-- Merge the non-train leg into the train it hands off to/from, keeping the
train's identity and extending its span to cover both. -/
def absorbIntoTrain (a b : Seg) : Seg :=
  let aIsTrain := isIdentifiedTrain a
  let train := if aIsTrain then a else b
  let other := if aIsTrain then b else a
  let reason := s!"absorbed contiguous {effectiveMode other} leg (impossible vehicle hand-off — same rail journey)"
  { train with
    startTs := min a.startTs b.startTs
    endTs := max a.endTs b.endTs
    pointCount := a.pointCount + b.pointCount
    -- The TS tests `train.refinedReason ? … : reason`, so an EMPTY existing
    -- reason is falsy and no "; " separator is emitted.
    refinedReason := some (match train.refinedReason with
      | some r => if r == "" then reason else s!"{r}; {reason}"
      | none => reason) }

/-- Repair contiguous vehicle hand-offs by absorbing the non-train leg into the
adjacent identified train. A single left-to-right fold handles runs — the fold
re-tests the already-merged head, so `driving → train → driving` collapses to
one train. -/
def repairVehicleHandoff (segments : Array Seg) : Array Seg :=
  segments.foldl (init := #[]) fun out seg =>
    match out.back? with
    | some prev => if isAbsorbableHandoff prev seg then out.pop.push (absorbIntoTrain prev seg)
                   else out.push seg
    | none => out.push seg

/-! ## `resolveVehicleIdentity` -/

def UNIDENTIFIED_VEHICLE_REASON : String :=
  "unidentified vehicle: a ride still in progress — vehicle speed, but no pass has yet placed it on a road, a bus route or a rail line, so a car cannot be asserted"

/-- Whether SOME pass has placed this ride: a matched road, a named street, or
an identified bus route. All three are read for TRUTHINESS in the TS, so an
empty `matchedPath` and an empty `wayName` are both "no claim". -/
def hasVehicleClaim (s : Seg) : Bool :=
  s.matchedPath.size > 0 || s.wayName.any (· != "") || s.vehicleKind.isSome

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
private def ABSORB (m : Mode) : String :=
  s!"absorbed contiguous {m} leg (impossible vehicle hand-off — same rail journey)"

private def sg (startTs endTs : Int) (mode : Mode) (wayName : Option String := none)
    (refinedMode : Option Mode := none) (refinedReason : Option String := none)
    (vehicleKind : Option String := none) (matchedPath : Array SPt := #[])
    (pointCount : Int := 5) : Seg :=
  { startTs, endTs, mode, refinedMode, wayName, vehicleKind, refinedReason, pointCount, matchedPath }

-- A summary projection: what the harness dumps for each output segment.
private def hview (out : Array Seg) : Array (Int × Int × Mode × Option String × Int × Option String) :=
  out.map fun s => (s.startTs, s.endTs, s.mode, s.wayName, s.pointCount, s.refinedReason)

-- The 2026-06-18 case: an underpass stretch snapped to driving, flush against
-- the identified ride, absorbed FORWARD into it.
#guard hview (repairVehicleHandoff #[sg 100 200 "driving", sg 200 400 "train" (some TRAIN)])
  == #[(100, 400, "train", some TRAIN, 10, some (ABSORB "driving"))]
-- Mirror image — absorbed backward; the train keeps its identity either way.
#guard hview (repairVehicleHandoff #[sg 100 300 "train" (some TRAIN), sg 300 380 "driving"])
  == #[(100, 380, "train", some TRAIN, 10, some (ABSORB "driving"))]
-- A run collapses to ONE train in the single fold.
#guard hview (repairVehicleHandoff
    #[sg 100 200 "driving", sg 200 400 "train" (some TRAIN), sg 400 500 "driving" (pointCount := 3)])
  == #[(100, 500, "train", some TRAIN, 13, some s!"{ABSORB "driving"}; {ABSORB "driving"}")]
-- A bare-line fragment (no station pair) is the side ABSORBED — the Jubilee case.
#guard hview (repairVehicleHandoff
    #[sg 100 200 "train" (some "Jubilee Line"), sg 200 400 "train" (some TRAIN)])
  == #[(100, 400, "train", some TRAIN, 10, some (ABSORB "train"))]
-- Two identified trains are a real interchange: left alone.
#guard (repairVehicleHandoff #[sg 100 200 "train" (some "A → B · Line"), sg 200 400 "train" (some TRAIN)]).size == 2
-- Neither identified: no journey to absorb into.
#guard (repairVehicleHandoff #[sg 100 200 "driving", sg 200 400 "driving"]).size == 2
-- 121 s is one second past the bar — park-and-ride, not a hand-off…
#guard (repairVehicleHandoff #[sg 100 200 "driving", sg 321 400 "train" (some TRAIN)]).size == 2
-- …while 120 s exactly still merges (the TS test is `>`).
#guard (repairVehicleHandoff #[sg 100 200 "driving", sg 320 400 "train" (some TRAIN)]).size == 1
-- Walking is not a vehicle mode.
#guard (repairVehicleHandoff #[sg 100 200 "walking", sg 200 400 "train" (some TRAIN)]).size == 2
-- Nor is `vehicle` — so what `resolveVehicleIdentity` emits is never absorbed.
#guard (repairVehicleHandoff #[sg 100 200 "vehicle", sg 200 400 "train" (some TRAIN)]).size == 2
-- `effectiveMode`: a leg the classifier called stationary but a pass refined to
-- driving DOES absorb.
#guard hview (repairVehicleHandoff
    #[sg 100 200 "stationary" (refinedMode := some "driving"), sg 200 400 "train" (some TRAIN)])
  == #[(100, 400, "train", some TRAIN, 10, some (ABSORB "driving"))]
-- An existing reason is preserved and the new one appended…
#guard (repairVehicleHandoff
    #[sg 100 200 "driving", sg 200 400 "train" (some TRAIN) (refinedReason := some "earlier note")])[0]!.refinedReason
  == some s!"earlier note; {ABSORB "driving"}"
-- …but an EMPTY one is falsy, so no separator is emitted.
#guard (repairVehicleHandoff
    #[sg 100 200 "driving", sg 200 400 "train" (some TRAIN) (refinedReason := some "")])[0]!.refinedReason
  == some (ABSORB "driving")
#guard hview (repairVehicleHandoff #[sg 100 200 "cycling", sg 200 400 "train" (some TRAIN)])
  == #[(100, 400, "train", some TRAIN, 10, some (ABSORB "cycling"))]
#guard repairVehicleHandoff #[] == #[]
#guard (repairVehicleHandoff #[sg 100 200 "driving"]).size == 1

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
#guard iview (resolveVehicleIdentity #[sg 100 200 "driving" (matchedPath := #[⟨51.52, -0.13, 100⟩])])
  == #[(100, "driving", none, none)]
#guard iview (resolveVehicleIdentity #[sg 100 200 "driving" (some "Euston Road")])
  == #[(100, "driving", none, none)]
#guard iview (resolveVehicleIdentity #[sg 100 200 "driving" (vehicleKind := some "bus")])
  == #[(100, "driving", none, none)]
-- An EMPTY path or way name is not a claim (both are falsy in the TS).
#guard iview (resolveVehicleIdentity #[sg 100 200 "driving" (matchedPath := #[])]) == #[DEMOTED 100 "driving"]
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
