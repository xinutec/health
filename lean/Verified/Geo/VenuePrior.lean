/-!
# Venue-plausibility scoring (port of `src/geo/venue-prior.ts`)

Ranking the candidate places a stay might have happened at, by summed
log-evidence in nats — the same discipline as the mode factor scorer:

* **distance** — Gaussian in metres; gentle in the near field where GPS noise
  lives, decisive across a large gap.
* **venue** — a fixed offset for real venue types (amenity/tourism/shop) over
  areas (parks, squares, ways).
* **shape** — the MINED visit-shape prior: `log P(subtype)` +
  `log P(dwell bucket | subtype)` + `log P(hour | subtype)`, each relative to
  uniform, with subtype → category → uniform backoff. No hand-tuned venue
  numbers: empty priors score exactly 0 everywhere (pinned by a `#guard`).
* **hours** — opening-hours evidence: open is weak support, closed is strong
  but out-votable. A missing or unparseable tag is NO evidence, never
  "closed".

Also ported: the hard attribution gate that decides which stays may train the
prior, the SOFT responsibilities (a softmax over candidates plus an `other`
component for "the true venue is not in this list"), and both miners.

## Boundaries

Two inputs arrive pre-resolved from the shell, because both are `Intl`/tz work:

* `Landmark.openFraction` — the fraction of the stay the venue was open,
  i.e. `parseOpeningHours` (ported in `Verified.Geo.OpeningHours`) fed through
  `openFractionOver`. `none` means tag absent OR outside the parser subset;
  both are "no evidence", exactly as the TS `hoursScore` returns null.
* `StayShape.localHour` — the venue-local hour of the stay midpoint
  (`localHourOf`).

## Exactness

