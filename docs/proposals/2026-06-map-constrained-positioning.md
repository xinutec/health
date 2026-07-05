---
created: 2026-06-21
updated: 2026-06-21
status: proposed
references:
  - ../design/probabilistic-principles.md
  - ../design/episode-geometry.md
  - ../design/rail-snap.md
  - decoder-roadmap.md
  - 2026-06-magnetic-focus-places.md
---

# Map-constrained positioning — the estimator should know about streets

> One-line: **replace the road-blind Kalman front-end with a map-constrained
> Bayesian smoother**, so position is estimated *on the map* (roads / rails /
> pavements / place polygons) under a robust noise model and a learned
> personal prior — instead of being filtered in free space and then
> cosmetically snapped to roads at the end.

## Why this proposal now

`src/geo/kalman.ts` smooths every GPS fix in free 2-D space, then the rest
of the pipeline (segmentation, mode, place, the drawn line) consumes its
output. Map-matching (`road-match.ts`, `rail-snap.ts`) was bolted on at the
**end**, display-only, and is now even *gated off* when it might hurt
(`fractionOffRoad` confidence gate, #261). That is a patch fighting the
upstream output, not a fix.

The motivating case, 2026-06-21, fully traced against both the live API and
the Nextcloud PhoneTrack raw page:

- A single Owntracks fix at `12:43:23` near home reported **±80 m accuracy**
  — by far the worst of the drive; its neighbours are ±7–15 m.
- **NC draws the raw coordinate** as recorded: on the road actually driven.
- **The health map draws the Kalman-smoothed coordinate**: **80 m west**, off
  the road, toward a parallel cul-de-sac.

The Kalman *does* read the accuracy field (measurement noise from `accuracy`,
plus an innovation gate). It still moved the point 80 m the wrong way, because
the only thing it can express is "blend this noisy fix into a free-space
trajectory." It has **no term for "you are almost certainly on a road"** — and
it structurally cannot have one. A road network is a discrete, non-convex
constraint; a linear-Gaussian filter is the wrong model class. You cannot tune
your way out of this.

This is the same root cause behind every road-match artifact we chased on
2026-06-21 (shortcuts, lone-fix excursions, dead-end spurs, corner-cutting):
all were a *display* layer trying to undo a *positioning* layer that threw the
map away. Fix the positioning layer.

## The principle

Stop thinking *"filter the GPS, then snap to roads."* Think: **what is the
most probable trajectory *on the map* that explains all the evidence?** The
map and the motion model are priors; GPS is one noisy sensor. Everything
becomes a term in a single probabilistic model — consistent with
`probabilistic-principles.md` and the generator/scorer architecture of
`decoder-roadmap.md` (this is the *positioning* analogue of
what that proposal did for *mode*).

### Model

| Term | What it encodes | What we already have |
|---|---|---|
| **Hidden state = position *on the map*** | "edge `E`, offset `x` along it, velocity `v`" while moving; "inside place-polygon `P`" while still. The state space **is** the map, not free lat/lon. | `route-graph.ts` (#218) is the road/rail graph; `road-match.ts` builds a routable per-leg graph; focus_places + OSM footprints are the place polygons. |
| **Motion prior (transition)** | Continuity + bounded kinematics *per mode*; on an edge you move 1-D along it; no jump to a parallel street except through a junction. | `road-match`'s on-road-distance ≈ GPS-step transition is exactly this (Newson-Krumm). Kalman's adaptive process noise is the free-space version. |
| **Robust emission (per fix)** | `P(GPS | true position)` as a **heavy-tailed** law (Huber / Student-t) scaled by accuracy. A wild ±80 m outlier gets near-zero weight *automatically* — no hard threshold. Evaluated against map-constrained hypotheses, so an off-road fix reads as "noisy fix", never "drove off-road". | `road-match`'s Gaussian snap emission — needs the heavy tail + the per-fix consistency gate below. |
| **Map prior** | Probability mass on the right layer for the current mode: drivable roads when driving, rails when on a train, pavements/anywhere when walking, a building when stationary. | `rail-road-proximity` subtype sets; the route graph's feature types. |
| **Personal / route prior** | The killer term for a single user: a *learned* distribution over **your** edge usage. You approach home up the same road hundreds of times; a junk fix can't move that. | `rail-snap`'s fix-cloud corridor is a crude per-leg version; `magnetic-focus-places` is the place-level analogue. Generalise to a persistent prior over the whole graph. |
| **Mode coupling** | Mode selects the map layer + kinematics; position evidence feeds back into mode. Jointly consistent. | The HSMM decoder already owns mode (`decoder-roadmap.md`); this is the missing position half of the same joint model (`decoder-roadmap.md`). |

### Inference

- **Online (live marker):** a **particle filter** / Monte-Carlo localisation on
  the road graph. Each particle is "on edge `E` at offset `x`". Multiple
  hypotheses (which of two parallel roads) are carried until a later fix
  disambiguates — instead of greedily committing and zig-zagging.
- **Offline (the day map, computed after the fact):** a **Viterbi /
  forward–backward smoother** over the HMM, or a **factor-graph MAP optimisation**
  (GPS factors + motion factors + on-road-distance factors). `road-match.ts` is
  already the HMM-Viterbi special case of this — so we *promote* it from display
  gimmick to the estimator, not start over.

This is textbook *online map-matching via HMM* (Newson & Krumm 2009) +
*map-aided sensor fusion* + *MCL on a road graph* — well-trodden, not
speculative.

### Why it fixes the motivating case

At `12:43:23` the emission probability of *being at the off-road point* is tiny
(the map prior says "on the road"), and the heavy tail caps the outlier's pull —
so the estimate **stays on the road**, matching reality and NC. No Kalman swing,
no accuracy cutoff, no cosmetic snap-then-gate.

## Staged migration

Each phase ships behind the deterministic-fixtures harness and a **position-level**
eval (below), and is measured before the next starts. The golden state-diff
stays frozen until a phase deliberately changes classification, at which point we
re-bless against ground truth (never against pipeline output).

- **Phase 0 — position ground truth + eval harness.** Extend the truth-engine
  (`decoder-roadmap.md`) and golden ground-truth from narratives to
  *coordinates*: for a handful of blessed days, the road actually travelled per
  leg. Metric: median + p90 cross-track error of the drawn line vs the true road,
  and a "stayed on the right road" rate. Without this we cannot tell better from
  worse (the lesson of every map-match iteration on 2026-06-21).
- **Phase 1 — promote the matcher to *the* estimator for moving legs.** Make a
  map-constrained HMM smoother (extended `road-match`) the source of the drawn
  track, with a **robust** emission + a per-fix innovation gate (down-weight a fix
  inconsistent with the local trajectory *regardless* of its self-reported
  accuracy — do not trust the phone's number). Stop drawing the road-blind Kalman
  output for these legs. This subsumes the #261 confidence gate: the map prior
  decides continuously, not a binary on/off.
- **Phase 2 — learned personal road prior.** Formalise the fix-cloud corridor into
  a persistent prior over graph edges (your historical usage). Known routes lock
  in; ambiguous parallel-road cases resolve toward what you actually drive.
- **Phase 3 — couple mode + position.** One joint model with the HSMM: the layer
  prior and kinematics follow the decoded mode, and the position likelihood feeds
  back into the mode decode (closes `decoder-roadmap.md` /
  `#257`).
- **Phase 4 — stationary as a place-polygon prior.** Model a stay as "inside this
  building", so a smeared indoor stay resolves to the footprint, not a centroid
  floating in the street (`#244`). The anchor becomes the doorstep / footprint,
  not the mean of garbage fixes.
- **Phase 5 (frontier) — particle smoother** for the genuinely multi-modal bits
  where Viterbi's single best path is too brittle.

## Honesty bar (non-negotiable)

Per `decoder-roadmap.md`: the estimator emits **calibrated
uncertainty** and falls back to drawing the **raw track** (or `unknown`) when the
evidence is genuinely ambiguous — never invents lane-level precision it doesn't
have. The 2026-06-21 confidence gate ("draw raw when the GPS already hugs the
road") is the v0 of this and must survive as the principled fallback.

## Non-goals / risks

- **Not** a real-time navigation system; offline correctness for *your* recorded
  days is the target, so the heavier offline smoother is fine.
- **Risk: over-snapping.** A map-constrained estimate that's *too* confident
  re-introduces the wrong-parallel-road failure. The robust emission + personal
  prior + honest fallback are the guards; Phase 0 eval is the referee.
- **Risk: scope.** This is multi-week and touches the spine of the pipeline. It
  must land incrementally behind the eval, each phase reversible, or it stalls
  like the route-aware decoder did.
- **Cost:** the offline smoother runs in the cron / cached velocity path, not the
  request path (`fast-ux-offline-precision`). The live marker uses the lighter
  online filter.

## Relationship to existing work

- Supersedes the *intent* of `#84` (off-the-rails GPS correction via personal
  corridors) — that becomes Phase 2 here.
- Subsumes the #261 road-match confidence gate as Phase 1's continuous map prior.
- Phase 4 is the positioning half of `#244` (anchor a poor-GPS stay to its
  doorstep).
- Phase 3 is the positioning half of `#257` / `decoder-roadmap.md`.
- The Kalman (`kalman.ts`) is **not deleted** — it remains a reasonable free-space
  pre-smoother / fallback where no map layer applies (open water, aircraft, areas
  with no OSM coverage). It stops being the thing that *positions you on the
  ground*.
