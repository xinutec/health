import Verified.Hsmm.FloatScore
/-!
# Probabilistic place assignment (port of `src/geo/place-prior.ts` and
`src/geo/place-snap.ts`)

Which of the user's mined long-term clusters (`focus_places`) a stationary
segment belongs to. `pickBestPlace` combines, in log-space:

* **distance** — a Gaussian at the place's stored centroid. σ is the place's
  empirical radius, floored by a tolerance the place has EARNED: the floor
  slides continuously from 40 m (seen on one day) toward 100 m (thoroughly
  established) as visit-days accumulate. No hard "established" step.
* **visit frequency** — `log(uniqueDays + 1)`; log-linear, so a place visited
  500 times beats one visited 5 times by ~4.6, which ~3σ of distance evidence
  can still outweigh.
* **time of day** — the stay's hour profile scored against the place's mined
  one, re-centred so a uniform (or un-mined `none`) profile scores exactly 0.
  This separates co-located candidates a distance term cannot.
* **magnetic anchoring** — inside a place's magnet radius AND with positive
  biometric coherence, a boost proportional to its magnet strength.

Then two hard gates the priors cannot argue past: a **3σ centroid veto** (a
stay outside the cluster is not that cluster, however strong the priors — the
Pizza-Union-as-Work bug), and an **absolute far-reach cap** that stops a
place seen on a single day from claiming a stop 118 m away (the Wembley
"Selekt Chicken" bug). The veto relaxes under magnet × coherence, but only
within the magnet radius and never past 2× the base 3σ.

`snapToPlace` (from `place-snap.ts`) is the separate, simpler magnetic snap:
pull a noisy fix onto a known centroid when it is in range, unambiguous, and
the GPS accuracy is worse than how precisely the place is known.

Both files are wholly pure — no shell split was needed. Arithmetic and every
ordering/veto decision are EXACT; `log`/`exp` put the scores at ≤1 ULP.
UNPROVEN; pinned by the `#guard`s against Node/V8
(`lean/experiments/place-prior-refs.mts`).
-/

namespace Verified.Geo.PlacePrior

open Verified.Hsmm.FloatScore (haversineMeters)

/-! ## Calibration (verbatim from the TS) -/

/-- The σ floor a thoroughly-established place converges to. Day-of GPS
    clusters routinely sit 100–200 m from a known centroid (indoor multipath,
    building corners, walking in and out), so a place we are confident about
    must not collapse to ~0 likelihood for ordinary noise. -/
def SIGMA_FLOOR_MAX_M : Float := 100
/-- The floor for a place seen on a single day: it has earned no benefit of
    the doubt and cannot capture a stay merely in the same neighbourhood. -/
def SIGMA_FLOOR_MIN_M : Float := 40
/-- e-folding constant (visit-days) for how fast the σ floor climbs MIN→MAX. -/
def SIGMA_ESTABLISH_TAU_DAYS : Float := 10
/-- Reject the best candidate below this many log-points. -/
def POSTERIOR_FLOOR : Float := -8
/-- A stay beyond this many σ from the centroid is geometrically outside the
    cluster, so the label cannot apply regardless of priors. -/
def MAX_DISTANCE_SIGMAS : Float := 3
/-- Absolute cap on a once-seen place's veto reach, independent of (and
    tighter than) its σ-derived 3σ reach. -/
def ABS_VETO_REACH_MIN_M : Float := 90
/-- Effectively unbounded: above any established place's 3σ reach. -/
def ABS_VETO_REACH_MAX_M : Float := 1000
def MAGNET_REF_DAYS : Float := 10
def MAGNET_BASE_RADIUS_M : Float := 30
def MAGNET_SIGMA_MULTIPLIER : Float := 2
/-- Even at maximal magnet × coherence the veto cannot stretch beyond this
    factor of the base 3σ — no infinite reach for any prior. -/
def MAGNET_VETO_RELAX_MAX : Float := 2.0
/-- Smoothing floor for the time-of-day term, so an hour absent from a
    place's profile takes a bounded penalty rather than `log 0`. -/
