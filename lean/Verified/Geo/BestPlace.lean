import Verified.Geo.Enrich
import Verified.Geo.VenuePrior
import Verified.Geo.OpeningHours
import Verified.Geo.SegmentMerge
/-!
# Naming a stay (port of `bestPlace` in `src/geo/osm.ts`)

Given a coordinate and, optionally, the stay window that happened there, which
label does the timeline show? The TS answer is one function with two arms:

* **with a stay** — the venue-plausibility ranking (#246). Every Overpass
  landmark plus a Nominatim venue candidate compete on summed log-evidence,
  and the winner must clear a floor or nothing is named.
* **without one** — `pickBestLandmark`, which is the same ranking with no stay
  and no priors, so it degrades to distance + venue-over-area.

Both then fall through the same address chain.

## Why this is not a shell

`Verified.Geo.PassFold.Env.bestPlace` and `Verified.Geo.DayChain`'s
`sleepPlace` were both injected answers, on the reading that venue naming is an
OSM question. Reading the function says otherwise, and it is the same finding
as `reenrich` (#424): a callback is not a shell because it is a callback; it is
a shell when what it does cannot be said in Lean.

What `bestPlace` actually does is TWO mirror reads —
`nearbyLandmarks(lat, lon, 100)` and `reverseGeocode(lat, lon, 18)`, plus
`reverseGeocode(lat, lon, 16)` on the fall-through — followed by ranking and a
chain of `if`s. The reads are shell and stay shell. Everything after them is
arithmetic and string work, which is this module.

## The one thing that genuinely cannot be said here

Opening hours are evaluated in the VENUE's local time, and the instant → local
`(weekday, minute-of-day)` map is tzdata. So the shell samples the stay window
and hands over the resolved pairs; {@link Verified.Geo.OpeningHours.openFractionOver}
was written for exactly that split and its docstring states the contract. The
same is true of `localHour`, the stay midpoint's hour, which the shape prior
reads.

That is a smaller shell than "the answer": the shell now supplies WHEN, and
Lean decides WHAT.

## Truthiness, twice, and they disagree

`hasSpecificVenue` tests `!!(a.amenity || a.tourism || a.leisure || a.shop)`,
so an EMPTY string is absent. `nominatimVenueName` uses
`a.amenity ?? a.tourism ?? …`, so an empty string is PRESENT and wins the
chain — after which `if (!name) return null` rejects it.

The two differ on exactly one input: `amenity = ""` with a real `tourism`.
`hasSpecificVenue` says yes, `nominatimVenueName` yields `""` and the candidate
is dropped. Both are modelled as written rather than as intended, because a
port that "fixes" this would diverge on that stay and the gate would call it a
port bug.
-/

namespace Verified.Geo.BestPlace

open Verified.Geo.Enrich (Address extractCity)
open Verified.Geo.VenuePrior (Landmark StayShape VenuePriors rankVenues VENUE_RANK_FLOOR_NATS)
open Verified.Geo.OpeningHours (parseOpeningHours openFractionOver)

/-- A Nominatim reverse-geocode response, as much of one as the naming reads. -/
structure Result where
  displayName : String
  /-- The OSM tag VALUE — `"restaurant"`, `"park"`. Rendered in parentheses
  after the venue name, so an empty one is omitted rather than printed. -/
  type : String
  /-- The top-level key — `"amenity"`, `"leisure"`, `"place"`. -/
  category : String
  address : Address
  deriving Inhabited, BEq, Repr

/-- An Overpass landmark BEFORE its opening-hours tag has been evaluated
against a stay. {@link Verified.Geo.VenuePrior.Landmark} carries the resolved
`openFraction` instead, because the scorer weighs the fraction and never sees
the tag — so the raw tag needs somewhere to live between the wire and the
scorer, and that is here. -/
structure Poi where
  name : String
  type : String
  subtype : String
  distanceM : Float
  /-- Raw OSM `opening_hours`. ~70% of venue POIs lack it. -/
  openingHours : Option String := none
  enclosing : Bool := false
  deriving Inhabited, BEq, Repr

/-- JS truthiness for a string field: absent AND empty both read as false. -/
private def truthy (o : Option String) : Bool := o.any (· != "")

/-- The JS `??` chain: an empty string is a VALUE and stops the chain. Distinct
from {@link truthy} on purpose — see the module header. -/
private def nullish (xs : List (Option String)) : Option String :=
  xs.foldl (fun acc x => acc.orElse fun _ => x) none

/-! ## Landmarks into candidates -/

/--
Resolve one POI's hours against the stay's sampled minutes, producing the
`Landmark` the scorer ranks.

`none` out of the parser means NO EVIDENCE, not closed — the asymmetry
{@link Verified.Geo.OpeningHours} exists to preserve. An absent or empty tag is
the same silence, which is why the guard is truthiness rather than `isSome`.
-/
def toLandmark (samples : List (Nat × Nat)) (hasStay : Bool) (p : Poi) : Landmark :=
  let openFraction :=
    if !hasStay || !truthy p.openingHours then none
    else match parseOpeningHours (p.openingHours.getD "") with
      | none => none
      | some spec => some (openFractionOver spec samples)
  { name := p.name, type := p.type, subtype := p.subtype, distanceM := p.distanceM,
    openFraction := openFraction, enclosing := p.enclosing, reverseGeocoded := false }

/-- The venue name a specific-venue Nominatim result carries — the address
fields hold the NAME, not the tag value. -/
def nominatimVenueName (r : Result) : Option String :=
  nullish [r.address.amenity, r.address.tourism, r.address.shop, r.address.leisure]

/-- Map a specific-venue Nominatim result onto a candidate so the ranking can
weigh it against the Overpass landmarks. Distance 0 because zoom-18 Nominatim
named the building the centroid is ON — which is why it is flagged
`reverseGeocoded` and barred from near-field dominance. -/
def nominatimVenueCandidate (r : Result) : Option Landmark :=
  match nominatimVenueName r with
  | none => none
  | some name =>
    if name == "" then none else
    let type := if r.category == "tourism" || r.category == "shop" || r.category == "leisure"
                then r.category else "amenity"
    some { name := name, type := type, subtype := r.type, distanceM := 0,
           openFraction := none, enclosing := false, reverseGeocoded := true }

/-! ## Results out of candidates -/

def landmarkToResult (l : Landmark) : Result :=
  let a : Address :=
    if l.type == "amenity" then { amenity := some l.name }
    else if l.type == "tourism" then { tourism := some l.name }
    else if l.type == "leisure" then { leisure := some l.name }
    else if l.type == "shop" then { shop := some l.name }
    else { pedestrian := some l.name }
  { displayName := l.name, type := l.subtype, category := l.type, address := a }

/--
`{...detailed.address, ...result.address}` — the detailed address underneath,
the landmark's own field on top.

Field-wise `orElse` is faithful HERE and not in general: the spread would let a
key present-but-`undefined` in `result` erase `detailed`'s, and `orElse` would
not. It cannot arise, because the only value ever passed as `result` comes from
{@link landmarkToResult}, which sets exactly one key and leaves the rest ABSENT.
-/
def mergeAddress (over under : Address) : Address :=
  { amenity := over.amenity.orElse fun _ => under.amenity
    tourism := over.tourism.orElse fun _ => under.tourism
    leisure := over.leisure.orElse fun _ => under.leisure
    shop := over.shop.orElse fun _ => under.shop
    building := over.building.orElse fun _ => under.building
    houseNumber := over.houseNumber.orElse fun _ => under.houseNumber
    road := over.road.orElse fun _ => under.road
    pedestrian := over.pedestrian.orElse fun _ => under.pedestrian
    neighbourhood := over.neighbourhood.orElse fun _ => under.neighbourhood
    suburb := over.suburb.orElse fun _ => under.suburb
    stateDistrict := over.stateDistrict.orElse fun _ => under.stateDistrict
    city := over.city.orElse fun _ => under.city
    town := over.town.orElse fun _ => under.town
    village := over.village.orElse fun _ => under.village
    municipality := over.municipality.orElse fun _ => under.municipality }

def withAddressFrom (result : Result) : Option Result → Result
  | none => result
  | some detailed => { result with address := mergeAddress result.address detailed.address }

/-! ## The three predicates the chain turns on -/

def hasSpecificVenue (r : Result) : Bool :=
  truthy r.address.amenity || truthy r.address.tourism
    || truthy r.address.leisure || truthy r.address.shop

def hasResidentialAddress (r : Result) : Bool :=
  truthy r.address.houseNumber && truthy r.address.road

/-- Squares, parks, plazas, named pedestrian areas — useful even without a
venue. -/
def isLandmarkResult (r : Result) : Bool :=
  r.category == "place" || r.category == "leisure" || truthy r.address.pedestrian

/-! ## The lodging override -/

def LODGING_TOURISM_SUBTYPES : List String :=
  ["hotel", "guest_house", "hostel", "apartment", "motel"]
def LODGING_OVERRIDE_DIST_M : Float := 50

def isLodgingLandmark (l : Landmark) : Bool :=
  l.type == "tourism" && LODGING_TOURISM_SUBTYPES.contains l.subtype

/-- The CLOSEST lodging POI within {@link LODGING_OVERRIDE_DIST_M}.

`Array.sort`'s ties are not the TS `Array.prototype.sort`'s, so this takes a
minimum by a strict `<` rather than sorting — which keeps the FIRST of an exact
distance tie, exactly as a stable sort would. -/
def pickLodgingOverride (landmarks : List Landmark) : Option Landmark :=
  (landmarks.filter fun l => isLodgingLandmark l && decide (l.distanceM ≤ LODGING_OVERRIDE_DIST_M)).foldl
    (fun best l => match best with
      | none => some l
      | some b => if decide (l.distanceM < b.distanceM) then some l else best) none

/-! ## `placeLabel` -/

/-- `` `${name}${type ? ` (${type})` : ""}` `` -/
private def named (name type : String) : String :=
  if type == "" then name else s!"{name} ({type})"

/-- Everything before the first comma of `display_name`.

The TS writes `?? "Unknown"` after the `[0]`, which cannot fire: `String.split`
always returns at least one element, so the fallback is dead and is not
modelled. An empty `displayName` yields `""` in both arms. -/
private def firstPart (s : String) : String :=
  (s.splitOn ",").headD ""

/-- The label the timeline shows for a resolved place. -/
def placeLabel (r : Result) : String :=
  let a := r.address
  if truthy a.amenity then named (a.amenity.getD "") r.type
  else if truthy a.tourism then named (a.tourism.getD "") r.type
  else if truthy a.leisure then named (a.leisure.getD "") r.type
  else if truthy a.shop then named (a.shop.getD "") r.type
  else if truthy a.building && r.type != "" then s!"{a.building.getD ""} ({r.type})"
  else if truthy a.houseNumber && truthy a.road then s!"{a.road.getD ""} {a.houseNumber.getD ""}"
  else if truthy a.pedestrian then named (a.pedestrian.getD "") r.type
  else if r.type != "" && truthy a.road then s!"{r.type} on {a.road.getD ""}"
  else if r.type != "" && truthy a.neighbourhood then s!"{r.type} in {a.neighbourhood.getD ""}"
  else firstPart r.displayName

/-! ## The chain -/

/-- Everything the shell answered for one `bestPlace` question.

`area` is the zoom-16 geocode. The TS fetches it LAZILY, at the bottom of the
chain, so most calls never ask — but a recorded table cannot be lazy, and
asking for it eagerly would put a question on the wire the run never asked and
turn it into a MISS. It is therefore `Option`, and `none` means "the run did not
reach the fall-through", which the chain below treats exactly as Nominatim
returning nothing. -/
structure Reads where
  landmarks : List Poi
  detailed : Option Result
  area : Option Result := none
  /-- The stay's minutes as `(weekday, minute-of-day)` in the VENUE's tz. -/
  samples : List (Nat × Nat) := []
  deriving Inhabited

/--
`bestPlace`, whole.

Reads the two (or three) geocodes the shell already answered and returns the
`NominatimResult` the TS would, or `none` when nothing names the place.

`stay` present selects the plausibility ranking; absent selects
`pickBestLandmark`, which is `rankVenues` with no context. `preferResidential`
enables the two overrides an overnight stay needs.
-/
def bestPlace (reads : Reads) (stay : Option StayShape) (priors : Option VenuePriors)
    (preferResidential : Bool) : Option Result :=
  let landmarks := reads.landmarks.map (toLandmark reads.samples stay.isSome)
  let detailed := reads.detailed
  -- `bestLandmark` and `nominatimWon` are the two `let`s the TS threads through
  -- the chain; they are computed here and read below.
  let (bestLandmark, nominatimWon) : Option Landmark × Bool :=
    match stay with
    | some _ =>
      let nomVenue := match detailed with
        | some d => if hasSpecificVenue d then nominatimVenueCandidate d else none
        | none => none
      -- Skipped when a landmark already names the same venue: that one carries
      -- the `opening_hours` tag and this one does not.
      let candidates := match nomVenue with
        | some nv => if landmarks.any (fun l => l.name == nv.name) then landmarks
                     else landmarks ++ [nv]
        | none => landmarks
      if candidates.isEmpty then (none, false) else
      match (rankVenues candidates stay priors).head? with
      | none => (none, false)
      | some top =>
        let accepted := top.landmark.enclosing || decide (top.total ≥ VENUE_RANK_FLOOR_NATS)
        if !accepted then (none, false)
        else match nomVenue with
          | some nv => if top.landmark.name == nv.name then (none, true) else (some top.landmark, false)
          | none => (some top.landmark, false)
    | none =>
      if landmarks.isEmpty then (none, false)
      else ((rankVenues landmarks none none).head?.map (·.landmark), false)

  if bestLandmark.any (·.enclosing) then
    some (withAddressFrom (landmarkToResult (bestLandmark.getD default)) detailed)
  else match detailed with
  | some d =>
    if hasSpecificVenue d && (if stay.isSome then nominatimWon else true) then some d
    else rest bestLandmark detailed reads.area preferResidential landmarks
  | none => rest bestLandmark detailed reads.area preferResidential landmarks
where
  /-- The tail of the chain, shared by both arms of the `detailed` match above.
  Split out only because Lean has no early `return` here; the ORDER is the TS's
  and is load-bearing — the lodging override must beat the residential address,
  and both must beat the landmark. -/
  rest (bestLandmark : Option Landmark) (detailed area : Option Result)
      (preferResidential : Bool) (landmarks : List Landmark) : Option Result :=
    if preferResidential then
      match pickLodgingOverride landmarks with
      | some lodging => some (withAddressFrom (landmarkToResult lodging) detailed)
      | none => afterLodging bestLandmark detailed area preferResidential
    else afterLodging bestLandmark detailed area preferResidential
  afterLodging (bestLandmark : Option Landmark) (detailed area : Option Result)
      (preferResidential : Bool) : Option Result :=
    if preferResidential && detailed.any hasResidentialAddress then detailed
    else match bestLandmark with
    | some bl => some (withAddressFrom (landmarkToResult bl) detailed)
    | none =>
      if detailed.any hasResidentialAddress then detailed
      else match area with
        | some ar => if hasSpecificVenue ar || isLandmarkResult ar then some ar
                     else detailed.orElse fun _ => area
        | none => detailed

/-- `bestPlace` composed with `placeLabel` and `extractCity` — the shape the
fold's jitter pass and the sleep-place attribution both consume. -/
def resolve (reads : Reads) (stay : Option StayShape) (priors : Option VenuePriors)
    (preferResidential : Bool) : Option Verified.Geo.SegmentMerge.ResolvedPlace :=
  (bestPlace reads stay priors preferResidential).map fun r =>
    { label := placeLabel r, city := extractCity (some r.address) }

/-! ## Guards

The ranking is guarded in {@link Verified.Geo.VenuePrior} and the parser in
{@link Verified.Geo.OpeningHours}. What is pinned here is the CHAIN — one case
per branch — and the two string functions the chain ends in. -/

section Guards

private def A : Address := {}
private def res (t c : String) (a : Address) : Result :=
  { displayName := "Somewhere, London, UK", type := t, category := c, address := a }
private def poi (n t s : String) (d : Float) : Poi :=
  { name := n, type := t, subtype := s, distanceM := d }

/-! ### `placeLabel` — every branch, in order -/

#guard placeLabel (res "cafe" "amenity" { A with amenity := some "Olivomare" })
  == "Olivomare (cafe)"
-- An empty `type` drops the parenthetical rather than printing "()".
#guard placeLabel (res "" "amenity" { A with amenity := some "Olivomare" }) == "Olivomare"
#guard placeLabel (res "hotel" "tourism" { A with tourism := some "The Zetter" }) == "The Zetter (hotel)"
#guard placeLabel (res "park" "leisure" { A with leisure := some "Regent's Park" }) == "Regent's Park (park)"
#guard placeLabel (res "supermarket" "shop" { A with shop := some "Lidl" }) == "Lidl (supermarket)"
-- Building needs a type; without one it falls THROUGH to the address.
#guard placeLabel (res "office" "building" { A with building := some "Kings Place" }) == "Kings Place (office)"
private def buildingNoType : Address :=
  { A with building := some "Kings Place", houseNumber := some "90", road := some "York Way" }
#guard placeLabel (res "" "building" buildingNoType) == "York Way 90"
-- Dutch ordering: street then number.
#guard placeLabel (res "house" "building" { A with houseNumber := some "161", road := some "Elm Street" })
  == "Elm Street 161"
#guard placeLabel (res "square" "place" { A with pedestrian := some "Granary Square" })
  == "Granary Square (square)"
#guard placeLabel (res "residential" "highway" { A with road := some "Caledonian Road" })
  == "residential on Caledonian Road"
#guard placeLabel (res "suburb" "place" { A with neighbourhood := some "Barnsbury" })
  == "suburb in Barnsbury"
-- Nothing at all: the first comma-separated part of the display name.
#guard placeLabel (res "" "" A) == "Somewhere"
-- An EMPTY field is not a name — truthiness, not presence.
#guard placeLabel (res "cafe" "amenity" { A with amenity := some "", road := some "York Way" })
  == "cafe on York Way"

/-! ### The two truthiness rules disagreeing

The single input they differ on: an empty `amenity` beside a real `tourism`. -/

private def emptyAmenity : Result := res "hotel" "tourism" { A with amenity := some "", tourism := some "The Zetter" }
#guard hasSpecificVenue emptyAmenity == true
-- `??` stops at the empty string, so the candidate is dropped.
#guard nominatimVenueName emptyAmenity == some ""
#guard nominatimVenueCandidate emptyAmenity == none

/-! ### `landmarkToResult` + `withAddressFrom` -/

private def cafe : Landmark :=
  { name := "Olivomare", type := "amenity", subtype := "restaurant", distanceM := 11 }

#guard (landmarkToResult cafe).address.amenity == some "Olivomare"
#guard (landmarkToResult cafe).type == "restaurant"
#guard (landmarkToResult cafe).category == "amenity"
-- A type outside the four venue keys lands in `pedestrian`.
#guard (landmarkToResult { cafe with type := "place" }).address.pedestrian == some "Olivomare"
-- The detailed address flows underneath; the landmark's own key stays on top.
private def detailedAddrFields : Address :=
  { A with amenity := some "Some Cafe", road := some "Lower Belgrave Street",
           houseNumber := some "10", city := some "London" }
private def detailedAddr : Result := res "house" "building" detailedAddrFields
#guard (withAddressFrom (landmarkToResult cafe) (some detailedAddr)).address.amenity == some "Olivomare"
#guard (withAddressFrom (landmarkToResult cafe) (some detailedAddr)).address.road
  == some "Lower Belgrave Street"
#guard (withAddressFrom (landmarkToResult cafe) (some detailedAddr)).address.city == some "London"

/-! ### The lodging override -/

private def hotel (n : String) (d : Float) : Landmark :=
  { name := n, type := "tourism", subtype := "hotel", distanceM := d }

#guard (pickLodgingOverride [hotel "Far" 60]) == none
#guard (pickLodgingOverride [hotel "Far" 60, hotel "Near" 20]).map (·.name) == some "Near"
-- An exact tie keeps the FIRST, which is what a stable sort would do.
#guard (pickLodgingOverride [hotel "First" 20, hotel "Second" 20]).map (·.name) == some "First"
-- A restaurant is not lodging however close it is.
#guard pickLodgingOverride [{ cafe with distanceM := 1 }] == none

/-! ### The chain

One case per branch, with a stay so the plausibility arm runs. -/

private def stay : StayShape := { startUnix := 0, endUnix := 3600, localHour := 13 }

-- An enclosing institution outranks everything, and takes the detailed address.
private def hospital : Poi :=
  { name := "UCLH", type := "amenity", subtype := "hospital", distanceM := 40, enclosing := true }
#guard (bestPlace { landmarks := [hospital, poi "Costa" "amenity" "cafe" 5], detailed := some detailedAddr }
  (some stay) none false).map placeLabel == some "UCLH (hospital)"

-- No landmarks and no geocode names nothing at all.
#guard bestPlace { landmarks := [], detailed := none } (some stay) none false == none

-- No landmarks, a specific-venue geocode: with a stay the Nominatim candidate
-- must WIN the ranking to be returned, and unopposed it does.
#guard (bestPlace { landmarks := [], detailed := some (res "cafe" "amenity" { A with amenity := some "Costa" }) }
  (some stay) none false).map placeLabel == some "Costa (cafe)"

