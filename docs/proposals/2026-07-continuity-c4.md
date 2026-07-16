---
created: 2026-07-16
status: draft
references:
  - decoder-roadmap.md
  - ../design/probabilistic-principles.md
---

# C4 — cross-segment continuity: implementation design

Phase 3's long pole from `decoder-roadmap.md` (#224), designed against the
five-day acceptance suite recorded on #327 (ten enforced wrong rows in the
gitignored ground-truth narratives). This doc is the *how*; the roadmap
holds the why.

## What the acceptance suite measures (mechanisms, not cases)

The enforced failures fall into four mechanism classes; case detail lives
in #327 and the narratives:

1. **Swallowed short hops.** A one-stop sub-surface ride inside a GPS
   blackout is bridged at a walking-pace average speed and drawn as part
   of a walk. Speed is *structurally* blind to this class: a short ride
   plus station corridors takes about as long as walking the same
   distance. Per-minute step counts refute it decisively (a multi-minute
   zero-step block inside a "walk"; a total far below distance/stride) —
   and are currently consulted by neither layer at that decision point.
2. **Shredded dark rides.** One continuous ride is carved into
   fragments (unlabelled ride head, phantom interchange walk, tail leg
   restarting kilometres back at the true board station). Consecutive
   *drawn* states can be minutes and kilometres apart — a teleport that
   the kinematic invariant cannot see because it is per-leg.
3. **Anchor overwrites.** The boarding/alighting anchor passes rewrite a
   *correct* reconstruction endpoint off phantom walk slivers or
   backward re-anchoring (#351, two confirmed instances — one produced a
   *valid* triple, invisible to every invariant; only narrative rows
   catch it).
4. **Decoder's own gaps.** The HSMM is not uniformly better: on the same
   suite it decodes some rides cleanly end-to-end where the cascade
   shreds them, but it also misses the same short hops (see the cadence
   hole below), can emit a phantom ride overlapping a confirmed stay,
   and mangles boundary timing. Neither layer dominates — which is why
   the fix is joint decoding with better evidence, not picking a winner.

## Design principle

Global optimization over worldline hypotheses — conceptually annealing /
travelling-salesman over the day — combining historical priors and
physics as **likelihood terms, never thresholds**. Every new signal
below enters as an expected-vs-observed likelihood with noise tolerance;
a handful of stray platform steps moves a score slightly, it never flips
a verdict. Hard structure lives only in the generator/state space
(what is representable), per the roadmap's generator/scorer split.

## The cadence hole (found 2026-07-16, fix first)

`steps_intraday` only writes non-zero minutes, so a genuinely-still
minute reaches the decoder as `Observation.cadence: null` — and null
**skips** the cadence emission factor. Walking (cadence μ≈100) pays no
penalty exactly when the step data would refute it. During GPS blackouts
cadence is the *only* per-minute movement sensor, so the walking
hypothesis coasts through tunnel windows unopposed. This inverts the
whole emission design for the swallowed-hop class.

Fix: **watch-liveness imputation** in `buildObservations` — a minute
with no step row counts as `cadence: 0` (not null) when the device was
demonstrably alive around it (HR samples in or adjacent to the minute,
or step rows within a small window on both sides). Watch-off periods
stay null and keep skipping the factor. Pure, testable, no schema
change; it makes the *existing* zero-inflated cadence emission do its
job.

## Workstreams

### C4.0 — shadow scoreboard (measurement before modes) — DONE 2026-07-16

