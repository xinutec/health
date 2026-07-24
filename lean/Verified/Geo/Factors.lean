import Verified.Geo.Segments
import Verified.Geo.ModeBiometrics
/-!
# Factor-decomposed mode scoring (port of `src/geo/factors/`)

The per-segment scoring layer of the decoder architecture. Each factor is a
pure function from a `Candidate` (one alternative interpretation of a segment)
and a `Ctx` (everything a factor might consult) to a log-likelihood in nats,
or `none`.

**`none` is not zero.** It means "this factor has nothing to say about this
candidate" — a missing per-user biometric signature must not dock a mode's
score, only a clearly-disagreeing one may. {@link scoreCandidates} drops `none`
contributions from the breakdown entirely rather than summing them as 0, so the
distinction survives into the explanation UI.

Ported: the six factors and the aggregator. The `rationale` display string each
TS factor also returns stays SHELL — same split as `classifyCluster.reason` and
`refinedReason`. Only `name` and `score` drive any decision.

## Two float behaviours that the obvious transcription gets wrong

* **The aggregator's comparator can return `NaN`.** When two candidates both
  total `-∞` (a factor ruled both out), `b.total - a.total` is `NaN`.
  ECMAScript specifies that a `NaN` comparator result is treated as `+0`, so
  the wayName tie-break NEVER RUNS for such a pair and the input order is
  preserved. Writing "if the scores are equal, prefer the labelled way" would
  silently disagree. Modelled here by comparing `cmp x y < 0`, which is `false`
  for `NaN` in both directions and so degrades to the stable order.
* **`margin` is `NaN`, not `0`, for that same pair** — it is computed as
  `best.total - alternatives[0].total`. Pinned by guard.

Exactness: every factor is arithmetic and comparison over already-computed
inputs ⇒ EXACT, except the `log` in `osm-distance`, `classifier-prior`,
`rail-corridor` and the `windowFeatures` arm of `speed-emission`, which are
≤1 ULP. UNPROVEN; pinned against Node/V8
(`lean/experiments/factors-refs.mts`).
-/

namespace Verified.Geo.Factors

open Verified.Geo.Segments (WindowFeatures ModeScore scoreWindow)
open Verified.Geo.ModeBiometrics (MinuteObservation ModeStats scoreModeLogLikelihood)

private def negInf : Float := -(1.0 / 0.0)
private def posInf : Float := 1.0 / 0.0

/-! ## Shapes -/

/-- One candidate interpretation of a segment. -/
structure Candidate where
  mode : String
  /-- Road name, line name, or station-pair label. -/
  wayName : Option String := none
  /-- Distance from the GPS trajectory to this candidate's chosen way. -/
  wayDistanceM : Option Float := none
  /-- OSM subtype in OSM's own vocabulary (`motorway`, `footway`, `subway`, …). -/
  waySubtype : Option String := none
  deriving Inhabited, BEq, Repr

/-- Everything a factor might consult; each field optional because most factors
    need only a few, and a factor returns `none` when its inputs are absent. -/
structure Ctx where
  windowFeatures : Option WindowFeatures := none
  /-- Coarse fallback when the full feature set lives upstream. -/
  speedKmh : Option Float := none
  biometricObs : Option MinuteObservation := none
  modeStats : Option (List ModeStats) := none
  /-- The pre-refinement mode the GPS-feature classifier chose. -/
  originalMode : Option String := none
  /-- The classifier's top-to-runner-up RATIO (not a delta in nats). -/
  confidenceMargin : Option Float := none
  /-- Mean distance to the nearest rail-only way; `none` = none in range. -/
  meanRailDistM : Option Float := none
  /-- Companion to {@link meanRailDistM} for the rail-vs-road log-ratio. -/
  meanDrivableRoadDistM : Option Float := none
  deriving Inhabited

/-- A factor's contribution. The TS also carries a `rationale` string; that is
    display and stays shell. -/
structure FactorScore where
  name : String
  score : Float
  deriving Inhabited, BEq, Repr