-- A landmark beats a non-venue geocode and inherits its address.
private def streetGeocode : Result := res "house" "building" { A with road := some "Lower Belgrave Street" }
private def landmarkVsStreet : Reads :=
  { landmarks := [poi "Olivomare" "amenity" "restaurant" 11], detailed := some streetGeocode }
#guard (bestPlace landmarkVsStreet (some stay) none false).map placeLabel == some "Olivomare (restaurant)"

-- Nothing nearby, a residential geocode: the address is the honest label.
private def downing : Result :=
  res "house" "building" { A with houseNumber := some "10", road := some "Downing Street" }
private def addressOnly : Reads := { landmarks := [], detailed := some downing }
#guard (bestPlace addressOnly none none false).map placeLabel == some "Downing Street 10"

-- The fall-through: no landmark, no residential address, and the zoom-16 area
-- names a square.
private def square : Result := res "square" "place" { A with pedestrian := some "Granary Square" }
private def areaSquare : Reads := { landmarks := [], detailed := none, area := some square }
#guard (bestPlace areaSquare none none false).map placeLabel == some "Granary Square (square)"

-- …and when the area names nothing either, `detailed ?? area` still answers.
private def areaNothing : Reads := { landmarks := [], detailed := none, area := some (res "" "boundary" A) }
#guard (bestPlace areaNothing none none false).map placeLabel == some "Somewhere"

