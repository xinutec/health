# Probabilistic system: ground rules and principles

This document captures the architectural philosophy of the
classification system — the *why* behind decisions that the
proposal docs and commit messages individually describe but never
collect in one place.

Read this before adding new factors, tuning parameters, or
proposing alternatives. The technical specifics of any one
component live in its own proposal under `docs/proposals/`; this
file is the contract on which all of those proposals operate.

## The frame: generator + probabilistic scorer + composition

We are building a *constraint-first probabilistic decoder*, in
three layers:

1. **Generator: enumerate only physically possible state
   sequences.** Hard structural constraints (a train segment has
   a valid `(board, alight, line)` station triple; adjacent
   segments share a physical endpoint; a `walking` segment has
   peak speed ≤ 12 km/h) filter the candidate space. A sequence
   that violates physics is not a candidate — the decoder doesn't
   weigh it, doesn't score it, doesn't consider it.
2. **Scorer: pick the highest-evidence candidate per minute.**
   Per-minute probabilistic factors (HR Gaussian, speed Gaussian,
   place-distance, duration prior, hour-of-day entry) score the
   survivors as a joint posterior. Composes multiplicatively
   (additively in log-space). When the data is unambiguous, the
   posterior concentrates on one candidate. When the data is
   genuinely ambiguous, the posterior spreads — and the
   user-facing presentation reflects that.
3. **Composition: group per-minute classifications into the
   events a human narrates.** A tube journey (train + intra-
   station walk + platform wait + train) is one segment-level
   event even though it contains multiple per-minute modes. The
   per-minute decoder stays physically honest about every minute
   (cadence-confirmed walking inside a station is walking); the
   composition layer wraps consecutive minutes that belong to
   the same logical event into a single segment for UI and eval.
   See
   [`../proposals/decoder-roadmap.md`](../proposals/decoder-roadmap.md).

The earlier framing of this document — "every constraint is a
probability, no hard constraints" — was incomplete. It correctly
identified that *unlikely-but-possible* cases must stay soft (a
London → Karlsruhe teleport via mis-timestamped fix is rare but
real). It incorrectly conflated *unlikely-but-possible* with
*genuinely impossible* (a Met train alighting at a station that
doesn't exist on Met). Soft-penalty modelling of genuine
physical impossibilities was the architectural mistake the
per-minute factor stack made; the constraint-first decoder
(`docs/proposals/decoder-roadmap.md`) corrects
it.

The classification pipeline isn't a sequence of `if/else`
discrimination rules. It also isn't a flat factor graph that
scores every cartesian-product tuple of `(mode, place, line)`.
It is a generator that produces the physically-valid candidate
set, followed by a factor-graph scorer over the survivors.

## Rule 1: hard constraints belong in the generator, soft constraints in the scorer

A constraint is *hard* if it forbids physically impossible
configurations — the kind of constraint a careful human would
not even consider as a hypothesis. Examples:

- A train segment that boards or alights mid-tunnel (no
  station).
- A `walking` segment with peak GPS speed > 12 km/h.
- Adjacent segments whose endpoints are 5 km apart (a teleport).
- A sleep-window place 30 km from the user's last pre-sleep GPS
  fix.

These are filtered by the *generator*. A candidate sequence
violating them is not in the search space.

A constraint is *soft* if it expresses graduated preference
between physically valid hypotheses:

- The user is more likely on a specific tube line they always
  take versus a parallel-track alternative.
- A 60-minute stationary is more likely a stay; a 3-minute
  stationary is more likely a traffic-light pause.
- A high-HR minute is more consistent with cycling than walking.

These are encoded by the *scorer* as log-probability factors.
Composes multiplicatively in log-space; MAP path picks the joint
maximum.

In practice this means:

- **Don't write `return -Infinity` from a scoring function for
  unlikely-but-possible cases.** Use a calibrated low log-prob
  (e.g. `-10` to `-15` nats) so the factor remains comparable
  in the MAP sum. The London → Karlsruhe-teleport scenario
  stays a scoring concern, not a generator concern.
- **Do write generator filters for genuinely impossible cases.**
  A train hypothesis with no valid `(board, alight, line)` triple
  is not a candidate, full stop. Generator code can literally
  short-circuit out of the candidate-enumeration loop.
- **The `-Infinity` exceptions inside the scorer** are reserved
  for mathematical identities (`log(0)`, division by zero) — not
  probabilistic statements.
- **The previous generation's "hard-zero transitions"** (e.g.
  `stationary @ A → stationary @ B` no-teleport,
  `train @ L → stationary @ P` station-graph) were implemented
  as `-Infinity` in the scorer's transition matrix. They're
  being moved to the generator (cross-segment continuity
  constraint C4) where they belong. Same MAP outcome, structural
  rather than numerical.

