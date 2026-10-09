import Verified.Geo.SegmentMerge
import Verified.Geo.TubeHop
/-!
# Transit continuity for place-naming (port of `src/geo/transit-place.ts`)

Four rules that give the place-picker the transit context it otherwise lacks.
The venue scorer ranks what is mapped near a coordinate; it has no idea the
user just got off a train or is about to board one, so a station forecourt
resolves to whatever café, hotel or doughnut counter happens to be mapped
inside the concourse.

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
* `stationsBeforeBoarding` — a stay that runs straight into a train, or is
  parted from it only by a short walk inside the board station, and the stays
  before it at the same station across short walks, are the wait for it
  (2026-10-01: an hour in Gare Montparnasse read as shop visits; 06-12 Victoria
  and 09-06 Stanmore through the walk to the platform).
* `stationsFromEnclosed` — a stay the station BUILDING encloses is the wait
  whatever touches the train, and so is every stay after it at the same
  station up to the train; named for the station the train boards at
  (2026-10-03: the last five minutes before Montparnasse's platform walk read
  "McDonald's").

The first two are `async` in the TS only because the station lookup is injected
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

UNPROVEN. The first two rules are pinned against Node/V8
(`lean/experiments/transit-place-refs.mts`); the two boarding rules are
Lean-only (#1891, 2026-10) and pinned by their `#guard`s below.
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

/-- The stations within `radiusM` of a coordinate, by name, nearest first. The
sort is stable, so a distance tie keeps the earlier station, as
`nearestStation` does. -/
def stationsWithin (lat lon : Float)
    (stationsLookup : Float → Float → Float → Array NearbyStation)
    (radiusM : Float := STATION_AT_ALIGHT_RADIUS_M) : Array String :=
  ((stationsLookup lat lon radiusM).filter (·.distanceM ≤ radiusM)
    |>.insertionSort (·.distanceM < ·.distanceM)).map (·.name)

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

/-- The longest wait before boarding that is still the wait for the train:
2026-09-30's Eurostar check-in at St Pancras was 74 minutes. A stay longer
than this is somewhere he went, and a train later is how he left it. -/
def BOARDING_WAIT_MAX_S : Int := 90 * 60

/-- The longest wait for a metro, tram or light-rail train: one comes every few
minutes, and there is no check-in. Longer than this beside a station that is
only those, a stay is somewhere he went: 88 minutes in a café 73 m from a
Métro entrance had read as the station. -/
def METRO_WAIT_MAX_S : Int := 15 * 60

/-- A node that says mainline: a station or halt, not an entrance, a platform
stop or a metro, tram or light-rail station. -/
def isMainlineNode (n : NearbyStation) : Bool :=
  n.subtype == "rail" || n.subtype == "halt"

/-- The stations in range that a stay of `durS` can be the wait for, nearest
first: every one up to `METRO_WAIT_MAX_S`, beyond it only a name with a
mainline node in range. -/
def stationsForWait (lat lon : Float) (durS : Int)
    (stationsLookup : Float → Float → Float → Array NearbyStation)
    (radiusM : Float := STATION_AT_ALIGHT_RADIUS_M) : Array String :=
  let names := stationsWithin lat lon stationsLookup radiusM
  if durS ≤ METRO_WAIT_MAX_S then names
  else
    let near := (stationsLookup lat lon radiusM).filter (·.distanceM ≤ radiusM)
    names.filter fun n => near.any fun x => x.name == n && isMainlineNode x

private def stWait (n st : String) (d : Float) : NearbyStation := { name := n, subtype := st, distanceM := d }
private def vavin : Float → Float → Float → Array NearbyStation := fun _ _ _ =>
  #[stWait "Rue Vavin" "subway_entrance" 73, stWait "Vavin" "stop_position" 81,
    stWait "Vavin" "subway" 89]
private def stPancras : Float → Float → Float → Array NearbyStation := fun _ _ _ =>
  #[stWait "King's Cross St Pancras" "subway" 40, stWait "London St Pancras International" "rail" 90]
-- A short wait can be for the Métro; an hour and a half beside it cannot.
#guard stationsForWait 0 0 (10 * 60) vavin == #["Rue Vavin", "Vavin", "Vavin"]
#guard stationsForWait 0 0 (88 * 60) vavin == #[]
-- A mainline station keeps the long wait, and only its own name.
#guard stationsForWait 0 0 (74 * 60) stPancras == #["London St Pancras International"]

/-- The longest walk from the concourse to the platform that is still inside
the station. Measured on both sides, not surveyed: the walks to the platform at
Victoria (2026-06-12) and Stanmore (2026-09-06) are 4 and 3 minutes; the walk
from Pizza Union along Pentonville Road to King's Cross (2026-05-22) is 9, and
every fix of it is within station range of a King's Cross entrance, so range
alone cannot tell a journey to the station from a walk inside it. -/
def PLATFORM_WALK_MAX_S : Int := 5 * 60

