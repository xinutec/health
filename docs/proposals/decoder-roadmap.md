---
created: 2026-06-24
status: active
references:
  - ../design/probabilistic-principles.md
  - ../design/overview.md
---

# Decoder roadmap — one joint model owns the day

This is the single forward plan for the classification line of work. It
replaces seven separate proposals that each described one slice of the same
arc (physical-plausibility, journey-worldline, constraint-first-decoder,
decoder-owns-mode, phase1-train-softprior, tube-journey-segment,
truth-engine), plus the 2026-05 scored-classification roadmap — whose
"escalate to a joint model or keep iterating factors in the cascade?"
decision point this document resolves: escalate. The factor library it
shipped lives on as the decoder's per-minute scoring layer
(`../design/probabilistic-principles.md`); its unfinished cascade-side
phases (activating the factor scorer inside `refineMode`, the
commute-history prior as a cascade feature) are abandoned — that
investment belongs in the decoder, not in a second scoring path inside
the incumbent. Full text of all replaced proposals is in git history;
the durable parts are here.

The shipped machinery these phases build on — the HSMM Viterbi decoder, the
factor library, the generator/scorer split — is documented as current
behaviour in `../design/probabilistic-principles.md` and
`../design/overview.md`. This doc is only the *plan*: where the decoder is
going and in what order.

## Thesis

