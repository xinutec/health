import Verified.Geo.PlacePrior
import Verified.Geo.BiometricCoherence
import Verified.Geo.TransitPlace
import Verified.Geo.BestPlace
/-!
# Naming a stay (port of the stationary branch of the enrichment loop,
`src/geo/velocity.ts` 916-1044)

The enrichment loop has two branches and this is the second one.
{@link Verified.Geo.Enrich} is the first — `enrichMovingSegment`, ported for
`reenrichSplitWalks` but the same function the loop runs on every moving
segment. So this module is the LAST piece of that stage, and with it the Lean
day stops being two sub-chains: `classifySegments` through to the episodes
becomes one chain (#430 B2).

## The cascade, in the order it decides

1. **Just alighted a train?** Then the stay is at that station, whatever else
   is co-located — the 2026-05-22 Finchley Road ambulance wait, mislabelled
   "Loft Coffee Company". {@link Verified.Geo.TransitPlace.stationAtTrainAlight}.
   The city still comes from the venue resolver; only the LABEL is the station.
2. Otherwise score the mined `focus_places`
   ({@link Verified.Geo.PlacePrior.pickBestPlace}), with the stay's hour profile
   and its biometric coherence
   ({@link Verified.Geo.BiometricCoherence.biometricCoherence}) as the two
   modulating signals.
3. A winner that is **Home or Work** wins outright — those are intent labels.
   "Stay" is a clustering bucket, not a timeline name, so it falls through.
4. A winner that is **not residential and carries a mined `amenityLabel`** takes
   that label.
5. Any other winner, and any stay with no winner at all, is named by the venue
   resolver ({@link Verified.Geo.BestPlace.resolve}) — at the winner's stored
   centroid if there was one, at the day's centroid if not.

## `preferResidential` is decided in three different ways

Worth stating because they are easy to read as one rule:

* the alight arm passes `false` outright;
* the Home/Work arm passes `true` outright;
* the amenity arm passes `false`;
* the fall-through arm passes `isResidential || venueless`, where `venueless`
  is `amenityLabel = null` — a place the mining gate found no confident venue
  at must show a neutral address rather than a low-confidence nearby park;
* the no-winner arm passes `isSleepWindow`, the per-stay overnight check.

## The centroid is the DAY's, and the lookup coordinate may not be

Steps 1, 2 and 5-without-a-winner ask about the mean of the stay's own fixes.
Steps 3-5 WITH a winner ask about the winner's stored centroid instead — the
snap exists so the OSM naming runs at the place's true coordinates rather than
the day's noisy aggregate. Two coordinates, and which one is asked about is part
of what this port has to get right: a recorded lookup table panics on the other.

## No new shell

`stationAtTrainAlight` and the venue resolver are already Lean; the tz lookup is
the fold's existing `tzAt`. `localSolarHour` looks like it needs a zone and does
not — it is longitude arithmetic on the epoch, so it ports exactly.

The solar arithmetic is UNPROVEN and pinned against Node/V8
(`lean/experiments/stay-enrich-refs.mts`) rather than derived by hand.
-/

namespace Verified.Geo.StayEnrich

open Verified.Geo.SegmentMerge (Seg ResolvedPlace)
open Verified.Geo.TubeHop (NearbyStation)

/-! ## Local solar time (`src/geo/focus-places.ts`) -/

/-- JS `%` on doubles: the TRUNCATED remainder, not Lean's `%` and not a
floored modulo. Exact for every value here — `|a/b| < 3`, so the quotient's
truncation and the subtraction are both exact. -/
private def jsMod (a b : Float) : Float :=
  let q := a / b
  a - (if q < 0 then Float.ceil q else Float.floor q) * b

/-- Hour of the local SOLAR day at a longitude — no tzdata, no zone, just
`lon / 15` hours of offset from UTC.

The double `%` is the TS's, kept rather than collapsed into one floored modulo:
`(x % 1440 + 1440) % 1440` adds 1440 in between, and that addition can round
where a single operation would not. -/
def localSolarHour (ts : Int) (lon : Float) : Nat :=
  -- `new Date(ts*1000).getUTCHours()*60 + getUTCMinutes()` — whole minutes of
  -- the UTC day, so seconds are DROPPED before the offset is applied.
  let secOfDay := ((ts % 86400) + 86400) % 86400
  let utcMinutes := Float.ofInt (secOfDay / 60)
  -- `local` is the TS's name for it and a Lean keyword, so `solarMinutes`.
  let solarMinutes := utcMinutes + (lon / 15) * 60
  let wrapped := jsMod (jsMod solarMinutes 1440 + 1440) 1440
  (Float.floor (wrapped / 60)).toUInt64.toNat

def HOUR_BUCKETS : Nat := 24
private def HOUR_PROFILE_STEP_SEC : Int := 30 * 60

/-- The stay's own hour-of-day dwell profile: 24 fractions summing to 1, or 24
zeros when the range admits no sample. Sampled every half hour INCLUSIVE of both
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

/-! ## Inputs -/

/-- Sleep hours at or above which a mined cluster is a RESIDENCE, and its
address beats a co-located venue label. -/
def RESIDENCE_SLEEP_THRESHOLD_H : Float := 5

/-- A mined `focus_places` row as this branch reads it: the scorer's candidate
fields plus the three the LABEL cascade branches on. One record rather than two
projections, because unlike the fix series both halves are read on the same
code path, for the same row, in the same decision. -/
structure NamedPlace where
  cand : Verified.Geo.PlacePrior.PlaceCandidate
  displayName : Option String := none
  sleepHours : Float := 0
  amenityLabel : Option String := none
  deriving Inhabited

/-- What this branch asks the world.

`place` is {@link Verified.Geo.BestPlace.resolve} with its reads already bound
to a coordinate — the caller supplies the landmarks and geocode tables, because
choosing WHICH coordinate to ask about is this module's decision and answering
is not. -/
structure Reads where
  /-- `osm.nearbyStations(lat, lon, radiusM)`. -/
  stations : Float → Float → Float → Array NearbyStation
  /-- `bestPlace(osm, lat, lon, { preferResidential, stay?, priors })` composed
  with `placeLabel` and `extractCity`. `withStay` is false for the two arms that
  pass no `stay` — the alight arm and the Home/Work arm — and those two ask a
  DIFFERENT question of the resolver, so they must not share a key with the
  arms that do. -/
  place : (lat : Float) → (lon : Float) → (preferResidential : Bool) → (withStay : Bool) →
    Option ResolvedPlace

/-- The biometric side-channels, in the shapes the coherence gate declares. -/
structure Biom where
  hr : List Verified.Geo.BiometricCoherence.HrPoint := []
  steps : List Verified.Geo.BiometricCoherence.StepPoint := []
  deriving Inhabited

/-! ## The branch -/

/-- Attach `place` and `city` to a stay. Returns the segment UNCHANGED when the
resolver has no answer — the TS's `if (!place) return seg`, which is a refusal
to name rather than a name of nothing. -/
def enrichStay (reads : Reads) (biom : Biom) (places : List NamedPlace)
    (prev : Option Seg) (seg : Seg) (cLat cLon : Float) : Seg :=
  let withCity (s : Seg) (p : Option ResolvedPlace) : Seg :=
    match p.bind (·.city) with
    | some c => { s with city := some c }
    | none => s
  -- 1. Transit continuity, ahead of every other rule.
  match Verified.Geo.TransitPlace.stationAtTrainAlight prev cLat cLon reads.stations with
  | some station =>
    withCity { seg with place := some station } (reads.place cLat cLon false false)
  | none =>
    let isSleepWindow := hasOvernightPresence seg.startTs seg.endTs cLon
    let stayHourProfile := hourProfileForRange seg.startTs seg.endTs cLon
    let bs := Verified.Geo.BiometricCoherence.biometricCoherence
      seg.startTs seg.endTs biom.hr biom.steps
    -- 2. The posterior over mined places. `pickBestPlace` refuses an empty list
    -- itself, so the TS's `knownPlaces.length > 0` guard is not restated.
    let winner := (Verified.Geo.PlacePrior.pickBestPlace (places.map (·.cand))
      cLat cLon stayHourProfile (some bs)).bind fun (c, _) =>
        places.find? fun p => p.cand.id == c.id
    match winner with
    | some wp =>
      let placeLat := wp.cand.centroidLat
      let placeLon := wp.cand.centroidLon
      -- 3. Home and Work are intent labels and win outright. "Stay" is a
      -- clustering bucket, so it is NOT here and falls through to naming.
      if wp.displayName == some "Home" || wp.displayName == some "Work" then
        withCity
          { seg with place := wp.displayName, focusPlaceId := some wp.cand.id }
          (reads.place placeLat placeLon true false)
      else
        let isResidential := wp.sleepHours ≥ RESIDENCE_SLEEP_THRESHOLD_H
        -- 4. A mined amenity label, but only off a residential cluster: a
        -- residential address beats a co-located cafe, because the cluster's
        -- sleep hours dwarf its awake hours.
        match (if isResidential then none else wp.amenityLabel) with
        | some label =>
          withCity
            { seg with place := some label, focusPlaceId := some wp.cand.id }
            (reads.place placeLat placeLon false false)
        | none =>
          -- 5a. Named at the SNAPPED centroid. `venueless` sends an
          -- amenity-less cluster to the address rather than to whatever
          -- low-confidence venue happens to be near.
          let venueless := wp.amenityLabel.isNone
          match reads.place placeLat placeLon (isResidential || venueless) true with
          | none => seg
          | some p =>
            withCity
              { seg with place := some p.label, focusPlaceId := some wp.cand.id }
              (some p)
    | none =>
      -- 5b. Somewhere new. The day's own centroid, and the overnight check
      -- decides whether an address beats a venue.
      match reads.place cLat cLon isSleepWindow true with
      | none => seg
      | some p => withCity { seg with place := some p.label } (some p)

/-! ## Guards

The scorer, the coherence gate, the station picker and the venue resolver are
pinned in their own modules. What is new here is the local-solar arithmetic and
the CASCADE — which arm fires, and which coordinate it asks about. -/

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
-- wraps BACKWARDS across midnight, which is what the double `%` is for.
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
-- Inclusive of BOTH ends, and stepped by HALF hours: 0..3600 is THREE samples
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
-- 06:00 is OUTSIDE the window — the TS tests `h < 6`, so the 06:00 bucket is
-- morning, not night. A stay from 05:30 to 06:30 has one overnight sample.
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

/-- A resolver that reports WHICH coordinate and WHICH flags it was asked
about, so a guard can pin the question rather than only the answer. -/
private def spy : Reads :=
  { stations := fun _ _ _ => #[]
    place := fun lat lon pref withStay =>
      some { label := s!"{fx lat 2}|{fx lon 2}|{pref}|{withStay}", city := some "London" } }
  where fx (x : Float) (n : Nat) : String := (Verified.JsNum.toFixed x n).getD "?"

private def STATION : NearbyStation :=
  { name := "Finchley Road", lat := some LAT, lon := some LON, distanceM := 10 }

private def withStation : Reads :=
  { spy with stations := fun _ _ _ => #[STATION] }

private def run (reads : Reads) (places : List NamedPlace) (prev : Option Seg := none) : Seg :=
  enrichStay reads {} places prev stay LAT LON

-- 1. The alight arm wins over a focus place that would otherwise have taken it,
-- and asks the resolver `preferResidential=false` with NO stay.
#guard (run withStation [home] (some train)).place == some "Finchley Road"
#guard (run withStation [home] (some train)).city == some "London"
#guard (run withStation [home] (some train)).focusPlaceId == none
-- It fires on the PRECEDING mode only: the same stay after a walk is named the
-- ordinary way.
#guard (run withStation [home] (some { stay with mode := "walking" })).place == some "Home"
#guard (run withStation [home] none).place == some "Home"

-- 3. Home wins outright, keeps the focus id, and asks at the PLACE's centroid
-- with `preferResidential=true`.
#guard (run spy [home]).place == some "Home"
#guard (run spy [home]).focusPlaceId == some 1
-- 4. A non-residential cluster with a mined label takes the label.
#guard (run spy [cafe]).place == some "Loft Coffee Company"
#guard (run spy [cafe]).focusPlaceId == some 2
-- ... and a RESIDENTIAL one does not, even carrying the same label: it falls
-- through to the resolver, which the spy answers with its arguments —
-- `preferResidential=true` (residential) and a stay.
#guard (run spy [resid]).place == some "51.52|-0.13|true|true"
#guard (run spy [resid]).focusPlaceId == some 3
-- 5a. Venue-less and non-residential still prefers the address, which is the
-- `venueless` disjunct doing the work rather than `isResidential`.
#guard (run spy [venueless]).place == some "51.52|-0.13|true|true"
-- 5b. No mined place at all: the DAY's centroid, and `preferResidential` is the
-- overnight check — false for this midday stay.
#guard (run spy []).place == some "51.52|-0.13|false|true"
#guard (run spy []).focusPlaceId == none
-- The same stay overnight flips that flag.
#guard (enrichStay spy {} [] none { stay with startTs := 0, endTs := 3600 } LAT LON).place
  == some "51.52|-0.13|true|true"

-- A resolver with no answer leaves the segment unnamed rather than naming it
-- something empty.
private def silent : Reads := { spy with place := fun _ _ _ _ => none }
#guard (run silent []).place == none
#guard (run silent []).city == none

end Guards

end Verified.Geo.StayEnrich
