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
  nearest-way / in-building lookups.
- **`WALK_RECON` per-leg swap** (`pedestrian-match-annotate.ts`, **off by
  default**): draws the reconstruction only when it is ≥25 % AND ≥150 m
  shorter than the matched/raw line — the dissolved-out-and-back signature.
  Surfaces as `walkSmoothedPath` / `kind:"smoothed"`.
- **Referee**: `score-walk-match.ts` replays golden walks over
  baseline/matched/smoother-primary arms; metrics in `walk-score.ts`,
  `walk-buildings.ts`, `walk-plausibility.ts`, `walk-route-correctness.ts`;
  SVG eyeball via `render-walk-match.ts`; wired into the deploy gate (#307).

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
- **Densification inflates corridor-stall — measured twice.** Blanket:
  102→187. Building-aware selective + free-state map-pull: 102→133 plus a new
  504 m excursion. Structural: the per-vertex clearance field can only route
  around a footprint by adding vertices, and added vertices projected onto
  sparse raw fixes read as wander. Keep `reconstructWalk` vertex-per-fix.
- **off-walkable-p90 and absolute building-crossing are snapper-biased** —
  they reward hiding on a way centreline. On the six worst legs the RAW GPS
  itself crosses buildings 117–538 m (offset + OSM footprint overlap, #305).
  Never gate the honest reconstructor on them; use raw-relative crossing.
- **Familiarity prior does not fix familiar-junction detours** (60 d
  validation): the invented apex was a local familiarity maximum.
- **Naive accuracy-weighting is a wash** (better 31 / worse 37 legs): the
  smear reported good accuracy. Robustness must come from mutual consistency
  (GNC), with accuracy a weak prior — and coherent smears still need G1.
- **No big-bang flips** — flag + referee ratchet + raw fallback, arm by arm.

## Verification

- `npm run verify`; `npm run golden` byte-identical until the flag flips.
- `node dist/cli/score-walk-match.js` under the G0-reframed gate.
- **The case**: replay 2026-07-06; the 10:16 leg must be a short
  Euston Square→UCLH walk (~350 m, bbox staying east of lon −0.14), not a
  Regent's Park out-and-back.