abbrev Factor := Candidate → Ctx → Option FactorScore

/-! ## mode-prior -/

/-- Fixed per-mode log-priors capturing the asymmetric flip rules the legacy
    cascade enforced as hard gates. Cycling is the only entry: the cascade
    blocked relabelling INTO cycling outright; as a soft prior of −4 nats, a
    confidently-cycling original with biometric agreement (~+5 nats combined)
    still needs ~+1 nat of independent evidence to actually win.

    Returns `none` for modes without a prior — "no prior is set" is meaningfully
    different from "the prior is zero". -/
def modePrior : Factor := fun c _ =>
  if c.mode == "cycling" then some ⟨"mode-prior", -4⟩ else none

/-! ## osm-distance -/

private def OSM_REFERENCE_M : Float := 25
private def OSM_MIN_M : Float := 1

/-- `-log(max(d, 1) / 25)` nats. Zero at the 25 m reference — calibrated so a
    way-attached candidate at typical urban GPS offset is a fair tie with the
    no-way fallback (which contributes nothing), rather than the asymmetric
    free pass a 10 m reference gave it. The 1 m floor stops `d = 0` from
    producing `+∞` and dominating the sum. -/
def osmDistance : Factor := fun c _ =>
  match c.wayDistanceM with
  | none => none
  | some d =>
    if !d.isFinite then none
    else some ⟨"osm-distance", -(Float.log (max d OSM_MIN_M / OSM_REFERENCE_M))⟩

/-! ## mode-coherence -/

private def PEDESTRIAN_HIGHWAY : List String :=
  ["footway", "path", "pedestrian", "cycleway", "bridleway", "steps"]
private def DRIVEABLE_HIGHWAY : List String :=
  ["motorway", "trunk", "primary", "secondary", "tertiary", "residential",
   "service", "unclassified", "track", "living_street"]
private def MAJOR_HIGHWAY : List String := ["motorway", "trunk", "primary", "secondary"]
private def RAIL_SUBTYPES : List String :=
  ["rail", "subway", "light_rail", "tram", "monorail", "narrow_gauge"]
private def AEROWAY : List String := ["runway", "taxiway", "aerodrome", "terminal"]

/-- Per-mode rule over the way subtype. `none` means "this rule has no opinion
    on that subtype" (distinct from a score of 0). -/
private def coherenceRule (mode subtype : String) : Option (Option Float) :=
  if mode == "driving" then some (
    if PEDESTRIAN_HIGHWAY.contains subtype then some (-1.5)
    else if MAJOR_HIGHWAY.contains subtype then some 1.0
    else if DRIVEABLE_HIGHWAY.contains subtype then some 0.3
    else none)
  else if mode == "walking" then some (
    if PEDESTRIAN_HIGHWAY.contains subtype then some 1.0
    else if MAJOR_HIGHWAY.contains subtype then some (-1.5)
    else if DRIVEABLE_HIGHWAY.contains subtype then some 0.0
    else none)
  else if mode == "cycling" then some (
    if subtype == "cycleway" then some 1.5
    else if PEDESTRIAN_HIGHWAY.contains subtype then some (-0.5)
    else if subtype == "motorway" || subtype == "trunk" then some (-2.0)
    else if DRIVEABLE_HIGHWAY.contains subtype then some 0.0
    else none)
  else if mode == "train" then some (
    if RAIL_SUBTYPES.contains subtype then some 1.5 else some (-3.0))
  else if mode == "plane" then some (
    if AEROWAY.contains subtype then some 1.5 else some (-3.0))
  else if mode == "stationary" then some none  -- rule exists, but never opines
  else none                                     -- no rule for this mode at all

/--
Compatibility of a candidate's mode with its way subtype — the scoring-era
replacement for the cascade's `pickBestHighway`. `osm-distance` favours the
closest way regardless of class, and in dense urban areas a footway is often
5–10 m closer than the real road, so on its own it would label fast driving as
"near footway".

