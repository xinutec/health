import Verified.Geo.SegmentMerge
import Verified.Geo.TubeHop
/-!
# Transit continuity for place-naming

The venue scorer knows nothing of trains, so a station forecourt resolves to
whatever café is mapped in the concourse. Four rules supply the context:

* `stationAtTrainAlight`: a stay directly after a train, within range, is at
  the station alighted at (a café visit has a walk in between).
* `stationsAfterAlighting`: the first stay after a train, across walks alone,
  is at the station the train's label alighted at, when in range.
* `stationsBeforeBoarding`: a stay running into a train, or parted from it by a
  short walk inside the station, and the stays before it there, are the wait.
* `stationsFromEnclosed`: a stay the station building encloses is the wait,
  and so is every stay after it there up to the train.

The station lookup is the caller's `(lat, lon, radiusM)` function. Exact: the
distances arrive computed. A distance tie keeps the earlier station (strict
`<`), since co-located nodes tie routinely. Indices are `Int` with `segAt`
returning `none` outside the array: `Nat` subtraction at `i = 0` would read the
stay itself, answer "not a train" and look right.

UNPROVEN; pinned by the `#guard`s below.
-/

namespace Verified.Geo.TransitPlace

open Verified.Geo.TubeHop (NearbyStation)

abbrev Mode := String

/-- The pipeline's segment record. This pass reads and rewrites a subset of
it; it names the whole thing so that `Verified.Geo.PassFold` can hand the same
value to every pass in the cascade without a lossy projection at each hop. -/
abbrev Seg := Verified.Geo.SegmentMerge.Seg

def effMode (s : Seg) : Mode := s.refinedMode.getD s.mode

/-- How close a train-alighting stay must sit to a station node to be named
after it: tight enough not to swallow a café actually walked to. -/
def STATION_AT_ALIGHT_RADIUS_M : Float := 150

/-- The nearest station, or `none` for an empty list.

Improves only on strict `<`, so a tie keeps the earlier element. -/
def nearestStation (stations : Array NearbyStation) : Option NearbyStation :=
  stations.foldl (init := none) fun best s =>
    match best with
    | some b => if s.distanceM < b.distanceM then some s else best
    | none => some s

/-- The nearest station's name inside `radiusM`. The radius test is kept even
though the adapter filters: nothing here guarantees it did. -/
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

/-- A platform-to-platform interchange walk inside a station complex (King's
Cross Victoria→Met is ~10 minutes); longer is a walk somewhere. A weak signal:
the stay being short and in range does most of the work. -/
def INTERCHANGE_WALK_MAX_S : Int := 720

/-- A stay assigned to a focus place visited on at least this many days is a
destination and keeps its label between trains: trains either side prove a
journey, not a platform (a hospital visit beside a station was renamed for the
station). One-off places stay overridable. -/
def INTERCHANGE_FOCUS_GUARD_MIN_DAYS : Int := 3

/-- The longest wait before boarding that is still the wait for the train:
09-30's Eurostar check-in at St Pancras was 74 minutes. A stay longer than this
is somewhere the user went, and a train later is how they left it. -/
def BOARDING_WAIT_MAX_S : Int := 90 * 60

/-- The longest wait for a metro, tram or light-rail train (frequent, no
check-in). Longer, beside a station that is only those, is somewhere the user
went: 88 minutes in a café by a Métro entrance had read as the station. -/
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

/-- The longest walk from concourse to platform still inside the station: 3–4
minutes measured, against 9 for a walk along a road to King's Cross whose every
fix is in station range, which range alone cannot tell apart. -/
def PLATFORM_WALK_MAX_S : Int := 5 * 60

/-- Boarding continuity, the mirror of `stationAtTrainAlight`: a stay that runs
into a train is its wait, and so is every stay before it at the same station
across short walks (an hour inside a terminus read as its shops).

The anchor touches the train: a meal and a walk to the station is not a wait.
It is a stay, or a short walk never leaving the board station's range (the last
platform wait is absorbed into the train). Read right to left; a stay out of
range closes the chain. `stationsAt i` is the stations in range of stay `i`,
nearest first, or none when it keeps its name; in range, not nearest, since a
Métro entrance can sit nearer the concourse than the gare. `trainBoard i` is
where train `i` boards; `walkWithin i st` whether walk `i` stays in range. -/
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

/-- Boarding continuity from inside the station: a stay the building encloses
is the wait whatever touches the train, as is every stay after it there up to
the train. Forward only: being inside is the evidence. `enclosedAt i` is the
stations in range of an enclosed stay `i`; the chain is named for the station
the train ahead boards at when in range, else the nearest. -/
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

/-- Alighting continuity, the mirror of `stationsBeforeBoarding`: the first stay
after a train, across walks alone, is at the station its label alighted at
(`trainAlight i`) when in range. The stay's position is the evidence, not the
walk's: fixes surfacing from a platform sit far out at poor accuracy. No length
bound; a stay out of range, or any other mode, closes the chain. -/
def stationsAfterAlighting (segments : Array Seg)
    (stationsAt : Nat → Array String)
    (trainAlight : Nat → Option String) : Array (Option String) := Id.run do
  let mut out : Array (Option String) := Array.replicate segments.size none
  let mut chain : Option String := none
  for i in [0 : segments.size] do
    let some s := segments[i]? | continue
    match effMode s, chain with
    | "train", _ => chain := trainAlight i
    | "walking", _ => pure ()
    | "stationary", some st =>
      if (stationsAt i).contains st then out := out.set! i (some st)
      chain := none
    | _, _ => chain := none
  return out