Arithmetic, bucketing, the attribution gate and every ordering decision are
EXACT. `shapeScore` and the softmax go through `log`/`exp`, so those are ≤1
ULP. One documented limit: the comparator's LAST-RESORT tie-break is
`String.localeCompare`, i.e. full ICU collation. {@link collateAscii}
reproduces it for ASCII (punctuation < digits < letters, case-folded primary,
lowercase-first on tie — verified against Node's en-GB), which covers realistic
venue names; **accented and non-ASCII names are out of scope** and may order
differently. That tie-break only fires when two candidates agree on enclosing,
near-field, total AND distance bit-for-bit, so it is close to unreachable in
production — but the limit is real and stated rather than hidden.

UNPROVEN; pinned by the `#guard`s against Node/V8
(`lean/experiments/venue-prior-refs.mts`).
-/

namespace Verified.Geo.VenuePrior

/-! ## Shapes -/

/-- A candidate place near the stay. Mirrors `NearbyLandmark`, with opening
    hours already reduced to an open-fraction by the shell. -/
structure Landmark where
  name : String
  /-- `"amenity" | "tourism" | "leisure" | "shop" | "place" | "highway"`. -/
  type : String
  subtype : String
  distanceM : Float
  /-- Fraction of the stay the venue was open; `none` = no evidence. -/
  openFraction : Option Float := none
  /-- A large institution whose mapped footprint encloses the query point. -/
  enclosing : Bool := false
  /-- Synthesised from a reverse-geocode rather than measured, so its
      `distanceM` of 0 must not earn near-field dominance. -/
  reverseGeocoded : Bool := false
  deriving Inhabited, BEq

/-- The stay being explained. `localHour` is shell-resolved from the tz. -/
structure StayShape where
  startUnix : Int
  endUnix : Int
  /-- Local hour (0–23, venue tz) of the stay midpoint. -/
  localHour : Int
  deriving Inhabited

/-- Per-venue-type visit statistics mined from the user's stay history. Counts
    are `Float` because soft attribution contributes fractional visits. -/
structure VenueTypeStats where
  visits : Float
  /-- Visit mass per dwell bucket (sums to `visits`). -/
  dwell : List Float
  /-- Visit mass per local hour (24 entries, sums to `visits`). -/
  hours : List Float
  deriving Inhabited, BEq

/-- The mined priors blob. Association lists preserve JS object insertion
    order, which `shapeScore` reads back as the subtype-universe size. -/
structure VenuePriors where
  bySubtype : List (String × VenueTypeStats)
  byCategory : List (String × VenueTypeStats)
  totalVisits : Float
  deriving Inhabited

structure VenueScoreParts where
  distance : Float
  venue : Float
  /-- `none` when priors or stay context are absent, or the landmark is not a
      typed venue. -/
  shape : Option Float
  /-- `none` when the tag is absent/unparseable or there is no stay context. -/
  hours : Option Float
  deriving Inhabited, BEq

structure VenueCandidateScore where
  landmark : Landmark
  total : Float
  parts : VenueScoreParts
  /-- Qualified for near-field distance dominance — ranked above every
      non-near-field candidate REGARDLESS of `total`. The flag is what makes
      the short-circuit measurable: when the top candidate carries it, the
      summed evidence below did not decide this stay. -/
  nearField : Bool
  deriving Inhabited

/-! ## Calibration (verbatim from the TS) -/

def DISTANCE_SIGMA_M : Float := 40
def VENUE_OVER_AREA_NATS : Float := 1.5
def HOURS_OPEN_NATS : Float := 0.7
def HOURS_CLOSED_NATS : Float := -2.5
def DWELL_PSEUDO_VISITS : Float := 4
def HOUR_PSEUDO_VISITS : Float := 8
def CATEGORY_VISIT_CAP : Float := 12
def BASE_RATE_PSEUDO : Float := 0.5
def BASE_RATE_MIN_TYPES : Nat := 8
def NEAR_FIELD_DECISIVE_M : Float := 12
def ATTRIBUTION_MAX_DIST_M : Float := 30
def ATTRIBUTION_MARGIN_M : Float := 20
/-- Honest-label floor: below this no nearby candidate is a plausible
    destination and the resolver falls through to the address chain. -/
def VENUE_RANK_FLOOR_NATS : Float := -1.5
/-- Log-odds of "the true venue is not in this list at all". PROVISIONAL in
    the TS — borrowed from the rank floor, and knowingly uncalibrated. -/
def OTHER_COMPONENT_NATS : Float := VENUE_RANK_FLOOR_NATS

/-- Boundaries (minutes) between dwell buckets: errand <10, short 10–40,
    meal/appointment 40–150, long 150+. -/
def DWELL_BUCKET_BOUNDS_MIN : List Float := [10, 40, 150]
def DWELL_BUCKETS : Nat := 4

def VENUE_TYPES : List String := ["amenity", "tourism", "shop"]
/-- Types whose subtype participates in the mined prior. `place`/`highway`
    subtypes name areas, not visitable venues. -/
def PRIOR_TYPES : List String := ["amenity", "tourism", "shop", "leisure"]

/-- Maximum distance at which a landmark counts as "the place the user is at"
    for the `focus_places` amenity vote. Beyond it the venue is something the
    stay is NEAR, not AT, and must not name the place. 50 m is a typical urban
    building footprint, and `LODGING_MAX_DIST_M` is deliberately the same. -/
def VENUE_VOTE_MAX_DIST_M : Float := 50

/--
The amenity vote's gate: a landmark may name a cluster only if it is a real
venue type AND close enough to be the place the stay is actually at.

A park (`leisure`) the stay merely sits near, a pedestrian way, or a café 80 m
off all fail — they name an AREA, not a venue, and the cluster is better left
with no `amenity_label` (the runtime then resolves a neutral area/address)
than labelled with a place the user was never inside.

⚠ Takes the two fields rather than a `Landmark`, because it is asked of BOTH
landmark shapes: `rankVenues`' input (`VenuePrior.Landmark`) and the shaped
output of `nearbyLandmarks` (`Landmarks.Landmark`). In the TypeScript those
are one type, so a version taking either would have to pick one and leave the
other call site to convert.

⚠ Absent from Lean entirely until 2026-08-24 (\#1003): it is a mining-only
gate, and no live comparison reaches the mining path.
-/
def isLabelWorthyVenue (type : String) (distanceM : Float) : Bool :=
  VENUE_TYPES.contains type && decide (distanceM ≤ VENUE_VOTE_MAX_DIST_M)

/-- Premises-less street furniture — objects nobody can be "at" for a
    10-minute-plus stay. The ONLY binary rule here; anything with premises is
    weighted via the mined prior instead. -/
def NEVER_DESTINATION_SUBTYPES : List String :=
  ["post_box", "vending_machine", "atm", "telephone", "waste_basket", "waste_disposal",
   "recycling", "bench", "shelter", "drinking_water", "fountain", "bicycle_parking",
   "bicycle_rental", "parcel_locker", "car_sharing", "motorcycle_parking", "grit_bin",
   "post_depot_box", "hydrant", "surveillance"]

/-- Explicit subtype → category map. Enumerated rather than pattern-matched on
    purpose; unknown subtypes fall through to `"other"`. The mapping is
    structural (which backoff pool), never quantitative. -/
def VENUE_CATEGORY : List (String × String) :=
  [("restaurant", "food"), ("cafe", "food"), ("fast_food", "food"), ("bar", "food"),
   ("pub", "food"), ("biergarten", "food"), ("food_court", "food"), ("ice_cream", "food"),
   ("nightclub", "food"), ("bakery", "food"),
   ("hotel", "lodging"), ("guest_house", "lodging"), ("hostel", "lodging"),
   ("apartment", "lodging"), ("motel", "lodging"),
   ("cinema", "leisure"), ("theatre", "leisure"), ("arts_centre", "leisure"),
   ("museum", "leisure"), ("gallery", "leisure"), ("library", "leisure"),
   ("fitness_centre", "leisure"), ("sports_centre", "leisure"), ("swimming_pool", "leisure"),
   ("park", "leisure"), ("playground", "leisure"), ("attraction", "leisure"),
   ("zoo", "leisure"), ("casino", "leisure"),
   ("pharmacy", "errand"), ("supermarket", "errand"), ("convenience", "errand"),
   ("clothes", "errand"), ("shoes", "errand"), ("hairdresser", "errand"),
   ("beauty", "errand"), ("bank", "errand"), ("post_office", "errand"),
   ("dry_cleaning", "errand"), ("laundry", "errand"), ("optician", "errand"),
   ("jewelry", "errand"), ("books", "errand"), ("gift", "errand"), ("florist", "errand"),
   ("furniture", "errand"), ("mobile_phone", "errand"), ("electronics", "errand"),
   ("bicycle", "errand"), ("car_repair", "errand"), ("butcher", "errand"),
   ("greengrocer", "errand"), ("chemist", "errand"), ("department_store", "errand"),
   ("mall", "errand"), ("kiosk", "errand"), ("travel_agency", "errand"),
   ("estate_agent", "errand"), ("fuel", "errand"),
   ("hospital", "institution"), ("clinic", "institution"), ("doctors", "institution"),
   ("dentist", "institution"), ("veterinary", "institution"), ("school", "institution"),
   ("college", "institution"), ("university", "institution"), ("kindergarten", "institution"),
   ("townhall", "institution"), ("courthouse", "institution"), ("police", "institution"),
   ("place_of_worship", "institution"), ("community_centre", "institution"),
   ("social_facility", "institution"), ("coworking_space", "institution"),
   ("station", "transport"), ("bus_station", "transport"), ("ferry_terminal", "transport"),
   ("airport", "transport"), ("parking", "transport"), ("car_rental", "transport"),
   ("charging_station", "transport"), ("taxi", "transport")]

def categoryOfSubtype (subtype : String) : String :=
  match VENUE_CATEGORY.find? (fun (k, _) => k == subtype) with
  | some (_, v) => v
  | none => "other"

private def lookupStats (tbl : List (String × VenueTypeStats)) (k : String) : Option VenueTypeStats :=
  (tbl.find? (fun (n, _) => n == k)).map (·.2)

private def clamp (x lo hi : Float) : Float := min hi (max lo x)

/-- Which dwell bucket a duration falls in. -/
def dwellBucket (durationSec : Float) : Nat := Id.run do
  let minutes := durationSec / 60
  for i in [0 : DWELL_BUCKET_BOUNDS_MIN.length] do
    if decide (minutes < DWELL_BUCKET_BOUNDS_MIN.getD i 0) then return i
  return DWELL_BUCKET_BOUNDS_MIN.length

/-! ## Scoring -/

/-- Shrunk estimate of `P(bin | subtype)`: subtype mass, backed off through a
    capped category pool, then a uniform pseudo-count. With no data at all
    this is exactly uniform → a log-ratio of 0, i.e. no evidence. -/
def blendedBinP (st cat : Option VenueTypeStats) (pick : VenueTypeStats → Float)
    (dims : Nat) (pseudo : Float) : Float :=
  let u := 1 / Float.ofNat dims
  let stN := match st with | some s => s.visits | none => 0
  let catN := min (match cat with | some c => c.visits | none => 0) CATEGORY_VISIT_CAP
  let stMass := match st with
                | some s => if decide (stN > 0) then pick s else 0
                | none => 0
  let catMass := match cat with
                 | some c => if decide (c.visits > 0) then (pick c / c.visits) * catN else 0
                 | none => 0
  (stMass + catMass + pseudo * u) / (stN + catN + pseudo)

/-- The mined visit-shape prior for a subtype: base rate + dwell shape + hour
    shape, each as a clamped log-ratio against uniform. -/
def shapeScore (subtype : String) (stay : StayShape) (priors : VenuePriors) : Float :=
  let st := lookupStats priors.bySubtype subtype
  let cat := lookupStats priors.byCategory (categoryOfSubtype subtype)
  let bucket := dwellBucket (Float.ofInt (stay.endUnix - stay.startUnix))
  let dwellP := blendedBinP st cat (fun s => s.dwell.getD bucket 0) DWELL_BUCKETS DWELL_PSEUDO_VISITS
  let hour := (stay.localHour.emod 24).toNat
  let hourP := blendedBinP st cat (fun s => s.hours.getD hour 0) 24 HOUR_PSEUDO_VISITS
  let kTypes := Float.ofNat (max priors.bySubtype.length BASE_RATE_MIN_TYPES)
  let stVisits := match st with | some s => s.visits | none => 0
  let baseP := (stVisits + BASE_RATE_PSEUDO) / (priors.totalVisits + BASE_RATE_PSEUDO * kTypes)
  clamp (Float.log (baseP * kTypes)) (-2) 1.5
  + clamp (Float.log (dwellP * Float.ofNat DWELL_BUCKETS)) (-2) 1.2
  + clamp (Float.log (hourP * 24)) (-1.5) 1.2

/-- Opening-hours evidence from an already-resolved open fraction: fully open
    is mild support, fully closed is strong but out-votable counter-evidence.
    `none` in ⇒ `none` out (no evidence, NOT closed). -/
def hoursScore (openFraction : Option Float) : Option Float :=
  openFraction.map (fun frac => HOURS_CLOSED_NATS + frac * (HOURS_OPEN_NATS - HOURS_CLOSED_NATS))

/-! ### ASCII collation

Reproduces `String.localeCompare` under Node's ICU for ASCII: punctuation and
space sort below digits, which sort below letters; letters compare
case-folded, and an otherwise-equal pair breaks with LOWERCASE FIRST. Accented
and non-ASCII characters are out of scope (see the module header). -/

private def isAsciiUpper (c : Char) : Bool := c ≥ 'A' && c ≤ 'Z'
private def isAsciiLower (c : Char) : Bool := c ≥ 'a' && c ≤ 'z'
private def isAsciiDigit (c : Char) : Bool := c ≥ '0' && c ≤ '9'

/-- Primary weight: class (0 = punctuation/space, 1 = digit, 2 = letter) then
    the case-folded character within the class. -/
private def primaryWeight (c : Char) : Nat × Nat :=
  if isAsciiUpper c then (2, c.toNat + 32)
  else if isAsciiLower c then (2, c.toNat)
  else if isAsciiDigit c then (1, c.toNat)
  else (0, c.toNat)

/-- Tertiary weight: lowercase (and non-letters) before uppercase. -/
private def caseWeight (c : Char) : Nat := if isAsciiUpper c then 1 else 0

private def cmpNat (a b : Nat) : Int := if a < b then -1 else if a > b then 1 else 0

private def cmpPrimary : List Char → List Char → Int
  | [], [] => 0
  | [], _ :: _ => -1
  | _ :: _, [] => 1
  | a :: as, b :: bs =>
    let (ca, wa) := primaryWeight a
    let (cb, wb) := primaryWeight b
    if ca != cb then cmpNat ca cb
    else if wa != wb then cmpNat wa wb
    else cmpPrimary as bs

private def cmpCase : List Char → List Char → Int
  | [], [] => 0
  | [], _ :: _ => -1
  | _ :: _, [] => 1
  | a :: as, b :: bs =>
    let wa := caseWeight a
    let wb := caseWeight b
    if wa != wb then cmpNat wa wb else cmpCase as bs

/-- `a.localeCompare b` for ASCII: −1 / 0 / 1. -/
def collateAscii (a b : String) : Int :=
  let la := a.toList
  let lb := b.toList
  let p := cmpPrimary la lb
  if p != 0 then p else cmpCase la lb

/-! ### `rankVenues` -/

private def isVenueType (l : Landmark) : Bool := VENUE_TYPES.contains l.type
private def isFurniture (l : Landmark) : Bool := NEVER_DESTINATION_SUBTYPES.contains l.subtype

/-- Stable insertion into a list already ordered by `before`: `x` lands before
    the first element it strictly precedes, so ties keep input order — this is
    what V8's stable `Array.prototype.sort` does. -/
private def insertBy (before : VenueCandidateScore → VenueCandidateScore → Bool)
    (x : VenueCandidateScore) : List VenueCandidateScore → List VenueCandidateScore
  | [] => [x]
  | y :: ys => if before x y then x :: y :: ys else y :: insertBy before x ys

private def sortStable (before : VenueCandidateScore → VenueCandidateScore → Bool)
    (xs : List VenueCandidateScore) : List VenueCandidateScore :=
  xs.foldl (fun acc x => insertBy before x acc) []

/--
Rank landmark candidates for a stay by summed log-evidence, best first.
`stay` and `priors` are optional — without them the ranking degrades to
distance + venue-over-area. Enclosing institutions outrank everything; a real
point venue inside `NEAR_FIELD_DECISIVE_M` outranks any farther candidate
EXCEPT when opening hours say it is closed (then either OSM is stale or you
are somewhere else, so proximity stops being decisive and the scored ranking
weighs the closed penalty).
-/
def rankVenues (landmarks : List Landmark) (stay : Option StayShape) (priors : Option VenuePriors) :
    List VenueCandidateScore :=
  let eligible := landmarks.filter (fun l => !isFurniture l)
  -- Degenerate input (everything is street furniture): better to rank the
  -- furniture than to return nothing — callers rely on non-empty in.
  let pool := if eligible.isEmpty then landmarks else eligible
  let isNearField := fun (l : Landmark) =>
    if l.reverseGeocoded || !isVenueType l || decide (l.distanceM > NEAR_FIELD_DECISIVE_M) then false
    else match (if stay.isSome then hoursScore l.openFraction else none) with
         | none => true
         | some h => decide (h ≥ 0)
  let scored := pool.map (fun l =>
    let distance := -0.5 * (l.distanceM / DISTANCE_SIGMA_M) ^ 2
    let venue := if isVenueType l then VENUE_OVER_AREA_NATS else 0
    let shape := match stay, priors with
                 | some s, some p => if PRIOR_TYPES.contains l.type then some (shapeScore l.subtype s p) else none
                 | _, _ => none
    let hours := if stay.isSome then hoursScore l.openFraction else none
    ({ landmark := l,
       total := distance + venue + shape.getD 0 + hours.getD 0,
       parts := ⟨distance, venue, shape, hours⟩,
       nearField := isNearField l } : VenueCandidateScore))
  sortStable (fun a b =>
    let ea := a.landmark.enclosing
    let eb := b.landmark.enclosing
    if ea != eb then ea
    else
      let na := a.nearField
      let nb := b.nearField
      if na != nb then na
      -- Two near-field venues: the nearer one is what you are sitting on.
      else if na && nb && a.landmark.distanceM != b.landmark.distanceM then
        decide (a.landmark.distanceM < b.landmark.distanceM)
      else if a.total != b.total then decide (a.total > b.total)
      else if a.landmark.distanceM != b.landmark.distanceM then
        decide (a.landmark.distanceM < b.landmark.distanceM)
      else decide (collateAscii a.landmark.name b.landmark.name < 0)) scored

/-! ## Attribution -/

private def sortByDistance (xs : List Landmark) : List Landmark :=
  let rec ins (x : Landmark) : List Landmark → List Landmark
    | [] => [x]
    | y :: ys => if decide (x.distanceM < y.distanceM) then x :: y :: ys else y :: ins x ys
  xs.foldl (fun acc x => ins x acc) []

/--
The venue this stay is unambiguously at, or `none`.

A stay trains the prior only when ONE venue is geometrically unambiguous:
close enough to be "at" (≤30 m, the urban building-footprint scale) and clear
of the runner-up by a margin GPS noise cannot flip (20 m). Everything else is
exactly the ambiguity the scorer must PREDICT — training on a guess there
would launder the old picker's mistakes into the prior.
-/
def attributeStayVenue (landmarks : List Landmark) : Option Landmark :=
  let venues := sortByDistance (landmarks.filter (fun l => isVenueType l && !isFurniture l))
  match venues with
  | [] => none
  | top :: _ =>
    if decide (top.distanceM > ATTRIBUTION_MAX_DIST_M) then none
    else match venues.find? (fun l => l.name != top.name) with
         | some next => if decide (next.distanceM < top.distanceM + ATTRIBUTION_MARGIN_M) then none else some top
         | none => some top

/-! ## Soft attribution -/

/-- How much of one stay each candidate venue may claim. -/
structure StayResponsibilities where
  candidates : List (Landmark × Float)
  /-- Mass assigned to "none of these" — the true venue is unmapped or absent. -/
  other : Float
  deriving Inhabited

/--
Fractional attribution: given the evidence, the probability this stay happened
at each candidate, summing to 1 across candidates PLUS `other`.

Deliberately uses every term `rankVenues` knows EXCEPT the shape prior —
feeding the shape prior into the weights that train the shape prior is a
self-confirming loop. Near-field dominance is likewise NOT applied: it is a
ranking shortcut, not a probability, and would hand a whole stay to whichever
venue happens to be nearest.
-/
def stayResponsibilities (landmarks : List Landmark) (stay : Option StayShape) : StayResponsibilities :=
  let pool := landmarks.filter (fun l => isVenueType l && !isFurniture l && !l.reverseGeocoded)
  let scores := pool.map (fun l =>
    let distance := -0.5 * (l.distanceM / DISTANCE_SIGMA_M) ^ 2
    let hours := if stay.isSome then (hoursScore l.openFraction).getD 0 else 0
    (l, distance + VENUE_OVER_AREA_NATS + hours))
  -- Softmax over the candidates plus `other`, in the numerically safe form.
  let logits := scores.map (·.2) ++ [OTHER_COMPONENT_NATS]
  let maxL := logits.foldl (fun a b => max a b) (logits.headD 0)
  let exps := logits.map (fun s => Float.exp (s - maxL))
  let z := exps.foldl (fun a b => a + b) 0
  { candidates := (scores.zip exps).map (fun ((l, _), e) => (l, e / z)),
    other := (exps.getLastD 0) / z }

/-- Effective sample size of a soft-attributed training set: how many whole
    visits' worth of evidence it carries, excluding the `other` mass. -/
def effectiveSampleSize (stays : List StayResponsibilities) : Float :=
  stays.foldl (fun n s => n + s.candidates.foldl (fun m c => m + c.2) 0) 0

/-! ## Mining -/

private def emptyStats : VenueTypeStats :=
  ⟨0, List.replicate DWELL_BUCKETS 0, List.replicate 24 0⟩

private def bumpAt (xs : List Float) (i : Nat) (by_ : Float) : List Float :=
  xs.zipIdx.map (fun (v, j) => if j == i then v + by_ else v)

/-- Add `r` visits' worth of mass at `(bucket, hour)` to `key`, appending a
    fresh entry when absent — preserving insertion order like the JS object. -/
private def bumpStats (tbl : List (String × VenueTypeStats)) (key : String)
    (bucket hour : Nat) (r : Float) : List (String × VenueTypeStats) :=
  if tbl.any (fun (k, _) => k == key) then
    tbl.map (fun (k, s) =>
      if k == key then (k, ⟨s.visits + r, bumpAt s.dwell bucket r, bumpAt s.hours hour r⟩) else (k, s))
  else
    tbl ++ [(key, ⟨r, bumpAt emptyStats.dwell bucket r, bumpAt emptyStats.hours hour r⟩)]

/-- One attributed training stay. -/
structure AttributedStay where
  subtype : String
  durationSec : Float
  /-- Local hour of the stay midpoint; negatives wrap (`-3` ⇒ 21). -/
  localHour : Int
  deriving Inhabited

/-- Aggregate attributed stays into the priors blob. Pure counting — every
    number in the result is mined, none authored. -/
def minePriors (stays : List AttributedStay) : VenuePriors := Id.run do
  let mut bySubtype : List (String × VenueTypeStats) := []
  let mut byCategory : List (String × VenueTypeStats) := []
  for stay in stays do
    let bucket := dwellBucket stay.durationSec
    let hour := (stay.localHour.emod 24).toNat
    bySubtype := bumpStats bySubtype stay.subtype bucket hour 1
    byCategory := bumpStats byCategory (categoryOfSubtype stay.subtype) bucket hour 1
  return ⟨bySubtype, byCategory, Float.ofNat stays.length⟩

/-- One stay, with the mass each candidate venue may claim of it. -/
structure SoftAttributedStay where
  responsibilities : StayResponsibilities
  durationSec : Float
  localHour : Int
  deriving Inhabited

/--
Mine the visit-shape prior from FRACTIONAL counts. Identical in structure to
{@link minePriors} — same buckets, same category pooling, same output shape —
but each stay contributes `r` of a visit to each candidate instead of 1 to the
argmax and 0 to everyone else. That is the whole point: the hard gate discards
a stay unless one venue is 20 m clear of its neighbours, which never happens
on a dense high street, which is where cafés are.
-/
def minePriorsSoft (stays : List SoftAttributedStay) : VenuePriors := Id.run do
  let mut bySubtype : List (String × VenueTypeStats) := []
  let mut byCategory : List (String × VenueTypeStats) := []
  let mut total : Float := 0
  for stay in stays do
    let bucket := dwellBucket stay.durationSec
    let hour := (stay.localHour.emod 24).toNat
    for (landmark, r) in stay.responsibilities.candidates do
      if decide (r ≤ 0) then continue
      bySubtype := bumpStats bySubtype landmark.subtype bucket hour r
      byCategory := bumpStats byCategory (categoryOfSubtype landmark.subtype) bucket hour r
      total := total + r
  return ⟨bySubtype, byCategory, total⟩

/-! ## Parity with Node/V8 (`lean/experiments/venue-prior-refs.mts`) -/

private def approx (a b : Float) : Bool := Float.abs (a - b) < 1e-9
private def approxO : Option Float → Option Float → Bool
  | none, none => true
  | some a, some b => approx a b
  | _, _ => false

/-! ### Helpers -/

#guard dwellBucket 0 == 0
#guard dwellBucket 59 == 0
#guard dwellBucket 600 == 1
#guard dwellBucket 601 == 1
#guard dwellBucket 2400 == 2
#guard dwellBucket 2401 == 2
#guard dwellBucket 9000 == 3
#guard dwellBucket 100000 == 3
#guard categoryOfSubtype "restaurant" == "food"
#guard categoryOfSubtype "hotel" == "lodging"
#guard categoryOfSubtype "cinema" == "leisure"
#guard categoryOfSubtype "pharmacy" == "errand"
#guard categoryOfSubtype "hospital" == "institution"
#guard categoryOfSubtype "station" == "transport"
#guard categoryOfSubtype "wormhole" == "other"
#guard categoryOfSubtype "park" == "leisure"

/-! ### ASCII collation -/

#guard collateAscii "a" "B" == -1
#guard collateAscii "B" "a" == 1
#guard collateAscii "Apple" "apple" == 1
#guard collateAscii "apple" "Apple" == -1
#guard collateAscii "The Library" "Urban Social" == -1
#guard collateAscii "Zebra" "apple" == 1
#guard collateAscii "Beta" "Zebra" == -1
#guard collateAscii "10 Downing" "2 Downing" == -1
#guard collateAscii "cafe" "cafe" == 0
-- Punctuation < digits < letters, which is NOT codepoint order.
#guard collateAscii "A" "1" == 1
#guard collateAscii "1" "A" == -1
#guard collateAscii "A" "_" == 1
#guard collateAscii "_" "A" == -1
#guard collateAscii "Cafe Rouge" "Cafe-Rouge" == -1
#guard collateAscii "St. Pancras" "St Pancras" == 1
#guard collateAscii "St Pancras" "StPancras" == -1
#guard collateAscii "a b" "ab" == -1
#guard collateAscii "a" "a " == -1
#guard collateAscii "Co-op" "Coop" == -1
#guard collateAscii "O'Neill" "ONeill" == -1
#guard collateAscii "3" "10" == 1
#guard collateAscii "Z" "a" == 1
#guard collateAscii "z" "A" == 1

/-! ### `rankVenues`: distance + venue only -/

private def LM (name type subtype : String) (d : Float) : Landmark := ⟨name, type, subtype, d, none, false, false⟩
private def names (cs : List VenueCandidateScore) : List String := cs.map (·.landmark.name)

-- A venue beats an area at comparable distance...
#guard names (rankVenues [LM "Cafe" "amenity" "cafe" 30, LM "Park" "leisure" "park" 10] none none)
       == ["Cafe", "Park"]
-- ...but not across a big distance gap.
#guard names (rankVenues [LM "Cafe" "amenity" "cafe" 95, LM "Park" "leisure" "park" 5] none none)
       == ["Park", "Cafe"]
#guard match rankVenues [LM "Cafe" "amenity" "cafe" 30, LM "Park" "leisure" "park" 10] none none with
       | c :: p :: [] => approx c.total 1.21875 && approx c.parts.distance (-0.28125)
                         && approx p.total (-0.03125) && c.parts.venue == 1.5 && p.parts.venue == 0
                         && c.parts.shape == none && c.parts.hours == none
       | _ => false

-- An enclosing institution outranks a near point venue despite a lower total.
#guard names (rankVenues [⟨"Clinic", "amenity", "clinic", 40, none, true, false⟩,
                          LM "Kiosk" "shop" "kiosk" 3] none none) == ["Clinic", "Kiosk"]