Note the two distinct zero cases, both of which the TS returns as a real
contribution rather than `none`: an unknown subtype under a known mode, and a
mode with no rule at all. Only a MISSING (or empty) subtype yields `none`.
-/
def modeCoherence : Factor := fun c _ =>
  match c.waySubtype with
  | none => none
  | some s =>
    if s.isEmpty then none  -- JS `!subtype` is also true for ""
    else match coherenceRule c.mode s with
      | none => some ⟨"mode-coherence", 0⟩        -- no rule for this mode
      | some none => some ⟨"mode-coherence", 0⟩   -- rule has no opinion
      | some (some v) => some ⟨"mode-coherence", v⟩

/-! ## classifier-prior -/

private def MIN_MARGIN_RATIO : Float := 2
private def CLASSIFIER_K : Float := 1.5
private def MAX_BONUS_NATS : Float := 4

/--
Soft replacement for the cascade's `RELABEL_MAX_MARGIN` gate: when the upstream
GPS-feature classifier chose the original mode by a comfortable margin,
biometric evidence alone should not flip it.

`confidenceMargin` is a RATIO, not a delta in nats — 1 is a coin flip. Scoring
linearly on the ratio over-fired on genuinely ambiguous underground sections
(margin 1.2) and locked tube trips as walking; log-of-ratio above a floor
preserves the "only protect confident classifications" intent. The floor is
EXCLUSIVE: margin exactly 2 yields `none`.

Unidirectional — `none` for any candidate whose mode differs from the original.
There is no anti-bonus; other factors carry evidence against alternatives.
-/
def classifierPrior : Factor := fun c ctx =>
  match ctx.originalMode, ctx.confidenceMargin with
  | some om, some m =>
    if m ≤ MIN_MARGIN_RATIO then none
    else if c.mode != om then none
    else some ⟨"classifier-prior",
               min (CLASSIFIER_K * Float.log (m / MIN_MARGIN_RATIO)) MAX_BONUS_NATS⟩
  | _, _ => none

/-! ## rail-corridor -/

private def RAIL_REFERENCE_M : Float := 25

/--
Discriminates train from driving by the ratio of mean fix-distance to rail
versus to drivable road. `osm-distance` scores each candidate against the
nearest way of its OWN kind and so never compares the modes against each other;
a trajectory 2 m off the Jubilee Line and 40 m off a parallel road produces a
good score for both. This adds the relative-proximity signal directly.

Symmetric: a road-hugging trajectory penalises train by exactly what it bonuses
driving, so there is no unilateral bias. The 25 m offset keeps the ratio finite
as either distance approaches zero.

Computed as one `ratio` that is then negated for driving — NOT as two separate
logs, which would differ in the last ULP.
-/
def railCorridor : Factor := fun c ctx =>
  match ctx.meanRailDistM, ctx.meanDrivableRoadDistM with
  | some railD, some roadD =>
    if c.mode != "train" && c.mode != "driving" then none
    else
      let ratio := Float.log ((roadD + RAIL_REFERENCE_M) / (railD + RAIL_REFERENCE_M))
      some ⟨"rail-corridor", if c.mode == "train" then ratio else -ratio⟩
  | _, _ => none

/-! ## speed-emission -/

/-- Coarser per-mode log-likelihood from aggregate speed alone, for when the
    full `WindowFeatures` live upstream.

    The very-low-speed penalties for vehicular modes are −7, not the −2.5 they
    started at: a train sustaining 5 km/h for ten minutes is essentially
    impossible, but −2.5 let a tube line directly underfoot (osm-distance +3,
    mode-coherence +1.5) push a walking-speed segment to "train" through the
    additive sum. −7 puts it ~5 nats below anything the other factors can
    reach, which is what "essentially impossible" should look like in nats. -/
