import Verified.Geo.BestPlace
import Verified.Geo.FocusPlaces
import Verified.Geo.VenuePrior

/-!
# The focus cron's amenity vote

`refresh-focus-places` decides ONE thing per cluster that the rest of the cron
does not: the `amenity_label` — which mapped venue, if any, this place IS. That
decision is this module (#982 Tier 2).

The geometry half of the cron (stay detection, clustering, splitting, hour
profiles, identity) already lives in {@link Verified.Geo.FocusPlaces} and
{@link Verified.Geo.FocusIdentity} and is reachable through `ServeEntry`'s
`focus` mode. The vote was the half with no entry point, and so the half that
drifted: `pickWinningAmenity` lost the near-field exemption for nine days and
`isLabelWorthyVenue` was never ported at all (both fixed 2026-08-24, #1003).

## Why one function and not three

The three gates read each other's leavings, so they cannot be composed from
outside without moving the state between them into the shell:

* the near-field exemption is a SET built from the same pass that builds the
  tally — a name is exempt because some stay saw it from inside
  `NEAR_FIELD_DECISIVE_M`, which is known only while voting;
* the centroid gate re-asks `isLabelWorthyVenue` about a DIFFERENT landmark
  list (the cluster centroid's, not any stay's);
* the tally's iteration order decides ties.

Putting any of that in Rust is putting the tie-breaks in Rust.

## What the shell still owns

Timezones and OSM rows. `localHour` and `samples` arrive resolved because
{@link Verified.Geo.VenuePrior.StayShape} takes them that way, and the landmark
lists arrive as `shapeLandmarks` output because the shell already fetched them.
-/

namespace Verified.Geo.FocusMining

open Verified.Geo.VenuePrior
  (Landmark StayShape AttributedStay rankVenues attributeStayVenue
   isLabelWorthyVenue VENUE_RANK_FLOOR_NATS NEAR_FIELD_DECISIVE_M)
open Verified.Geo.FocusPlaces (pickWinningAmenity)

/-- One stay of the cluster, with the venues near it. -/
structure MinedStay where
  shape : StayShape
  durationSec : Int
  /-- `nearbyLandmarks` at this stay's centroid, hours already resolved
      against this stay's window. -/
  landmarks : List Landmark
  deriving Inhabited

/-- Which gate refused a label, when one was refused. A null `amenity_label`
looks identical whichever gate wrote it, and #789 turned on knowing which —
so the reason is returned rather than reconstructed from the absence. -/
inductive Refusal where
  /-- Not enough total voting dwell, and the leader was not near-field. -/
  | weight
  /-- The leader did not take a majority. -/
  | majority
  /-- A winner was chosen, but it is not AT the cluster centroid. -/
  | centroid
  deriving Inhabited, BEq, Repr

def Refusal.name : Refusal → String
  | .weight => "1-weight"
  | .majority => "1-majority"
  | .centroid => "3-centroid"

structure Mined where
  /-- The cluster's `amenity_label`, or `none` when a gate refused. -/
  label : Option String
  /-- The winning venue's OSM subtype — `amenity_kind`, so a consumer can
      classify the place without parsing its name. Read off the CENTROID's
      landmark, which is the one the centroid gate accepted. -/
  kind : Option String
  /-- Training records for the venue-type prior: one per stay whose venue was
      geometrically unambiguous. The ambiguous stays are exactly what the
      scorer must predict, so they never train it. -/
  attributed : List AttributedStay
  refusal : Option Refusal
  deriving Inhabited

/-- Insertion-ordered accumulate. ⚠ NOT a `HashMap` and NOT sorted: the
TypeScript tallies into a JS `Map` and `pickWinningAmenity` takes the argmax
with a strict `>`, so an exact tie keeps the FIRST name seen. Any reordering
here silently re-picks those ties. -/
private def bump (f : Float → Float → Float) (xs : List (String × Float))
    (k : String) (v : Float) : List (String × Float) :=
  if xs.any (fun p => p.1 == k) then xs.map (fun p => if p.1 == k then (p.1, f p.2 v) else p)
  else xs ++ [(k, v)]

/-- Total dwell across the tally, used by both gate-1 branches. -/
private def tallyTotal (votes : List (String × Float)) : Float :=
  votes.foldl (fun a p => a + p.2) 0

/--
The vote, in the cron's own order.

Per stay: attribute it (for the prior), then rank its venues with the stay's
own window so opening-hours evidence weighs in, then let the leader vote its
dwell — if it is a real venue type close enough to be the place the stay is AT,
and if even the best candidate is plausible.

⚠ `priors` is deliberately `none` when ranking. This same pass rebuilds the
priors blob, and voting with the previous run's blob would let one bad label
echo into the next.
-/
def mineCluster (stays : List MinedStay) (centroid : List Landmark)
    (minWeight minFraction : Float) : Mined := Id.run do
  let mut votes : List (String × Float) := []
  let mut voteDist : List (String × Float) := []
  let mut attributed : List AttributedStay := []
  for s in stays do
    -- An empty landmark list is NOT a vote for nothing; it is no evidence.
    if s.landmarks.isEmpty then continue
    match attributeStayVenue s.landmarks with
    | some a =>
      attributed := attributed ++
        [{ subtype := a.subtype, durationSec := Float.ofInt s.durationSec,
           localHour := s.shape.localHour }]
    | none => pure ()
    match rankVenues s.landmarks (some s.shape) none with
    | [] => pure ()
    | top :: _ =>
      let best := top.landmark
      if !isLabelWorthyVenue best.type best.distanceM then continue
      if decide (top.total < VENUE_RANK_FLOOR_NATS) then continue
      votes := bump (· + ·) votes best.name (Float.ofInt s.durationSec)
      -- The CLOSEST sighting, not the latest: one visit that sat on the venue
      -- establishes "you have been in here" as well as ten would, so a later
      -- sloppier fix must not undo it.
      voteDist := bump min voteDist best.name best.distanceM
  let nearField := (voteDist.filter (fun p => decide (p.2 ≤ NEAR_FIELD_DECISIVE_M))).map (·.1)
  match pickWinningAmenity votes minWeight minFraction nearField with
  | none =>
    -- Which gate refused, and only when a vote was actually cast: no votes at
    -- all is silence, not a refusal.
    let refusal :=
      if votes.isEmpty then none
      else if decide (tallyTotal votes < minWeight) then some Refusal.weight
      else some Refusal.majority
    pure { label := none, kind := none, attributed := attributed, refusal := refusal }
  | some winner =>
    -- The centroid gate: the winner must be AT the cluster, within venue range
    -- of its CENTROID, not merely near some scattered stays. Two co-located
    -- places ~45 m apart would otherwise let the residence's evening stays —
    -- the ones whose GPS drifts venue-ward — vote the café's name onto the
    -- residence, whose centroid stays a clear ~70 m off it.
    match centroid.find? (fun l => l.name == winner) with
    | some here =>
      if isLabelWorthyVenue here.type here.distanceM then
        pure { label := some winner, kind := some here.subtype,
               attributed := attributed, refusal := none }
      else
        pure { label := none, kind := none, attributed := attributed,
               refusal := some Refusal.centroid }
    | none =>
      pure { label := none, kind := none, attributed := attributed,
             refusal := some Refusal.centroid }

/-! ## Guards

⚠ These are the ONLY check on this module until the Rust arm runs against prod
and its output is diffed against `focus_places` — there is no live comparator
for the mining half (#1003). Written to pin the gates and the tie-breaks, which
is what drifted last time. -/

private def LM (name type_ subtype : String) (d : Float) : Landmark :=
  { name := name, type := type_, subtype := subtype, distanceM := d }

private def ST (dur : Int) (hour : Int) (ls : List Landmark) : MinedStay :=
  { shape := { startUnix := 0, endUnix := dur, localHour := hour }
  , durationSec := dur, landmarks := ls }

private def cafe : Landmark := LM "Cafe" "amenity" "cafe" 10
private def shop : Landmark := LM "Shop" "shop" "books" 80

-- A single long stay on one venue takes the label, and the centroid agrees.
#guard (mineCluster [ST 3600 13 [cafe]] [cafe] 1800 0.5).label == some "Cafe"
#guard (mineCluster [ST 3600 13 [cafe]] [cafe] 1800 0.5).kind == some "cafe"
-- No stays at all is silence, not a refusal.
#guard (mineCluster [] [] 1800 0.5).refusal == none
#guard (mineCluster [] [] 1800 0.5).label == none
-- A stay with no landmarks casts no vote and refuses nothing.
#guard (mineCluster [ST 3600 13 []] [] 1800 0.5).refusal == none
-- Gate 1, weight: 10 minutes of dwell against a 30-minute floor, and the venue
-- is 10 m away so it is NOT near-field-exempt (the floor is 12 m).
#guard (mineCluster [ST 600 13 [LM "Far" "amenity" "cafe" 40]]
          [LM "Far" "amenity" "cafe" 40] 1800 0.5).refusal == some Refusal.weight
-- ⚠ The near-field exemption rescues exactly that case when the venue was seen
-- from inside 12 m. This is the behaviour that was missing from Lean for nine
-- days; a guard on `mineCluster` pins it at the level the cron uses it.
#guard (mineCluster [ST 600 13 [cafe]] [cafe] 1800 0.5).label == some "Cafe"
-- Gate 2: a `leisure` park is not a label-worthy venue however long the stay.
#guard (mineCluster [ST 7200 13 [LM "Park" "leisure" "park" 5]]
          [LM "Park" "leisure" "park" 5] 1800 0.5).label == none
-- Gate 2 again: a real venue type but 80 m off names an area, not the place.
#guard (mineCluster [ST 7200 13 [shop]] [shop] 1800 0.5).label == none
-- Gate 3: the vote wins but the centroid has no such venue near it.
#guard (mineCluster [ST 3600 13 [cafe]] [] 1800 0.5).refusal == some Refusal.centroid
#guard (mineCluster [ST 3600 13 [cafe]] [] 1800 0.5).label == none
-- Gate 3 is not satisfied by mere presence: the centroid's copy must itself be
-- label-worthy, so a match 80 m from the centroid still refuses.
#guard (mineCluster [ST 3600 13 [cafe]] [LM "Cafe" "amenity" "cafe" 80] 1800 0.5).refusal
       == some Refusal.centroid
-- The prior trains on the unambiguous stay even when a gate refuses the LABEL:
-- attribution and labelling answer different questions.
#guard (mineCluster [ST 3600 13 [cafe]] [] 1800 0.5).attributed.length == 1
#guard ((mineCluster [ST 3600 13 [cafe]] [] 1800 0.5).attributed.head!).subtype == "cafe"
-- ⚠ An ambiguous stay trains nothing: two differently-named venues inside the
-- 20 m margin is exactly what the scorer must learn to predict.
#guard (mineCluster [ST 3600 13 [cafe, LM "Other" "amenity" "bar" 12]] [] 1800 0.5).attributed.length == 0

end Verified.Geo.FocusMining