-- Near-field dominance: 8 m beats 28 m.
#guard names (rankVenues [LM "Cafe" "amenity" "cafe" 28, LM "Clinic" "amenity" "clinic" 8] none none)
       == ["Clinic", "Cafe"]
-- Two near-field venues: the nearer wins.
#guard names (rankVenues [LM "Far" "amenity" "cafe" 11, LM "Near" "shop" "bakery" 4] none none)
       == ["Near", "Far"]
-- A reverse-geocoded candidate never qualifies for near-field, so the
-- genuinely-measured 9 m venue outranks it despite a lower total.
#guard names (rankVenues [⟨"Geocoded", "amenity", "restaurant", 0, none, false, true⟩,
                          LM "Real" "amenity" "cafe" 9] none none) == ["Real", "Geocoded"]
-- Street furniture is filtered out of the pool entirely...
#guard names (rankVenues [LM "Post Box" "amenity" "post_box" 2, LM "Cafe" "amenity" "cafe" 45] none none)
       == ["Cafe"]
-- ...unless it is all there is.
#guard names (rankVenues [LM "Post Box" "amenity" "post_box" 2] none none) == ["Post Box"]
-- A three-way tie on total AND distance falls through to name collation.
#guard names (rankVenues [LM "Zebra" "amenity" "cafe" 20, LM "apple" "amenity" "cafe" 20,
                          LM "Beta" "amenity" "cafe" 20] none none) == ["apple", "Beta", "Zebra"]