The deeper reason: forcing absolute certainty *inside the
scorer* is the heuristic-patching pattern. But filtering the
candidate space *upstream of scoring* isn't a patch — it's the
encoding of what we know about how the world works.

## Rule 2: probabilities are graduated and conditional

A single soft factor isn't enough — the framework requires that
factors compose to express graduated, jointly-conditional
beliefs. Pippijn's concrete example:

| Scenario                       | Plausibility | Why                          |
|--------------------------------|--------------|------------------------------|
| Walking for 8h while asleep    | ~0           | Sleepwalking is brief        |
| Driving for 8h while asleep    | ~0           | Would crash                  |
| On a plane for 8h while asleep | Plausible    | Long-haul flight             |
| On a train for 8h while asleep | Unlikely     | Sleeper trains exist, rare   |
| On a train for 30m while asleep| Plausible    | Power nap on the commute     |

This composes naturally from a per-minute `P(observed sleep_stage | mode)`
emission factor that varies per mode, combined with the
duration factor `P(d | mode)` and the joint MAP path. No special-
case logic, no flags, no thresholds. The probabilities multiply.

In code: every factor function returns `log P(observation | hidden_state)`
in the relevant condition (per-minute emission, per-segment
duration, per-transition entry boost). The Viterbi / forward-
backward inference does the rest.

## Rule 3: runtime budget is generous, but read-side is hard

> *"By 'quickly' I mean runtime: the user loads the page and
> wants to see 'your day'. It doesn't need to all happen live
> (we can do any amount of offline precomputes we need), but the
> user shouldn't wait minutes."*

The architectural consequence:

- **Heavy inference runs offline.** A cron job re-decodes
  recent days using the most expensive model we want; results
  land in the `decoded_days` cache table.
- **The page-load path is a single `SELECT decoded_days`.**
  Milliseconds of latency. No live decode, no live OSM fetch,
  no live HMM run.
- **Model complexity is bounded by the offline budget**, not the
  request budget. ~3–10 seconds per day of HSMM decoding is fine.
  60 seconds per day would be fine if the model improved enough
  to justify it.
- **Recompute over an N-day window**, never incremental
  accumulation. When parameters change (model retrains, place
  centroids drift, sleep tags update), we re-decode the whole
  recent window. Reproducibility > incremental cleverness.

## Rule 4: do it right, not MVP-shortcut

We are past MVP. The real architecture is in place; bolting on
"good-enough-for-now" code at this stage builds debt that the
framework will then have to work around forever.

Specific implications:

- **A new physical constraint** becomes a new soft factor in
  the existing emission / transition / duration interfaces. Not
  a special-case branch, not a flag, not a wrapper. If the
  framework doesn't accept the factor, extend the framework.
- **A new signal** (battery level, day-of-week pattern, HR
  intraday derivative) is plumbed into the `Observation`
  shape, weighted by a calibrated `P(signal | state)` factor,
  and added to the per-minute emission. It does not become a
  post-processing pass.
- **A new mode** (e-bike, scooter, plane) gets its own state in
  the state space, its own duration distribution, its own
  emission distribution. Not a sub-flag on an existing mode.
- **Calibration comes from data**, not from intuition. When in
  doubt, fit from heuristic-labeled minutes (or human-confirmed
  ground truth where it exists). Hand-tuned parameters are a
  bootstrap stage; every one is technical debt to be retired.

## Rule 5: expose uncertainty, never hide it