def HOUR_PROFILE_EPS : Float := 0.02

/-- One mined long-term cluster. -/
structure PlaceCandidate where
  id : Int
  centroidLat : Float
  centroidLon : Float
  /-- Empirical scatter of the cluster, floored per {@link effectiveSigmaM}. -/
  radiusM : Float
  /-- Distinct days this place has been visited. -/
  uniqueDays : Float
  /-- 24 fractions summing to 1; `none` for a place mined before the column
      existed, which then contributes 0 to the time-of-day term. -/
  hourProfile : Option (List Float)
  deriving Inhabited, BEq

/-- The Gaussian σ a candidate effectively uses — shared between the scorer
    (smooth penalty) and the picker (hard veto) so both see the same notion of
    cluster size. -/
def effectiveSigmaM (c : PlaceCandidate) : Float :=
  let establishedness := 1 - Float.exp (-(max 0 (c.uniqueDays - 1)) / SIGMA_ESTABLISH_TAU_DAYS)
  let sigmaFloor := SIGMA_FLOOR_MIN_M + (SIGMA_FLOOR_MAX_M - SIGMA_FLOOR_MIN_M) * establishedness
  max sigmaFloor c.radiusM

/-- Time-of-day match between a place's mined hour profile and the stay's.
    `Σ stay[h]·log(place[h]+ε)` re-centred by the uniform baseline, so a
    uniform — or `none` — place scores 0, concentration on the stay's hours
    scores positive, and avoidance scores negative. -/
def hourProfileMatch (placeProfile : Option (List Float)) (stayProfile : List Float) : Float :=
  match placeProfile with
  | none => 0
  | some pp =>
    let uniformLog := Float.log (1 / Float.ofNat stayProfile.length + HOUR_PROFILE_EPS)
    let (raw, stayTotal) := stayProfile.zipIdx.foldl (fun (raw, tot) (w, h) =>
      if w == 0 then (raw, tot)
      else (raw + w * Float.log (pp.getD h 0 + HOUR_PROFILE_EPS), tot + w)) (0, 0)
    if stayTotal == 0 then 0 else raw - stayTotal * uniformLog

/-- Magnet strength: bounded so Home does not drown out everything else. -/
def magnetStrength (c : PlaceCandidate) : Float := Float.log (1 + c.uniqueDays)

/-- Magnet radius: CONSTANT at 30 + 2·40 = 110 m. Reach answers "could GPS
    noise have put this stay here?", a property of the sensor, not of the
    place — so it does not scale with visit history.

    It used to multiply `effectiveSigmaM`, which grows with visit-days, giving
    an established place a ~224 m magnet. That triple-counted establishedness
    (it already widens the Gaussian σ and already relaxes the distance veto),
    and let a frequently-visited place magnet a stay in the building next
    door. The docstring it carried — "scales with the place's scatter" — was
    never true of the data: `radiusM` is a constant 25 m on all 127 corpus
    focus places, so `effectiveSigmaM` reduces to its establishedness floor.

    The corpus separates cleanly: a stay sits ~24 m from its true building and
    ~205 m from the neighbouring one, so the cut lies in the empty band
    between. See `src/geo/place-prior.ts` for the measured case. -/
def magnetRadiusM (_c : PlaceCandidate) : Float :=
  MAGNET_BASE_RADIUS_M + MAGNET_SIGMA_MULTIPLIER * SIGMA_FLOOR_MIN_M

/-- Posterior score for one candidate: Gaussian log-likelihood on distance
    (constant terms dropped — this is only ever argmaxed) + frequency prior +
    time-of-day match + magnet boost. -/
