import Verified.Geo.SegmentMerge
import Verified.Geo.TubeHop
/-!
# Transit continuity for place-naming (port of `src/geo/transit-place.ts`)

Two rules that give the place-picker the transit context it otherwise lacks.
The venue scorer ranks what is mapped near a coordinate; it has no idea the
user just got off a train, so a station forecourt resolves to whatever café,
hotel or doughnut counter happens to be mapped inside the concourse.

* `stationAtTrainAlight` — a stay DIRECTLY after a train, within station
  range, is at the station just alighted at (2026-05-22: an ambulance wait on
  the Finchley Road forecourt read "Loft Coffee Company"). A genuine café visit
  has a walking segment in between, so `prev` would be walking.
* `stationAtTransitInterchange` — a SHORT stay in station range bracketed by
  trains on both sides, each reached directly or across one short
  platform-change walk, is a change of trains (2026-06-29: a Baker Street
  Circle→Met platform change read "Krispy Kreme", a unit mapped 40 m away
  inside the station). The first rule cannot see this one: it bails the moment
  a walk sits between the train and the stay.

Both are `async` in the TS only because the station lookup is injected
(`osm: Pick<OsmAdapter, "nearbyStations">`) — the TubeHop shape. Modelled here
with the lookup as an ordinary function of `(lat, lon, radiusM)`, which is what
reference-tests the private `bracketingTrain` and `isShortWalk` through the
public functions rather than needing a test-only export.

Wholly EXACT — no trigonometry and no arithmetic beyond a duration subtraction;
the distances arrive already computed from the adapter.

## Two things the port had to get right

**A distance tie keeps the EARLIER station.** The TS reduce improves only on
strict `<`, so the fold here must too. Station order out of the adapter is
distance order, and co-located nodes at a big interchange tie routinely.

**`segments[i - 1]` at `i = 0` is `undefined` in JS, but `Nat` subtraction
truncates to 0** and would read the stay itself — which is `stationary`, so it
would silently answer "not a train" and look correct while meaning something
else. Indices here are `Int` and `segAt` returns `none` outside the array, the
same landmine `WalkAnchors` records.

UNPROVEN; every value pinned against Node/V8
(`lean/experiments/transit-place-refs.mts`).
-/

namespace Verified.Geo.TransitPlace

open Verified.Geo.TubeHop (NearbyStation)

abbrev Mode := String

/-- The pipeline's segment record. This pass reads and rewrites a subset of
it; it names the whole thing so that `Verified.Geo.PassFold` can hand the same
value to every pass in the cascade without a lossy projection at each hop. -/
abbrev Seg := Verified.Geo.SegmentMerge.Seg

def effMode (s : Seg) : Mode := s.refinedMode.getD s.mode

/-- "You are at the station" footprint: how close a train-alighting stay must
sit to a station node before the stay is named after it. Tight enough that a
café you genuinely walked to (which also has a walking segment in between,
disqualifying it anyway) is not swallowed by the station. -/
def STATION_AT_ALIGHT_RADIUS_M : Float := 150

/-- The nearest station, or `none` for an empty list.

Improves only on STRICT `<`, so a tie keeps the earlier element — the TS
`reduce` seeds with index 0 and this fold reproduces it. -/
def nearestStation (stations : Array NearbyStation) : Option NearbyStation :=
  stations.foldl (init := none) fun best s =>
    match best with
    | some b => if s.distanceM < b.distanceM then some s else best
    | none => some s

/-- The nearest station's name when it is inside `radiusM`.

The radius test is redundant against an adapter that already filtered by it,
and deliberately kept: the lookup is the caller's, so nothing here guarantees
the filter happened. -/
private def nameWithin (stations : Array NearbyStation) (radiusM : Float) : Option String :=
  match nearestStation stations with
  | none => none
  | some n => if n.distanceM ≤ radiusM then some n.name else none

/-- Transit continuity: the station a stay sits at, having just alighted a
train there. `none` when the preceding segment is not a train or no station is
close enough. -/
def stationAtTrainAlight
    (prev : Option Seg) (lat lon : Float)
    (stationsLookup : Float → Float → Float → Array NearbyStation)
    (radiusM : Float := STATION_AT_ALIGHT_RADIUS_M) : Option String :=
  match prev with
  | none => none
  | some p =>
    if effMode p ≠ "train" then none
    else nameWithin (stationsLookup lat lon radiusM) radiusM

/-- A platform-to-platform interchange walk inside a large station complex. Set
to cover genuine long transfers — King's Cross Victoria→Met is a ~10-minute
concourse walk between separate stations of one interchange. Longer than this is
a walk to somewhere.