The MAP path was always a compromise — a single best guess that
collapses the model's actual posterior. The architectural
endpoint is the posterior over states per minute, exposed as
first-class output.

When the system is confident (overnight at Home: 99% one place),
the user sees a single definite answer. When the system is
genuinely uncertain (indoor cafe with three candidates within
50m, all consistent with the GPS noise model), the user sees the
top alternatives with their confidence percentages.

The output schema is therefore not `state[]` per minute, but
`distribution[]` per minute. The frontend renders the top-1
when confidence is high and surfaces top-3 when confidence is
mixed.

This rule has a corollary: **do not "improve" the system by
artificially sharpening the posterior.** Tighter Gaussians,
narrower priors, more aggressive vetos all *look* better in the
mode-only audit metric while hiding the model's actual
uncertainty. The metric to optimise is *calibration* (the
posterior matches the long-run frequency of being right), not
top-1 agreement.

## Rule 6: the user never edits the algorithm's output

**The user does not label, confirm, correct, override or
otherwise hand-feed the algorithm. Ever. There is no "was this
right?" prompt, no venue picker, no drag-the-track-here, no
tick-to-confirm. Zero user load.**

This is a hard rule, not a preference, and it holds even —
especially — when the algorithm is stuck.

The temptation is precise and it is seductive. The model narrows
an indoor cafe to two venues 13 m apart in the same building,
both plausible, and the fixes genuinely cannot separate them.
The obvious move is to show the two and let the user tap one.
It "works": the label becomes right, the user was only
inconvenienced once, and the answer is remembered forever.

It is a cop-out, for three reasons:

1. **It moves the cost of an unsolved inference problem onto the
   person the system exists to serve.** A dashboard that asks
   you to do its homework is a worse product than one that is
   sometimes wrong and says so.
2. **It caps the algorithm.** The moment a manual override
   exists, every hard case has a cheap escape, and the hard
   cases are precisely the ones that would have forced the model
   to get better. The 2 % of stays the model cannot name are
   where the remaining signal is; hand them to the user and that
   signal is never mined.
3. **It launders a modelling failure as a feature.** The picker
   *looks* like Rule 5 (surfacing uncertainty) but it is the
   opposite: Rule 5 says *show* the posterior, own the doubt, and
   go fix the model. A picker shows the posterior and then asks
   the user to collapse it.

A venue the model cannot name is a **bug**, and it stays open as
a bug. "The GPS genuinely cannot separate these two" is a
finding, not a resolution — it means the *geometry* cannot
separate them, and the answer is to find the signal that can:
the approach vector through the door, the dwell shape, the
opening hours, the biometric signature of a cafe versus a pub,
the sequence of what the user did before and after. When none of
those work yet, the honest output is the top candidate with its
uncertainty exposed (Rule 5) — never a question.

### What this rule does NOT forbid

- **Ground-truth narratives** (`tests/golden/ground-truth/*.md`).
  These are a *developer* test oracle, written offline, used to
  measure the algorithm and to fit parameters. They are how we
  know the model is wrong. They are not a runtime input and no
  user-facing surface writes them.
- **Explicit user *preferences*** that are not claims about what
  happened — home timezone, share-link settings, capture
  frequency. Configuration is not labelling.
- **Learning from behaviour the user produces anyway** — the
  mined focus places, venue-type priors, per-mode biometric
  signatures. The user is not being *asked* for anything; the
  system is inferring from data it already has.

The line is: **does the product ask the user to supply, confirm
or fix an inference?** If yes, it is forbidden, however small the
tap.

### History

A place-confirmation picker was built and shipped on 2026-07-12
(commit 49876af) for exactly the Urban Social case above, and
reverted the same day for exactly this reason. Do not rebuild it.
The venue is still misnamed; that is the correct state of the
world until the model earns it.

## The current generator constraints

These are the hard generator constraints — properties a
candidate state sequence must satisfy to be in the search space
at all. See `docs/proposals/decoder-roadmap.md`
for the architectural justification.

