import Verified.Geo.PlacePrior
import Verified.Geo.BiometricCoherence
import Verified.Geo.TransitPlace
import Verified.Geo.BestPlace
/-!
# Naming a stay

The enrichment loop's stationary branch ({@link Verified.Geo.Enrich} is the
moving one). The cascade, in order:

1. Just off a train: the station
   ({@link Verified.Geo.TransitPlace.stationAtTrainAlight}), whatever else is
   co-located; the city still comes from the resolver.
2. Otherwise score the mined `focus_places`
   ({@link Verified.Geo.PlacePrior.pickBestPlace}), modulated by the stay's
   hour profile and biometric coherence.
3. A winner at least {@link HOME_WORK_FAR_SIGMA}σ away for
   {@link HOME_WORK_FAR_MIN_S} or more, with a building enclosing the stay: that
   building. Else a Home or Work winner wins outright (intent labels); "Stay" is
   a clustering bucket and falls through.
4. Any other winner is named by the resolver ({@link Verified.Geo.BestPlace.resolve})
   at {@link namingCoordinate}, or at the stored centroid for a night at a
   residence, with `preferResidential := isResidential || venueless`.
5. No winner: the resolver at the day's centroid, `preferResidential :=
   isSleepWindow`.

The mined `amenityLabel` is not a name: as a shortcut past the resolver it moved
no truth verdict and no elected venue on the corpus. Only `venueless` reads it,
sending an amenity-less cluster to a neutral address.

`namingCoordinate` blends the day's centroid and the place's by precision:
snapping to the stored centroid assumes the day is noisy, but a tight stay's
fixes are better than a cluster wider than its radius (named wrongly, they sat
79–90 m from it). A night at a residence keeps the stored centroid, since a
night's indoor fixes scatter; a daytime visit there is named like any other.

No new shell: the tz lookup is the fold's `tzAt`, and `localSolarHour` is
longitude arithmetic on the epoch. The solar arithmetic is UNPROVEN, pinned by
the `#guard`s.
-/

namespace Verified.Geo.StayEnrich

open Verified.Geo.SegmentMerge (Seg ResolvedPlace)
open Verified.Geo.TubeHop (NearbyStation)

/-! ## Local solar time -/

/-- `%` on doubles as the truncated remainder, not Lean's `%` and not a
floored modulo. Exact for every value here — `|a/b| < 3`, so the quotient's
truncation and the subtraction are both exact. -/
private def jsMod (a b : Float) : Float :=
  let q := a / b
  a - (if q < 0 then Float.ceil q else Float.floor q) * b

/-- Hour of the local solar day at a longitude: `lon / 15` hours from UTC, no
zone. The double `%` stays: collapsing it would round differently. -/
def localSolarHour (ts : Int) (lon : Float) : Nat :=
  -- `new Date(ts*1000).getUTCHours()*60 + getUTCMinutes()` — whole minutes of
  -- the UTC day, so seconds are dropped before the offset is applied.
  let secOfDay := ((ts % 86400) + 86400) % 86400
  let utcMinutes := Float.ofInt (secOfDay / 60)
  -- `local` is a Lean keyword, so `solarMinutes`.
  let solarMinutes := utcMinutes + (lon / 15) * 60
  let wrapped := jsMod (jsMod solarMinutes 1440 + 1440) 1440
  (Float.floor (wrapped / 60)).toUInt64.toNat

def HOUR_BUCKETS : Nat := 24
private def HOUR_PROFILE_STEP_SEC : Int := 30 * 60

/-- The stay's own hour-of-day dwell profile: 24 fractions summing to 1, or 24
zeros when the range admits no sample. Sampled every half hour inclusive of both
ends, so a zero-length stay still contributes one sample. -/
def hourProfileForRange (startTs endTs : Int) (lon : Float) : List Float := Id.run do
  let mut buckets : Array Float := Array.replicate HOUR_BUCKETS 0
  let mut t := startTs
  while t ≤ endTs do
    let h := localSolarHour t lon
    buckets := buckets.modify h (· + 1)
    t := t + HOUR_PROFILE_STEP_SEC
  let total := buckets.foldl (· + ·) 0
  return (if total == 0 then buckets else buckets.map (· / total)).toList

/-- At least an hour of local 00:00-06:00 inside the stay. Half-hour samples
each count half an hour, so this is "two or more overnight samples". -/
def hasOvernightPresence (startTs endTs : Int) (lon : Float) : Bool := Id.run do
  let mut overnight : Float := 0
  let mut t := startTs
  while t ≤ endTs do
    if localSolarHour t lon < 6 then overnight := overnight + 0.5
    t := t + HOUR_PROFILE_STEP_SEC
  return overnight ≥ 1