/-! ### `rankVenues`: opening hours

The stay is a Tuesday-evening meal-length sit; the shell resolved each
candidate's open fraction (1 = open throughout, 0 = closed throughout). -/

private def stayEve : StayShape := ⟨1778688000, 1778692440, 19⟩
private def LMH (name type subtype : String) (d : Float) (frac : Option Float) : Landmark :=
  ⟨name, type, subtype, d, frac, false, false⟩

#guard names (rankVenues [LMH "OpenResto" "amenity" "restaurant" 32 (some 1),
                          LMH "ClosedPharm" "amenity" "pharmacy" 18 (some 0)] (some stayEve) none)
       == ["OpenResto", "ClosedPharm"]
#guard match rankVenues [LMH "OpenResto" "amenity" "restaurant" 32 (some 1),
                         LMH "ClosedPharm" "amenity" "pharmacy" 18 (some 0)] (some stayEve) none with
       | o :: c :: [] => approx o.total 1.8800000000000001 && approxO o.parts.hours (some 0.7)
                         && approx c.total (-1.1012500000000001) && approxO c.parts.hours (some (-2.5))
       | _ => false
-- A venue OSM says is CLOSED forfeits near-field dominance at 8 m.
#guard names (rankVenues [LMH "ClosedPharm" "amenity" "pharmacy" 8 (some 0),
                          LMH "OpenResto" "amenity" "restaurant" 32 (some 1)] (some stayEve) none)
       == ["OpenResto", "ClosedPharm"]