A WEAK discriminator on its own: the venue-vs-interchange call rests on the stay
being short AND within station range, which is what the stay being labelled must
satisfy, so a short station-sited stay bracketed by trains is a change of trains
regardless of the transfer walk's exact length. -/
def INTERCHANGE_WALK_MAX_S : Int := 720

/-- A change of trains is a short wait on the platform. A stay longer than this,
even bracketed by trains, is a genuine destination reached by one ride and left
by a later one — a hospital appointment between an outbound and a return train
hours apart, not an interchange. -/
def INTERCHANGE_DWELL_MAX_S : Int := 900

/-- Established-focus-place guard: a stay the place prior confidently assigned
to a focus place visited on at least this many distinct days is a genuine
destination and keeps its label even when train legs bracket it.

Trains on both sides prove a JOURNEY structure — not that the stop between them
was a platform (2026-07-02, user-confirmed: a visit 5 m from the 6-day Hospital U
focus place, between the morning tube and a real one-stop hop onward, was
renamed "Warren Street" after the station 100 m away). One-off focus places stay
overridable, so the 06-29 Baker Street case this rule exists for keeps working
even if a low-evidence cluster ever mines at a platform. -/
def INTERCHANGE_FOCUS_GUARD_MIN_DAYS : Int := 3

/-- Array read at a possibly-out-of-range index, mirroring JS `segments[i]`.

`Int`, not `Nat`: the callers reach for `i - 1` and `i - 2`, and at the head of
the array those are negative in JS and `undefined`, where `Nat` would truncate
to 0 and read a real segment. -/
def segAt (segments : Array Seg) (i : Int) : Option Seg :=
  if i < 0 then none
  else
    let n := i.toNat
    if h : n < segments.size then some segments[n] else none

private def isShortWalk (s : Seg) : Bool :=
  effMode s == "walking" && s.endTs - s.startTs ≤ INTERCHANGE_WALK_MAX_S

/-- Is the segment chain on one side of the stay a train, reached either
directly or across a single short platform-change walk? -/
def bracketingTrain (segments : Array Seg) (adjacent beyond : Int) : Bool :=
  match segAt segments adjacent with
  | none => false
  | some a =>
    if effMode a == "train" then true
    else if isShortWalk a then
      match segAt segments beyond with
      | none => false
      | some b => effMode b == "train"
    else false

/-- Transit-interchange continuity: the station a short, train-bracketed stay
sits at. `none` when the stay is too long, is an established focus place, is not
transit-bracketed on BOTH sides, or no station is close enough.

Requiring trains on both sides (within one short walk) is what separates a
change of trains from alight → walk to a café → walk back → board. -/
def stationAtTransitInterchange
    (segments : Array Seg) (i : Int) (lat lon : Float)
    (stationsLookup : Float → Float → Float → Array NearbyStation)
    (radiusM : Float := STATION_AT_ALIGHT_RADIUS_M)
    (stayFocusDays : Option Int := none) : Option String :=
  match segAt segments i with
  | none => none
  | some stay =>
    if stay.endTs - stay.startTs > INTERCHANGE_DWELL_MAX_S then none
    else if stayFocusDays.any (· ≥ INTERCHANGE_FOCUS_GUARD_MIN_DAYS) then none
    else if !bracketingTrain segments (i - 1) (i - 2) then none
    else if !bracketingTrain segments (i + 1) (i + 2) then none
    else nameWithin (stationsLookup lat lon radiusM) radiusM

/-! ## Reference guards

Pinned against `lean/experiments/transit-place-refs.mts`. -/

section Guards

private def stn (name : String) (distanceM : Float) : NearbyStation :=
  { name, subtype := "station", distanceM }

/-- Two stations, the nearer one SECOND — so a fold that kept the head would
answer "Far". -/
private def two (_lat _lon _r : Float) : Array NearbyStation := #[stn "Far" 120, stn "Near" 40]
/-- Exactly equidistant, so only the tie rule decides. -/
private def tie (_lat _lon _r : Float) : Array NearbyStation := #[stn "First" 40, stn "Second" 40]
/-- One station, one metre outside the default radius. -/
private def beyond (_lat _lon _r : Float) : Array NearbyStation := #[stn "Outside" 151]
/-- …and one sitting exactly ON it, which the inclusive test admits. -/
private def atRadius (_lat _lon _r : Float) : Array NearbyStation := #[stn "Edge" 150]
private def noStations (_lat _lon _r : Float) : Array NearbyStation := #[]

#guard STATION_AT_ALIGHT_RADIUS_M == 150
#guard INTERCHANGE_WALK_MAX_S == 720
#guard INTERCHANGE_DWELL_MAX_S == 900
#guard INTERCHANGE_FOCUS_GUARD_MIN_DAYS == 3