private def scoreFromSpeedOnly (mode : String) (kmh : Float) : Option Float :=
  if mode == "stationary" then
    some (if kmh < 2 then 0.5 else if kmh < 8 then -0.5 else -2.5)
  else if mode == "walking" then
    some (if kmh > 15 then -3.0 else if kmh ≥ 2 && kmh ≤ 8 then 0.5 else -0.5)
  else if mode == "cycling" then
    some (if kmh ≥ 10 && kmh ≤ 28 then 0.5 else if kmh > 40 then -2.0 else -0.5)
  else if mode == "driving" then
    some (if kmh > 25 then 1.0 else if kmh > 15 then 0.3 else if kmh > 8 then -0.5 else -7)
  else if mode == "train" then
    some (if kmh > 40 then 1.0 else if kmh > 15 then 0 else -7)
  else if mode == "plane" then
    some (if kmh > 200 then 1.5 else if kmh < 80 then -3.0 else 0)
  else none

/--
Wraps the existing `scoreWindow` Gaussian range-score as a log-likelihood.
Structural, not behavioural — it unpacks a computation that already existed.

`scoreWindow` returns multiplicative masses, so we take the log to make the
per-candidate sum additive. A mass of 0 becomes `-∞`, which the aggregator
treats as "ruled out" — that is the right behaviour, not a special case.
`windowFeatures` takes precedence over `speedKmh` when both are present.
-/
def speedEmission : Factor := fun c ctx =>
  match ctx.windowFeatures with
  | some wf =>
    match (scoreWindow wf).find? (fun s => s.mode == c.mode) with
    | none => none
    | some m =>
      some ⟨"speed-emission", if m.score > 0 then Float.log m.score else negInf⟩
  | none =>
    match ctx.speedKmh with
    | none => none
    | some kmh =>
      match scoreFromSpeedOnly c.mode kmh with
      | none => none
      | some s => some ⟨"speed-emission", s⟩

/-! ## biometric-ll -/

/--
Thin adapter around `scoreModeLogLikelihood`, which already returns nats under
the per-user Gaussian emissions.

A non-finite result means no modality contributed (every observation null, or
every matching stat null / zero-std). That is "no evidence", not "evidence
against", so it maps to `none` — a cold-start mode with no signature yet must
not be penalised. A FINITE negative value does penalise, and is kept.
-/
def biometricLL : Factor := fun c ctx =>
  match ctx.biometricObs, ctx.modeStats with
  | some obs, some stats =>
    match stats.find? (fun s => s.mode == c.mode) with
    | none => none
    | some st =>
      let score := scoreModeLogLikelihood obs st
      if !score.isFinite then none else some ⟨"biometric-ll", score⟩
  | _, _ => none

/-! ## Aggregator -/

/-- A candidate run through the factor stack. -/
structure ScoredCandidate where
  candidate : Candidate
  factors : List FactorScore
  totalScore : Float
  deriving Inhabited

structure ScoredRefinement where
  best : ScoredCandidate
  alternatives : List ScoredCandidate
  /-- `+∞` when there are no alternatives; `NaN` when the best and the
      runner-up are both `-∞`. -/
  margin : Float
  deriving Inhabited

/-- The TS comparator, verbatim: total descending, then prefer a candidate
    carrying a `wayName`. Returns a Float because it can be `NaN`. -/
private def cmpScored (a b : ScoredCandidate) : Float :=
  let byScore := b.totalScore - a.totalScore
  if byScore != 0 then byScore
  else
    let aHas : Float := if a.candidate.wayName.isSome then 1 else 0
    let bHas : Float := if b.candidate.wayName.isSome then 1 else 0
    bHas - aHas

/-- Stable insertion under `cmp x y < 0`. `NaN < 0` is `false` in both
    directions, so a `NaN` comparison degrades to "equal" and keeps input
    order — exactly what ECMAScript does with a `NaN` comparator result. -/
private def insertStable (x : ScoredCandidate) :
    List ScoredCandidate → List ScoredCandidate
  | [] => [x]
  | y :: ys => if cmpScored x y < 0 then x :: y :: ys else y :: insertStable x ys

private def sortStable (xs : List ScoredCandidate) : List ScoredCandidate :=
  xs.foldl (fun acc x => insertStable x acc) []

