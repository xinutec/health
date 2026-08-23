/-!
# Naming the venue a stay is at (port of `shapeLandmarks` / `filterLandmarks`
in `src/geo/osm.ts`)

This turns OSM features near a stay into the candidate venues the picker ranks.
It is what puts "Honest Burgers" or "Royal Free Hospital" on a timeline instead
of a bare "stationary", so a gap here is not a missing optimisation — it is a
place the person went, unnamed.

## One feature can be several landmarks

⚠ Each of `amenity`, `tourism`, `leisure`, `shop`, `place` spawns its OWN entry,
so a feature tagged both `amenity=cafe` and `tourism=attraction` appears TWICE.
That is deliberate: the picker scores them independently and resolves precedence
itself. Collapsing them here would decide, silently, which of the two a person
meant.

## The enclosing-institution override, and why it is narrow

A stay deep inside a hospital campus would otherwise be named after whatever
tiny point POI sits nearest the noisy GPS centroid — a hairdresser, a pharmacy.
So a large institution whose FOOTPRINT CONTAINS the stay outranks nearer points.

⚠ The point-only radius fallback is restricted to a HOSPITAL mapped as a POINT,
and the restriction is the whole design:

* a long sedentary stay by a hospital node IS the hospital (2026-04-29);
* a university or college has campus eateries you visit AS DESTINATIONS — a
  Greek restaurant next to LSHTM is the restaurant, not the university
  (2026-05-14);
* a polygon already carries the precise `encloses` signal, so the loose radius
  must not widen it.

Pure and total. UNPROVEN; the thresholds and the tag order are the TypeScript's.
-/
namespace Verified.Geo.Landmarks

/-- Amenity subtypes big enough that being inside one names the stay. -/
def LARGE_INSTITUTION_SUBTYPES : List String := ["hospital"]

/-- How near a point-mapped institution still counts as enclosing. -/
def LARGE_INSTITUTION_POINT_RADIUS_M : Float := 80

/-- `tourism` subtypes that mark a point of interest rather than a place a
person goes. ⚠ Dropped at the END, after shaping — an artwork inside a museum
must not suppress the museum. -/
def POI_MARKER_TOURISM : List String := ["artwork", "viewpoint", "picnic_site", "information"]

/-- Tag keys that can name a venue, in PRIORITY ORDER. ⚠ The order is the
picker's tie-break; reordering it renames places. -/
def LANDMARK_TAG_KEYS : List String := ["amenity", "tourism", "leisure", "shop", "place"]

/-- One OSM feature near the query point. -/
structure Feature where
  name : Option String
  /-- `(key, value)` pairs, as stored. -/
  tags : List (String × String)
  distanceM : Float
  /-- Does this feature's footprint CONTAIN the query point? -/
  encloses : Bool
  /-- From the point table (a node) rather than the line/area table (a way).
      ⚠ The radius fallback applies to nodes ONLY. -/
  isPoint : Bool
  deriving Inhabited, Repr

/-- One candidate venue. -/
structure Landmark where
  name : String
  type_ : String
  subtype : String
  distanceM : Float
  enclosing : Bool
  openingHours : Option String
  deriving Inhabited, Repr, BEq

private def tagOf (tags : List (String × String)) (k : String) : Option String :=
  (tags.find? (fun p => p.1 == k)).map (·.2)

/-- Should this landmark outrank nearer point POIs?

⚠ `amenity` only, `hospital` only, and the radius fallback for POINTS only. See
the module note — each narrowing is a specific day that went wrong. -/
def isEnclosingInstitution (type_ subtype : String) (distanceM : Float)
    (encloses isPoint : Bool) : Bool :=
  if type_ != "amenity" then false
  else if !(LARGE_INSTITUTION_SUBTYPES.contains subtype) then false
  else if encloses then true
  else isPoint && distanceM ≤ LARGE_INSTITUTION_POINT_RADIUS_M

/-- Drop the markers that name a thing rather than a place. -/
def filterLandmarks (ls : List Landmark) : List Landmark :=
  ls.filter (fun l => !(l.type_ == "tourism" && POI_MARKER_TOURISM.contains l.subtype))

/-- Turn features into ranked candidates.