-- `preferResidential`: an overnight stay 5 m from a guesthouse slept AT the
-- guesthouse. The override has to beat the ranking, so the discriminating case
-- puts a NEARER non-lodging venue beside it — with the flag the guesthouse wins
-- anyway, without it the closer cafe does.
private def guesthouse : Poi := { name := "Sea View", type := "tourism", subtype := "guest_house", distanceM := 5 }
private def nearerCafe : Poi := { name := "Beach Cafe", type := "amenity", subtype := "cafe", distanceM := 2 }
private def residential : Result :=
  res "house" "building" { A with houseNumber := some "12", road := some "Marine Parade" }
private def lodgingReads : Reads := { landmarks := [nearerCafe, guesthouse], detailed := some residential }
#guard (bestPlace lodgingReads none none true).map placeLabel == some "Sea View (guest_house)"
#guard (bestPlace lodgingReads none none false).map placeLabel == some "Beach Cafe (cafe)"

/-! ### Hours resolution -/

private def openPoi : Poi :=
  { name := "Lidl", type := "shop", subtype := "supermarket", distanceM := 8,
    openingHours := some "Mo-Sa 08:00-22:00" }

-- Monday 13:00 is inside the window: fully open.
#guard (toLandmark [(0, 780)] true openPoi).openFraction == some 1
-- Sunday is not in the spec at all: fully closed, which is EVIDENCE, not silence.
#guard (toLandmark [(6, 780)] true openPoi).openFraction == some 0
-- No stay ⇒ no hours evidence, even with a parseable tag.
#guard (toLandmark [(0, 780)] false openPoi).openFraction == none
-- Outside the parser's subset ⇒ silence, NOT closed.
#guard (toLandmark [(0, 780)] true { openPoi with openingHours := some "sunrise-sunset" }).openFraction == none
-- An empty tag is silence too — truthiness again.
#guard (toLandmark [(0, 780)] true { openPoi with openingHours := some "" }).openFraction == none

end Guards

end Verified.Geo.BestPlace