def scorePlaceForSegment (c : PlaceCandidate) (segLat segLon : Float)
    (stayHourProfile : List Float) (biometricCoherence : Option Float := none) : Float :=
  let distM := haversineMeters c.centroidLat c.centroidLon segLat segLon
  let sigma := effectiveSigmaM c
  let logLikelihood := -(distM * distM) / (2 * sigma * sigma)
  let logPriorFreq := Float.log (c.uniqueDays + 1)
  let logPriorTimeOfDay := hourProfileMatch c.hourProfile stayHourProfile
  let bs := biometricCoherence.getD 0
  let magnetBoost := if decide (distM ≤ magnetRadiusM c) then magnetStrength c * bs else 0
  logLikelihood + logPriorFreq + logPriorTimeOfDay + magnetBoost

/--
Pick the `focus_place` with the highest posterior, or `none` when the best is
below the floor (typically: everything is too far away).

The distance veto runs BEFORE the argmax, so a closer in-cluster candidate
still wins when a far one would otherwise have topped the list.
-/
def pickBestPlace (candidates : List PlaceCandidate) (segLat segLon : Float)
    (stayHourProfile : List Float) (biometricCoherence : Option Float := none) :
    Option (PlaceCandidate × Float) := Id.run do
  if candidates.isEmpty then return none
  let bs := biometricCoherence.getD 0
  let mut best : Option (PlaceCandidate × Float) := none
  for c in candidates do
    let s := scorePlaceForSegment c segLat segLon stayHourProfile biometricCoherence
    let dist := haversineMeters c.centroidLat c.centroidLon segLat segLon
    -- Veto relaxation under magnet × coherence. The candidate must ALSO sit
    -- within its own magnet radius: outside it the magnet contributes nothing
    -- anyway, so relaxing there would let a heavily-visited place steal a stay
    -- hundreds of metres away.
    let magnetFactor := if decide (dist ≤ magnetRadiusM c)
                        then min MAGNET_VETO_RELAX_MAX (1 + (magnetStrength c * bs) / MAGNET_REF_DAYS)
                        else 1
    -- Absolute far-reach cap, climbing with visit-days so it only meaningfully
    -- binds for the genuinely once-seen place.
    let establishedness := 1 - Float.exp (-(max 0 (c.uniqueDays - 1)) / SIGMA_ESTABLISH_TAU_DAYS)
    let absCap := ABS_VETO_REACH_MIN_M + (ABS_VETO_REACH_MAX_M - ABS_VETO_REACH_MIN_M) * establishedness
    let vetoReach := min (MAX_DISTANCE_SIGMAS * effectiveSigmaM c * magnetFactor) absCap
    if decide (dist > vetoReach) then continue
    match best with
    | none => best := some (c, s)
    | some (_, bScore) => if decide (s > bScore) then best := some (c, s)
  match best with
  | some (_, score) => if decide (score < POSTERIOR_FLOOR) then return none else return best
  | none => return none

/-! ## Magnetic place-snap (`place-snap.ts`) -/

/-- A known cluster to snap onto. -/
structure KnownPlace where
  centroidLat : Float
  centroidLon : Float
  /-- How precisely we know this centroid; defaults to 10 m when absent. -/
  radiusM : Option Float := none
  id : Option String := none
  deriving Inhabited, BEq

structure SnapResult where
  lat : Float
  lon : Float
  accuracy : Option Float
  snapped : Bool
  snappedTo : Option KnownPlace := none
  snapDistanceM : Option Float := none
  deriving Inhabited, BEq

/-- Maximum distance from a place to consider snapping. -/
def SNAP_RADIUS_M : Float := 75
/-- Don't snap fixes already more accurate than this. -/
def MIN_ACCURACY_TO_SNAP_M : Float := 30
/-- The closest place must be at least this many times closer than the
    runner-up, else the fix could plausibly belong to either. -/
def AMBIGUITY_RATIO : Float := 2.0

private def sortByDist (xs : List (KnownPlace × Float)) : List (KnownPlace × Float) :=
  let rec ins (x : KnownPlace × Float) : List (KnownPlace × Float) → List (KnownPlace × Float)
    | [] => [x]
    | y :: ys => if decide (x.2 < y.2) then x :: y :: ys else y :: ins x ys
  xs.foldl (fun acc x => ins x acc) []