/-! ## The naming coordinate -/

/-- The least scatter a stay's fixes are credited with. A stay of two
coincident fixes has not located the phone to a metre; below this the day's
weight in {@link namingCoordinate} stops growing. -/
def SPREAD_FLOOR_M : Float := 10

/-- Where to ask the resolver about a stay that elected a mined place: the
precision-weighted mean of the day's centroid (scatter `spreadM`) and the
place's (its σ), two Gaussian beliefs about one position. -/
def namingCoordinate (cLat cLon spreadM : Float)
    (c : Verified.Geo.PlacePrior.PlaceCandidate) : Float × Float :=
  let sd := max spreadM SPREAD_FLOOR_M
  let sp := Verified.Geo.PlacePrior.effectiveSigmaM c
  let wd := 1 / (sd * sd)
  let wp := 1 / (sp * sp)
  ((cLat * wd + c.centroidLat * wp) / (wd + wp), (cLon * wd + c.centroidLon * wp) / (wd + wp))

/-! ## Inputs -/

/-- Sleep hours at or above which a mined cluster is a residence, and its
address beats a co-located venue label. -/
def RESIDENCE_SLEEP_THRESHOLD_H : Float := 5

/-- In σ of the place ({@link Verified.Geo.PlacePrior.effectiveSigmaM}), how far
a stay must sit from its elected Home or Work before the enclosing building is
asked: on the corpus nearly every Home or Work stay is within 50 m (σ ≈ 100 m),
and the exception was a long wait inside the station next to Work. -/
def HOME_WORK_FAR_SIGMA : Float := 1.2

/-- …and how long it must last, so a piece of the walk in, carved as a stay
inside the station, does not carry the station's name into the merged stay. -/
def HOME_WORK_FAR_MIN_S : Int := 30 * 60

/-- A mined `focus_places` row as this branch reads it: the scorer's fields plus
the three the cascade branches on, one record since both are read together. -/
structure NamedPlace where
  cand : Verified.Geo.PlacePrior.PlaceCandidate
  displayName : Option String := none
  sleepHours : Float := 0
  amenityLabel : Option String := none
  deriving Inhabited

/-- What this branch asks the world. `place` is the resolver with its reads
bound: choosing the coordinate is this module's decision, answering is not. -/
structure Reads where
  /-- `osm.nearbyStations(lat, lon, radiusM)`. -/
  stations : Float → Float → Float → Array NearbyStation
  /-- The resolver composed with `placeLabel` and `extractCity`. `withStay` is
  false for the alight and Home/Work arms, which ask a different question and so
  must not share a key with the others. -/
  place : (lat : Float) → (lon : Float) → (preferResidential : Bool) → (withStay : Bool) →
    Option ResolvedPlace

/-- The biometric side-channels, in the shapes the coherence gate declares. -/
structure Biom where
  hr : List Verified.Geo.BiometricCoherence.HrPoint := []
  steps : List Verified.Geo.BiometricCoherence.StepPoint := []
  deriving Inhabited

/-! ## The branch -/