⚠ An UNNAMED feature is skipped entirely. A landmark with no name cannot name a
place, and carrying it would let the picker choose "" over a real venue further
away. -/
def shapeLandmarks (points lines : List Feature) : List Landmark :=
  -- ⚠ POINTS FIRST, then lines — the order feeds a STABLE sort below, so it is
  -- the tie-break between a node and a way at the same distance.
  let tagged := points.map (fun f => (f, true)) ++ lines.map (fun f => (f, false))
  let out := tagged.flatMap fun (f, isPoint) =>
    match f.name with
    | none => []
    | some name =>
      let byTag := LANDMARK_TAG_KEYS.flatMap fun k =>
        match tagOf f.tags k with
        | none => []
        | some sub =>
          [{ name, type_ := k, subtype := sub, distanceM := f.distanceM
           , enclosing := isEnclosingInstitution k sub f.distanceM f.encloses isPoint
           , openingHours := tagOf f.tags "opening_hours" }]
      -- ⚠ A pedestrian way is a landmark with NO enclosing test and no opening
      -- hours: it names a street, not a venue.
      let ped :=
        if tagOf f.tags "highway" == some "pedestrian" then
          [{ name, type_ := "highway", subtype := "pedestrian", distanceM := f.distanceM
           , enclosing := false, openingHours := none }]
        else []
      byTag ++ ped
  -- ⚠ STABLE, by distance only. Ties keep the order above, which is why points
  -- come first.
  filterLandmarks (out.mergeSort (fun a b => a.distanceM ≤ b.distanceM))

/-! ## Guards -/

private def feat (name : String) (tags : List (String × String)) (d : Float)
    (encloses := false) (isPoint := true) : Feature :=
  { name := some name, tags, distanceM := d, encloses, isPoint }

-- One tag, one landmark.
#guard (shapeLandmarks [feat "Honest Burgers" [("amenity", "restaurant")] 12] []).length == 1
#guard ((shapeLandmarks [feat "Honest Burgers" [("amenity", "restaurant")] 12] []).head!).subtype
       == "restaurant"

-- ⚠ TWO tags, TWO landmarks — the picker resolves precedence, not this.
#guard (shapeLandmarks [feat "X" [("amenity", "cafe"), ("tourism", "attraction")] 10] []).length == 2

-- An unnamed feature names nothing.
#guard (shapeLandmarks [{ name := none, tags := [("amenity", "cafe")], distanceM := 5
                        , encloses := false, isPoint := true }] []).length == 0

-- Sorted by distance, nearest first.
#guard ((shapeLandmarks [feat "Far" [("shop", "bakery")] 90, feat "Near" [("shop", "bakery")] 5] []).head!).name
       == "Near"

-- ⚠ A tourism MARKER is dropped; a real tourism venue is kept.
#guard (shapeLandmarks [feat "Statue" [("tourism", "artwork")] 3] []).length == 0
#guard (shapeLandmarks [feat "Museum" [("tourism", "museum")] 3] []).length == 1

-- Opening hours ride along when present.
#guard ((shapeLandmarks [feat "Cafe" [("amenity", "cafe"), ("opening_hours", "Mo-Fr 09:00-17:00")] 4] []).head!).openingHours
       == some "Mo-Fr 09:00-17:00"

-- A pedestrian way is a landmark, and never an institution.
#guard ((shapeLandmarks [feat "Market Sq" [("highway", "pedestrian")] 6] []).head!).type_ == "highway"

-- ⚠ THE ENCLOSING RULE, case by case.
-- A hospital whose footprint contains the stay: definitive.
#guard isEnclosingInstitution "amenity" "hospital" 500 true false == true
-- A hospital mapped as a POINT, inside the campus radius.
#guard isEnclosingInstitution "amenity" "hospital" 50 false true == true
-- …but not beyond it.
#guard isEnclosingInstitution "amenity" "hospital" 100 false true == false
-- ⚠ A hospital mapped as a WAY does NOT get the radius fallback — a polygon
-- already carries `encloses`, so the loose radius must not widen it.
#guard isEnclosingInstitution "amenity" "hospital" 50 false false == false
-- ⚠ A university is NOT a large institution here: its campus eateries are
-- destinations in their own right (2026-05-14).
#guard isEnclosingInstitution "amenity" "university" 10 true false == false
-- Only `amenity` at all.
#guard isEnclosingInstitution "shop" "hospital" 10 true false == false

end Verified.Geo.Landmarks
