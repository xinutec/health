import Verified.Hsmm.FloatScore
import Verified.JsNum
/-!
# "Which focus place is the user in right now"

A pure selector over mined `focus_places` and the latest fix, behind
`/internal/place/current`, which coach uses to pick a training location. No
dwell requirement (a gym is a ~1 h visit); focus places are already dwell
clusters. Nearest within 100 m, as the long-stay gate uses: wide enough for
jitter, narrow enough to miss next door. `placeLabel` names the winner and
never picks it.

Exact except `haversineMeters` (≤ 1 ULP before rounding). UNPROVEN; pinned by
the `#guard`s.
-/

namespace Verified.Geo.CurrentPlace

open Verified.Hsmm.FloatScore (haversineMeters)

/-- The generic auto-name given to a cluster with no Home/Work classification —
`Verified.Geo.FocusPlaces.STAY_DISPLAY_NAME`, repeated here rather than
imported so this selector does not drag in the whole mining pipeline. -/
def STAY_DISPLAY_NAME : String := "Stay"

/-- Presence radius around a focus-place centroid. Matches the long-stay gate. -/
def PRESENCE_RADIUS_M : Float := 100

open Verified.JsNum (jsRound)

structure FocusPlaceForPresence where
  id : Int
  displayName : Option String := none
  amenityLabel : Option String := none
  centroidLat : Float
  centroidLon : Float
  deriving Inhabited, BEq, Repr

structure CurrentPlace where
  id : Int
  /-- Best available human label: the auto Home/Work/Stay, else the OSM venue. -/
  label : String
  displayName : Option String
  amenityLabel : Option String
  centroidLat : Float
  centroidLon : Float
  distanceM : Float
  deriving Inhabited, BEq, Repr

/-- Best human label for a focus place. A specific auto-name (Home/Work) wins;
otherwise a mined venue name beats the generic "Stay"; otherwise "Place".
Without the sentinel test, "Stay" would mask a perfectly good venue name. -/
def placeLabel (displayName amenityLabel : Option String) : String :=
  match displayName with
  | some d => if d != STAY_DISPLAY_NAME then d else amenityLabel.getD d
  | none => amenityLabel.getD "Place"

/-- Whether a place is recognisable in a picker: a specific Home/Work, or a
mined venue name. A bare "Stay" names no specific place, so several are
indistinguishable — not worth offering. -/
def isNamedPlace (displayName amenityLabel : Option String) : Bool :=
  (displayName.any (· != STAY_DISPLAY_NAME)) || amenityLabel.isSome

/-- The nearest focus place whose centroid is within `PRESENCE_RADIUS_M` of the
fix, or `none`. Ties keep the earlier place: the scan improves on strict `<`. -/
def pickCurrentPlace (lat lon : Float) (places : Array FocusPlaceForPresence) : Option CurrentPlace :=
  let best := places.foldl (init := none) fun best p =>
    let d := haversineMeters lat lon p.centroidLat p.centroidLon
    if d > PRESENCE_RADIUS_M then best
    else match best with
      | some (_, bd) => if d < bd then some (p, d) else best
      | none => some (p, d)
  best.map fun (p, d) =>
    { id := p.id
      label := placeLabel p.displayName p.amenityLabel
      displayName := p.displayName
      amenityLabel := p.amenityLabel
      centroidLat := p.centroidLat
      centroidLon := p.centroidLon
      distanceM := jsRound d }

/-! ## Guards -/

-- A specific auto-name wins outright.
#guard placeLabel (some "Home") (some "Gym") == "Home"
#guard isNamedPlace (some "Home") (some "Gym") == true
-- The generic "Stay" must not mask a venue.
#guard placeLabel (some "Stay") (some "PureGym Wembley") == "PureGym Wembley"
#guard isNamedPlace (some "Stay") (some "PureGym Wembley") == true
-- Nothing better: "Stay" comes back through the fallback chain, but it does not
-- name a place, so the picker declines to offer it.
#guard placeLabel (some "Stay") none == "Stay"
#guard isNamedPlace (some "Stay") none == false
#guard placeLabel none (some "Sainsbury's") == "Sainsbury's"
#guard isNamedPlace none (some "Sainsbury's") == true
#guard placeLabel none none == "Place"
#guard isNamedPlace none none == false
-- `""` is not the sentinel, so it wins as a displayName: an empty label, and
-- `isNamedPlace` still says yes. The comparison is against the sentinel, not
-- truthiness.
#guard placeLabel (some "") none == ""
#guard isNamedPlace (some "") none == true

private def HOME : FocusPlaceForPresence :=
  { id := 1, displayName := some "Home", centroidLat := 51.52, centroidLon := -0.13 }
-- ~78 m east of Home, so the two genuinely compete on distance.
private def GYM : FocusPlaceForPresence :=
  { id := 2, displayName := some "Stay", amenityLabel := some "PureGym",
    centroidLat := 51.52, centroidLon := -0.1288749 }
private def FAR : FocusPlaceForPresence := { id := 3, centroidLat := 51.6, centroidLon := -0.13 }
private def PLACES : Array FocusPlaceForPresence := #[HOME, GYM, FAR]

private def pv (r : Option CurrentPlace) : Option (Int × String × Float) :=
  r.map fun c => (c.id, c.label, c.distanceM)

#guard pv (pickCurrentPlace 51.52 (-0.13) PLACES) == some (1, "Home", 0)
-- Between the two: the gym is nearer, so it wins even though "Home" is the
-- stronger label. Nearest, not rank.
#guard pv (pickCurrentPlace 51.52 (-0.1291) PLACES) == some (2, "PureGym", 16)
#guard pickCurrentPlace 51.4 (-0.4) PLACES == none
-- Just inside 100 m of Home, and nothing else in range — pins the `Math.round`
-- of `distanceM` as well as the radius test…
#guard pv (pickCurrentPlace 51.5208 (-0.13) PLACES) == some (1, "Home", 89)
-- …and just outside it.
#guard pickCurrentPlace 51.5210 (-0.13) PLACES == none
-- Exactly 100 m from Home: the test is `d > radius`, so the boundary is in.
-- Found by search (neighbouring doubles differ by ~8e-10 m); it pins `>` vs `≥`.
#guard pv (pickCurrentPlace 51.52089857309002 (-0.129941044) #[HOME]) == some (1, "Home", 100)
#guard pickCurrentPlace 51.52 (-0.13) #[] == none

end Verified.Geo.CurrentPlace