/--
Run every factor against every candidate, sum the non-`none` contributions, and
rank. The aggregator does NO candidate generation — the caller supplies
candidates and this scores them.

An empty candidate list is a programming error in the TS (it throws); here it
yields `none`, which the shell turns back into the throw.

The wayName tie-break exists because two candidates at identical distance — an
unnamed footway and a named footpath it overlaps — should resolve to the
labelled one: it is the more specific feature and the rendered timeline depends
on it for readability. Read the module header before touching it; it does not
fire when both totals are `-∞`.
-/
def scoreCandidates (candidates : List Candidate) (ctx : Ctx) (factors : List Factor) :
    Option ScoredRefinement :=
  if candidates.isEmpty then none else
  let scored := candidates.map (fun c =>
    let contributions := factors.filterMap (fun f => f c ctx)
    { candidate := c,
      factors := contributions,
      totalScore := contributions.foldl (fun acc s => acc + s.score) 0 : ScoredCandidate })
  match sortStable scored with
  | [] => none
  | best :: alts =>
    let margin := match alts with
      | [] => posInf
      | a :: _ => best.totalScore - a.totalScore
    some { best := best, alternatives := alts, margin := margin }

/-! ## Parity with Node/V8 (`lean/experiments/factors-refs.mts`) -/

private def approx (a b : Float) : Bool := Float.abs (a - b) < 1e-12
private def scoreOf : Option FactorScore → Option Float := Option.map (·.score)
private def approxO : Option Float → Option Float → Bool
  | none, none => true
  | some a, some b => (a == b) || approx a b
  | _, _ => false

private def C (mode : String) (wayName : Option String := none)
    (wayDistanceM : Option Float := none) (waySubtype : Option String := none) : Candidate :=
  { mode := mode, wayName := wayName, wayDistanceM := wayDistanceM, waySubtype := waySubtype }

/-! ### mode-prior -/

#guard scoreOf (modePrior (C "cycling") {}) == some (-4)
#guard modePrior (C "walking") {} == none
#guard modePrior (C "driving") {} == none
#guard modePrior (C "train") {} == none

/-! ### osm-distance -/

#guard osmDistance (C "driving") {} == none
-- The 1 m floor: 0, 0.5 and 1 all clamp to the same score.
#guard approxO (scoreOf (osmDistance (C "driving" (wayDistanceM := some 0)) {}))
  (some 3.2188758248682006)
#guard approxO (scoreOf (osmDistance (C "driving" (wayDistanceM := some 0.5)) {}))
  (some 3.2188758248682006)
#guard approxO (scoreOf (osmDistance (C "driving" (wayDistanceM := some 1)) {}))
  (some 3.2188758248682006)
#guard approxO (scoreOf (osmDistance (C "driving" (wayDistanceM := some 2)) {}))
  (some 2.5257286443082556)
#guard approxO (scoreOf (osmDistance (C "driving" (wayDistanceM := some 5)) {}))
  (some 1.6094379124341003)
-- Zero exactly at the reference distance.
#guard scoreOf (osmDistance (C "driving" (wayDistanceM := some 25)) {}) == some 0
#guard approxO (scoreOf (osmDistance (C "driving" (wayDistanceM := some 50)) {}))
  (some (-0.69314718055994529))
#guard approxO (scoreOf (osmDistance (C "driving" (wayDistanceM := some 100)) {}))
  (some (-1.3862943611198906))
-- Non-finite distances are "no measurement", not a score.
#guard osmDistance (C "driving" (wayDistanceM := some (0.0/0.0))) {} == none
#guard osmDistance (C "driving" (wayDistanceM := some posInf)) {} == none

/-! ### mode-coherence -/

private def mc (mode subtype : String) : Option Float :=
  scoreOf (modeCoherence (C mode (waySubtype := some subtype)) {})