/-- Boarding continuity, the mirror of `stationAtTrainAlight`: a stay that runs
straight into a train is the wait for it, and so is every stay before it at the
SAME station, across short walks (2026-10-01: an hour inside Gare Montparnasse
read "Maison du Chocolat", "McDonald's" and "Jardin Atlantique", the garden on
the station roof).

The anchor touches the train, as the alight rule's does: dinner at Pizza Union
and a walk to King's Cross for the train home (2026-05-22) is a meal, not a
wait. The anchor is a stay, or a short walk that never leaves the range of the
station the train BOARDS at: the last wait on the platform is absorbed into the
train as its boarding (2026-10-01, 11:03), which leaves the walk from the
concourse to the platform touching the train, and the hour of waits before it
read as the shops beside each. Pizza Union's walk sets out from outside any
node of King's Cross, so it anchors nothing. Read right to left; a stay not in
range of the chain's station closes the chain for everything earlier.

`stationsAt i` is the caller's answer for the stay at `i`: the stations in
range, nearest first, or none at all when the stay must keep its name (an
established focus place). In range, not nearest: at Montparnasse a Métro
entrance sits nearer the concourse than any node of the gare above it.
`trainBoard i` is the station the train at `i` boards at, when its label says;
`walkWithin i st` is whether every fix of the walk at `i` is in range of `st`. -/
def stationsBeforeBoarding (segments : Array Seg)
    (stationsAt : Nat → Array String)
    (trainBoard : Nat → Option String := fun _ => none)
    (walkWithin : Nat → String → Bool := fun _ _ => false) : Array (Option String) := Id.run do
  let mut out : Array (Option String) := Array.replicate segments.size none
  -- `some none`: a train is directly to the right. `some (some st)`: the chain
  -- is at `st`. `none`: closed.
  let mut chain : Option (Option String) := none
  for k in [0 : segments.size] do
    let i := segments.size - 1 - k
    let some s := segments[i]? | continue
    let dur := s.endTs - s.startTs
    chain := match effMode s, chain with
      | "train", _ => some none
      | "walking", some (some st) => if dur ≤ INTERCHANGE_WALK_MAX_S then some (some st) else none
      | "walking", some none =>
        -- The walk to the platform: an anchor only inside the board station.
        match trainBoard (i + 1) with
        | some b => if dur ≤ PLATFORM_WALK_MAX_S && walkWithin i b then some (some b) else none
        | none => none
      | "stationary", some want =>
        let here := if dur ≤ BOARDING_WAIT_MAX_S then stationsAt i else #[]
        match want with
        | none => here[0]?.map some
        | some st => if here.contains st then some (some st) else none
      | _, _ => none
    if let some (some st) := chain then
      if effMode s == "stationary" then out := out.set! i (some st)
  return out

/-- Boarding continuity from INSIDE the station: a stay the station's building
encloses is the wait whatever touches the train, and so is every stay after it
at the same station, across short walks, up to the train (2026-10-03: at
Montparnasse the last five minutes before the platform walk sat at
"McDonald's", its centroid outside every hall outline under 100 m fixes, and
the stay before it was inside Hall 1). FORWARD ONLY: a stay before entering the
building is a destination of its own; being inside is the evidence, and it
starts there. `enclosedAt i` is the stations in range of a building-enclosed
stay at `i`, nearest first, and empty for every other segment; `trainBoard j` is
where the train at `j` boards. The chain is named for the station the train
ahead boards at when that is in range — at Montparnasse the Métro's node sits
nearer the halls than the gare's, and the TGV says which one the wait was for —
and for the nearest otherwise. -/
def stationsFromEnclosed (segments : Array Seg)
    (enclosedAt : Nat → Array String) (stationsAt : Nat → Array String)
    (trainBoard : Nat → Option String := fun _ => none) :
    Array (Option String) := Id.run do
  let mut out : Array (Option String) := Array.replicate segments.size none
  let mut chain : Option String := none
  for i in [0 : segments.size] do
    let some s := segments[i]? | continue
    let dur := s.endTs - s.startTs
    let here := enclosedAt i
    if !here.isEmpty then
      -- The train this wait was for: the first one after the stay, within the
      -- boarding-wait bound. Not the chain's own walk: the name does not need
      -- the chain to reach the train, only to know which train it was.
      let mut board : Option String := none
      let mut j := i + 1
      while j < segments.size do
        let some t := segments[j]? | break
        if effMode t == "train" then
          if t.startTs - s.endTs ≤ BOARDING_WAIT_MAX_S then board := trainBoard j
          break
        j := j + 1
      let st := match board with
        | some b => if here.contains b then b else here[0]!
        | none => here[0]!
      chain := some st
      out := out.set! i (some st)
      continue
    chain := match effMode s, chain with
      | "walking", some st => if dur ≤ INTERCHANGE_WALK_MAX_S then some st else none
      | "stationary", some st =>
        if dur ≤ BOARDING_WAIT_MAX_S && (stationsAt i).contains st then some st else none
      | _, _ => none
    if let some st := chain then
      if effMode s == "stationary" then out := out.set! i (some st)
  return out

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
  stationAtTrainAlight prev 51.5 (-38.2) lookup radiusM

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
  stationAtTransitInterchange segs i 51.5 (-38.2) lookup STATION_AT_ALIGHT_RADIUS_M focusDays

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