Move the day's reconstruction out of the ~38-pass heuristic cascade — each
pass making a local decision and handing off — into one joint probabilistic
decoder that owns the day end to end. The latent object becomes **one
continuous map-matched worldline**: a connected path through a unified
multimodal transport graph, observed noisily. Physical feasibility (no
teleports; board = previous alight; a line connects its endpoints) is then a
**property of the hypothesis space**, not a post-hoc pass. Every continuity
rule we hand-wrote reactively (#175, #176, #181, #234) stops being code and
becomes a structural consequence. Impossible journeys become
*unrepresentable* rather than *pruned*.

Measured evidence the cascade cannot be patched into correctness
(2026-07-14, #354): the passes don't just leak at their seams — some
**depend on other passes' errors**. Short mid-ride "stationary" fragments
(sparse tunnel fixes clustered as a stop) are mis-flipped to *walking* by
the stationary-coherence pass, and the rail absorbers rely on that wrong
label to assemble the ride; making the flip more honest broke reconstructed
journeys and moved an alight to the wrong station. In a cascade, fixing one
pass's lie can regress its consumers; in a joint decode there is no
intermediate label to lie about.

## The bar (what "good" means)

- A "your day" output a human reads and immediately accepts as *plausible*.
  Wrong-in-details is acceptable; absurd-on-its-face is not. The shared shape
  of every bug: the pipeline manufactures false structure to fill gaps and
  never checks whether that structure is physically possible.
- Type coherence: sleep snaps to lodging/residence, meals to food POIs,
  medical time to medical POIs; name-bearing places outrank nearest-address;
  physical bounds hold (a train leg ≥ expected_travel_time/2; >200 km/h is a
  plane, not a train; cycling needs HR + cadence).
- Honest "don't know": when signals conflict or are sparse, say so. "Sleeping
  somewhere near X (low confidence)" beats fabricated precision.

## Architecture

- **Latent object = a worldline.** A continuous trajectory through space-time
  that alternates *dwell at a place* and *travel between places via a mode*.
  Its support is exactly the set of physically-realisable journeys. State =
  a point on the graph + mode; the latent journey is a *path* (each state
  graph-adjacent to the next).
- **One unified multimodal graph** carrying walk / drive / rail edges. The
  substrate mostly exists unintegrated (`RouteGraph`, `osm.drivableRoads()`,
  the pedestrian walkable prior); it must be unified and given **interchange
  edges** — the only places mode may change.
- **Feasibility by construction.** The path choice makes "no teleport, board =
  prior alight, no line that skips its endpoints" true unbreakably, because
  adjacent states share a graph node.
- **Emission = map-matching likelihood** (Newson–Krumm: accuracy-weighted,
  heavy-tailed fix→edge distance) + biometric emission per mode. A bad fix
  self-attenuates under *every* hypothesis — weight evidence, don't
  hard-filter.
- **GPS gaps are inferred, not reconstructed.** The transition model
  marginalises over connected paths between the last surface fix and
  reacquisition, so there is no seam between "observed" and "reconstructed"
  for an impossibility to hide in. Confidence = forward–backward posterior
  marginals.
- **The mechanism: generator/scorer split.** The generator emits only
  physically-possible state sequences via hard constraints; the existing
  per-minute factor library (HR / speed / cadence / place-distance / duration
  / hour-of-day) scores the survivors. Factors are for tie-breaking *inside*
  the valid set, not for filtering the invalid set out of it — so the factor
  library shrinks. The hard constraints:
  - **C1** train leg is a valid `(board, line, alight)` triple
  - **C2** walking-speed bounds
  - **C3** stationary place-coherence
  - **C4** cross-segment continuity (adjacent legs share a node)
  - **C5** sleep-window coherence

Everything else is an *arm* of this one estimator, not a separate direction:
map-constrained positioning is the position arm; the generator is the
rail-edge transition support; the HSMM is the inference shell; the decoder
owns mode *because* it owns the worldline; a tube journey is a contiguous run
of the worldline (grouping is a read, not a reconstruction); the truth engine
is the measurement substrate.

**Cautionary precedent:** the superseded route-aware decoder blew position up
into a discrete `(mode, route, position, edge)` state and regressed mode by
0.6 pp with line stuck at 0/6. This plan avoids that by treating position as
a *continuous emission*, not a discrete state explosion — and by putting hard
structure in the generator, never in a per-minute scorer.

## Phase 0 — measurement first (the prerequisite, #250)

The evaluation apparatus the whole plan rests on does not fully exist, so
every phase's "ships only when the score rises" gate is currently a phantom.
Build the measurement before the modes — you cannot build "much smarter"
against a metric that can't move.

- **Make `bus` scorable.** `canonicalMode`/`DecoderMode` cannot relate a
  blessed `bus` row to the decoder's road-vehicle output, so the flagship
  metric literally cannot move. Surface `vehicleKind=bus`.
- **Journey-level scorer.** Score whole journeys (home → tube → bus → clinic)
  against ground-truth narratives, not just per-minute — the cutover gate is
  *defined* as journey-level no-regression but no journey metric exists.
- **Corpus invariant checker.** Run no-teleport / board = prior-alight /
  every-triple-connected over current output. It would have caught the
  2026-06-22 two-alights-at-one-station bug.
- **Position-teleport check.** Extend `worldline-feasibility.ts` (today only
  `rail-discontinuity` / `degenerate-train-leg`) with a `position-teleport`
  kind: a stay/sleep place must be reachable from the adjacent observed
  position. The 2026-06-24 sleep-10km-from-prior-fix bug proves the invariant
  must cover *place*, not just rail. The "prefer Home" patch was tried and
  reverted (it broke inpatient nights) — the fix is continuity, not a
  residential bias.
- **Confidence calibration.** Emit a per-segment confidence plus a
  reliability/Brier/ECE metric so "calibrated honesty" is measured, not
  asserted. Phase 4's gate depends on this.
- Grow the ~11-day confirmed ground-truth corpus — the single
  highest-leverage input.

## Phase 1 — wire the train generator (C1) as a soft prior

Line attribution should come from structural `(board, line, alight)` validity
instead of soft proximity factors that left the line score at 0/6. The
generator `enumerateTrainCandidates` is written and tested but unused in the
decode. **Soft prior, not a hard −∞ filter** — a hard filter zeroed real
rides when sparse post-alight GPS fell >250 m from the station. Status:
in progress (#249, #181). Measured: 05-22 line 0/6 → 3/6.

## Phase 2 — buses (C-bus)

Turn "driving" into a named "bus N" via a stop-anchored route layer (mirror
OSM `route=bus` relations into `bus_route_cache` via throttled cron; match by
stops, not fixes; a personal route prior breaks parallel-route ties). The
matcher shipped on the **heuristic path** 2026-06-15/16 (#256); the
decoder-side `bus` mode does not exist yet (today bus is a display mode
derived from `driving` + `vehicleKind:"bus"`). Sequenced early because the
named-bus win depends on nothing downstream. Bus stays ambiguous-by-design on
shared corridors until the personal-route model lands.

## Phase 3 — physical generator constraints (C2–C5)

Walking veto, stationary coherence, cross-segment continuity, sleep-window
coherence. **C4 (continuity) is the long pole** — highest value, most
slip-prone, subsumes the most heuristics. The 2026-06-16 re-measure confirmed
the decoder's real weakness is **under-reconstruction** (abandoning legs to
`unknown`; trips 48%) — that is C4, *not* #238 rail-over-crediting, which is
demoted to a lower-priority guard already pinned by the 05-25 taxi fixture.
Status: pending (#224, #225).

## Tube-journey composition (prerequisite of the cutover)

Group consecutive train + intra-station-walk + platform-wait minutes into one
journey segment, so eval and UI read at journey level while the per-minute
physics stay honest. Post-decode, pure, deterministic
(`tube-journey-assembler.ts`); persistence is a light `tube_journeys` table
pointing into minute runs, not a tree rewrite. This is a hard dependency of
Phase 4 — the cutover gate is journey-level precisely because the decoder is
deliberately honest about interchange walks the narrative folds into the
journey. Status: assembler shipped (#228), eval/persistence/UI pending (#227,
#229, #230).

## Phase 4 — the cutover

Take the user-facing mode from the decoder's per-minute sequence (composed via
the tube wrapper) instead of `refinedMode ?? mode`, gated where a per-segment
decoder confidence clears a bar — that calibrated confidence is itself a
deliverable of this phase. Gate = journey-level truth-check parity: no
ground-truth narrative regresses. A premature flip (2026-06-13:
support-fraction ≥ 0.6, no composition, no calibrated confidence) measured
0 wins, 2 regressions — which is the empirical case for doing Phase 0 + C-bus
+ C2–C5 + calibration first. Must also close the decoder's *line* gap first
(its ~50% line accuracy is far below the pipeline's 98%) by feeding the
pipeline's line attribution in as an emission. Status: pending (#252 landed
mode-ownership behind the flag; full cutover gated).

## Phase 5 — retire the heuristic mode passes

Delete the ~16 hand-coded mode passes one at a time, each behind a
no-regression check + `CLASSIFIER_VERSION` bump + full re-decode. **Not pure
subtraction:** structural passes (reconcile / absorb / splits) map onto C1–C4
and are safe to drop; scorer-side passes (`revertIsolatedCadenceDrives`,
`demoteJitterWalkToStationary`) encode emission knowledge the decoder must be
*shown* to reproduce before deletion. Requires the classification-snapshot CI
gate (#103) because real fixtures are gitignored. Status: pending (#226).

## Dependencies

- **Phase 0 gates everything** — no phase can claim no-regression until the
  journey scorer, bus-scorable mode, calibrated confidence, and the
  invariant/teleport checks exist.
- **Phase 1 → Phase 4** — line attribution must improve before the cutover
  can rest on decoder mode.
- **C-bus depends on nothing downstream** — shippable early on the heuristic
  path; decoder-side bus needs a new state + route mirroring + L4 personal
  prior.
- **C4 continuity is the long pole** for both the structure work and the
  cutover.
- **Tube composition is a hard prerequisite of Phase 4.**
- **Phase 5 depends on Phases 1–4 being in prod and stable**, plus the
  decoder proven (not assumed) to reproduce scorer-side emission knowledge.

The whole program runs **shadow** behind the existing output and is compared
before it takes authority. Both wholesale swaps tried this cycle measured to
regress (`USE_FACTOR_SCORER=1` cost +15 truth regressions; a symmetric
train-demotion cost +4) — the empirical case for incremental gating over a
big-bang flip. The hard bar on every phase: golden truth clears ≥ regressions,
impossibility count = 0, judged against ground-truth narratives, never
pipeline output.