#guard match rankVenues [LMH "ClosedPharm" "amenity" "pharmacy" 8 (some 0),
                         LMH "OpenResto" "amenity" "restaurant" 32 (some 1)] (some stayEve) none with
       | _ :: c :: [] => c.nearField == false && approx c.total (-1.02)
       | _ => false
-- An unparseable tag is NO evidence (the shell passes `none`), not "closed".
#guard match rankVenues [LMH "Odd" "amenity" "cafe" 25 none] (some stayEve) none with
       | [c] => c.parts.hours == none && approx c.total 1.3046875 && c.nearField == false
       | _ => false
-- Partial overlap interpolates between the closed and open weights.
#guard match rankVenues [LMH "Half" "amenity" "bar" 25 (some 0.5)] (some stayEve) none with
       | [c] => approx c.total 0.40468750000000009 && approxO c.parts.hours (some (-0.9))
       | _ => false

/-! ### Mining + the shape term -/

private def attributed : List AttributedStay :=
  [⟨"cafe", 1800, 10⟩, ⟨"cafe", 3600, 11⟩, ⟨"restaurant", 4800, 19⟩, ⟨"restaurant", 5400, 20⟩,
   ⟨"restaurant", 300, 13⟩, ⟨"pharmacy", 400, 14⟩, ⟨"hospital", 12000, 9⟩]