/-! ### `stationsBeforeBoarding` -/

/-- Every stay is in range of station "S" alone unless listed otherwise. -/
private def board (segs : Array Seg) (others : List (Nat × Array String) := []) :
    Array (Option String) :=
  stationsBeforeBoarding segs fun i =>
    match others.find? (·.1 == i) with
    | some (_, sts) => sts
    | none => #["S"]

/-- `stay | walk | stay | walk | stay | train`: the Montparnasse hour. -/
private def wait : Array Seg :=
  #[sg "stationary" 0 300, sg "walking" 300 840, sg "stationary" 840 1100,
    sg "walking" 1100 1300, sg "stationary" 1300 2100, sg "train" 2100 9000]

private def S : Option String := some "S"

/-- `stay | walk | stay | walk | train`: the Montparnasse hour as served live,
the platform wait absorbed into the train. The last walk is the one to the
platform. -/
private def toPlatform (within : Bool) (boardsAt : Option String := some "S")
    (walkS : Int := 300) (others : List (Nat × Array String) := []) : Array (Option String) :=
  stationsBeforeBoarding
    #[sg "stationary" 0 300, sg "walking" 300 840, sg "stationary" 840 1100,
      sg "walking" 1100 (1100 + walkS), sg "train" (1100 + walkS) 9000]
    (fun i => match others.find? (·.1 == i) with
      | some (_, sts) => sts
      | none => #["S"])
    (fun i => if i == 4 then boardsAt else none)
    (fun i st => i == 3 && st == "S" && within)

#guard stationsWithin 0 0 two == #["Near", "Far"]
#guard stationsWithin 0 0 tie == #["First", "Second"]
#guard stationsWithin 0 0 beyond == #[]
#guard stationsWithin 0 0 atRadius == #["Edge"]
#guard BOARDING_WAIT_MAX_S == 5400
#guard PLATFORM_WALK_MAX_S == 300
#guard board wait == #[S, none, S, none, S, none]
-- A walk between the stay and the train is going TO the train: no anchor.
#guard board #[sg "stationary" 0 1900, sg "walking" 1900 2100, sg "train" 2100 9000]
  == #[none, none, none]
-- …unless it never leaves the board station: the walk to the platform after the
-- last wait was absorbed into the train (10-01). The chain is at the BOARD
-- station, so a stay in range of it is named, and one that is not closes it.
#guard toPlatform (within := true) == #[S, none, S, none, none]
#guard toPlatform (within := false) == #[none, none, none, none, none]
-- The train's label must say where it boards; a walk inside some station the
-- train did not board at (a Métro entrance beside the restaurant) is nothing.
#guard toPlatform (within := true) (boardsAt := none) == #[none, none, none, none, none]
-- The platform walk has its own, shorter bar: Pizza Union's nine minutes along
-- Pentonville Road are in range of King's Cross the whole way and are a journey.
#guard toPlatform (within := true) (walkS := PLATFORM_WALK_MAX_S) == #[S, none, S, none, none]
#guard toPlatform (within := true) (walkS := PLATFORM_WALK_MAX_S + 1)
  == #[none, none, none, none, none]
#guard toPlatform (within := true) (walkS := 9 * 60) == #[none, none, none, none, none]
-- The stay before the platform walk must be in range of the BOARD station.
#guard toPlatform (within := true) (others := [(2, #["T"])]) == #[none, none, none, none, none]
-- A stay AFTER a train is the alight rule's, not this one's.
#guard board #[sg "train" 0 600, sg "stationary" 600 900] == #[none, none]
#guard board #[sg "stationary" 0 300] == #[none]
-- A stay at ANOTHER station, or at none, closes the chain for everything before.
#guard board wait [(2, #["T"])] == #[none, none, none, none, S, none]
#guard board wait [(2, #[])] == #[none, none, none, none, S, none]
#guard board wait [(4, #[])] == #[none, none, none, none, none, none]
-- The anchor takes its NEAREST station; earlier stays need it only in range.
#guard board wait [(4, #["T", "S"])] == #[none, none, none, none, some "T", none]
#guard board wait [(2, #["T", "S"])] == #[S, none, S, none, S, none]
-- The walk bar is inclusive, and one second over closes the chain.
#guard board (withAt wait 1 (sg "walking" 120 840)) == #[S, none, S, none, S, none]
#guard board (withAt wait 1 (sg "walking" 119 840)) == #[none, none, S, none, S, none]

/-! ### `stationsFromEnclosed` -/

/-- `stay | walk | stay(inside) | walk | stay | walk(12 min) | train`: the hour
as served live, the third stay inside Hall 1. -/
private def hall : Array Seg :=
  #[sg "stationary" 0 300, sg "walking" 300 540, sg "stationary" 540 900,
    sg "walking" 900 1440, sg "stationary" 1440 1740, sg "walking" 1740 2460,
    sg "train" 2460 9000]