/-! ### `stationAtTrainAlight` -/

/-- `stationAtTrainAlight` reads the mode alone — its TS parameter names only
`mode` and `refinedMode`. The window is what the shared record requires, not
evidence this rule looks at. -/
private def md (mode : Mode) (refinedMode : Option Mode := none) : Seg :=
  { mode, refinedMode, startTs := 0, endTs := 0 }

private def alight (prev : Option Seg)
    (lookup : Float → Float → Float → Array NearbyStation := two)
    (radiusM : Float := STATION_AT_ALIGHT_RADIUS_M) : Option String :=
  stationAtTrainAlight prev 51.5 (-0.2) lookup radiusM

#guard alight none == none
#guard alight (some (md "walking")) == none
#guard alight (some (md "train")) == some "Near"
-- `refinedMode ?? mode`, both directions.
#guard alight (some (md "driving" (some "train"))) == some "Near"
#guard alight (some (md "train" (some "walking"))) == none
#guard alight (some (md "train")) noStations == none
#guard alight (some (md "train")) tie == some "First"
#guard alight (some (md "train")) beyond == none
-- The radius test is INCLUSIVE at the bar.
#guard alight (some (md "train")) atRadius == some "Edge"
-- The radius is a parameter, not a constant: the same station admits at 200 m.
#guard alight (some (md "train")) beyond 200 == some "Outside"

/-! ### `stationAtTransitInterchange` -/

private def sg (mode : Mode) (startTs endTs : Int) (refinedMode : Option Mode := none) : Seg :=
  { mode, startTs, endTs, refinedMode }

/-- `train | stay | train` — both sides directly adjacent. Stay at index 1. -/
private def direct : Array Seg :=
  #[sg "train" 0 600, sg "stationary" 600 900, sg "train" 900 1500]

/-- `train | walk | stay | walk | train` — one short platform change each side.
Stay at index 2. -/
private def viaWalk : Array Seg :=
  #[sg "train" 0 600, sg "walking" 600 900, sg "stationary" 900 1200,
    sg "walking" 1200 1500, sg "train" 1500 2100]

private def withAt (segs : Array Seg) (i : Nat) (s : Seg) : Array Seg := segs.set! i s

private def ix (segs : Array Seg) (i : Int)
    (lookup : Float → Float → Float → Array NearbyStation := two)
    (focusDays : Option Int := none) : Option String :=
  stationAtTransitInterchange segs i 51.5 (-0.2) lookup STATION_AT_ALIGHT_RADIUS_M focusDays

#guard ix direct 1 == some "Near"
#guard ix viaWalk 2 == some "Near"
-- The short-walk bar is inclusive, and one second over disarms the whole side.
#guard ix (withAt viaWalk 1 (sg "walking" 180 900)) 2 == some "Near"
#guard ix (withAt viaWalk 1 (sg "walking" 179 900)) 2 == none
-- A short walk only qualifies the side if a TRAIN sits beyond it.
#guard ix (withAt viaWalk 0 (sg "driving" 0 600)) 2 == none
-- …and "beyond" off the front of the array is `undefined`, not index 0.
#guard ix (viaWalk.extract 1 viaWalk.size) 1 == none
#guard ix (direct.extract 1 direct.size) 0 == none
#guard ix (direct.extract 0 2) 1 == none
#guard ix direct 9 == none
-- The negative index itself. Degenerate on purpose, and it has to be: with a
-- STATIONARY stay the `Nat`-truncation bug is unreachable, because both `i - 1`
-- and `i - 2` clamp to index 0, which is either the stay or the short walk that
-- led there — and neither can pass the train test. Only a stay that is itself a
-- train separates `segments[-1] === undefined` from `segments[0]`.
#guard ix #[sg "train" 0 600, sg "train" 600 1200] 0 == none
-- The dwell bar is inclusive too.
#guard ix (withAt direct 1 (sg "stationary" 600 1500)) 1 == some "Near"
#guard ix (withAt direct 1 (sg "stationary" 599 1500)) 1 == none
-- The focus guard fires at the constant, not below it.
#guard ix direct 1 two (some 2) == some "Near"
#guard ix direct 1 two (some 3) == none
-- A bracketing leg is judged on its EFFECTIVE mode, both directions.
#guard ix (withAt direct 0 (sg "driving" 0 600 (some "train"))) 1 == some "Near"
#guard ix (withAt direct 0 (sg "train" 0 600 (some "walking"))) 1 == none
#guard ix direct 1 noStations == none
#guard ix direct 1 tie == some "First"
#guard ix direct 1 beyond == none

end Guards

end Verified.Geo.TransitPlace