/-- Attach `place` and `city` to a stay. Returns the segment unchanged when the
resolver has no answer: a refusal to name rather than a name of nothing. -/
def enrichStay (reads : Reads) (biom : Biom) (places : List NamedPlace)
    (prev : Option Seg) (seg : Seg) (cLat cLon : Float) (spreadM : Float := 0) : Seg :=
  let withCity (s : Seg) (p : Option ResolvedPlace) : Seg :=
    match p.bind (·.city) with
    | some c => { s with city := some c }
    | none => s
  -- 1. Transit continuity, ahead of every other rule.
  match Verified.Geo.TransitPlace.stationAtTrainAlight prev cLat cLon reads.stations with
  | some station =>
    withCity { seg with place := some station, placeSource := some ⟨station, "station", some (cLat, cLon)⟩ }
      (reads.place cLat cLon false false)
  | none =>
    let isSleepWindow := hasOvernightPresence seg.startTs seg.endTs cLon
    let stayHourProfile := hourProfileForRange seg.startTs seg.endTs cLon
    let bs := Verified.Geo.BiometricCoherence.biometricCoherence
      seg.startTs seg.endTs biom.hr biom.steps
    -- 2. The posterior over mined places. `pickBestPlace` refuses an empty list
    -- itself, so no emptiness guard is needed here.
    let winner := (Verified.Geo.PlacePrior.pickBestPlace (places.map (·.cand))
      cLat cLon stayHourProfile (some bs)).bind fun (c, _) =>
        places.find? fun p => p.cand.id == c.id
    match winner with
    | some wp =>
      let placeLat := wp.cand.centroidLat
      let placeLon := wp.cand.centroidLon
      -- 3. Home and Work are intent labels and win outright. "Stay" is a
      -- clustering bucket, so it is not here and falls through to naming.
      -- Far from it, a building the stay is inside names it instead: the
      -- intent label is the guess, the outline around the fixes is evidence.
      let far := seg.endTs - seg.startTs ≥ HOME_WORK_FAR_MIN_S &&
        Verified.Hsmm.FloatScore.haversineMeters cLat cLon placeLat placeLon
          ≥ HOME_WORK_FAR_SIGMA * Verified.Geo.PlacePrior.effectiveSigmaM wp.cand
      let inside := if far then (reads.place cLat cLon false true).filter (·.source == "enclosing")
        else none
      if let some p := inside then
        withCity
          { seg with place := some p.label, placeSource := some ⟨p.label, p.source, some (cLat, cLon)⟩
                     placeKind := some (p.category, p.type_) }
          (some p)
      else if wp.displayName == some "Home" || wp.displayName == some "Work" then
        withCity
          { seg with place := wp.displayName, focusPlaceId := some wp.cand.id
                     placeSource := wp.displayName.map fun n => ⟨n, n.toLower, some (placeLat, placeLon)⟩ }
          (reads.place placeLat placeLon true false)
      else
        let isResidential := wp.sleepHours ≥ RESIDENCE_SLEEP_THRESHOLD_H
        -- 4. Named by the resolver (see the header); `venueless` sends an
        -- amenity-less cluster to an address rather than a nearby
        -- low-confidence venue.
        let venueless := wp.amenityLabel.isNone
        let (askLat, askLon) :=
          if isResidential && isSleepWindow then (placeLat, placeLon)
          else namingCoordinate cLat cLon spreadM wp.cand
        match reads.place askLat askLon (isResidential || venueless) true with
        | none => seg
        | some p =>
          withCity
            { seg with place := some p.label, focusPlaceId := some wp.cand.id
                       placeSource := some ⟨p.label, p.source, some (askLat, askLon)⟩
                       placeKind := some (p.category, p.type_) }
            (some p)
    | none =>
      -- 5b. Somewhere new. The day's own centroid, and the overnight check
      -- decides whether an address beats a venue.
      match reads.place cLat cLon isSleepWindow true with
      | none => seg
      | some p => withCity { seg with place := some p.label, placeSource := some ⟨p.label, p.source, some (cLat, cLon)⟩
                                      placeKind := some (p.category, p.type_) } (some p)

/-! ## Guards

The scorer, coherence gate, station picker and resolver are pinned in their
modules; here, the solar arithmetic and which arm fires at which coordinate. -/

section Guards

open Verified.Geo.PlacePrior (PlaceCandidate)

/-! ### Local solar time -/

-- Greenwich: solar hour is the UTC hour.
#guard localSolarHour 0 0 == 0
#guard localSolarHour 3600 0 == 1
#guard localSolarHour 86340 0 == 23
-- Seconds are dropped before the offset, not after: 59 s into the hour is
-- still the hour.
#guard localSolarHour 59 0 == 0
-- 15° east is one hour ahead, 15° west one hour behind — and the west case
-- wraps backwards across midnight, which is what the double `%` is for.
#guard localSolarHour 0 15.0 == 1
#guard localSolarHour 0 (-15.0) == 23
#guard localSolarHour 3600 (-30.0) == 23
-- London's longitude is a fraction of an hour and floors away.
#guard localSolarHour 0 (-0.1) == 23
#guard localSolarHour 3600 (-0.1) == 0

/-! ### The hour profile -/

-- A stay wholly inside one hour is that hour, at weight 1.
private def ONE_HOUR : List Float := hourProfileForRange 0 1500 0
#guard ONE_HOUR.length == 24
#guard ONE_HOUR[0]! == 1.0
#guard ONE_HOUR[1]! == 0.0
-- Inclusive of both ends, and stepped by half hours: 0..3600 is three samples
-- (0, 1800, 3600), two of them in hour 0. An exclusive end would give two, and
-- an hourly step would give two — so this one case separates both.
private def ONE_HOUR_SPAN : List Float := hourProfileForRange 0 3600 0
#guard ONE_HOUR_SPAN[0]! == 2.0 / 3.0
#guard ONE_HOUR_SPAN[1]! == 1.0 / 3.0
-- A zero-length stay still samples once, so the profile is never all-zero for
-- a real segment.
#guard (hourProfileForRange 0 0 0)[0]! == 1.0