/--
Pull a noisy fix to a known centroid when it is in range, unambiguous, and the
GPS uncertainty is worse than how precisely the place is known. A very precise
fix is trusted as-is — it is better than the cluster centroid would be.
-/
def snapToPlace (lat lon : Float) (accuracy : Option Float) (places : List KnownPlace)
    (snapRadiusM : Float := SNAP_RADIUS_M) (minAccuracyToSnapM : Float := MIN_ACCURACY_TO_SNAP_M)
    (ambiguityRatio : Float := AMBIGUITY_RATIO) : SnapResult :=
  let unchanged : SnapResult := ⟨lat, lon, accuracy, false, none, none⟩
  match accuracy with
  | some a => if decide (a < minAccuracyToSnapM) then unchanged else go unchanged
  | none => go unchanged
where
  go (unchanged : SnapResult) : SnapResult :=
    if places.isEmpty then unchanged
    else
      let candidates := sortByDist ((places.map (fun p =>
        (p, haversineMeters lat lon p.centroidLat p.centroidLon))).filter
          (fun c => decide (c.2 ≤ snapRadiusM)))
      match candidates with
      | [] => unchanged
      | (winner, dist) :: rest =>
        -- Ambiguity guard: a comparably-close runner-up means don't pick.
        match rest with
        | (_, d2) :: _ => if decide (d2 < dist * ambiguityRatio) then unchanged else snapTo winner dist
        | [] => snapTo winner dist
  snapTo (p : KnownPlace) (dist : Float) : SnapResult :=
    ⟨p.centroidLat, p.centroidLon, some (p.radiusM.getD 10), true, some p, some dist⟩

/-! ## Parity with Node/V8 (`lean/experiments/place-prior-refs.mts`) -/

private def approx (a b : Float) : Bool := Float.abs (a - b) < 1e-9

/-- An hour profile concentrated on the given hours, equal mass each. -/
private def profile (hours : List Nat) : List Float :=
  (List.range 24).map (fun h => if hours.contains h then 1 / Float.ofNat hours.length else 0)

private def UNIFORM : List Float := (List.range 24).map (fun _ => 1 / 24)
private def DAYTIME : List Float := profile [9, 10, 11, 12, 13, 14, 15, 16, 17]
private def EVENING : List Float := profile [19, 20, 21, 22]

private def LAT : Float := 51.5205
private def LON : Float := -0.1275
/-- Roughly `m` metres north of the anchor. -/
private def north (m : Float) : Float := LAT + m / 111320

private def C (id : Int) (lat lon radiusM uniqueDays : Float) (hp : Option (List Float)) : PlaceCandidate :=
  ⟨id, lat, lon, radiusM, uniqueDays, hp⟩

private def work : PlaceCandidate := C 1 LAT LON 25 120 (some DAYTIME)
private def oneOff : PlaceCandidate := C 2 LAT LON 25 1 (some EVENING)

#guard approx (haversineMeters LAT LON (north 100) LON) 99.887645207303692
#guard haversineMeters LAT LON LAT LON == 0

#guard magnetStrength (C 1 LAT LON 25 0 none) == 0
#guard approx (magnetStrength (C 1 LAT LON 25 1 none)) 0.69314718055994529
#guard approx (magnetStrength (C 1 LAT LON 25 10 none)) 2.3978952727983707
#guard approx (magnetStrength (C 1 LAT LON 25 500 none)) 6.2166061010848646

/-! ### `magnetRadiusM` — constant reach

Nothing pinned the magnet radius before 2026-08-12, and nothing pinned the
boost at all: `biometricCoherence` defaults to `none`, so every guard above
runs with the magnet contributing exactly 0. The whole mechanism was dark. -/

-- Reach does not scale with visit history. Before the fix these read 110 and
-- 230 — a 500-day place got a magnet twice as wide as a one-off's.
#guard magnetRadiusM (C 1 LAT LON 25 1 none) == 110
#guard magnetRadiusM (C 1 LAT LON 25 500 none) == 110

