---
created: 2026-07-07
status: active
references:
  - ../design/probabilistic-principles.md
  - ../design/episode-geometry.md
  - decoder-roadmap.md
---

# Geometry roadmap — one honest estimator draws the day's movement

This is the single forward plan for the positioning/geometry line of work:
what line the map draws for a moving leg, starting with walks. It replaces
five proposals that each described one slice of the same convergent thesis
(true-path-reconstruction, map-constrained-positioning,
continuous-field-walk-reconstruction, joint-mode-position-model,
robust-outlier-smoother). Their full text is in git history; the durable
parts are here and in `../design/episode-geometry.md`.

## Thesis

Stop snapping GPS to a graph and patching the result with reactive geometric
cleanups. Compute the drawn path as the **MAP estimate of one robust energy
model** that fuses every evidence stream as a soft, calibrated factor — GPS
(robustly, accuracy as a weak prior only), walking physics, the map as a soft
field (pavements attract, buildings repel), leg endpoints, the pedometer
budget, and eventually heading. Artifacts are then low-probability *by
construction* and there is nothing to excise afterward. Hard constraints live
in the hypothesis space, soft calibrated factors in the scorer, never `-Inf`
for the merely unlikely, always an honest raw fallback
(`../design/probabilistic-principles.md`).

## What is built (current behaviour)

- **Production draw**: per-leg Newson–Krumm Viterbi (`pedestrian-match.ts`)
  onto the walkable network, plus cleanup passes (`trimOverRouteExcursions`,
  `despikeUnsupportedApexes`, `correctWalkPath`). Blind to accuracy, steps,
  heading.
- **`reconstructWalk`** (`walk-smooth-map.ts`): the robust continuous MAP
  reconstructor — redescending Geman–McClure GPS emission under a
  deterministic graduated-non-convexity anneal (no RNG; golden stays
  deterministic); accuracy a weak clamped scale prior; L2 smoothness;
  adaptive robust walkable attraction; building clearance field; optional
  endpoint anchors; uniform-grid spatial index (`WalkGrid`) for near-O(1)
  nearest-way / in-building lookups. Since #353 (2026-07-14) buildings are a
  HARD constraint on transit, not presence: output edges passing through a
  footprint are routed around that ring's own corners (`routeChordAroundBuildings`,
  the corrector's case-2.5 primitive re-exported narrow; ≤2.5× chord bound,
  else the honest chord stands), and an **indoor-presence exemption**
  (≥3 consecutive observed fixes raw-inside the same ring = genuine entry —
  a café, a shop, a mall walkway) turns ALL building forces off for that
  stretch, its interior free states, terminals (doorways), and
  mapped-passage states. Corpus: crossing metres 1081→987, walks-with-
  crossings 36→30, stall/length unchanged, zero introduced crossings; the
  exemption alone fixed 4 walks (one 332→0 m) — the old soft field had been
  nudging genuine indoor fixes toward walls.
- **`WALK_RECON` per-leg swap** (`pedestrian-match-annotate.ts`, **on by
  default** since the G2 flip; `WALK_RECON=0` is the off-switch): draws the
  reconstruction only when it is ≥25 % AND ≥150 m shorter than the
  matched/raw line — the dissolved-phantom signature. Surfaces as
  `walkSmoothedPath` / `kind:"smoothed"`. **Input parity is load-bearing**:
  both invocations of `reconstructWalk` (recon-primary arm AND the
  conditional swap) receive the same collapsed fix set
  (`rejectSpikes` + `holdImplausibleSpeed`). The swap once received
  un-collapsed fixes; dense indoor jitter then reached the solver as
  mutually-consistent evidence and legs drew far over their step budget —
  the walk-gate red that motivated tracking the ratchet floors in git.