/-! ### Overnight presence -/

-- One sample is half an hour and does not reach the bar; two do.
#guard hasOvernightPresence 0 0 0 == false
#guard hasOvernightPresence 0 1800 0 == true
-- 06:00 is outside the window (`h < 6`), so the 06:00 bucket is morning, not
-- night. A stay from 05:30 to 06:30 has one overnight sample.
#guard hasOvernightPresence (5 * 3600 + 1800) (6 * 3600 + 1800) 0 == false
#guard hasOvernightPresence (5 * 3600) (6 * 3600) 0 == true
-- Daytime never qualifies however long it runs.
#guard hasOvernightPresence (12 * 3600) (18 * 3600) 0 == false

/-! ### The cascade -/

private def LAT : Float := 51.52
private def LON : Float := -0.13

private def stay : Seg :=
  { startTs := 12 * 3600, endTs := 12 * 3600 + 3600, mode := "stationary", pointCount := 20 }

private def train : Seg := { stay with mode := "train" }

private def cand (id : Int) (lat lon : Float) (days : Float) : PlaceCandidate :=
  { id, centroidLat := lat, centroidLon := lon, radiusM := 50, uniqueDays := days,
    hourProfile := none }

private def home : NamedPlace :=
  { cand := cand 1 LAT LON 40, displayName := some "Home", sleepHours := 40 }

private def cafe : NamedPlace :=
  { cand := cand 2 LAT LON 40, displayName := some "Stay", sleepHours := 0,
    amenityLabel := some "Loft Coffee Company" }

private def resid : NamedPlace :=
  { cand := cand 3 LAT LON 40, displayName := some "Stay", sleepHours := 40,
    amenityLabel := some "Loft Coffee Company" }

private def venueless : NamedPlace :=
  { cand := cand 4 LAT LON 40, displayName := some "Stay", sleepHours := 0 }

/-- The same cafe seen on one day and on two: the day count does not change
the question asked. -/
private def cafe1day : NamedPlace := { cafe with cand := cand 5 LAT LON 1 }

private def cafe2day : NamedPlace := { cafe with cand := cand 6 LAT LON 2 }

/-- A resolver that reports which coordinate and which flags it was asked
about, so a guard can pin the question rather than only the answer. -/
private def spy : Reads :=
  { stations := fun _ _ _ => #[]
    place := fun lat lon pref withStay =>
      some { label := s!"{fx lat 3}|{fx lon 3}|{pref}|{withStay}", city := some "London" } }
  where fx (x : Float) (n : Nat) : String := (Verified.JsNum.toFixed x n).getD "?"

private def STATION : NearbyStation :=
  { name := "Finchley Road", lat := some LAT, lon := some LON, distanceM := 10 }

private def withStation : Reads :=
  { spy with stations := fun _ _ _ => #[STATION] }

private def run (reads : Reads) (places : List NamedPlace) (prev : Option Seg := none) : Seg :=
  enrichStay reads {} places prev stay LAT LON

-- 1. The alight arm wins over a focus place that would otherwise have taken it,
-- and asks the resolver `preferResidential=false` with no stay.
#guard (run withStation [home] (some train)).place == some "Finchley Road"
#guard (run withStation [home] (some train)).city == some "London"
#guard (run withStation [home] (some train)).focusPlaceId == none
-- It fires on the preceding mode only: the same stay after a walk is named the
-- ordinary way.
#guard (run withStation [home] (some { stay with mode := "walking" })).place == some "Home"
#guard (run withStation [home] none).place == some "Home"

-- 3. Home wins outright, keeps the focus id, and asks at the place's centroid
-- with `preferResidential=true`.
#guard (run spy [home]).place == some "Home"
#guard (run spy [home]).focusPlaceId == some 1

-- 3, far: a stay 200 m from Home, inside a building the resolver
-- reports as enclosing, is named for the building; a non-enclosing answer, or
-- the same building at the place itself, leaves it Home.
private def enclosingAt (src : String) : Reads :=
  { spy with place := fun _ _ _ _ => some { label := "St Pancras", source := src, city := some "London" } }
private def farHome : NamedPlace := { home with cand := cand 1 (LAT + 200 / 111195) LON 40 }
private def runFar (reads : Reads) : Seg := enrichStay reads {} [farHome] none stay LAT LON
#guard (runFar (enclosingAt "enclosing")).place == some "St Pancras"
#guard (runFar (enclosingAt "enclosing")).focusPlaceId == none
#guard (runFar (enclosingAt "nearField")).place == some "Home"
#guard (run (enclosingAt "enclosing") [home]).place == some "Home"
-- A short piece far out is not asked about: the stay it joins decides.
#guard (enrichStay (enclosingAt "enclosing") {} [farHome] none
  { stay with endTs := stay.startTs + HOME_WORK_FAR_MIN_S - 1 } LAT LON).place == some "Home"