private def inside (segs : Array Seg) (at_ : Nat) (others : List (Nat × Array String) := [])
    (here : Array String := #["S"]) (boardsAt : Option String := none) :
    Array (Option String) :=
  stationsFromEnclosed segs (fun i => if i == at_ then here else #[])
    (fun i => match others.find? (·.1 == i) with
      | some (_, sts) => sts
      | none => #["S"])
    (fun i => if i == 6 then boardsAt else none)

-- From the enclosed stay forward to the train; the stay before it is its own.
#guard inside hall 2 == #[none, none, S, none, S, none, none]
-- No enclosed stay, no chain (Pizza Union).
#guard stationsFromEnclosed hall (fun _ => #[]) (fun _ => #["S"]) == Array.replicate 7 none
-- Two stations in range of the halls, the Métro's nearer: the TGV's board
-- station names the wait; with no train label, or a train boarding elsewhere,
-- the nearest does.
#guard inside hall 2 [(4, #["M", "G"])] (here := #["M", "G"]) (boardsAt := some "G")
  == #[none, none, some "G", none, some "G", none, none]
#guard inside hall 2 [(4, #["M", "G"])] (here := #["M", "G"])
  == #[none, none, some "M", none, some "M", none, none]
#guard inside hall 2 [(4, #["M", "G"])] (here := #["M", "G"]) (boardsAt := some "X")
  == #[none, none, some "M", none, some "M", none, none]
-- The train names the wait even when the walk to the platform is longer than
-- the chain follows (the chain still stops there); a train past the wait bound
-- does not.
#guard inside (withAt hall 5 (sg "walking" 1740 (1740 + INTERCHANGE_WALK_MAX_S + 1)))
    2 [(4, #["M", "G"])] (here := #["M", "G"]) (boardsAt := some "G")
  == #[none, none, some "G", none, some "G", none, none]
#guard inside (withAt hall 6 (sg "train" (900 + BOARDING_WAIT_MAX_S + 1) 99999))
    2 [(4, #["M", "G"])] (here := #["M", "G"]) (boardsAt := some "G")
  == #[none, none, some "M", none, some "M", none, none]
-- A later stay at another station, or at none, closes it.
#guard inside hall 2 [(4, #["T"])] == #[none, none, S, none, none, none, none]
#guard inside hall 2 [(4, #[])] == #[none, none, S, none, none, none, none]
-- A long walk closes it; the platform walk's length does not matter.
#guard inside (withAt hall 3 (sg "walking" 900 (900 + INTERCHANGE_WALK_MAX_S + 1))) 2
  == #[none, none, S, none, none, none, none]
-- Nothing after the train.
#guard inside #[sg "stationary" 0 300, sg "train" 300 900, sg "stationary" 900 1200] 0
  == #[S, none, none]
-- So is the wait bar, on the anchor too.
#guard board (withAt wait 2 (sg "stationary" 840 6240)) == #[S, none, S, none, S, none]
#guard board (withAt wait 2 (sg "stationary" 839 6240)) == #[none, none, none, none, S, none]
#guard board (withAt wait 4 (sg "stationary" 0 5400)) == #[S, none, S, none, S, none]
#guard board (withAt wait 4 (sg "stationary" 0 5401)) == #[none, none, none, none, none, none]
-- Any other mode closes it; the train is judged on its effective mode.
#guard board (withAt wait 3 (sg "driving" 1100 1300)) == #[none, none, none, none, S, none]
#guard board (withAt wait 5 (sg "driving" 2100 9000 (some "train"))) == board wait
#guard board (withAt wait 5 (sg "train" 2100 9000 (some "walking"))) == #[none, none, none, none, none, none]

end Guards

end Verified.Geo.TransitPlace