Extend the decoder eval (`score-day.ts` / the #227 journey eval) so each
acceptance day scores the decoder's journey structure against the
narrative: journeys reconstructed, board/alight/line correctness where
the narrative asserts them, phantom-ride count. Record the baseline
before any change. Every workstream below ships only when this
scoreboard improves and nothing regresses corpus-wide. (This is the
#227 Phase A deliverable, scoped to what C4 needs.)

Shipped as `src/eval/decoder-scoreboard.ts` (station fidelity with a
`missing` outcome distinct from wrong — the decoder emits no stations
until C4.3 — and majority-rule phantom-ride counting) + the ratchet in
`score-decoder-golden.ts` against the tracked
`tests/golden/decoder-scoreboard.json`. All five acceptance days have
decoded-day fixtures (07-15/07-16 captured 2026-07-16). Baseline over
the 10-day decoder corpus: trips 15/36, stations 0/32 (all missing, none
wrong), 5 phantom rides. A wrong station ratchets separately from a
missing one: wrong may never rise, so C4.3 cannot buy coverage with
lies.

### C4.1 — emission honesty in blackouts

The cadence-hole fix above, plus a per-segment **step-budget entry
term**: at segment entry the hypothesis predicts a step distribution
(walk of implied distance D → ~D/stride with variance; ride → low count
with corridor bursts; stationary → near zero) and is scored against the
observed sum. Entry-shaped (fires once per segment, like the hour-of-day
prior) so long stays aren't over-weighted. Targets mechanism 1.

### C4.2 — exit→entry chain context

The decoder's transition model knows mode adjacency but not *place*
continuity for moving states. Add chain context at segment entry,
composing into the existing `entryLogProb`:

- entering `train @ L` is scored by the feasibility of boarding L from
  the previous segment's exit context (last confident position or
  alighted station): distance to the nearest L-station as a likelihood,
  sharpened by **pre-boarding standstill dwell** evidence (a measured
  minutes-long standstill at station coordinates immediately before
  movement is strong boarding evidence — his stated platform-wait
  habit, visible in fixes on the suite);
- entering `stationary @ P` is scored by reachability from the exit
  context (subsumes the roadmap's `position-teleport` check as a soft
  term, with the invariant as the hard backstop);
- a phantom ride overlapping a confirmed stay pays the full "you were
  never near the line" entry cost that per-minute factors currently
  amortise away.

Per-segment, not per-minute — no state-space explosion (the route-aware
decoder's cautionary precedent).

### C4.3 — chained train triples (subsume the anchors)

`enumerateTrainCandidates` scores triples per ride window in isolation.
Chain them: within a journey, alight(N−1) must be board(N) or connected
by a scored intra-station transfer; the **step-burst / step-silence
discriminator** decides interchange-vs-through at a station stop (a
burst = walked between platforms, the #222 primitive; silence = stayed
aboard). The anchors' legitimate evidence — walked-to-station endpoints,
in-tunnel station-coordinate fixes, platform waits — becomes generator
input scored jointly, instead of post-hoc label rewrites that can
overwrite a correct answer. Targets mechanisms 2 and 3.

### C4.4 — journey-structure authority flip

Behind a flag, mirroring the hsmm place/mode override pattern: where the
decoder's journey structure for a train journey clears a confidence bar,
velocity.ts takes leg boundaries + board/alight/line from the decoder,
and `boardingAnchor` / `alightAnchor` / the interchange-erasing rewrites
are gated OFF for that window (not deleted — Phase 5 retires them one at
a time once the scoreboard proves the decoder reproduces their wins).
Gate: journey-level truth parity on the full corpus — clears ≥
regressions, invariants at zero, per the roadmap's shadow discipline.

## Order and dependencies

C4.0 → C4.1 → C4.2 → C4.3 → C4.4, each measured on the suite before the
next starts. C4.1 and C4.2 are independent of #364 (route-relation stop
membership); C4.3's triple validity and stop-pattern evidence get
sharper when #364 lands but do not block on it (proximity-inferred
membership under-reports safely). The walking C2 / stationary C3
constraints (#223) stay as shipped; C5 (sleep windows, #225) follows the
same chain-context mechanism later.

## What "done" means

The ten enforced wrong rows across the five acceptance days flip to
`cleared` (the truth report announces each), the journey ratchet floor
rises to take the previously-missing rides, no narrative row regresses,
and the anchors are inert behind the flag with the scoreboard showing
the decoder reproducing their wins. Then Phase 5 deletes them.