| Constraint | Applies to | Status |
|---|---|---|
| C1: Train `(board, line, alight)` triple — both stations on L, graph-connected on L's edge subgraph | `train @ L` segments | Planned (proposal Phase 1) |
| C2: Walking peak GPS speed ≤ 12 km/h | `walking` segments | Planned (proposal Phase 2; task #176) |
| C3: Stationary fixes within R_place of centroid | `stationary @ P` segments | Planned (proposal Phase 2) |
| C4: Adjacent segments share endpoint (station node, place polygon, or walkable handoff) | All transitions | Planned (proposal Phase 3) |
| C5: Sleep-window place ∈ lodging/residence POIs near last pre-sleep GPS | `sleeping @ P` segments | Partly shipped (post-midnight-place); proposal Phase 4 codifies |
| Back-to-back train legs share a station | Adjacent train segments | Shipped (task #175) |

When a generator constraint is planned but not yet shipped, the
soft factor that approximates it (e.g. route-rail-evidence
approximates C1) remains active. Shipping the generator
constraint retires the soft approximation.

## The current scorer factor library

These are the per-minute soft factors that score among
physically valid candidates produced by the generator. Each
returns a log-probability; the scorer sums them as the joint
log-likelihood of a candidate sequence. None is a hard
constraint — all are calibrated graduated preferences.

| Layer        | Factor                       | Source                              | Status   |
|--------------|------------------------------|-------------------------------------|----------|
| Initial      | Visit-frequency prior        | `focus_places.total_dwell_sec`      | Wired    |
| Emission     | Per-mode HR Gaussian         | Learned from heuristic labels        | Wired    |
| Emission     | Per-mode cadence (zero-inflated) | Learned from heuristic labels    | Wired    |
| Emission     | Per-mode speed Gaussian      | Learned from heuristic labels        | Wired    |
| Emission     | Per-mode GPS-presence Bernoulli | Hand-tuned uniform 0.85           | Wired    |
| Emission     | Per-place HR override        | Learned from heuristic labels        | Wired    |
| Emission     | Sleep state (`inBed`)        | Fitbit `sleep_stages`               | Wired    |
| Emission     | Asleep-HR override           | Universal asleep distribution        | Wired    |
| Emission     | Place-distance (heavy-tailed) | Gaussian capped at -3 nats          | Wired    |
| Emission     | Off-network log-prior        | Calibrated against place-distance    | Wired    |
| Transition   | Self-loop (HSMM duration-aware) | log(0.95) cross-mass split        | Wired    |
| Transition   | Hour-of-day entry boost      | `focus_places.hour_profile`         | Wired    |
| Segment      | Per-mode duration Gamma      | Hand-tuned from empirical histograms | Wired    |
| Pre-process  | GPS outlier filter           | Cluster-median 2km deviation        | Wired    |
| Pre-process  | GPS QC (anchor walk)         | Velocity pipeline `qualityFilterGps`| Wired    |

### Scorer factors being retired

These are scorer factors that approximated constraints which
properly belong in the generator. They remain wired until the
corresponding generator constraint ships, then are retired.

| Factor | Approximates generator constraint | Retired when |
|---|---|---|
| `route-rail-evidence` | C1 (train (board, line, alight) triple) | Phase 1 of constraint-first-decoder ships |
| `line-proximity-factor` | C1 | Phase 1 ships |
| `inner-viterbi-edges` for train-line scoring | C1 | Phase 1 ships |
| `geometric-feasibility` teleport-speed penalty | C4 (cross-segment continuity) | Phase 3 ships |
| `route-aware-decoder` (Phase 1 hierarchical Viterbi) | C1 + C4 | Phases 1 + 3 ship |

The route-graph extraction (Phase 0 of route-aware-decoder)
survives — it's the substrate the generator builds on.

Inference modes:

- **Viterbi MAP** (HSMM) — single best state sequence among the
  generator's candidate set; cached to `decoded_days`.
- **Forward-backward posterior marginals** (HSMM) — per-minute
  distribution over candidates; exposes confidence for
  user-facing presentation.

## Factors / constraints that are missing (the to-add list)

Generator constraints (filter the candidate space):

- **C1 through C5** as listed above. Phase 1 of
  `decoder-roadmap.md` starts on C1.
- **Cycling needs HR + cadence support**. A `cycling` candidate
  with HR < 90 and cadence ~0 across the segment is not
  physically a cycling candidate. (Task #139 is the soft-factor
  veto; the generator version is the structural form.)

Scorer factors (graduated preference among valid candidates):

- **HR continuity**: pair-wise factor on `|HR_t - HR_{t-1}|`.
  HR doesn't jump 50 bpm in one minute without a mode change.
- **Battery level**: low + decreasing implies the user isn't
  active; high + stable implies charging (often overnight at a
  known place).
- **Day-of-week patterns**: weekday vs weekend changes the
  prior over which places are visited at what hours.
- **Per-place duration distributions**: stationary @ Home is
  bimodal (short drop-ins + overnight stays); the per-mode
  Gamma can't fit both.
- **Per-amenity-class HR priors**: hospitals / clinics share a
  learned elevated-HR baseline; one-off visits to a new clinic
  inherit it.
- **Hierarchical / empirical-Bayes priors**: per-place fits
  draw from a hyper-prior so rare-data places aren't
  unconstrained. Already partly implemented (hyper-prior for
  unfitted places); needs the full hierarchical model.

## Audit and verification

Two complementary tools:

- **Mode-level agreement metric**: `compare-hmm-vs-heuristic`
  reports per-minute agreement between heuristic and HSMM. Good
  for catching mode-misclassification regressions. Blind to
  place attribution.
- **Side-by-side render (`--render`)**: per-minute timeline
  showing heuristic label and HSMM label side by side. Reveals
  place-level errors that the mode metric hides.
- **Posterior marginals (`--marginals`)**: per-hour top-3 states
  with their probability mass. Reveals the model's actual
  uncertainty.

Always render before declaring a change "an improvement." The
mode metric alone has misled this work multiple times.

## What this means in practice for new contributions

If you find yourself:

- Tempted to add a soft per-minute factor that's trying to
  penalise a *physically impossible* configuration (a train
  alighting in a tunnel, a walking segment moving at 60 km/h, a
  teleport between adjacent segments) → that's a generator
  constraint, not a scorer factor. Add it to the generator's
  candidate-enumeration code. See Rule 1.
- Tempted to *lie* about a per-minute physical fact to match a
  segment-level labelling convention (e.g. classify a cadence-
  confirmed walking minute as "train" because the convention
  absorbs intra-station walks into surrounding trains) → don't.
  The per-minute decoder stays physically honest. If the
  *labels* a user sees in their timeline differ from the
  per-minute classifications, that belongs in the composition
  layer (e.g. tube-journey wrapper), not in the decoder.
- Writing a `-Infinity` inside the scorer for an
  unlikely-but-possible case (a London → Karlsruhe teleport via
  GPS noise) → use a calibrated low log-prob (-10 to -15 nats)
  so the factor stays comparable in the MAP sum.
- Adding a flag / threshold / cutoff to control behaviour in
  the scorer → model whatever the flag is selecting between as
  two factors with different log-probs.
- Pushing through a tuning value that makes one day's audit
  number jump → re-render and check it didn't regress others;
  also check that the same change is justifiable from the data,
  not the day.
- Tempted to hard-lock a state when a strong signal fires
  ("definitely asleep, must be stationary") → factor it as a
  per-minute soft factor with a strong log-ratio; let the
  composition speak. (The "asleep ⇒ stationary" rule is in
  practice a generator constraint, since the Fitbit signal is
  external evidence about which configurations are possible.)
- Adding a fast path / heuristic for "the common case" → don't.
  Generator + scorer is supposed to BE the common case.
- Tempted to ask the user — a confirm prompt, a venue picker, a
  "was this right?", a drag-the-track handle — because the model
  is stuck on a hard case → **no.** See Rule 6. The hard case is
  the work. Ship the top candidate with its uncertainty exposed
  and leave the bug open.

These aren't style preferences — they're the difference between
a probabilistic system that respects physics and a stack of
patches with a Bayesian veneer.