private def priors : VenuePriors := minePriors attributed

#guard priors.totalVisits == 7
#guard priors.bySubtype.map (·.1) == ["cafe", "restaurant", "pharmacy", "hospital"]
#guard priors.byCategory.map (·.1) == ["food", "errand", "institution"]
#guard match lookupStats priors.bySubtype "cafe" with
       | some s => s.visits == 2 && s.dwell == [0, 1, 1, 0] && s.hours.getD 10 0 == 1 && s.hours.getD 11 0 == 1
       | none => false
#guard match lookupStats priors.bySubtype "restaurant" with
       | some s => s.visits == 3 && s.dwell == [1, 0, 2, 0]
       | none => false
#guard match lookupStats priors.byCategory "food" with
       | some s => s.visits == 5 && s.dwell == [1, 1, 3, 0]
       | none => false
-- A negative local hour wraps into the 24-hour ring.
#guard match lookupStats (minePriors [⟨"cafe", 60, -3⟩]).bySubtype "cafe" with
       | some s => s.hours.getD 21 0 == 1
       | none => false

-- The prior is what separates a meal-length evening restaurant from a pharmacy.
#guard names (rankVenues [LM "Resto" "amenity" "restaurant" 32, LM "Pharm" "amenity" "pharmacy" 30]
              (some stayEve) (some priors)) == ["Resto", "Pharm"]
