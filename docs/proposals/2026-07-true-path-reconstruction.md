# True-path reconstruction — from geometric snapping to an evidence-fused story

Status: proposal (staging). Supersedes the reactive geometry cleanups on the
walk matcher; extends the map-constrained-positioning direction (#265).

## Why the current matcher makes mistakes

Today a walking leg is drawn by a per-leg Newson-Krumm Viterbi
(`pedestrian-match.ts`) that snaps the GPS onto the OSM walkable network, then a
chain of **post-hoc geometric cleanups** patches the result: over-route excision
(#293), building-crossing repair, apex de-spike (#295). Each cleanup is a
reactive geometric rule, and each hit the same wall: **geometry alone cannot tell
an invented artifact from a real feature.**

The 2026-06-30 13:20 walk is the proof. Its bad "triangle" is a single matched
vertex that juts 32 m off the chord — 24 m further than the raw GPS went there —
turning 107°. A genuine pavement corner where the GPS cut the corner has the
*same* signature. Every threshold that removed the triangle also deleted real
corners (a corpus walk went +10 m off-pavement). The failure is not a bug in a
rule; it is that the problem is **under-constrained**: the matcher optimises "the
cheapest network path that fits noisy GPS," and noisy GPS admits many equally
cheap paths, most of them wrong.

You cannot threshold your way out of an under-constrained problem. You add
constraints.

## The principle

A path is *true* when it is the most probable trajectory given **all** the
evidence and everything known about how this person moves — not the cheapest
curve that touches the GPS dots. The upgrade is to replace geometric snapping +
cleanups with a **joint probabilistic reconstruction** that fuses several
independent evidence streams under strong, learned priors, anchored to the day's
story. Artifacts like the triangle then never form — they are low-probability
under the model — so there is nothing to excise afterwards.

## Five pillars

### 1. Pedestrian dead-reckoning (PDR) — an independent motion witness

Step cadence × stride length, combined with phone heading (compass /
accelerometer), gives displacement **independent of GPS**. Over the 13:20
triangle span the step count and heading say "≈40 m, roughly straight"; the
triangle contradicts that and is rejected. GPS-only is the root under-constraint;
a second, uncorrelated motion estimate breaks it. `steps_intraday` is already
captured; heading/accelerometer would need the capture apps (Owntracks / lares)
to log it. This is the single biggest lever.

**Measured caveat — steps ALONE (no heading) are not enough (2026-07-01).** A
whole-walk step-distance gate ("reject the match when drawn length > steps ×
stride × factor → draw raw") was built and calibrated against `score-walk-match`.
Result: to catch the 13:20 triangle (drawn 918 m vs a ~720 m step budget = 1.24×)
the factor must drop to ~1.2, which also rejects **27 of ~63 good golden matches**
— because a ~25 % over-length sits inside the ±20 % stride-estimate noise, and GPS
noise already inflates even the raw track. A corpus-safe factor (~2.0) only
catches gross 2×+ over-routes (a real but small physical guardrail, benefit
invisible to the off-walkable scorer) and does nothing for the triangle. Reverted
— not shipped. Conclusion: steps give a coarse GLOBAL magnitude check, not a local
scalpel; the disambiguation must come from **per-fix heading** (the direction the
step budget lacks), fused — not steps as a standalone gate.

### 2. Map + physics as first-class constraints, not a post-hoc snap

Model the leg as a trajectory *on* the pedestrian network where buildings are
impassable and walker speed/acceleration are bounded. The path is network- and
physics-feasible **by construction** — no building crossings and no off-pavement
shortcuts to detect and repair later. This retires the building-crossing repair
and the length/spur bails as special cases of one model.

### 3. Personal route priors — learn how *he* actually moves (#84)

A solo user walks the same routes over and over (home ↔ station, home ↔ shops).
Mine the location history into a weighted graph of habitual corridors. A learned
prior makes the real route (home → the main road → the station)
far more probable than any invented triangle, because it is the route he takes
almost every time. For a single user with a small set of repeated journeys this
is the highest-ROI signal available, and the data already exists.

**Measured caveat (2026-07-01):** familiarity priors of any granularity do NOT
fix the hardest case. Validated on the 30-06 13:20 triangle over 60 days of
history at radii 10/15/20/25 m: the invented apex is *familiar at every scale* —
at 10 m it is even a LOCAL MAXIMUM (27 pts vs corridor neighbours 8–15), because
it sits at a junction he genuinely frequents. History says "yes he goes there";
only *this walk's* evidence says "but not this time." So a route prior helps only
where a detour leaves genuinely-unvisited ground; it cannot disambiguate a
plausible movement through familiar territory. That needs **per-walk motion
evidence (Pillar 1, PDR: steps + heading)** — the independent witness of whether
he actually stepped out-and-back or straight. Re-order accordingly: PDR is the
only lever with a real chance on the triangle class; the route prior is a
general-quality improvement, not a fix for this case.

### 4. Story anchoring — reconstruct between known truths (#244, #257)

The day is a story: home → walk → board → ride → alight → walk → hospital. Each
walk leg runs **between confident anchors** — his doorstep, the station entrance,
the hospital entrance (real POI coordinates), not free-floating GPS. Anchoring a
leg to its true endpoints (#244) and letting the decoder own the journey
structure (#257) turns "some jitter near the main road" into "his doorstep → the
station entrance along his usual corridor" — a true path with
correct ends.

### 5. Evidence-proportional output + a truth loop

Draw only what the fused evidence supports; where GPS is sparse, draw a clean
confident line along the prior route rather than inventing wiggles — a solid
line, per the existing preference. Close the loop: the visual diff harness
(`render-walk-match`, built alongside #293) plus the user-confirmed ground-truth
narratives (#184) become the eval and training signal. A **story-correctness
score** — does the reconstructed path match the confirmed route between anchors?
— replaces threshold-guessing with measurement against truth. Without this loop
every future change is back to guessing, which is exactly the wall this session
kept hitting.

## Architecture sketch

A factor-graph / particle-filter smoother per walk leg. Factors:

- GPS emission (per fix, accuracy-weighted);
- PDR motion (step-derived displacement + heading);
- network adherence (on a walkable way) + building impassability;
- personal-corridor prior (habitual routes);
- anchor endpoints (doorstep / station / POI entrances);
- speed / acceleration bounds.

The MAP estimate is the drawn path. This subsumes the Viterbi matcher and makes
`trimOverRouteExcursions` / `despikeUnsupportedApexes` unnecessary — feasible,
evidence-backed paths do not contain the artifacts those passes chase.

## Phasing (each phase measurable and independently shippable)

- **Phase 0 — truth foundation.** Grow the visual harness into a labelled walk
  corpus and add a story-correctness score to `score-walk-match`. Ships nothing;
  unblocks everything, and ends the threshold-guessing.
- **Phase 1 — personal route priors (#84).** Mine habitual corridors from
  history; add as a routing prior to the current matcher. Highest ROI, low risk,
  no new sensors. Validate on the corpus.
- **Phase 2 — PDR fusion.** Capture heading; fuse steps + heading with GPS as a
  motion factor. Breaks the GPS-only under-constraint.
- **Phase 3 — story anchoring (#244, #257).** Doorstep / entrance anchors and
  decoder-owned journey structure.
- **Phase 4 — unify.** Fold the factors into one smoother; retire the post-hoc
  geometric cleanups.

## Honest costs and risks

- New sensors (heading / accelerometer) need the capture apps updated and a
  data-collection period before Phase 2 pays off.
- Personal priors need enough history and a cold-start fallback (new areas,
  first visits) so a novel route is not forced onto an old corridor.
- A particle filter / factor graph is a real system; the phasing keeps each step
  small and measured against Phase 0's score.
- Phase 0 is the prerequisite for all the rest — build the truth loop first, or
  the model tuning is back to guessing.