-- The measured corpus shape (two adjacent buildings of one institution): a
-- stay ~24 m from the building it is in, which the user visits rarely,
-- against the neighbour ~205 m away, which the user visits constantly.
private def nearSparse : PlaceCandidate := C 1 (north 24) LON 25 4 (some DAYTIME)
private def farEstablished : PlaceCandidate := C 2 (north 205) LON 25 31 (some DAYTIME)

-- THE FIX, stated as an invariance: the far place is outside its magnet, so
-- biometric coherence cannot move its score by any amount.
#guard approx (scorePlaceForSegment farEstablished LAT LON DAYTIME (some 0)) 1.9924056837212474
#guard approx (scorePlaceForSegment farEstablished LAT LON DAYTIME (some 1)) 1.9924056837212474
-- The near place is inside its magnet, so coherence does move it.
#guard approx (scorePlaceForSegment nearSparse LAT LON DAYTIME (some 0)) 2.2706214960936260
#guard approx (scorePlaceForSegment nearSparse LAT LON DAYTIME (some 1)) 3.8800594085277265
-- At the real stay's measured coherence the near building wins by 1.71 nats.
-- Under the old 224 m magnet the far one won by 0.0056.
#guard approx (scorePlaceForSegment nearSparse LAT LON DAYTIME (some 0.886842487040252)) 3.6979394170935551
#guard decide (scorePlaceForSegment farEstablished LAT LON DAYTIME (some 0.886842487040252)
             < scorePlaceForSegment nearSparse LAT LON DAYTIME (some 0.886842487040252))

/-! ### `scorePlaceForSegment` -/

#guard approx (scorePlaceForSegment work LAT LON DAYTIME) 5.5500921493100179
#guard approx (scorePlaceForSegment work (north 100) LON DAYTIME) 5.0512110009393520
#guard approx (scorePlaceForSegment work (north 300) LON DAYTIME) 1.0601618139977029
-- The same place scores lower for an evening stay: the mined profile is the
-- only thing separating these two.
#guard approx (scorePlaceForSegment work LAT LON EVENING) 3.6697792827405173
#guard approx (scorePlaceForSegment work LAT LON UNIFORM) 4.3748966077040778
#guard approx (scorePlaceForSegment oneOff LAT LON EVENING) 2.1698256031481051
#guard approx (scorePlaceForSegment oneOff (north 100) LON EVENING) (-0.94815616718320106)
-- An un-mined profile and a uniform one both contribute exactly 0 on time.
#guard approx (scorePlaceForSegment (C 3 LAT LON 25 30 none) LAT LON DAYTIME) 3.4339872044851463
#guard approx (scorePlaceForSegment (C 4 LAT LON 25 30 (some UNIFORM)) LAT LON DAYTIME) 3.4339872044851472
-- A stay profile of all zeros contributes nothing rather than dividing by it.
#guard approx (scorePlaceForSegment work LAT LON ((List.range 24).map (fun _ => 0))) 4.7957905455967413
-- Magnet boost needs positive coherence AND being inside the radius (230 m here).
#guard approx (scorePlaceForSegment work LAT LON DAYTIME (some 1)) 10.345882694906759
#guard approx (scorePlaceForSegment work (north 100) LON DAYTIME (some 1)) 9.8470015465360934
#guard approx (scorePlaceForSegment work (north 400) LON DAYTIME (some 1)) (-2.4320062245890641)
#guard approx (scorePlaceForSegment work LAT LON DAYTIME (some 0.5)) 7.9479874221083886
#guard approx (scorePlaceForSegment oneOff LAT LON EVENING (some 1)) 2.8629727837080505
-- A large empirical radius overrides the earned floor.
#guard approx (scorePlaceForSegment (C 5 LAT LON 300 50 none) (north 200) LON UNIFORM) 3.7101024846118773

/-! ### `pickBestPlace` -/

private def pickId (r : Option (PlaceCandidate × Float)) : Option Int := r.map (·.1.id)