#guard modeCoherence (C "driving") {} == none
-- JS `!subtype` is true for the empty string too.
#guard modeCoherence (C "driving" (waySubtype := some "")) {} == none
#guard mc "driving" "footway" == some (-1.5)
#guard mc "driving" "motorway" == some 1.0
#guard mc "driving" "tertiary" == some 0.3
#guard mc "walking" "footway" == some 1.0
#guard mc "walking" "primary" == some (-1.5)
#guard mc "walking" "residential" == some 0.0
#guard mc "cycling" "cycleway" == some 1.5
#guard mc "cycling" "footway" == some (-0.5)
#guard mc "cycling" "motorway" == some (-2.0)
#guard mc "cycling" "primary" == some 0.0
#guard mc "train" "subway" == some 1.5
#guard mc "train" "rail" == some 1.5
-- A train on anything that is not rail is wrong, whatever the distance.
#guard mc "train" "primary" == some (-3.0)
#guard mc "train" "footway" == some (-3.0)
#guard mc "plane" "runway" == some 1.5
#guard mc "plane" "rail" == some (-3.0)
-- Two distinct zero cases, both a real contribution rather than `none`:
-- a known mode on a subtype its rule ignores...
#guard mc "driving" "rail" == some 0.0
#guard mc "driving" "unknown_thing" == some 0.0
#guard mc "stationary" "footway" == some 0.0
-- ...and a mode with no rule at all.
#guard mc "boat" "river" == some 0.0

/-! ### classifier-prior -/

private def cp (mode : String) (om : Option String) (m : Option Float) : Option Float :=
  scoreOf (classifierPrior (C mode) { originalMode := om, confidenceMargin := m })

#guard cp "driving" none (some 5) == none
#guard cp "driving" (some "driving") none == none
-- Unidirectional: no anti-bonus on a different mode.
#guard cp "walking" (some "driving") (some 5) == none
-- The floor is EXCLUSIVE.
#guard cp "driving" (some "driving") (some 1) == none
#guard cp "driving" (some "driving") (some 2) == none
#guard approxO (cp "driving" (some "driving") (some 2.0001)) (some 0.000074998125062655926)
#guard approxO (cp "driving" (some "driving") (some 3)) (some 0.60819766216224658)
#guard approxO (cp "driving" (some "driving") (some 7.4)) (some 1.9624992294752683)
#guard approxO (cp "driving" (some "driving") (some 14)) (some 2.9188652235829697)
-- Saturates at the cap.
#guard cp "driving" (some "driving") (some 1000) == some 4.0

/-! ### rail-corridor -/

private def rc (mode : String) (rail road : Option Float) : Option Float :=
  scoreOf (railCorridor (C mode) { meanRailDistM := rail, meanDrivableRoadDistM := road })

#guard rc "train" none none == none
#guard rc "train" none (some 40) == none
#guard rc "train" (some 2) none == none
-- Only train and driving are in scope.
#guard rc "walking" (some 2) (some 40) == none
#guard approxO (rc "train" (some 2) (some 40)) (some 0.87855040389130812)
-- Symmetric: driving loses exactly what train gains on the same geometry.
#guard approxO (rc "driving" (some 2) (some 40)) (some (-0.87855040389130812))
#guard approxO (rc "train" (some 40) (some 2)) (some (-0.87855040389130801))
#guard rc "train" (some 10) (some 10) == some 0
#guard rc "train" (some 0) (some 0) == some 0
#guard approxO (rc "train" (some 0) (some 2500)) (some 4.6151205168412597)

/-! ### speed-emission (speed-only fallback) -/

private def se (mode : String) (kmh : Float) : Option Float :=
  scoreOf (speedEmission (C mode) { speedKmh := kmh })