/-! ## Reference guards

Pinned by the reference answers. -/

section Guards

private def stn (name : String) (distanceM : Float) : NearbyStation :=
  { name, subtype := "station", distanceM }

/-- Two stations, the nearer one second — so a fold that kept the head would
answer "Far". -/
private def two (_lat _lon _r : Float) : Array NearbyStation := #[stn "Far" 120, stn "Near" 40]
/-- Exactly equidistant, so only the tie rule decides. -/
private def tie (_lat _lon _r : Float) : Array NearbyStation := #[stn "First" 40, stn "Second" 40]
/-- One station, one metre outside the default radius. -/
private def beyond (_lat _lon _r : Float) : Array NearbyStation := #[stn "Outside" 151]
/-- …and one sitting exactly on it, which the inclusive test admits. -/
private def atRadius (_lat _lon _r : Float) : Array NearbyStation := #[stn "Edge" 150]
private def noStations (_lat _lon _r : Float) : Array NearbyStation := #[]

#guard STATION_AT_ALIGHT_RADIUS_M == 150
#guard INTERCHANGE_WALK_MAX_S == 720
#guard INTERCHANGE_FOCUS_GUARD_MIN_DAYS == 3

/-! ### `stationAtTrainAlight` -/

/-- `stationAtTrainAlight` reads the mode alone. The window is what the shared
record requires, not evidence this rule looks at. -/
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
-- The radius test is inclusive at the bar.
#guard alight (some (md "train")) atRadius == some "Edge"
-- The radius is a parameter, not a constant: the same station admits at 200 m.
#guard alight (some (md "train")) beyond 200 == some "Outside"

private def sg (mode : Mode) (startTs endTs : Int) (refinedMode : Option Mode := none) : Seg :=
  { mode, startTs, endTs, refinedMode }

/-- `train | stay | train` — a change of trains. Stay at index 1. -/
private def direct : Array Seg :=
  #[sg "train" 0 600, sg "stationary" 600 900, sg "train" 900 1500]

private def withAt (segs : Array Seg) (i : Nat) (s : Seg) : Array Seg := segs.set! i s

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
-- A walk between the stay and the train is going to the train: no anchor.
#guard board #[sg "stationary" 0 1900, sg "walking" 1900 2100, sg "train" 2100 9000]
  == #[none, none, none]
-- …unless it never leaves the board station: the walk to the platform after the
-- last wait was absorbed into the train (10-01). The chain is at the board
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
-- The stay before the platform walk must be in range of the board station.
#guard toPlatform (within := true) (others := [(2, #["T"])]) == #[none, none, none, none, none]
-- A stay after a train is the alight rule's, not this one's.
#guard board #[sg "train" 0 600, sg "stationary" 600 900] == #[none, none]
#guard board #[sg "stationary" 0 300] == #[none]
-- A stay at another station, or at none, closes the chain for everything before.
#guard board wait [(2, #["T"])] == #[none, none, none, none, S, none]
#guard board wait [(2, #[])] == #[none, none, none, none, S, none]
#guard board wait [(4, #[])] == #[none, none, none, none, none, none]
-- The anchor takes its nearest station; earlier stays need it only in range.
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

/-! ### `stationsAfterAlighting` -/

/-- Every stay is in range of station "S" alone unless listed otherwise; the
trains alight where `alights` says, nowhere otherwise. -/
private def after (segs : Array Seg) (alights : List (Nat × String))
    (others : List (Nat × Array String) := []) : Array (Option String) :=
  stationsAfterAlighting segs
    (fun i => match others.find? (·.1 == i) with
      | some (_, sts) => sts
      | none => #["S"])
    (fun i => (alights.find? (·.1 == i)).map (·.2))

-- A change of trains; the second train's own alight is not reached.
#guard after direct [(0, "S"), (2, "T")] == #[none, S, none]
-- Across the walk up from the platform, and the stay's length is no bar.
#guard after #[sg "train" 0 600, sg "walking" 600 720, sg "stationary" 720 9000] [(0, "S")]
  == #[none, none, S]
-- The first stay only.
#guard after #[sg "train" 0 600, sg "stationary" 600 900, sg "walking" 900 1000, sg "stationary" 1000 1800]
    [(0, "S")]
  == #[none, S, none, none]
-- A stay out of the alight station's range closes the chain; so does a drive.
#guard after #[sg "train" 0 600, sg "walking" 600 1200, sg "stationary" 1200 1800] [(0, "S")] [(2, #["T"])]
  == #[none, none, none]
#guard after #[sg "train" 0 600, sg "driving" 600 900, sg "stationary" 900 1800] [(0, "S")]
  == #[none, none, none]
-- The ride's own alight, not the nearest station; a ride without one names nothing.
#guard after direct [(0, "T")] == #[none, none, none]
#guard after direct [] == #[none, none, none]
-- The train is judged on its effective mode.
#guard after (withAt direct 0 (sg "driving" 0 600 (some "train"))) [(0, "S")] == #[none, S, none]
#guard after (withAt direct 0 (sg "train" 0 600 (some "walking"))) [(0, "S")] == #[none, none, none]

end Guards

end Verified.Geo.TransitPlace