#guard (pickBestPlace [] LAT LON DAYTIME).isNone
#guard pickId (pickBestPlace [work] LAT LON DAYTIME) == some 1
-- The 3σ veto: work's earned σ is ~100 m, so its reach is ~300 m.
#guard pickId (pickBestPlace [work] (north 250) LON DAYTIME) == some 1
#guard pickId (pickBestPlace [work] (north 299) LON DAYTIME) == some 1
#guard (pickBestPlace [work] (north 305) LON DAYTIME).isNone
#guard (pickBestPlace [work] (north 500) LON DAYTIME).isNone
-- The absolute far-reach cap: a once-seen place is held to 90 m even though
-- its 3σ reach would be 120 m.
#guard pickId (pickBestPlace [oneOff] (north 85) LON EVENING) == some 2
#guard (pickBestPlace [oneOff] (north 95) LON EVENING).isNone
#guard (pickBestPlace [oneOff] (north 118) LON EVENING).isNone
-- Two visit-days already lift the cap past the 3σ reach.
#guard pickId (pickBestPlace [C 6 LAT LON 25 2 (some EVENING)] (north 100) LON EVENING) == some 6
-- A far established place must not steal a stay from a near one.
#guard pickId (pickBestPlace [work, C 9 (north 400) LON 25 1 (some EVENING)] (north 400) LON EVENING) == some 9
-- Veto relaxation requires being INSIDE the magnet radius (230 m), so a
-- 320 m stay is vetoed even at maximal coherence.
#guard (pickBestPlace [work] (north 320) LON DAYTIME (some 0)).isNone
#guard (pickBestPlace [work] (north 320) LON DAYTIME (some 1)).isNone
#guard (pickBestPlace [work] (north 700) LON DAYTIME (some 1)).isNone
-- Posterior floor: a distant, low-history place is rejected outright.
#guard (pickBestPlace [C 10 LAT LON 25 1 none] (north 200) LON UNIFORM).isNone
#guard match pickBestPlace [work] LAT LON DAYTIME with
       | some (_, s) => approx s 5.5500921493100179
       | none => false

/-! ### `snapToPlace` -/

private def home : KnownPlace := ⟨LAT, LON, some 15, some "home"⟩
private def cafe35 : KnownPlace := ⟨north 35, LON, some 15, some "cafe"⟩
private def cafe60 : KnownPlace := ⟨north 60, LON, some 15, some "cafe"⟩

-- A fix already more precise than 30 m is trusted as-is.
#guard (snapToPlace (north 20) LON (some 10) [home]).snapped == false
-- Unknown accuracy is not a reason to trust it.
#guard (snapToPlace (north 20) LON none [home]).snapped == true
#guard match snapToPlace (north 20) LON (some 50) [home] with
       | r => r.snapped && r.lat == LAT && r.accuracy == some 15
              && (r.snapDistanceM.map (approx · 19.977529041460738)).getD false
-- An omitted place radius defaults to 10 m.
#guard (snapToPlace (north 20) LON (some 50) [⟨LAT, LON, none, some "home"⟩]).accuracy == some 10
#guard (snapToPlace (north 20) LON (some 50) []).snapped == false
#guard (snapToPlace (north 200) LON (some 50) [home]).snapped == false
-- A comparably-close runner-up makes the fix ambiguous: don't pick.
#guard (snapToPlace (north 20) LON (some 50) [home, cafe35]).snapped == false
#guard (snapToPlace (north 10) LON (some 50) [home, cafe60]).snapped == true
-- The accuracy gate is exclusive: exactly 30 m still snaps.
#guard (snapToPlace (north 20) LON (some 30) [home]).snapped == true
#guard (snapToPlace (north 200) LON (some 50) [home] (snapRadiusM := 250)).snapped == true
-- A looser ambiguity ratio lets the (here nearer) cafe win.
#guard match snapToPlace (north 20) LON (some 50) [home, cafe35] (ambiguityRatio := 1.1) with
       | r => r.snapped && (r.snappedTo.bind (·.id)) == some "cafe"
              && (r.snapDistanceM.map (approx · 14.983146780700512)).getD false

end Verified.Geo.PlacePrior
