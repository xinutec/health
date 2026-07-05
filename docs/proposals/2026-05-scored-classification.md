---
status: active
created: 2026-05-13
updated: 2026-05-23
references:
  - ../archive/2025-model-hmm.md
  - ../archive/2025-priors.md
---

# Roadmap — scored-classification refactor

An incremental path toward the same goal as `../archive/2025-model-hmm.md`:
classify each segment by combining multiple lines of evidence with explicit
scores, instead of layering hand-tuned rule cascades that we keep patching.

This roadmap does **not** commit to the full HMM in `2025-model-hmm.md`. It
delivers shippable value at the end of each phase, and absorbs ~30-50%
of the work an HMM rewrite would need anyway. After Phase 3 we can
decide whether to escalate to 2025-model-hmm.md's joint-Viterbi rewrite or keep
iterating with more factors.

This is **not** strictly faster than 2025-model-hmm.md (the incremental path
totals 8-10 weeks; 2025-model-hmm.md totals 8-9). The benefit is that each phase
ships independent improvements, and the system can stop at the point
its accuracy is good enough — without committing the full HMM budget
up front.

## Why a new roadmap

Today's pipeline mixes two paradigms:

- **Soft-likelihood:** `segments.ts:scoreWindow` (Gaussian range-scores
  per mode) and `mode-biometrics.ts:scoreModeLogLikelihood` (per-user
  HR/cadence emissions) both produce real probabilities.
- **Hard rules:** `osm.ts:refineMode` (priority cascade) and
  `velocity.ts:annotateRailRuns` (local heuristics) are if/else trees we
  keep adding cases to.

A recent session shipped five separate patches to the hard-rule
layers for what is structurally one problem: *the labeller chose
an explanation that didn't match the actual route, because each
rule decided locally without seeing the full evidence.* The same
root cause that 2025-model-hmm.md addresses with a full HMM.

The bet of this roadmap: we can absorb most of that bug class with
**factor-decomposed scoring + a commute-history prior + careful mining
lifecycle**. The numeric refinement layer fits factor decomposition
well; the structural layer (mode dispatch, segment merging, gap
inference) stays as a reduced cascade wrapping the factor scorer.

The user's directive on data mining: do this properly, iterate, don't
rush. The mining-lifecycle infrastructure is treated as a first-class
concern, not a side-effect of Phase 2. See "Mining lifecycle and
version handling" below.

## Relationship to 2025-model-hmm.md

| Aspect | This roadmap | 2025-model-hmm.md |
|---|---|---|
| Per-segment scoring | Factor decomposition with weighted log-likelihoods | Same |
| Cross-segment coupling | None (per-segment max-score) | Viterbi joint MAP |
| Personal history | Frequent-route prior keyed by (start, end, time bin) | Full transition matrix per state, EM-learned |
| Biometric signal | Reuses today's `correctModeBySignature` LL test as a factor | Subsumed into per-state emission |
| OSM | Today's `nearbyWays` / `nearbyStations` queries; refineMode rewired to score candidates | Station-graph hard-zeros baked into transition prior |
| Fixture supervision | 3 fixture days for Phase 1 calibration + bootstrap-bias audit | 10-15 fixture days for EM hard-constraints |
| Schema additions | journey_patterns + classifier_version columns; no segment_explanations | model_states, model_emissions, model_transitions, line_stations, decoded_days, model_metadata |
| Budget | 8-10 weeks for full pipeline | 8-9 weeks for full system |

### Forward-compatibility, honestly accounted

Earlier framing claimed "~80% forward-compatible with 2025-model-hmm.md." On
closer inspection, that's optimistic. Reality:

**What survives a future HMM rewrite (~30-50% of this roadmap's work):**

- #80 (focus_places.id stability). 2025-model-hmm.md's Phase 0a; same code.
- Factor implementations as pure functions: `biometric-ll`,
  `osm-distance`, `mode-coherence`, `rail-road-tiebreak`,
  `station-line-intersection`, `walking-pace-sanity`. These become
  emission components in 2025-model-hmm.md's state-specific distributions.
- Classifier-version tracking + re-classification walker.
  2025-model-hmm.md describes the same pattern as `decoded_days` +
  `model_version` (line 466-489 of 2025-model-hmm.md).
- Fixture day infrastructure (capture-day CLI, fixture JSONs). The
  10-15 days 2025-model-hmm.md needs are a superset of the 3 days Phase 1
  needs; the capture pipeline is identical.
- The `?explain=1` API endpoint (the response schema changes but the
  endpoint stays).

**What gets thrown away on an HMM rewrite (~50-70%):**

- `journey_patterns` table. Per-trip aggregates aren't a starting
  point for 2025-model-hmm.md's per-minute transition matrix. The HMM mines
  raw observations, not aggregated trips.
- `commute-prior` factor. Subsumed by the HMM's transition prior.
- The cascade structure (wrapping the factor scorer). 2025-model-hmm.md
  replaces it with Viterbi, not a wrapper around emissions.
- Per-day candidate enumeration logic (the alternative station pairs).
  HMM's `(mode, place, line)` state space subsumes this differently.
- The UI factor-breakdown panel. HMM produces posterior probabilities
  and Viterbi paths, a different explanation surface. The endpoint
  survives; the response schema and frontend rendering get redone.

This is a smaller carryover than the previous draft of this doc
implied. **Honest framing: ~30-50%.** The roadmap is still a useful
incremental path — each phase ships independent value — but it is
not a free preview of 2025-model-hmm.md.

## Pre-existing work this builds on

- **#79 [done]** — `confidence` normalisation. `TrackSegment` now carries
  a proper probability and a separate `confidenceMargin`, prerequisite for
  any factor-weighted scoring.
- **#81 [done]** — station-graph in `refineMode`. The line-intersection
  logic in `annotateRailRuns` already constrains start/end stations to
  lines that serve both endpoints — that's the station-graph idea, built
  inline. It produces useful signal today; the refactor below makes it a
  named factor.
- **#82/#83 [done]** — mode biometrics. `scoreModeLogLikelihood` is
  exactly the per-modality log-likelihood the factor framework needs.
  Already in use as a re-classification gate; the refactor reuses it as a
  scoring factor.
- **#86 [done]** — per-cluster amenity-label mining. Will become an
  additional factor in stationary-segment labelling.

## Pre-existing work this depends on

- **#80 [pending]** — stable `focus_places.id` across rebuilds. **Hard
  precondition for Phase 2.** The commute-history prior is keyed by
  cluster pairs, which requires cluster IDs that don't churn nightly.
  Phase 1 can proceed without it; Phase 2 cannot.

## Phase 1 — Factor-decomposed scoring + reduced cascade (2-3 weeks)

Goal: turn the *numeric* parts of `refineMode` and `annotateRailRuns` into
named factors with weighted log-likelihoods. Keep the *structural* parts
(dispatch, merging, gap inference) as a reduced cascade that wraps the
factor scorer.

### What becomes a factor vs what stays as cascade

This roadmap was initially framed as "replace the cascade." That's wrong
on closer inspection. `refineMode` and `annotateRailRuns` mix two kinds
of logic:

- **Numeric refinement** (which mode/way wins given comparable signal):
  the rail-vs-road tie-break, the driveable-over-footway preference,
  the line-intersection check. These are genuinely factor-shaped — each
  is a continuous score over candidates.
- **Structural dispatch + rewrites:** the aeroway branch in `refineMode`
  *overwrites* the segment's mode to `plane`/`stationary` regardless of
  other signals; `annotateRailRuns` *merges* multiple segments into one
  and *absorbs* short platform-stationaries between rail-likes;
  `inferTransitGaps` produces synthetic segments from GPS gaps. None
  of these have a natural representation as `Σ factor_i` — they're
  rewrites of the segment list shape.

Phase 1's honest scope: **port the numeric layer, keep the structural
layer.** The result is a factor scorer wrapped by a smaller cascade.
Concretely:

```
                                       ┌──────────────────────┐
input segments                         │ structural cascade   │
                                       │ (preprocessing)      │
                                       │  • aeroway dispatch  │
                                       │  • plane override    │
                                       │  • inferTransitGaps  │
                                       └──────────┬───────────┘
                                                  ▼
                                       ┌──────────────────────┐
                                       │ candidate generator  │
                                       │ (enumerate plausible │
                                       │  mode + way_name +   │
                                       │  station-pair tuples)│
                                       └──────────┬───────────┘
                                                  ▼
                                       ┌──────────────────────┐
                                       │ factor scorer        │
                                       │  • speed-emission    │
                                       │  • osm-distance      │
                                       │  • mode-coherence    │
                                       │  • rail-road-tie     │
                                       │  • station-line-int  │
                                       │  • biometric-LL      │
                                       │  • walking-sanity    │
                                       └──────────┬───────────┘
                                                  ▼
                                       ┌──────────────────────┐
                                       │ structural cascade   │
                                       │ (postprocessing)     │
                                       │  • rail-run merge    │
                                       │  • platform absorb   │
                                       │  • physical limits   │
                                       └──────────┬───────────┘
                                                  ▼
                                       enriched + scored segments
```

The win is in the middle layer. The wrapping cascade shrinks to ~30%
of today's `refineMode` + `annotateRailRuns` line count.

### Candidate enumeration is the precondition for Phase 2

Phase 2's commute prior can only demote a wrong label if the *right*
label is in the candidate set. Today's `annotateRailRuns` returns one
station pair — picking the wrong pair in observed bug cases gave
the system no recovery path.

Phase 1 must therefore enumerate **alternative candidates** in the
candidate generator, not just produce a single best. Concretely for
rail-run annotation: enumerate the top-K station pairs from
`nearbyStations` at both endpoints (K=3-5), filter through the
line-intersection constraint, and emit each as a separate scored
candidate. The factor scorer then picks the highest-total, and
alternatives are retained for Phase 2's prior to lift if needed.

This is real work — it's not in today's code and the doc previously
elided it. Adds about a week to Phase 1.

### Deliverable shape

```ts
interface FactorScore {
    name: string;          // "speed-emission", "osm-rail-distance", "biometric-ll", ...
    score: number;         // in nats of log-likelihood
    rationale: string;     // human-readable: "rail 18m, road 32m → rail closer"
}

interface ScoredCandidate {
    mode: string;
    wayName?: string;
    factors: FactorScore[];
    totalScore: number;    // sum of factor scores
}

interface ModeRefinement {
    best: ScoredCandidate;
    alternatives: ScoredCandidate[];   // top-N alternatives, score-ordered
    margin: number;                    // best.totalScore - alternatives[0].totalScore
}
```

`EnrichedSegment` gains an optional `factorBreakdown: ModeRefinement`
field. UI doesn't consume it yet; the data is plumbed through so Phase 3
can render it.

### Factor inventory at end of Phase 1

The factors below come from today's rule cascade plus two failure-mode
gaps the cascade doesn't address.

**Reused from today (the numeric layer):**

- **`speed-emission`** — from `segments.ts:normalizeScores`. Already a log
  probability per mode; this factor just unpacks it.
- **`osm-distance`** — distance from each sample point to the nearest
  way/rail/station of each candidate's class. Today's `NearbyWay.distanceM`
  is the raw data; the factor turns it into `-log(distance / scale)` per
  class.
- **`mode-coherence`** — penalises mode/way mismatch at high speed
  (driving on footway, walking on motorway). Subsumes #99's
  `pickBestHighway`.
- **`rail-road-tiebreak`** — when both are nearby, prefer the closer one.
  Subsumes #100's distance-aware Betuweroute guard.
- **`biometric-ll`** — wraps `scoreModeLogLikelihood`. Already a log
  probability; passes through.
- **`station-line-intersection`** — for rail segments, +N nats when
  candidate boarding + alighting stations share a line, –N when they
  don't. Promotes today's `linesAtPoint` intersection from a bare label
  appendix to a scoring factor that can rule out implausible station
  pairs.
- **`walking-pace-sanity`** — the slowBefore / after gate from #100/#101.
  When apparent velocity between two fixes exceeds walking-pace ceiling,
  this factor docks score from any candidate that uses the later fix as a
  pedestrian-context lookup.

**New factors needed to address today's gaps:**

- **`cycling-signature`** — flagged in `2025-model-hmm.md` as a primary motivation
  (cycling-as-driving is one of the named bugs). Cycling has a distinct
  signature: elevated HR + near-zero cadence + sustained 15-25 km/h. The
  `biometric-ll` factor handles this *if* the user has a cycling
  `mode_biometrics` row, which only exists when prior history already
  classified some segments as cycling correctly — a chicken-and-egg
  problem for casual cyclists. This factor adds an explicit additive
  bonus for "cycling-like signal" derived from speed + HR + cadence
  *jointly*, independent of the per-mode emission lookup.
**Note on gap segments (handled by the cascade, not by a factor):**
`inferTransitGaps` produces synthetic segments with `pointCount: 0`
(no GPS observations for the gap minutes). Most factors have null
input for such segments. Earlier drafts of this roadmap proposed a
`gap-segment-handling` factor; on reflection that's structural work
(synthesising a segment from a gap, deciding it's plausibly a tube
ride) that belongs in the preprocessing cascade — same place
`inferTransitGaps` lives today. Phase 1's cascade keeps that logic
and adds explicit handling for "score this synthetic segment using
endpoint-station and duration signals only," so the factor scorer
sees a candidate with non-null inputs even when GPS is empty in the
middle. No new factor; the existing cascade gains ~30 lines.

### Biometric-corrector migration

The existing cascade has a per-segment biometric pass —
`applyBiometricSignature` in `src/geo/velocity.ts`, which delegates
to `correctModeBySignature` + `gateCycling` + `vetoImplausibleHr` +
`vetoImplausibleCadence` in `src/geo/mode-biometrics.ts` — that runs
*after* `refineMode` and can override anything the refinement picked.
On segments where the biometric corrector fires, refineMode's output
is effectively advisory. The 2026-05-23 backtest surfaced this as a
class of bugs the factor scorer cannot address by adding more factors
on top: a low-speed segment classified as walking, OSM-refined as
walking, then promoted to "train" by the biometric corrector because
"low HR + no cadence" matched the corrector's sitting-on-a-train
biometric signature. The factor scorer never saw a train candidate
to dock.

The migration brings the corrector's logic into the factor scorer so
biometric evidence composes with everything else instead of running
as a separate override pass.

**Decomposition of `correctModeBySignature`:**

| cascade piece | factor equivalent | new? |
|---|---|---|
| `scoreModeLogLikelihood` (per-mode HR/cadence/speed LL) | `biometric-ll` | exists |
| `vetoImplausibleHr` / `vetoImplausibleCadence` | `biometric-veto` | new |
| confidence-margin gate ("don't relabel a confident classification") | `classifier-prior` | new |
| `NEVER_FLIP_TARGET` (never flip INTO cycling) | `mode-prior` | new |
| `RELABEL_MIN_BIOMETRIC_OBS` gate | natural via null factor | — |
| `SIT_MODES` rule (don't flip sit→sit) | candidate-generator filter | — |
| `MAX_SPEED_FOR_MODE` cap | candidate-generator filter | — |

`biometric-veto` produces a very large negative score for the
disqualified mode, achieving the cascade's binary-veto effect through
the additive score sum. `classifier-prior` gives the original
classifier mode a bonus scaled by `confidenceMargin` — captures the
cascade's "don't override a confident classification on weak
biometric evidence" intuition, without which the factor scorer would
happily flip a high-margin classification on small LL deltas.
`mode-prior` is a small fixed negative score on cycling candidates;
the existing cycling-signature factor (Phase 1 inventory above)
provides the positive offset cyclists actually trip.

**Structural change:**

`applyBiometricSignature` runs as a sequential pass with the
biometric stream already loaded. The factor migration requires
biometrics to live in `FactorContext` *when refineMode runs*. The
velocity pipeline has to load biometrics earlier — or refineMode's
call site has to move after biometric load — so the factor pass
sees the same context the cascade saw.

**Two-flag staging:**

A second feature flag `USE_BIOMETRIC_FACTOR=1` gates the migration
*under* the existing `USE_FACTOR_SCORER=1` flag. The three relevant
combinations:

| `USE_FACTOR_SCORER` | `USE_BIOMETRIC_FACTOR` | path |
|---|---|---|
| unset | unset | legacy cascade (current prod) |
| `1` | unset | factor scorer for refineMode; biometric cascade still runs |
| `1` | `1` | factor scorer with biometric factors; biometric cascade skipped |

This lets the backtest CLI compare flag-on vs flag-off at each
migration stage without disturbing the others, and keeps every
combination shippable.

**Calibration open questions** (do these before settling weights):

- `classifier-prior` magnitude — today's cascade gates relabel
  on `confidenceMargin >= RELABEL_MAX_MARGIN` (effectively
  infinite bonus on the original mode above that margin). The
  factor needs a finite number large enough to dominate weak
  biometric evidence but not strong evidence. Calibrate against
  the fixture days; the binding test cases are (a) a
  high-confidence walking segment with a marginal biometric
  signal favouring driving (must stay walking) vs (b) a
  low-confidence driving segment with strong biometric evidence
  for cycling (must flip to cycling).
- `mode-prior` magnitude for cycling — the hard "never flip INTO"
  rule is asymmetric; cycling can be flipped *out of* but not
  *into*. As a fixed negative prior the magnitude needs to be
  exceeded by the cycling-signature factor's positive evidence
  but not by `biometric-ll` alone. Add `cycling-signature` before
  calibrating this one.

**Migration order:**

1. Reading + design pass (this section). **Done.**
2. Add `biometric-veto`, `classifier-prior`, `mode-prior`
   factors. Each gets unit tests in isolation. **Done with one
   amendment: `biometric-veto` was reshaped from a soft factor into
   a candidate-generator filter under the `#182` cleanup (a binary
   veto disguised as a probability is shape-wrong; the same effect
   lives correctly in the generator's `BiometricContext` filter).
   `mode-prior` and `classifier-prior` shipped as soft factors.**
3. Extend `FactorContext` to carry biometric observation +
   user mode stats + classifier confidence-margin. Extend the
   candidate generator with the `SIT_MODES` / `MAX_SPEED_FOR_MODE`
   filters. **Done — `originalMode`, `confidenceMargin`,
   `biometricObs`, `modeStats` all on `FactorContext`; candidate
   generator filters by HR + cadence implausibility.**
4. Move biometric load earlier in the velocity pipeline so
   refineMode's call site has the context. **Done — `velocity.ts`
   awaits the biometric + mode-stats loads before segment
   enrichment when `useBiometricFactor()` returns true.**
5. Add the `useBiometricFactor()` flag and the parallel path in
   `refineMode` (or alongside it). **Done — flag in
   `factors/feature-flag.ts`; `refineModeViaFactors` adds the
   biometric stack (`biometric-ll`, `mode-prior`, `classifier-prior`)
   when `biometric` is provided; `applyBiometricSignature` pass
   skipped under the flag to avoid double-correction.**
6. Backtest the migrated path vs the existing factor path vs the
   legacy cascade. Iterate on calibration until the migrated path
   is decisively better than each of the others. **In progress —
   `scripts/backtest.sh --compare biometric` does the migrated vs
   scorer-only comparison; `--compare scorer` does scorer vs legacy.
   Three fixture days captured (`2026-05-{16,18,22}`); calibration
   pass against them is the next concrete step.**
7. Retire `applyBiometricSignature` + `gateCycling` as separate
   passes once the migration is on by default. **Pending — keep both
   in place while `USE_BIOMETRIC_FACTOR` is opt-in. Remove after the
   flag has been on in prod through one calibration cycle.**

### Calibration

Factor weights are flat at first (all 1.0). After Phase 1 is in place,
backtest against the fixture days (see "Fixture infrastructure" below)
and tune weights so backtest segment-mode agreement matches or beats the
current baseline on those fixtures. **The doc was originally silent
on fixtures.** Phase 1 has to capture at least 3 fixture days
(a routine commute, a multi-leg-with-misclassification trip, and a
short-visit grocery stop) before calibration is meaningful.
Adds ~3 days.

### Files modified

- `src/geo/osm.ts` — `refineMode` returns `ModeRefinement` (object) not
  `{mode, confidence, reason, wayName}`. Internal helpers like
  `pickBestHighway` move into factor implementations.
- `src/geo/velocity.ts` — `annotateRailRuns` adopts the same shape. The
  station-pair lookup becomes a `station-line-intersection` factor.
- `src/geo/factors/` — **new directory.** One file per factor, each
  exporting a pure function that takes a candidate + context and returns
  a `FactorScore`. Test each in isolation.
- `tests/factors/*.test.ts` — **new.** Per-factor unit tests; replace the
  scattered tests in `osm.test.ts` and `velocity.test.ts` that pin rule
  outcomes.
- `src/cli/backtest-classification.ts` — **new, Phase 1 deliverable.**
  Runs analyze-day across a date range, compares the factor-decomposed
  output against the current production output. Used in Phase 1 to
  verify the cascade-to-factor port is behaviour-preserving on the
  corrected baseline; used in Phase 2 to measure prior-induced
  improvement; used by the CI snapshot check to detect drift.
- `tests/fixtures/days/*.json` — **new.** 3-5 fixture days captured
  via `capture-day.ts` (also new). Covers normal commute, a
  Baker-Street-style edge case, a grocery-shop visit. Reused by
  Phase 2 fixture-validation and by the CI snapshot.

### Success criteria

- Captured fixture-day outputs match the pre-Phase-1 baseline: each
  fixture's segments are labelled with the same modes and station
  pairs as the cascade-based classifier produces at the moment Phase 1
  begins. Note: this is **not** "bit-identical to a frozen snapshot"
  — Phase 1 must be free to fix issues the cascade still has, so long
  as the corrected fixture days remain correct after re-capture.
- Per-segment `factorBreakdown` field is populated and inspectable in raw
  JSON output (no UI yet — Phase 3).
- For rail-run segments: **alternative candidate station-pairs** are
  enumerated and present in `factorBreakdown.alternatives`. Today's
  output has a single station pair; Phase 1 must produce 2-5.
- New per-factor tests replace the ~12 patch-specific rules in current
  tests. Each factor is a pure function with its own unit tests.
- Total scoring pass time per segment is < 5 ms on real data
  (factor evaluation is O(samples × factors), ~50 ops each).

### Out of scope

- Frontend changes. Phase 3 handles UI rendering.
- Per-user history mining (commute priors). Phase 2.
- Replacing the structural cascade (aeroway dispatch, rail-run merge,
  gap-segment synthesis). These stay; they get shorter but don't
  disappear.

## Phase 2 — Commute-history prior + classifier-version tracking (3 weeks)

**Preconditions:**
- #80 (`focus_places.id` stability) must land first.
- Phase 1's candidate enumeration for rail-runs (the prior can only
  lift the right answer if it's in the candidate set).

Goal: add a factor that boosts candidates matching historical
journey patterns for the same cluster pair, hour-of-day, and day-
of-week. This addresses the class of bug where a one-off
GPS-noise-induced wrong station-pair gets picked over a station-
pair that the user travels every working day — **provided Phase 1's
alternative-candidate enumeration includes the correct station-pair
as one of the candidates**. The prior cannot rescue a candidate
that wasn't generated; Phase 1's candidate generator is the
upstream dependency.

This phase also adds the **classifier-version tracking** infrastructure
that mining requires (see "Mining lifecycle" below).

### New table

```sql
CREATE TABLE journey_patterns (
    user_id            VARCHAR(64) NOT NULL,
    start_cluster_id   INT NOT NULL,        -- FK focus_places.id (requires #80)
    end_cluster_id     INT NOT NULL,        -- FK focus_places.id
    hour_bin           TINYINT NOT NULL,    -- 0-23, ALWAYS in segment's displayTz
    dow_bin            TINYINT NOT NULL,    -- 0-6 (Sunday=0), in displayTz
    mode               VARCHAR(16) NOT NULL,
    way_name           VARCHAR(128) NULL,   -- e.g. "Station A → Station B"
    line_name          VARCHAR(64) NULL,
    observation_count  INT NOT NULL,        -- decayed count (not raw)
    last_seen          DATE NOT NULL,
    classifier_version INT NOT NULL,        -- version of classifier that produced source segments
    PRIMARY KEY (user_id, start_cluster_id, end_cluster_id, hour_bin, dow_bin, mode, way_name)
);
```

Each row records "the user made this journey (mode + waypoints + line) at
this hour/dow with `observation_count` decayed weight, most recently on
`last_seen`."

**Timezone binning is a requirement, not an open question.** `hour_bin`
and `dow_bin` are always computed in the segment's `displayTz`, not UTC.
A user travelling between time zones must not have their commute pattern
silently corrupted by UTC binning. The mining job reads `displayTz` from
each source segment and bins accordingly.

### Decay policy (explicit)

Exponential decay with **45-day half-life** for `observation_count`. A
move-house or job-change event takes ~3 months to dominate; an
occasional "took a different route home" doesn't disturb the
established pattern. The 90-day half-life originally proposed was too
slow — a moved-home user would see months of wrong priors. 45 days
is the right trade-off for a single-user system.

Additionally: an admin endpoint `POST /api/admin/reset-commute-history`
that truncates `journey_patterns` for a given user. Used after a
deliberate life change (moved house, changed job) to start fresh
without waiting 3+ months for decay.

### Mining job

Nightly cron `mine-journey-patterns.ts`. Runs at 03:30, after the
re-classification walker (see "Mining lifecycle" below) has had time
to refresh stale segments:

1. Load all `EnrichedSegment` rows for the user from the past 180 days
   **where `classifier_version = CURRENT_CLASSIFIER_VERSION`**. Skip
   rows tagged with older versions.
2. If < 90 days of current-version data exist, **skip mining entirely**
   for this user — too sparse to produce a reliable prior, and the
   bootstrap-bias risk dominates.
3. For each non-stationary segment, identify the preceding and following
   stationary clusters (via `focus_places.id`, requires #80).
4. Bin by `(hour_bin, dow_bin)` in segment's displayTz; group by
   `(start_cluster, end_cluster, mode, way_name)`; count with decay
   weight `exp(-Δdays · ln 2 / 45)`.
5. **Truncate and rewrite** the user's `journey_patterns` rows. No
   incremental updates — the small data size makes from-scratch rewrite
   safe and ensures the table is always consistent with the
   classifier-version filter.

### Bootstrap-bias audit (required before wiring the prior in)

The reviewer's biggest concern, and the user's explicit directive: do
this properly, don't rush. Mining `journey_patterns` from historical
`EnrichedSegment.wayName` rows produced by the *old* classifier risks
encoding old bugs as priors. Before the commute-prior factor is enabled
in production, the following audit must pass:

1. **Re-classify a 30-day window with the post-Phase-1 classifier**
   (using the version-tagged cache, see Mining lifecycle). This
   guarantees the mining job reads only current-version labels.
2. **Manually review the top-20 most-frequent journey patterns** by
   `observation_count` for each user. Flag any with a suspicious
   `way_name` (e.g. a station pair that doesn't match the user's
   known routine) for inspection.
3. **For each flagged pattern**, re-run analyze-day on a sample of
   contributing dates and verify the labels look right under the
   current classifier. Patterns that look wrong even under the
   corrected classifier indicate either a deeper bug or a real
   user behaviour (a road closure that genuinely changed the route
   during the audit window) — surface both for human judgment.
4. **Block prior enablement** until the audit produces zero
   unresolved flagged patterns.

This adds ~3-5 days of work to Phase 2. It's the difference between
"the prior probably works" and "the prior is auditably correct."
Per the user's directive: get this right, don't rush.

### Fixture validation

Three fixture days (added in Phase 1 calibration) get re-run with the
commute-prior factor enabled:

- **Daily commute day:** the prior should boost the correct route to
  the highest-total candidate. If it doesn't, the factor weight is
  too low or the candidate enumeration is missing the right pair.
- **One-off route day:** the user took a non-routine route. The prior
  should be near-zero (no `journey_patterns` row for that
  cluster-pair); other factors must still produce a correct label.
  If the prior fires anyway, the smoothing constant `α` is too high.
- **Moved-home simulation:** synthesise a scenario where the user's
  start cluster shifts. Verify that within ~3 months of simulated
  data, the old prior decays to negligible weight.

If any fixture fails, Phase 2 doesn't ship.

### New factor

`commute-prior` reads `journey_patterns` for `(start, end, hour, dow)`.
Returns a log-prior:

```
score = log((observation_count + α) / total_observations_in_bin)
```

with `α = 0.5` Laplace smoothing. Unseen but plausible journeys still get
nonzero (small) prior; frequently-observed journeys get high prior.

### Scope of the boost

Apply the prior only when:

- Both start and end clusters resolve to known `focus_places`.
- `total_observations_in_bin >= 3` (otherwise smoothing dominates and the
  prior is uninformative).
- The candidate's `mode` and `way_name` match a known pattern.

This is **deliberately weak.** The prior nudges decisions but cannot
override strong evidence from other factors. A novel-but-real journey
(first time taking a new route home) still gets correctly classified
because the speed/OSM/biometric factors dominate.

### Calibration

Factor weight starts at 1.0 in log-prob units. Backtest against fixture
days; if the prior overrules correct one-off classifications, lower the
weight; if it doesn't influence repeat commutes enough, raise.

### Files modified

- `src/db/schema.ts` — migration v30 with `journey_patterns`.
- `src/db/tables.ts` — table interface.
- `src/cli/mine-journey-patterns.ts` — **new.** Nightly mining job.
- `k8s/04-cronjob.yaml` — schedule mining job.
- `src/geo/factors/commute-prior.ts` — **new.** Reads patterns, scores
  candidates.

### Success criteria

- Mining job populates `journey_patterns` from 180 days of history in
  < 60 s.
- Per-user pattern count fits in DB (< 10k rows per user).
- On a fixture day where the user takes their daily commute, the
  `commute-prior` factor contributes ≥ +2.0 nats to the correct
  candidate vs alternatives.
- On a representative routine-commute fixture, the correct station
  pair receives `commute-prior: +2.5 nats`, and a previously
  misclassified neighbouring-station alternative appears in the
  candidate list with a lower total score (now correctly demoted).

### Out of scope

- Per-line preference (e.g. user prefers Met over Jubilee on a route
  where both work). Defer — needs more data and could come as part of
  Phase 4.
- Live updates during the day. Mining is nightly; today's segments use
  yesterday's snapshot of patterns. Same as biometric signatures today.

## Mining lifecycle and version handling (cross-cutting, ~1 week)

This is shared infrastructure that Phase 2 introduces and that all
three existing mining jobs (`refresh-focus-places`, `mine-mode-
biometrics`, plus the new `mine-journey-patterns`) need to adopt.
Treating it as a top-level concern, not a Phase 2 sub-step, because
**all three jobs have the same circular-dependency risk** and the
user's directive is: do this properly.

### The loop

```
Classifier (factors + cascade)
     ↓ produces
EnrichedSegment.{mode, wayName, refinedMode, line}
     ↓ mining reads as ground truth
journey_patterns, mode_biometrics
     ↓ fed back as priors / factors into
Classifier
```

When the classifier changes — exactly what happened five times on
in any recent multi-fix session — the cached `EnrichedSegment` rows
in the DB reflect the
*old* classifier. Naive nightly mining reads those and produces priors
that bake in old bugs as ground truth. The reviewer's #1 concern; the
user's stated reason to slow down.

### Mechanism

**Add `classifier_version INT` to:**
- `EnrichedSegment` (in the per-day decoded cache, wherever that lives —
  currently it doesn't exist as a persistent table; Phase 2 introduces
  it, see schema below).
- `mode_biometrics` (per-user-per-mode signatures get a version tag).
- `journey_patterns` (already specified above).

**New `decoded_days` table (Phase 2 introduces this):**

```sql
CREATE TABLE decoded_days (
    user_id            VARCHAR(64) NOT NULL,
    date               DATE NOT NULL,                -- in segment's displayTz
    classifier_version INT NOT NULL,
    segments_json      MEDIUMTEXT NOT NULL,           -- array of EnrichedSegment
    decoded_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, date),
    INDEX idx_user_version (user_id, classifier_version)
);
```

**Size estimate.** Per-day-per-user row, ~5-20 KB serialised
(~10-30 segments at ~500 bytes each, including factor breakdowns).
180 days × 1 user = **~2 MB total** today. At 10 users it's ~20 MB.
Bounded; no growth concern. The `idx_user_version` index makes the
"find rows with old classifier_version" query O(log n) for the
stale walker.

This table also serves Phase 3's `?explain=1` query path — the
factor breakdown is read from `segments_json` without re-running
the classifier.

**Define a code constant:**

```ts
// src/geo/classifier-version.ts
export const CURRENT_CLASSIFIER_VERSION = 2;
// Bumped by hand when factor weights or factor implementations change
// in ways that materially affect labels. Adding a new factor: bump.
// Tightening a threshold: bump. Refactoring a factor without
// changing semantics: don't bump (unit tests should prove unchanged
// output on fixtures).
```

The version is bumped **at code-review time**, by the engineer making
the change, with a comment in the commit message explaining what
labels are expected to drift. Not auto-incremented from package.json
— that would be too granular. Not implicit — that risks forgetting.

**CI enforcement.** Process-only "remember to bump" is a known
landmine. We back it with a CI check: a `classification-snapshot`
fixture set is checked in; the classifier produces a label for each
segment. On every PR, the snapshot is re-generated and compared to
the checked-in version. If labels differ AND
`CURRENT_CLASSIFIER_VERSION` did not change, the build fails with a
message instructing the engineer to either revert the behaviour
change or bump the version (and update the snapshot in the same
PR). This makes "bump on label change" mechanical rather than
disciplinary.

The snapshot fixture set covers one segment per known failure
category so the CI check catches regressions across all the rules
we've patched:

- one motorway/secondary driving segment (rail-road tie-break)
- one footway/pedestrian walking segment (driveable-vs-pedestrian)
- one Tube ride with a non-disembark intermediate station (alight-fix
  speed threshold)
- one inferred-from-gap transit segment (gap-handling)
- one cycling segment with HR+cadence (cycling-signature)
- one boarding from preceding-stationary vs walked-from-stationary
  (walking-pace sanity)
- one home/work cluster-pair commute (commute-prior, added in Phase 2)

Captured via `capture-day.ts` (Phase 1 deliverable, shipped
2026-05-13). The captured fixtures contain real GPS + biometric
data, which violates the "no private data in test fixtures" rule
and so they are gitignored under `tests/fixtures/days/`.

**Synthetic CI fixtures are a separate Phase 1 deliverable.** The
CI snapshot test cannot use the real captured fixtures. It needs
hand-authored synthetic fixtures with made-up coordinates, made-up
station names, and made-up biometrics — designed to cover each
failure category. Probably stored under `tests/fixtures/synthetic/`
to make the distinction obvious. Calibration uses the real
fixtures (local-only); CI uses the synthetic fixtures (in repo).
This separation is load-bearing: the CI check is the version-bump
forcing mechanism, and it must run on every PR without private
data leakage.

**Rollback story.** Bumping the version triggers re-classification
of historical days. If the new classifier turns out *worse* on the
top-20 audit (see "Bootstrap-bias audit" above), we need a way back:

1. Revert the code change in a new commit. `CURRENT_CLASSIFIER_VERSION`
   stays at the (now-current) bumped value — version numbers only go
   up.
2. Bump `CURRENT_CLASSIFIER_VERSION` again in the revert commit (so
   the re-classification walker refreshes the cache with the reverted
   classifier's output).
3. Mining gates on the new version; previous-version cache rows are
   ignored.
4. Within 2 nights, mined priors reflect the reverted classifier.

No rollback of mined data is needed — it self-corrects from the
re-classification walker. The price is one round of 90 min of
walker compute, which is bounded.

**Re-classification walker:**

New cronjob `re-classify-stale-days.ts`, runs at 02:00 (before the
mining jobs at 03:00 / 03:30):

```sql
SELECT date FROM decoded_days
 WHERE user_id = ? AND classifier_version < CURRENT_CLASSIFIER_VERSION
 ORDER BY date DESC
 LIMIT batch_size
```

Walks at most `MAX_DAILY_RECLASSIFY_MINUTES = 60` of wall-time per
night, processing newest-first (so the most-recent days converge to
the new version fastest, which is what mining cares about). After a
version bump, full reconvergence of 180 days takes ~2 nights.

### Mining job gating

All three mining jobs gate their input on `classifier_version =
CURRENT_CLASSIFIER_VERSION` and **skip the user entirely** if too
little current-version data exists yet (per-job thresholds):

- `mine-journey-patterns`: ≥ 90 days current-version data required.
- `mine-mode-biometrics`: ≥ 30 days current-version data required, with
  ≥ 100 minutes per mode (cycling, walking, etc.) for that mode's
  signature to be mined.
- `refresh-focus-places`: independent of classifier version (clusters
  are from raw GPS stays, not classified segments) — no gating needed.

When mining skips, the production code falls back to the
previous-version mined output (kept until the new one is produced)
**but with a discount factor** — the `commute-prior` factor reads
the version from the mined rows and applies `weight × 0.5` when
the rows are previous-version (stale). The intent is "useful but
distrusted": stale priors avoid the catastrophic case of no prior
at all on a freshly-bumped system, but are weighted down enough
that wrong labels in the stale window don't dominate the factor
sum. The 0.5 multiplier is a tunable; the initial value is chosen
so a single strong stale-prior contribution (~+2.5 nats fresh →
+1.25 nats stale) can't outweigh combined evidence from speed +
OSM + biometric on its own (~+3.2 nats jointly). Calibrate against
fixture days during Phase 2 audit.

**Rollback during stale window — important edge case.** A
bump-revert-bump sequence (a version was bumped, audit revealed
worse output, code reverted, version bumped again) leaves the user
with *no* current-version data and "previous-version" output that's
the *buggy* version we just rolled back. The stale-discount path
would naively apply, treating the buggy priors as 0.5× weight rather
than zero. The fix: the production code MUST also check
`journey_patterns.classifier_version` against the two most-recent
version numbers — if the only mined output is from a *rolled-back*
version (one strictly between the current-on-disk version and the
previous-active version), the factor returns 0, not stale-discounted.
This is one extra DB query column and a min-of comparison; mention
in the migration spec so Phase 2 doesn't miss it.

When even the previous-version output is missing (cold-start user,
or two version bumps in close succession with no rollback), the
factor returns 0 (no prior contribution) and the rest of the factor
stack carries the classification.

### Cycling-signature mining: a special case

`mine-mode-biometrics` produces a per-user signature for each mode the
user has been classified into. **A casual cyclist will never have a
cycling signature mined** because the classifier mislabels cycling as
driving without that signature → no cycling-classified segments → no
training data → forever no cycling signature. The classic
chicken-and-egg problem.

The fix has two layers, with different roles:

1. **Bootstrap (the loop-breaker).** The `cycling-signature` factor in
   Phase 1 does *not* depend on a mined signature. It uses a
   hand-tuned baseline (HR elevated >+30 bpm above resting AND cadence
   < 20/min AND speed 12-28 km/h) as a first-pass cycling detector.
   Calibrated against ~1-2 fixture cycling days. This is the bootstrap
   — fragile (thresholds are guesses on first pass) but enough to
   classify *some* cycling segments correctly.
2. **Trust anchor (deferred).** A `label-cycling-day.ts` CLI that lets
   the user mark a date as "I cycled today," forcing those segments
   into the cycling bucket regardless of classifier output. This is
   the canonical training data the audit can verify against.
   **Build only if the bootstrap fails in practice.** If the
   hand-tuned baseline picks up cycling segments well enough on the
   first few rides, the CLI is unnecessary. Defer to "build on
   demand" — adds ~2 days when needed, not now.

The mining-skip rule (≥30 days × ≥100 min per mode) interacts: with
1 cycling commute per week the gate takes months to open. That's
fine if the bootstrap baseline is doing the work in the meantime;
if the bootstrap fails, the manual-label CLI bypasses the gate by
producing trusted training data immediately.

### Audit tooling (deferred to Phase 4)

Earlier drafts proposed a weekly `audit-mining.ts` cron sending
reports to Nextcloud. On reflection that's steady-state hygiene, not
launch-blocking; the bootstrap-bias audit in Phase 2 is the real
safety check at rollout time.

Defer the weekly cron + Nextcloud-report writer to Phase 4. The
risk of "write-only file" (audit reports nobody reads) is real;
better to wait until we have lived with the system enough to know
what we'd want to look at routinely.

What Phase 2 does need for its rollout-time audit (separate from
the weekly cron):

- **`list-pattern-contributors.ts` CLI** — given a `journey_patterns`
  row's primary key, list the contributing source dates with their
  current labels. Makes the "for each flagged pattern, re-run
  analyze-day on contributing dates" step (Bootstrap-bias audit
  step 3) executable rather than a vague "eyeball the JSON." About
  half a day of work; bundled into the audit deliverable in Phase 2.

### Files modified

- `src/db/schema.ts` — migration v30 adds `classifier_version` to
  affected tables, plus a `decoded_days` table if not already present.
- `src/geo/classifier-version.ts` — **new.** The constant + a
  bump-checklist comment.
- `src/cli/re-classify-stale-days.ts` — **new.** Stale walker cron.
- `src/cli/list-pattern-contributors.ts` — **new.** CLI for the
  bootstrap-bias audit (lookup contributing dates for a flagged
  journey_pattern).
- `src/cli/mine-mode-biometrics.ts` — adopt version gating.
- `src/cli/refresh-focus-places.ts` — no version gating but adopt
  cron entry.
- `k8s/04-cronjob.yaml` — schedule the three mining + reclassify jobs.
- **Deferred to Phase 4 (don't build now):**
  `src/cli/audit-mining.ts` (weekly audit cron),
  `src/cli/label-cycling-day.ts` (manual-label CLI — build if
  bootstrap baseline turns out insufficient).

### Why this is its own section

Treating it inline within Phase 2 would understate the scope. The
mining-lifecycle is shared infrastructure that *also* serves
`mode_biometrics` retroactively (it has the same loop problem today,
just less visible because biometric signatures drift more slowly than
journey-pattern wayNames). Doing it once, properly, lets all current
and future mined outputs share the same versioning, the same
reclassification path, and the same audit. The user's directive: get
it right, then iterate. ~1 week of work; substantially de-risks the
prior factor.

## Phase 3 — Frontend explanation surface (1 week)

Goal: turn `factorBreakdown` into a real UI feature. The thing every bug
report from today would have benefited from is being able to ask "why
this label?" in the UI and see the factor breakdown.

### UX

Each timeline segment is clickable. Clicking opens a detail panel:

```
13:29-13:46 (17 min) Train
   Station A → Station B

   Why this label?
     ✓ Speed/linearity profile fits "train"     +1.8
     ✓ Rail line at 18m, road at 32m             +0.9
     ✓ HR within your train signature            +0.5
     ✓ Matches your recurring commute pattern    +2.5
                                       total:    +5.7
                              margin over 2nd:    +4.2

   Other interpretations considered:
     • Driving on a parallel primary road        -3.1
       (see breakdown)
```

This is a real explanation, not "station-pair upgrade (was: on subway)."

### No new persistence

The reviewer was right to flag the originally-proposed
`segment_explanations` table as over-engineered:

- The `factor_json` blob is forward-incompatible with the eventual HMM
  rewrite (which would store posteriors + Viterbi paths, a different
  shape).
- The blob is small enough (~1-2 KB) that retaining it in the existing
  per-day cache or recomputing on demand are both cheap.

Instead: factor breakdown is **computed on demand** when the frontend
requests it. The day-overview endpoint stays small; explanation comes
from a new endpoint:

```
GET /api/segment/:date/:startTs?explain=1
```

When the `?explain=1` query parameter is set, the handler runs
`computeVelocity` for that single segment's day (already cached after
the first request thanks to the per-day decoded-segments cache that
Phase 2's classifier_version work will introduce) and returns the
`factorBreakdown` for the matching segment.

Latency target: < 200 ms for the explain query, given the day-cache
is warm. If the day isn't cached, the first request is ~1-2 s
(re-classification of a single day), subsequent explain requests are
< 50 ms.

This is forward-compatible with the HMM rewrite: the endpoint stays,
its response payload schema changes from "factor list" to "posterior +
Viterbi" but the frontend can adapt.

### Files modified

- `src/routes/timeline.ts` — new `/api/segment/:date/:startTs` route
  with `?explain` support.
- `frontend/src/app/services/health.service.ts` — fetch explanation on
  segment click.
- `frontend/src/app/components/timeline/segment-detail.component.ts` —
  **new.** Renders the factor breakdown.

### Success criteria

- Click any segment, see its factor breakdown within 200 ms.
- "Why this label?" makes sense to a user without reading the source code.
- The top alternative candidate's score is shown inline (one line:
  "Driving on parallel primary road: -3.1, lost by 4.2"). A dedicated
  comparison view ("show me the second-best and why it lost in
  detail") is **deferred** — the inline alternative score is enough
  for the common case, and the deeper comparison view is fragile for
  structural-rewrite candidates (rail-run merges can't easily
  enumerate "what other merge would have happened").

## Phase 4 — Decision point

After Phase 3, evaluate residual error class:

- If **most remaining bugs are local** (single segment misclassified,
  single factor wrong): keep iterating factors. Add factors as needed,
  recalibrate weights, ship.
- If **most remaining bugs are joint** (one segment's misclassification
  cascades into wrong labels for neighbours; the system needs to back
  off a high-confidence choice when later evidence contradicts):
  escalate to 2025-model-hmm.md's HMM rewrite. Phase 1–3 work carries forward;
  the HMM replaces the per-segment max-score with a Viterbi decode over
  the factor scores reinterpreted as emission log-likelihoods.

This decision should be made with **at least 30 days of post-Phase-3
data** so the residual error class is measurable, not speculative.

## Budget

| Phase | Time | Cumulative |
|---|---|---|
| #80 precondition (focus_places.id stable) | 1-2 weeks*    | 1-2 weeks |
| Phase 1 (factors + reduced cascade + candidate enumeration) | 2-3 weeks | 3-5 weeks |
| Mining lifecycle (version handling, audit, fixture support) | 1 week | 4-6 weeks |
| Phase 2 (commute prior + bootstrap-bias audit + fixture validation) | 3 weeks | 7-9 weeks |
| Phase 3 (UI, no persistence) | 1 week | 8-10 weeks |
| Phase 4 (decision) | — | — |

\* The #80 estimate of 1-2 weeks is a placeholder that mirrors what
2025-model-hmm.md's Phase 0a budgeted; both documents call it out
as a known-hard problem (centroid-overlap identity matching with
split/merge handling). Pending a proper scoping pass on #80 itself,
treat this as the floor, not the ceiling — 3 weeks would not be
shocking. Refine when #80 is scoped, not before.

Total to factor-decomposed system with commute priors, mining
lifecycle, and UI explanation: **8-10 weeks**, modulo the #80
scoping caveat above.

Compare honestly with 2025-model-hmm.md's stated 8-9 weeks for the full HMM
rewrite. The gap is smaller than the previous draft of this roadmap
implied. The trade-off:

- This roadmap delivers **incremental, shippable value** at the end of
  each phase. Phase 1 alone catches a subset of the observed bug
  classes (cycling-as-driving via the new cycling-signature factor;
  rail-vs-road tie-break failures via distance-aware scoring;
  driveable-vs-footway misses via mode-coherence). The "wrong-
  neighbouring-station-picked-over-routine-station" class needs
  Phase 2's commute prior to resolve — Phase 1 enumerates the
  candidate but doesn't yet pick it. Phase 2 adds the prior; Phase
  3 adds explainability. Each phase is a deploy.
- 2025-model-hmm.md delivers **one big system** at the end, with intermediate
  phases that aren't independently shippable (fixture capture, model
  training, inference) — same total time, less granular delivery.
- This roadmap's ~30-50% of work carries forward if Phase 4 decides
  on HMM. 2025-model-hmm.md's full plan doesn't have an intermediate-deliverable
  fallback.

If Phase 4 says "escalate to HMM," add 2025-model-hmm.md's HMM-specific phases
(its Phase 0c fixtures, Phase 1 model storage + EM, Phase 2 Viterbi
+ persistence, Phase 3 seam quality): **+5-7 weeks** on top of what
this roadmap delivers. Total HMM-by-incremental-path: 13-17 weeks.
Total HMM-by-2025-model-hmm.md-direct-path: 8-9 weeks. The increment cost
of the safer path is ~5-8 weeks; the value is that you can stop at
Phase 3 if it's good enough.

## Open questions (genuinely open)

The previous draft of this section punted multiple decisions to
"verify during the phase." Two of those — timezone binning and decay
half-life — are now decisions taken (see Phase 2 spec). The remaining
genuinely-open questions:

1. **Cluster pair coverage.** `focus_places` won't cover every journey
   endpoint — e.g., a one-off visit to a friend's house. The
   `commute-prior` factor returns 0 in that case (no row in
   `journey_patterns`). Verify during Phase 2 fixture validation that
   this is correctly null-and-additive (other factors still produce a
   correct label) rather than null-and-broken (the prior somehow
   suppresses other factors).
2. **Hour-of-day binning granularity.** 1-hour bins are the default;
   2-hour bins are a candidate if peaks turn out to be wider than
   expected, finer bins are unlikely to be useful for the sparse
   patterns of a single user. Decide after the audit step in Phase 2.
3. **Factor weights vs learned weights.** Phase 1-3 hand-tunes weights
   against fixtures. A natural next step is learning weights from
   user-confirmed correct/incorrect labels — but that opens a labelling
   UX rabbit hole. Defer to post-Phase-3.
4. **Classifier-version bump policy in practice.** The mechanism is
   defined (manual bump, code review, commit message); the question is
   how often it gets bumped in steady state. If every refactor bumps,
   re-classification thrash burns the mining priors. If nothing bumps,
   stale priors creep in. Probably converges to ~monthly bumps; verify
   after 6 months of use.

## Failure modes the factor framework does NOT address

Worth naming explicitly so we don't claim too much.

- **Cross-segment coupling.** If segment N is misclassified, the
  factor system can't go back and re-evaluate segment N-1 in light of
  that. Example: a chain of "walking → train → walking → train →
  walking" segments where the middle walking was actually a transfer
  between two tube lines — the framework annotates each independently.
  2025-model-hmm.md's Viterbi handles this; the factor framework doesn't. This
  is a known limit; if Phase 4 finds it dominant, escalate.
- **Structural ambiguity.** "Was this one train ride with a brief
  stop, or two train rides?" — the segment classifier decides this
  upstream of the factor scorer. If it decides wrong, factors can't
  fix it. The cascade's rail-run-merge logic helps but is local
  (look at adjacent pairs, not the whole day).
- **Mode boundaries between candidates with same total score.** When
  two candidates score identically by factor sum, the picker is
  deterministic but arbitrary. In practice these are vanishingly rare
  on real data because biometric and commute-prior factors break ties
  almost always; but a debug user might be surprised at apparently
  capricious labels in edge cases.
- **Truly novel events.** First time taking a new commute route after
  moving job. Other factors classify correctly; `commute-prior`
  returns 0 (correctly). The route doesn't become "remembered" until
  enough mining rounds pass with the new pattern. Working as
  intended; flag if the cold-start period is too long in practice.

## Test plan

Per-factor unit tests in `tests/factors/` (Phase 1). Each factor is a
pure function — test the score it produces against representative
inputs.

Backtest harness in `src/cli/backtest-classification.ts` (Phase 1):
runs analyze-day across a date range, compares the new factor-decomposed
output against the current production output. Use to verify Phase 1
behaviour change is zero, and to measure Phase 2 improvement after the
commute prior is added.

Fixture days (Phase 3): reuse 2025-model-hmm.md's Phase 0c fixture set. Capture
10-15 days covering the known failure modes; use as calibration target.

## What this replaces / supersedes

- Today's `refineMode` rule cascade → factor scoring.
- Today's `annotateRailRuns` heuristics → factors operating over the same
  data.
- `2025-model-hmm.md` is **not** superseded — it's still the right design for the
  full HMM rewrite. This roadmap is the smaller, sooner-shippable
  alternative that **also serves as a forward-compatible foundation** if
  the HMM is later judged necessary.