#guard match rankVenues [LM "Resto" "amenity" "restaurant" 32, LM "Pharm" "amenity" "pharmacy" 30]
                        (some stayEve) (some priors) with
       | r :: p :: [] => approx r.total 4.0074564179367780 && approxO r.parts.shape (some 2.8274564179367783)
                         && approx p.total 0.67715271756725559
                         && approxO p.parts.shape (some (-0.54159728243274441))
       | _ => false
-- An unseen subtype backs off to its category pool; a categoryless one to uniform.
#guard match rankVenues [LM "Bar" "amenity" "bar" 30, LM "Wormhole" "amenity" "wormhole" 30]
                        (some stayEve) (some priors) with
       | b :: w :: [] => approxO b.parts.shape (some 0.46454977856327173)
                         && approxO w.parts.shape (some (-1.0116009116784799))
       | _ => false
-- THE load-bearing property: empty priors contribute exactly 0, everywhere.
#guard match rankVenues [LM "Resto" "amenity" "restaurant" 30] (some stayEve) (some ⟨[], [], 0⟩) with
       | [c] => c.parts.shape == some 0 && approx c.total 1.21875
       | _ => false
-- `leisure` participates in the prior; `place` names an area and does not.
#guard match rankVenues [LM "Park" "leisure" "park" 30, LM "Square" "place" "square" 30]
                        (some stayEve) (some priors) with
       | s :: p :: [] => s.landmark.name == "Square" && s.parts.shape == none
                         && p.landmark.name == "Park" && approxO p.parts.shape (some (-1.0116009116784799))
       | _ => false

