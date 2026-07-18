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

### C4.1 — emission honesty in blackouts — imputation BUILT, shadow (2026-07-16)

The cadence-hole fix above, plus a per-segment **step-budget entry
term**: at segment entry the hypothesis predicts a step distribution
(walk of implied distance D → ~D/stride with variance; ride → low count
with corridor bursts; stationary → near zero) and is scored against the
observed sum. Entry-shaped (fires once per segment, like the hour-of-day
prior) so long stays aren't over-weighted. Targets mechanism 1.

Status: watch-liveness imputation implemented in `buildObservationTensor`
(measured liveness within a 5-minute window on BOTH sides; a day with no
step rows imputes nothing), behind `USE_CADENCE_IMPUTATION=1` — the flag
gate lives in the loaders, `decodeHsmm` stays pure. Shadow-measured on
the scoreboard (`USE_CADENCE_IMPUTATION=1 npm run score-decoder`):

- **Wins**: two journeys reconstructed on a previously 0-matched day
  (pre-boarding platform waits sharpen leg boundaries), leg mode/line
  gains on three days, and hidden mid-walk stops surface (sensor-decisive
  multi-minute sub-1 km/h zero-step blocks with sagging HR inside coarse
  narrative "walking" rows — the known hidden-shop-stop class, #268).
- **Blockers to flipping the flag**: (a) zero-step GPS-drift bursts that
  used to decode as phantom *walks* now decode as phantom vehicle
  micro-rides — the lie changed shape, not size; C4.2's entry chain
  context ("you never left the place") is the principled fix. (b) One
  real slow walk with measured positive cadence gets swallowed into the
  adjacent stay on a thin margin — the step-budget entry term is the
  counter-pressure. (c) The hidden-stop days need narrative adjudication
  (ground truth comes only from Pippijn).
- **Refuted en route**: a global heavy-tailed drift mixture on the
  stationary speed emission (0.9·N(0,2) + 0.1·N(0,12)). It fixed the
  drift phantom but reshaped marginal boundaries corpus-wide — on
  acceptance day 07-15 the midday hop fragmented from one 5-minute train
  into two 1-minute trains on *different lines* (+1 phantom). Do not
  reintroduce a global tail; drift robustness must come from per-segment
  chain context (C4.2) or learned emissions (#208).

### C4.2 groundwork — segment physics evidence (shadow, 2026-07-16)

`src/hmm/segment-evidence.ts`, behind `USE_SEGMENT_EVIDENCE=1` (same
loader-gated pattern): one bounded z-penalty per candidate segment
composed into the duration hook — net bracket displacement vs mode
(stationary ≈ 0; walking ≈ measured steps × stride, the
expected-vs-observed step likelihood; vehicles ≈ mode-typical net
displacement for the segment's duration). First measurement with both
flags on: 05-15 gains a journey (2/3), 06-12 holds 2/3, one line gain;
but two leg-mode losses appear (05-20, 06-09) and the 06-12 drift
phantom SURVIVES: drift fixes scatter at jog speed, so the segment's
own brackets show real local motion and stationary pays the
displacement penalty too. Confirmed: the drift-phantom class is only
separable with NEIGHBOUR-STATE context (entering a ride from
`stationary @P` and returning to `stationary @P` minutes later = never
left) — C4.2 proper, below, not segment-local observables.

**Bracket-slop misattribution (diagnosed + fixed 2026-07-16).** Both
leg-mode losses had one mechanism: deep in a GPS blackout the same
bracket pair spans *every* candidate sub-segment, so the term charged
each of them the whole dark journey's displacement. The 05-20
pre-boarding standstill (last fix 7.5 h stale) paid −6 for the tube
ride's 5.8 km — killing the platform wait that had let imputation win
the swallowed hop — and the 06-09 interchange walk (3 min of real
cadence inside a 34-min bracket, 10.4 km) paid −6 while `unknown`,
which asserts nothing, took the window. Fix: σ grows in quadrature by
`SLOP_SPEED_M_PER_MIN` (500 m/min) per minute of bracket slop — time
between a bracketing fix and the segment boundary belongs to
NEIGHBOURING segments, so stale brackets assert ~nothing while tight
brackets (drift bursts have per-minute fixes) stay sharp. Likelihood
shape, no cutoff.

Post-fix scoreboard (both flags vs blessed baseline): both leg-mode
losses gone; legs-mode 65→68, legs-line 8→10, new leg gains on
05-15/05-22; journeys 06-12 0→2. Remaining deltas, all pre-existing
flag blockers, none from the fix: 05-20 journey 2→1 (the
imputation-caused walk-to-car swallow), 05-25 1→0, 06-16 1→0, 06-12
phantomRides 1→2 (drift class). The fix also *dropped* the first
measurement's 05-15 morning-journey gain — adjudicated as luck, not a
regression: the whole morning is one blackout (prev fix 01:50 → next
09:08, 9.9 km), and the dishonest charge that flipped the dark-ride
stay to train would equally have flipped a real stay anywhere in a
blackout. Recovering dark rides honestly is C4.2 proper (reachability
chain context) and C4.3 (station anchors as generator input).

### C4.2 — exit→entry chain context — transition factor BUILT, shadow (2026-07-16)

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

Status: the transition-level factor is implemented in
`src/hmm/chain-context.ts` behind `USE_CHAIN_CONTEXT=1` (same
loader-gated pattern; composed into `transitionLogProb`, evaluated only
on non-hard-zero transitions): place-anchored reachability both ways
(entering/leaving `stationary @ P` scored by `dist(prevGpsFix, P)`)
plus boarding feasibility for `train @ L` (exit anchor to L's nearest
track, true per-line polyline distance — the `edgesNear` grid only
reaches ~750 m; gated off on generator-vouched windows). Same staleness
σ-inflation as segment evidence, so blackout transitions assert
~nothing. Per-minute memoization keeps overhead ~0.7 s/day.

Shadow-measured 2026-07-16, chain-context ALONE vs blessed baseline:
one day changes corpus-wide — 05-15 legs-mode 7→8, legs-line 1→2 (the
midday hop's line evidence), everything else byte-identical. No
regressions: the first C4 flag that is strictly clean on its own. All
three flags together reproduce the two-flag result exactly (the
remaining blockers are imputation/evidence-era, none chain-caused).

**"Never left the place" close-term REFUTED before building
(2026-07-16).** Measured the drift-phantom margins directly (per-state
emission totals over the 06-12 windows): the phantom vehicle minutes
buy 12–18 nats *per minute* from the stationary speed emission —
N(0,2) charging 12–14 km/h reacquire drift at z≈6–7 — while an honest
never-left displacement term computes to only ~−0.9 nats (a 2-minute
drive predicting 733 m vs ~200 m observed is genuinely mild evidence).
No bounded per-segment term closes that gap without tuning-to-win. The
lie is emission-side; chain context cannot fix it.

**Reacquire-robust stationary speed (BUILT, shadow, 2026-07-16).** The
drift bursts start at the first bright minute after ≥14-minute GPS
blackouts and settle over ~6 minutes — an observable
(`Observation.reacquireAgeMin`). Behind `USE_REACQUIRE_ROBUST_SPEED=1`
the STATIONARY speed σ widens by `1 + 2.5·exp(−age/3)`, scaled DOWN by
rail-corridor proximity (`1 − exp(−railDist²/2·100m²)`). Both
conditionings are measured, not tuned blind: drift is 5–14 km/h at
264–296 m off-rail; the acceptance-day midday hop reacquires at
22–37 km/h at 0–7 m ON the corridor. The first cut (width 4, no rail
scaling) reproduced the refuted-mixture failure in miniature — the
07-15 hop's first three minutes absorbed into the stay, remnant
fragmented across lines (+1 phantom) — and the speed-only algebra
proves age-0 22 km/h vs age-2 14 km/h cannot be separated by any
decaying σ; the rail term is what separates them. Road proximity
carries no signal (everything in London is within ~25 m of a road —
the #234 lesson).

Scoreboard with all four flags (imputation + segment evidence + chain
context + reacquire-robust) vs blessed baseline: legs-mode 65→69,
legs-line 8→10, 06-12 journeys 0→2 and phantomRides 1→0 (both drift
phantoms dissolve into the true stay — including the one the BASELINE
had), corpus phantoms 5→4, 07-15 hop intact as one Jubilee ride, zero
leg-level losses anywhere. Remaining deltas, both pre-existing
journey-SHAPE drops whose days' leg scores are equal or better:
05-25 journeysMatched 1→0 and 06-16 1→0 — diagnose before bless/flip.

### C4.3 — chained train triples (subsume the anchors) — v1 SHIPPED (2026-07-18)

`enumerateTrainCandidates` scores triples per ride window in isolation.
Chain them: within a journey, alight(N−1) must be board(N) or connected
by a scored intra-station transfer; the **step-burst / step-silence
discriminator** decides interchange-vs-through at a station stop (a
burst = walked between platforms, the #222 primitive; silence = stayed
aboard). The anchors' legitimate evidence — walked-to-station endpoints,
in-tunnel station-coordinate fixes, platform waits — becomes generator
input scored jointly, instead of post-hoc label rewrites that can
overwrite a correct answer. Targets mechanisms 2 and 3.

**v1 status (#370):** `src/hmm/station-chain.ts` — post-decode
per-journey Viterbi over (board, alight) pairs per named-line train
leg; terms: anchor distance (staleness-slopped σ, candidate radius
widens with slop so a stale anchor admits rather than excludes),
along-line path duration (Dijkstra on the line's edges, doubling as
connectivity), terminal-dwell consistency (an in-leg fix near a
candidate minutes away from the leg boundary implies an impossible
through-station dwell), and interchange-feasibility chain terms.
Emission is confidence-gated per side (max-marginal margin ≥ 1 nat
AND absolute anchor plausibility) — wrong is worse than missing.
Stations flow through `HmmSegment.boardStation/alightStation`
(CLASSIFIER_VERSION 5) into the journey eval legs.

Measured on the 10-day corpus (four C4 flags on): the first station
pair matches (06-12), **zero wrong stations**, no regressions; 07-16
resolves the true morning board (Wembley Park) and return alight
(Wembley Park) and correctly refuses the corrupted-anchor Finchley
Road alight. Traps found and closed en route: real stations are
several same-named OSM nodes (margins must compare NAMES); station
complexes fabricate sub-400 m "hops" via proximity-inferred line
membership (min-path floor; real membership is #364); a leg boundary
deep in a blackout makes observed duration a LOWER bound only
(one-sided term — a decoded bright fragment of a dark ride must not
be read as the whole ride); a fresh reacquire fix can be km-wrong
(the 07-16 08:41 jump-back), which the dwell term + margins turn
into an honest null rather than a lie.

Residuals: most asserted pairs stay `missing` until decode quality
catches up (fragmented dark rides, wrong line labels, stale
anchors); recovering the 07-16 Baker Street alight from the
in-tunnel flicker over the corrupted anchor needs a
trajectory-coherence term (v2); a phantom ride can still carry a
station label — the phantom itself is the lie and dies with #366;
the KX complex's three station names need #364's real membership to
consolidate.

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