#guard speedEmission (C "driving") {} == none
-- A mode with no speed-only rule contributes nothing.
#guard se "boat" 20 == none
#guard se "stationary" 1 == some 0.5
#guard se "stationary" 2 == some (-0.5)
#guard se "stationary" 8 == some (-2.5)
#guard se "walking" 2 == some 0.5
#guard se "walking" 8 == some 0.5
#guard se "walking" 8.5 == some (-0.5)
#guard se "walking" 15 == some (-0.5)
#guard se "walking" 15.5 == some (-3.0)
#guard se "cycling" 10 == some 0.5
#guard se "cycling" 28 == some 0.5
#guard se "cycling" 40 == some (-0.5)
#guard se "cycling" 40.5 == some (-2.0)
#guard se "driving" 8 == some (-7)
#guard se "driving" 8.5 == some (-0.5)
#guard se "driving" 15.5 == some 0.3
#guard se "driving" 25 == some 0.3
#guard se "driving" 25.5 == some 1.0
-- The −7 calibration: a walking-pace "train" must be essentially impossible,
-- so no combination of osm-distance + mode-coherence can rescue it.
#guard se "train" 5 == some (-7)
#guard se "train" 15 == some (-7)
#guard se "train" 15.5 == some 0
#guard se "train" 40 == some 0
#guard se "train" 40.5 == some 1.0
#guard se "plane" 80 == some 0
#guard se "plane" 200 == some 0
#guard se "plane" 250 == some 1.5

/-! ### speed-emission (windowFeatures arm) -/

private def wfWalk : WindowFeatures :=
  { medianSpeed := 4.5, maxSpeed := 7, speedVariance := 1.2, headingChangeRate := 20,
    linearity := 0.4, accelerationBursts := 0, stopFraction := 0.05,
    netDisplacement := 700, boundingRadius := 400 }
private def wfStill : WindowFeatures :=
  { medianSpeed := 0.2, maxSpeed := 1, speedVariance := 0.1, headingChangeRate := 0,
    linearity := 0.1, accelerationBursts := 0, stopFraction := 0.95,
    netDisplacement := 3, boundingRadius := 5 }

private def sew (mode : String) (wf : WindowFeatures) : Option Float :=
  scoreOf (speedEmission (C mode) { windowFeatures := wf })

#guard approxO (sew "walking" wfWalk) (some 2.3527563839094818)
#guard approxO (sew "stationary" wfWalk) (some (-4.4512098358305678))
#guard approxO (sew "cycling" wfWalk) (some (-2.1618781249999999))
#guard approxO (sew "driving" wfWalk) (some (-4.0598299909532294))
#guard approxO (sew "stationary" wfStill) (some 3.5493122415829315)
#guard approxO (sew "walking" wfStill) (some (-5.2142452276503679))
-- windowFeatures takes precedence over speedKmh when both are present.
#guard approxO
  (scoreOf (speedEmission (C "walking") { windowFeatures := wfWalk, speedKmh := some 99 }))
  (some 2.3527563839094818)

/-! ### biometric-ll -/

private def obs (hr cadence speed : Option Float) : MinuteObservation :=
  { hr := hr, cadence := cadence, speed := speed }
private def stDriving : ModeStats :=
  { mode := "driving", hrMean := some 100, hrStd := some 10, hrSampleCount := 100,
    cadenceMean := some 60, cadenceStd := some 15, cadenceSampleCount := 100,
    speedMean := some 20, speedStd := some 5, speedSampleCount := 100, sampleCount := 100 }

#guard biometricLL (C "driving") { modeStats := some [stDriving] } == none
#guard biometricLL (C "driving") { biometricObs := some (obs (some 100) (some 60) (some 20)) } == none
-- No signature for THIS mode: silence, not a penalty.
#guard biometricLL (C "train")
  { biometricObs := some (obs (some 100) (some 60) (some 20)), modeStats := some [stDriving] } == none
#guard scoreOf (biometricLL (C "driving")
  { biometricObs := some (obs (some 100) (some 60) (some 20)), modeStats := some [stDriving] })
  == some 0
#guard approxO (scoreOf (biometricLL (C "driving")
  { biometricObs := some (obs (some 110) (some 75) (some 25)), modeStats := some [stDriving] }))
  (some (-1.5))
-- An all-null observation contributes no modality ⇒ -∞ ⇒ "no evidence".
#guard biometricLL (C "driving")
  { biometricObs := some (obs none none none), modeStats := some [stDriving] } == none