/-! ### `attributeStayVenue` -/

#guard (attributeStayVenue [LM "Cafe" "amenity" "cafe" 10, LM "Shop" "shop" "books" 60]).map (·.name)
       == some "Cafe"
-- The runner-up is inside the 20 m margin ⇒ ambiguous ⇒ trains nothing.
#guard (attributeStayVenue [LM "Cafe" "amenity" "cafe" 10, LM "Shop" "shop" "books" 25]).isNone
#guard (attributeStayVenue [LM "Cafe" "amenity" "cafe" 35, LM "Shop" "shop" "books" 90]).isNone
-- Both gates are inclusive at the boundary.
#guard (attributeStayVenue [LM "Cafe" "amenity" "cafe" 30, LM "Shop" "shop" "books" 50]).map (·.name)
       == some "Cafe"
#guard (attributeStayVenue [LM "Cafe" "amenity" "cafe" 10, LM "Shop" "shop" "books" 30]).map (·.name)
       == some "Cafe"
-- The margin is measured against the nearest DIFFERENTLY-NAMED venue, so a
-- duplicate mapping of the same place does not defeat attribution.
#guard (attributeStayVenue [LM "Cafe" "amenity" "cafe" 10, LM "Cafe" "shop" "bakery" 12,
                            LM "Other" "shop" "books" 80]).map (·.name) == some "Cafe"
#guard (attributeStayVenue [LM "Park" "leisure" "park" 5]).isNone
#guard (attributeStayVenue [LM "Post Box" "amenity" "post_box" 5]).isNone
#guard (attributeStayVenue []).isNone

/-! ### `isLabelWorthyVenue` -/

#guard isLabelWorthyVenue "amenity" 10
#guard isLabelWorthyVenue "tourism" 10
#guard isLabelWorthyVenue "shop" 10
-- ⚠ `leisure` is a PRIOR type but not a VOTE type: a park names an area, and
-- the two lists differ by exactly this entry.
#guard !isLabelWorthyVenue "leisure" 10
#guard !isLabelWorthyVenue "place" 1
#guard !isLabelWorthyVenue "highway" 1
-- Inclusive at 50 m, and the metre past it fails.
#guard isLabelWorthyVenue "amenity" 50
#guard !isLabelWorthyVenue "amenity" 51
-- The café 80 m off from the module note.
#guard !isLabelWorthyVenue "amenity" 80

/-! ### `stayResponsibilities` -/

private def rs (lms : List Landmark) : StayResponsibilities := stayResponsibilities lms none

#guard match rs [LM "A" "amenity" "cafe" 10, LM "B" "amenity" "restaurant" 15] with
       | r => approx (r.candidates.getD 0 (default, 0)).2 0.49675665563383314
              && approx (r.candidates.getD 1 (default, 0)).2 0.47772620700800006
              && approx r.other 0.025517137358166731
#guard approx (effectiveSampleSize [rs [LM "A" "amenity" "cafe" 10, LM "B" "amenity" "restaurant" 15]])
       0.97448286264183315
-- A lone far venue only just out-argues "the truth is not in this list".
#guard match rs [LM "A" "amenity" "cafe" 95] with
       | r => approx (r.candidates.getD 0 (default, 0)).2 0.54480139569827812
              && approx r.other 0.45519860430172188
-- No candidates ⇒ all mass to `other`, and the stay teaches nothing.
#guard (rs []).other == 1
#guard effectiveSampleSize [rs []] == 0
#guard (rs [LM "Park" "leisure" "park" 5, LM "Box" "amenity" "post_box" 3]).other == 1
-- A dense high street spreads the mass — which is exactly the case the hard
-- gate throws away entirely.
#guard match rs [LM "A" "amenity" "cafe" 8, LM "B" "amenity" "restaurant" 12,
                 LM "C" "shop" "clothes" 16, LM "D" "amenity" "bar" 20] with
       | r => approx (r.candidates.getD 0 (default, 0)).2 0.25851872171035656
              && approx (r.candidates.getD 3 (default, 0)).2 0.23275074470348844
              && approx r.other 0.013130898482800071
-- Closed hours discount a candidate without vetoing it.
#guard match stayResponsibilities [LMH "Open" "amenity" "restaurant" 20 (some 1),
                                   LMH "Closed" "amenity" "pharmacy" 20 (some 0)] (some stayEve) with
       | r => approx (r.candidates.getD 0 (default, 0)).2 0.93564832586502644
              && approx (r.candidates.getD 1 (default, 0)).2 0.038139087910927058
              && approx r.other 0.026212586224046548

/-! ### `minePriorsSoft` -/

private def soft : VenuePriors := minePriorsSoft
  [⟨rs [LM "A" "amenity" "cafe" 10, LM "B" "amenity" "restaurant" 15], 3600, 11⟩,
   ⟨rs [LM "C" "amenity" "cafe" 20], 5400, 19⟩]

#guard approx soft.totalVisits 1.9210795328420089
#guard match lookupStats soft.bySubtype "cafe" with
       | some s => approx s.visits 1.4433533258340088 && approx (s.dwell.getD 2 0) 1.4433533258340088
       | none => false
#guard match lookupStats soft.bySubtype "restaurant" with
       | some s => approx s.visits 0.47772620700800006
       | none => false
#guard match lookupStats soft.byCategory "food" with
       | some s => approx s.visits 1.9210795328420089
       | none => false

end Verified.Geo.VenuePrior