-- A labelled cluster is not `venueless`, so it asks with
-- `preferResidential=false`, while the venueless guard below asks with `true`:
-- the rule reads the field, not some other verdict.
#guard (run spy [cafe]).place == some "51.520|-0.130|false|true"
#guard (run spy [cafe]).focusPlaceId == some 2
#guard (run spy [cafe2day]).place == some "51.520|-0.130|false|true"
#guard (run spy [cafe1day]).place == some "51.520|-0.130|false|true"
-- A one-day cluster still carries an `amenityLabel`, so it asks with
-- `preferResidential=false` too.
#guard (run spy [cafe1day]).focusPlaceId == some 5
-- ... and a residential one does not, even carrying the same label: it falls
-- through to the resolver, which the spy answers with its arguments —
-- `preferResidential=true` (residential) and a stay.
#guard (run spy [resid]).place == some "51.520|-0.130|true|true"
#guard (run spy [resid]).focusPlaceId == some 3
-- 5a. Venue-less and non-residential still prefers the address, which is the
-- `venueless` disjunct doing the work rather than `isResidential`.
#guard (run spy [venueless]).place == some "51.520|-0.130|true|true"
-- 5a asks at the blend: a cafe 0.002° north of a tight stay is asked about at
-- the fixes (the place's σ ≈ 99 m against a 10 m floor moves it a metre)…
private def cafeNorth : NamedPlace := { cafe with cand := cand 7 (LAT + 0.002) LON 40 }
#guard (run spy [cafeNorth]).place == some "51.520|-0.130|false|true"
-- …the same cafe under a smeared stay is asked about at the place…
#guard (enrichStay spy {} [cafeNorth] none stay LAT LON 1000).place == some "51.522|-0.130|false|true"
-- …and a residence by day is asked about at the fixes like any other winner,
-- with `preferResidential` so the lodging override still runs from there…
private def residNorth : NamedPlace := { resid with cand := cand 8 (LAT + 0.002) LON 40 }
#guard (run spy [residNorth]).place == some "51.520|-0.130|true|true"
-- …while a night at it is asked about at the place, however tight the fixes.
#guard (enrichStay spy {} [residNorth] none { stay with startTs := 0, endTs := 6 * 3600 } LAT LON 10).place
  == some "51.522|-0.130|true|true"

/-! ### The naming coordinate itself -/

private def northM (m : Float) : Float := LAT + m / 111320
private def metresNorth (lat : Float) : Float := (lat - LAT) * 111320
private def placeNorth (m : Float) : PlaceCandidate := cand 9 (northM m) LON 40
-- A tight stay 100 m from an established place (σ ≈ 99 m) stays within two
-- metres of its own fixes.
#guard (let la := (namingCoordinate LAT LON 10 (placeNorth 100)).1
        metresNorth la > 0 && metresNorth la < 2)
-- A smeared stay (scatter 200 m) leans on the place: past the midpoint.
#guard metresNorth (namingCoordinate LAT LON 200 (placeNorth 100)).1 > 50
-- The scatter is floored: two coincident fixes are not an exact position.
#guard namingCoordinate LAT LON 0 (placeNorth 100) == namingCoordinate LAT LON SPREAD_FLOOR_M (placeNorth 100)

-- 5b. No mined place at all: the day's centroid, and `preferResidential` is the
-- overnight check — false for this midday stay.
#guard (run spy []).place == some "51.520|-0.130|false|true"
#guard (run spy []).focusPlaceId == none
-- The same stay overnight flips that flag.
#guard (enrichStay spy {} [] none { stay with startTs := 0, endTs := 3600 } LAT LON).place
  == some "51.520|-0.130|true|true"

-- A resolver with no answer leaves the segment unnamed rather than naming it
-- something empty.
private def silent : Reads := { spy with place := fun _ _ _ _ => none }
#guard (run silent []).place == none
#guard (run silent []).city == none

end Guards

end Verified.Geo.StayEnrich