- **Referee**: `score-walk-match.ts` replays golden walks over
  baseline/matched/smoother-primary arms; metrics in `walk-score.ts`,
  `walk-buildings.ts`, `walk-plausibility.ts`, `walk-route-correctness.ts`;
  SVG eyeball via `render-walk-match.ts`; wired into the deploy gate (#307).

Known residuals in the current draw (re-measured 2026-07-14 via
`diag-walk-crossings` after the corner detour landed):

- **Mapped passages are NOT defects.** The prominent station-parade
  "crossing" (#350) measured as the matcher correctly following a real
  OSM walkway through the block — drawn vertices ≤3 m from the way, raw
  fixes on the same line. The basemap paints the footprint over the
  passage; the referee's "raw crossing incl. mapped passages" class had
  it right. Check for a mapped way under any visually-alarming crossing
  BEFORE treating it as a pipeline defect.
- **Corner detour (case 2.5, `repairChord`)** now handles the
  free-standing-footprint chord class: when the street network cannot
  route a crossing run around, the line follows the footprint's own
  corners (2 m clearance) — accepted only when the crossing is
  ELIMINATED outright (no partial purchases, the #347 lever), within the
  same detour-ratio bound as routes. Corpus: 2 former zigzag escapes now
  draw as clean corner lines (offPath 15→0 and 15→9).
- **Passage snap (`snapPassages`)** — the drawing half of the `onWayM`
  mapped-passage exemption. A stretch the badness metric excuses as riding
  an OSM way through a building was still DRAWN 2–3 m beside the way, over
  the roofs. In-building points now project exactly onto the way when it is
  within 4 m (`PASSAGE_SNAP_REACH_M` — real passage offsets measure 2–3 m),
  a stretch qualifies only with ≥3 m in-building length, and the snaps must
  be COHERENT (one way, monotone parameter) or the stretch is left alone.
  Runs LAST in `pedestrian-match-annotate`, after the display gate and the
  corrector, so it cannot perturb their decisions. Two per-metric stall
  "regressions" this caused were adjudicated from geometry as improvements
  (the line now follows the passage's real bend; one leg went offPath
  129→0 m) and blessed — corridor-stall penalises way-bends raw GPS cut
  across; judge passage changes by way-adherence, not stall alone.
- **The 14 surviving through-building runs split into two classes the
  detour honestly declines**: TERRACED ROWS (10 — abutting footprints;
  rounding one house means rounding the whole row; no bounded honest
  path; trustGPS is right, especially on sparse-fix days) and WEAVES
  (6 — the drawn line wobbles off-network near buildings while the
  straight anchor chord crosses nothing; not a detour problem at all).
  Both point at the reconstruction (buildings-as-hard-constraint), not
  at more corrector cases.
- **Corrector buys building fixes with invented distance** (#347): open,
  with both obvious guards measured and refuted — see the task before
  touching it. Points at retirement (#330), not a third guard.
- **Walks drawn across UNMAPPED housing blocks are invisible to every
  building-aware pass** — measured 2026-07-14: a user-flagged diagonal cut
  across terraced blocks scored offPath 0 m and all visible crossing-runs
  routed, because those blocks have no building polygons in OSM (the #305
  data-gap class; block-cut needs a footprint within 30 m to fire). Check
  the basemap for missing house outlines BEFORE treating such a cut as a
  corrector decline. Candidate lever: landuse-block interiors as soft
  cut-through evidence (#357) — falsify with the passage-snap discipline
  (must not touch forest/park walks or tie lines to centerlines).

## #357 — the "walking through houses" class: root cause, corrected in five mechanisms

**Ground truth settled the WHAT (2026-07-15, user-confirmed): the walk
follows the streets; no alley exists.** The WHY took three measurement
rounds, each falsifying the previous design — all three recorded here so
none is rebuilt:

1. **Landuse cut-through evidence: REFUTED.** The drawn line is never
   more than ~12 m from a mapped walkable way on this class — an
   off-network-chord detector can never fire.
2. **"Systematic 10–30 m GPS offset + per-fix half-snap": REFUTED at leg
   level (2026-07-15).** A per-point dump of the confirmed acceptance
   legs showed the RAW line already 1–8 m from the walked ways for
   almost every vertex (one ~28 m stray tail fix), and the pure matched
   line riding the correct route at 0.0 m off-network. There was no
   sustained offset to commit away. A synthetic probe closed the theory:
   `reconstructWalk` already absorbs a UNIFORM lateral offset up to
   ~25 m (a uniform translation is in the smoothness prior's null space
   and the way attraction wins it back; it collapses only past
   `networkRadiusM`, where the way is invisible). The corridor-commitment
   / lateral-bias-variable design this section previously proposed is
   therefore parked: the evidence it needs (a sustained sign-stable
   offset with the way out of attraction range) has not been observed on
   the corpus. Revive it only against a measured leg of that shape.
   The personal corridor prior (#84) stays open on its own merits.
3. **The actual mechanisms, measured and fixed (2026-07-15):**
   - **`refineMatchedPath` was the degrader (#359).** The de-boxing
     refinement carried a whole-line 12 m deviation budget, so on
     straight stretches it pulled the vetted on-network matched line up
     to ~12 m off-street toward ordinary GPS wobble — the half-snap
     zigzag photographed by the user (that leg's offWalkP90 REGRESSED
     10→12 m vs raw). Fixed: the full budget now attaches only to
     STAIRCASE-ARTIFACT corners (two sharp corners ≤ 25 m apart — the
     graph-snap zigzag signature); everywhere else, including isolated
     REAL street corners (cutting one 8–12 m puts the line through the
     corner building), the budget is a tight 2.5 m. Measured on the
     confirmed day: all six walks improved, the regressed leg flipped to
     offWalkP90 8 m (below its raw 10 m).
   - **`building=canopy` counted as a house (#360).** The evening leg's
     entire "building crossing" (37 m) was one station-forecourt canopy
     — a roof over open walkable ground, genuinely walked under.
     Non-enclosing `building=roof`/`canopy` footprints are now excluded
     from `queryBuildingsNear`, so they no longer repel drawers, trigger
     the corrector, or score as crossings (fixtures pick this up on
     re-capture).
   - **Refine dropped route vertices between fixes (#361).** The
     refinement resamples the matched line one-vertex-per-FIX, so a
     street-junction corner with no fix within ~25 m of it simply
     vanished and the chord cut through the block. Per-vertex clamps are
     structurally blind to this (every vertex IS on-route; the EDGE
     shortcuts), and `offWalkP90` hides a single ~25 m cut below the
     percentile on a long leg — detection has to be max-deviation /
     route-corner fidelity. Fixed: after the clamp, matched vertices
     whose chord deviation exceeds their local budget are spliced back
     in, gap endpoints snapped to the route (seam kinks), and the
     reinstated detour bounded (unbounded splicing resurrected a matcher
     route spur: stall 11→300 with a 103 m building crossing).
   - **The staircase-artifact signature matched real geometry (follow-up
     to #359/#361).** A pedestrian-crossing double-back is exactly two
     clustered sharp corners — the old two-corner artifact test gave
     refine a 12 m licence there and it cut a 9.8 m diagonal. An
     artifact now requires ≥ 3 clustered sharp corners; a real crossing
     double-back keeps its shape.
   - **The splice detour bound rejected acute junctions (follow-up to
     #361).** A genuine acute double-back at a junction needs ~1.7× the
     chord, over the 1.6× ratio bound, so the restored-corner splice
     refused the exact corner class the user reported. The bound is now
     ratio AND absolute: a gap's insertions are rejected only when the
     detour exceeds 1.6× the chord AND adds > 50 m — spur-class
     resurrections add hundreds of metres and still trip it.

   Corpus verdict for the two follow-ups (2026-07-15, blessed): improved
   6 legs (one stall 184→37), regressed 2 — both regressions are matcher
   route spurs (on-street out-and-backs, offPath 0) that refine's old
   two-corner licence had been trimming by accident. The spur defect
   belongs to the matcher's routing (#330 class), filed as #362; hiding
   it in the display stage cut real corners.
   - **The temporal-stall spur (#362, same day).** The unmasked spur is a
     doubling-back over street the walker JUST covered (the leg's own
     junction, ~44 m up and back while the fixes wobble in place), so
     every spur vertex sits within ~22 m of a fix from the descent —
     spatially on-corridor, and `trimOverRouteExcursions`' spatial gate
     never flags it. `despikeUnsupportedApexes` can't either (the spur
     has interior route vertices, not a single apex). Fixed with a second
     trim pass on the corridor positions the function already computes:
     a stretch that travels ≥ 80 m while its monotone corridor position
     advances < 15 % of that AND returns near its start (net displacement
     < 35 % of span) is excised. The three guards hold each look-alike: a
     GPS-traced out-and-back advances the corridor arc in step (the fixes
     polyline contains it), a gap-fill advances along the fix chord, and
     a real corner/way-bend ends far from its start. Corpus: regressed 0,
     improved 3 (the unmasked leg stall 88→3, plus two latent spur legs
     171→40 and 149→101). The 05-15 leg's stall stays: it ships the
     smoother arm and all arms agree — not this class.
- **A walk whose head is a mis-segmented ride** draws fine (the matcher
  sheds unwalkable fixes) but leaves a kilometre-scale frontend bridge —
  the boundary defect chain and its fix live in
  `../design/episode-geometry.md` ("The boundary class recurs") and #348,
  with the display-honesty half in #349.

## The central fact — two phantom classes (measured 2026-07-07)

1. **Isolated spur**: an out-and-back excursion on otherwise-good fixes. The
   robust emission rejects the lone excursion; the reconstruction is
   substantially shorter. **Fixed** — this is what the `WALK_RECON` swap
   ships (e.g. 04-29 10:32 matched 2060 m → recon 1411 m).
2. **Coherent smear**: a run of many reacquire fixes all pulled the same
   wrong way (post-tunnel GPS, the 07-06 Regent's Park case: truth ≈300 m /
   418 steps, drawn 1135 m; recon draws 1897 m — *worse*). The smear IS the
   local consensus: GPS, smoothness and the map are all consistent with it,
   so no amount of robust weighting rejects it. **Only independent evidence
   can**: the step budget, the leg's endpoint anchors, a true heading.

Corollary (RESOLVED 2026-07-08): G1 landed, the swap fires on class 2, and
the flag is ON by default (`WALK_RECON=0` is the off-switch).

## Phase G0 — measurement honesty (gates everything) — DONE 2026-07-08

- **Validate phantom fixes by geometry** — drawn length + bbox against the
  ground-truth narrative — never by corridor-stall alone (it is fooled by
  smears; see Landmines).
- **Reframe the ship gate** onto non-snapper-biased metrics: raw-relative
  building crossing (does the candidate cross MORE than the raw GPS did?),
  route-correctness, corridor-stall non-regression, and the phantom fixtures
  themselves (07-06, 06-16, 04-29 legs by drawn length).
- **Add a step-budget consistency column** to the referee: drawn length vs
  `steps × stride` per leg. Cheap, independent, and it would have exposed the
  corridor-stall artifact immediately.

Shipped: the referee prints `len/budget` per walk with an over-budget flag;
the walk ratchet (`walk-gate.ts`) no longer gates off-walkable p90 (recorded,
display-only — snapper-biased) and instead gates step-budget EXCESS
(`len − budget×slack`, 30 m eps) alongside stall / route / offPath / speed.

## Phase G1 — independent-evidence factors (the Regent's Park fix) — DONE 2026-07-08

- **G1a — soft step-magnitude factor (#320).** Thread per-minute steps
  (`biometrics.cadenceForSegment`) into `reconstructWalk`; a soft factor
  pulling total displacement toward the pedometer budget, strong enough to
  collapse a 1900 m smear toward ~300 m, weighted so it never distorts a
  legit leg. **Never a gate** (see Landmines). This is the highest-value open
  item in the line.
- **G1b — endpoint anchors (#319).** Pin first/last states to station
  entrances (`osm.ts` `nearbyStations` gate coords) or adjacent stay
  centroids (`episode-geometry.ts` `stayAnchor`/`entryPoint`). The 07-06
  narrative calls the failure "the anchor bug" — both leg endpoints are
  confidently known and contradict the smear. Subsumes #244's walking slice.
- Verdict by geometry on the smear fixtures + full-corpus referee
  non-regression.

Shipped (#320 + #319): per-edge step contraction with a quadratic excess ramp
over a 1.4× slack + extra anneal iterations while evidence is violated;
anchors from neighbour stay centroids (σ25) / snapped-rail terminals (σ15,
gap ≤180 s). The unlock for the anchors was making the walkable attraction
NORMAL-ONLY (point-to-line): the isotropic point spring resisted sliding
along the way and stalled every anchor correction. Measured: the 07-06 smear
pins at Euston Square and draws ~714 m; 06-16's 17.6 km/h fragment collapses
2493→1028 m; legit legs byte-identical.

## Phase G2 — flip (#321) — flip DONE 2026-07-08; retirement DEFERRED

Flipped: `WALK_RECON` on by default; the swap fired on exactly the two
confirmed smears (07-06 09:16Z, 06-16 15:48Z) and nothing else; walk floor
re-blessed against the narratives; deployed.

Deferred: retiring `trim/despike/correctWalkPath` and the Viterbi walk
matcher. The smoother-primary arm does not yet beat the matched line
corpus-wide, so only the swap ships — the retirement verdict re-runs under
the reframed (G0) gate when the reconstruction wins outright.

**Retirement verdict re-run 2026-07-08 (#330): still deferred, now measured
honestly.** The recon-primary draw is wired into the pipeline as
`walkDraw: "recon"` (annotateWalkMatches; matcher path byte-identical, golden
26/26) — reconstructWalk + the shared building corrector, no Viterbi / gate /
trim / despike — and the referee's smoother arm is a pipeline replay of it,
not an in-referee reimplementation. Two measurement defects fixed on the way:

- The old referee arm fed the smoother UNFILTERED raw fixes (no speed cap, no
  rejectSpikes, no holdImplausibleSpeed) — prod never shows it those. Input
  parity dissolved the absurd tails (a "1808 m on a 533 m raw line" leg was
  the teleport-run jitter the raw renderer collapses).
- `maxCorridorStall`'s greedy monotone projection mis-scored walks whose
  FIXES run out-and-back on one street: a smoothed vertex snapped to the
  return pass, ratcheting the floor so the rest read as stall (a line ≤ 12 m
  off a 118 m-stall line scored 2169 m; a matched line scored 2226 m that is
  really 18 m). Now a min-cost monotone (DP) assignment; the invented-detour
  signal is unchanged. Stall floors re-blessed on unchanged lines.

Honest verdict, gate axes vs the current draw (142 corpus walks): recon
LOSES 67 — stall +20–60 m on ~45 (the Viterbi's on-network routing is simply
a better local draw for ordinary dense-OSM walks), offPath building-crossing
+6–125 m on ~25 (recon bends near ways but does not route around blocks; the
corrector's honesty guards decline many repairs) — and WINS ~31 (the big
phantom dissolutions, which the shipped conditional swap already captures).
Retirement stays earned-not-given: the flip re-runs when G3 evidence (true
heading) or better factors close the ordinary-leg gap. The `walkDraw` arm +
honest referee are the standing harness for that re-run.

**Re-run 2026-07-15 (160 corpus walks): unchanged verdict, still
deferred.** Corridor-stall mean 32→38 m (better >15 m on 20, worse on
48); route-correctness better >5 % on 6, worse on 10; offWalkP90 worse
>3 m on 39. The loss profile is the same routing gap, not a factor gap —
recon wanders where the matcher routes. Priority therefore shifted to
fixing the shipping matcher path's own degrader (#359, below) rather
than adding recon factors that don't address routing.

## Phase G3 — PDR / true heading (#322, #297)

`motion_log.cog` is GPS-derived course, correlated with the noise it should
catch (`score-heading` verdict). A true magnetometer heading needs a capture
change (OwnTracks fork or lares-style app) + proxy parse + `motion_log`
columns — weeks of collection lead, so start early. Once `heading-eval`
confirms signal, add the PDR motion factor: the only lever for the
invented-detour-through-familiar-territory class.

## Phase G4 — personal corridor prior (#84)

Mine habitual corridors from ~180 d of history as a soft factor with a
cold-start fallback. Scoped as general quality — measured NOT a fix for
familiar-junction detours (the invented apex was a local maximum of
familiarity).

## Front-end unification (the map-constrained-positioning remainder, #265)

The broader idea — replace the road-blind Kalman front-end so position is
estimated *on the map* for all modes — is now split: the walk slice is this
roadmap; road/rail display is `road-match`/`rail-snap`; the estimator-level
unification is exactly the decoder's continuous map-matched worldline and
proceeds under `decoder-roadmap.md`, not here. The tube-teleport outlier
class is already mitigated (#144 QC pre-filter, #311 single-hop speed floor,
tunnel-transit coherence #251).

## Landmines (measured negative results — do NOT repeat)

- **corridor-stall is FOOLED by a coherent smear.** It measures over-route
  relative to the raw fixes; when the fixes are smeared, a line following
  them scores a LOW stall while being geographically wrong (07-06: "stall
  841→77" while the drawn line got 762 m longer). Geometry or nothing.
- **Whole-walk step-distance GATE: reverted 2026-07-01.** At the threshold
  that caught the triangle it rejected 27/63 good matches. Steps are a coarse
  global magnitude — soft factor only.
- **Densification inflates corridor-stall — measured THREE times, the last
  under the FIXED (min-cost DP) stall metric** (2026-07-14, closing #353's
  re-measure mandate): free states at 20 m spacing cost +4 % drawn length
  and 8 stall regressions across 154 walks for no crossing gain — the
  refutation no longer rests on the broken greedy metric. Keep
  `reconstructWalk` vertex-per-fix; corner INSERTION (a targeted vertex
  exactly where an edge crosses a ring) is the measured exception that
  works.
- **Hard per-iteration building projection is REFUTED** (2026-07-14, #353):
  projecting an interior state to its clearance target INTRODUCED crossings
  on 2 clean walks — the moved vertex's re-angled edges cut *neighbouring*
  footprints — regressed stall on 3, and netted ~nothing; the soft clearance
  field already does the vertex work. The knob stays
  (`RECON_HARD_PROJECT=1`) as a measured-dead experiment; do not enable.
- **off-walkable-p90 and absolute building-crossing are snapper-biased** —
  they reward hiding on a way centreline. On the six worst legs the RAW GPS
  itself crosses buildings 117–538 m (offset + OSM footprint overlap, #305).
  Never gate the honest reconstructor on them; use raw-relative crossing.
- **Familiarity prior does not fix familiar-junction detours** (60 d
  validation): the invented apex was a local familiarity maximum.
- **Naive accuracy-weighting is a wash** (better 31 / worse 37 legs): the
  smear reported good accuracy. Robustness must come from mutual consistency
  (GNC), with accuracy a weak prior — and coherent smears still need G1.
- **Passage-snap scoping is load-bearing — four measured failures.** An
  any-sample in-building trigger yanked corner-nicking street walks onto
  ways (corridor-stall regressed on ~12 ordinary legs); an 8 m snap reach
  regressed 3 more (true passage offsets are 2–3 m); per-point nearest-way
  snapping WITHOUT way-coherence zigzags between parallel ways/branches;
  and snapping INSIDE `correctWalkPath` perturbed its whole-line honesty
  invariant, flipping one leg's entire correction into a revert — display
  re-positioning must run after every accept/reject decision, on the line
  that actually ships.
- **No big-bang flips** — flag + referee ratchet + raw fallback, arm by arm.

## Verification

- `npm run verify`; `npm run golden` byte-identical until the flag flips.
- `node dist/cli/score-walk-match.js` under the G0-reframed gate.
- **The case**: replay 2026-07-06; the 10:16 leg must be a short
  Euston Square→UCLH walk (~350 m, bbox staying east of lon −0.14), not a
  Regent's Park out-and-back.