#guard scoreOf (biometricLL (C "driving")
  { biometricObs := some (obs (some 100) none none), modeStats := some [stDriving] }) == some 0

/-! ### scoreCandidates -/

private def ALL : List Factor :=
  [speedEmission, osmDistance, modeCoherence, classifierPrior, railCorridor, modePrior, biometricLL]

private def bestMode (r : Option ScoredRefinement) : Option String :=
  r.map (·.best.candidate.mode)
private def bestWay (r : Option ScoredRefinement) : Option (Option String) :=
  r.map (·.best.candidate.wayName)
private def marginOf (r : Option ScoredRefinement) : Option Float := r.map (·.margin)

-- An empty candidate list is a programming error; the TS throws.
#guard (scoreCandidates [] {} ALL).isNone
-- A single candidate has an infinite margin.
#guard marginOf (scoreCandidates [C "driving" (wayDistanceM := some 25)]
  { speedKmh := some 30 } ALL) == some posInf

-- The wayName tie-break fires on equal scores, in BOTH input orders — so it is
-- the rule doing the work, not sort stability.
#guard bestWay (scoreCandidates
  [C "walking" (wayDistanceM := some 25),
   C "walking" (some "Queen's Walk") (some 25)] { speedKmh := some 4 } [osmDistance])
  == some (some "Queen's Walk")
#guard bestWay (scoreCandidates
  [C "walking" (some "Queen's Walk") (some 25),
   C "walking" (wayDistanceM := some 25)] { speedKmh := some 4 } [osmDistance])
  == some (some "Queen's Walk")
-- All-equal and all-unlabelled: input order survives.
#guard bestMode (scoreCandidates
  [C "walking" (wayDistanceM := some 25), C "driving" (wayDistanceM := some 25)] {} [osmDistance])
  == some "walking"

-- A tube line directly underfoot must NOT beat walking at walking pace: this is
-- what the −7 speed-emission calibration buys.
#guard bestMode (scoreCandidates
  [C "walking" (some "Marchmont St") (some 20) (some "footway"),
   C "train" (some "Piccadilly") (some 2) (some "subway")] { speedKmh := some 4.5 } ALL)
  == some "walking"
-- At vehicular speed the corridor ratio decides, and it is symmetric.
#guard bestMode (scoreCandidates
  [C "train" (some "Jubilee") (some 2) (some "subway"),
   C "driving" (some "A41") (some 40) (some "primary")]
  { speedKmh := some 45, meanRailDistM := some 2, meanDrivableRoadDistM := some 40 } ALL)
  == some "train"
#guard bestMode (scoreCandidates
  [C "train" (some "Jubilee") (some 40) (some "subway"),
   C "driving" (some "A41") (some 2) (some "primary")]
  { speedKmh := some 45, meanRailDistM := some 40, meanDrivableRoadDistM := some 2 } ALL)
  == some "driving"
-- The cycling prior holds even against a confident cycling original.
#guard bestMode (scoreCandidates
  [C "cycling" (wayDistanceM := some 25), C "driving" (wayDistanceM := some 25)]
  { speedKmh := some 20, originalMode := some "cycling", confidenceMargin := some 10 } ALL)
  == some "driving"

-- BOTH candidates -∞: the comparator computes NaN, ECMAScript treats it as 0,
-- so the wayName rule never runs and input order is preserved. The margin is
-- NaN, not 0. (`nan == nan` is false, hence `Float.isNaN`.)
private def negFactor : Factor := fun _ _ => some ⟨"neg", negInf⟩
#guard bestWay (scoreCandidates [C "walking", C "walking" (some "Named")] {} [negFactor])
  == some none
#guard bestWay (scoreCandidates [C "walking" (some "Named"), C "walking"] {} [negFactor])
  == some (some "Named")
#guard ((scoreCandidates [C "walking", C "walking" (some "Named")] {} [negFactor]).map
  (fun r => r.margin.isNaN)) == some true

end Verified.Geo.Factors
