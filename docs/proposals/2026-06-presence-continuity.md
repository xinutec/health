---
created: 2026-06-03
updated: 2026-06-03
status: partly shipped (Phases 1, 3; Phase 4 pending)
references:
  - 2026-06-magnetic-focus-places.md
  - ../design/overview.md
  - decoder-roadmap.md
  - ../design/probabilistic-principles.md
---

# Cross-day presence continuity — established stays persist across
# sparse-data days, as HSMM factors

## Problem

`computeVelocity` decodes each day **independently** from raw GPS,
biometrics, and a static focus_places snapshot. Sparse-data days
within an established stay get the same independent treatment as a
fresh travel day. This produces an unphysical labelling regression
the user sees directly:

- 2026-05-25 (rich data): admitted to Cleveland Clinic London → day
  labels correctly as `@ Cleveland Clinic London`
- 2026-05-26 through 2026-06-01 (Owntracks frequency turned down):
  fewer fixes per day, some days with zero or near-zero fixes. The
  same hospital bed. Day labelling drifts to `@ Stay`, `@ unknown`,
  or worse.
- 2026-06-02 (discharge taxi home): the leaving-day decodes correctly
  again from rich movement data.

The user-visible bug: "fewer points shouldn't make things worse after
some time." From a Bayesian standpoint they are exactly right — seven
days of confirmed presence at place X should be an overwhelming prior
for day eight's labelling, regardless of GPS density. The current
per-day decode discards that prior entirely.

The magnetic-focus-places work (shipped 2026-06-03) addresses a
within-day version of this — noisy fixes that drift toward a
geometrically-close OSM POI get pulled back toward an established
focus_place. But the magnet only fires when *some* fix is within its
radius. A day with no fixes near the hospital gets no magnet.

## Principle

A stay at a known place is the stable state. Continuation is the
default; ending it requires positive evidence. The Bayesian frame:
`P(at place X on day N+1 | at place X on day N, no contradicting
evidence) ≈ 1`. When evidence is genuinely absent, "still at X" is
the rational posterior — not "unknown" and certainly not "drifted
to a nearby playground."

This generalises the within-day magnetic anchoring (spatial pull from
focus_place centroids) to a temporal pull across days: an established
stay persists forward in time until movement evidence breaks it.

## Architecture

This is **not** a post-processing pass. The earlier draft of this
doc proposed exactly that — and `probabilistic-principles.md`
Rule 4 forbids it ("plumbed into the `Observation` shape, weighted
by a calibrated `P(signal | state)` factor… does not become a
post-processing pass"). `decoder-roadmap.md` carries
the same warning at its banner: hard rules belong *upstream of*
scoring, not downstream as a layer-2 post-pass that rewrites
violations.

So the continuity mechanism is split across the two principled
placements:

1. **Sparse-day candidate generator.** When the day's raw fixes
   would not produce a viable stay candidate at the prior day's
   end-of-day place (because there are too few fixes, or they
   cluster elsewhere), the state-space builder
   (`buildStateSpace`) adds the prior-day end-place as an
   **extra candidate state** anchored at the focus_place's stored
   centroid. The HSMM then chooses between this candidate and the
   from-data candidates on the same scoring footing as everything
   else.
2. **HSMM emission factor.** A new emission factor scores per-minute
   observations against state hypotheses. The new factor:
   `P(observation = no-fix | state = stationary @ prior_place) ≫
   P(observation = no-fix | state = travelling)`. A
   no-fix minute is much more consistent with sitting at a known
   place (the phone is in your hospital pocket) than with
   travelling (a moving phone with line-of-sight to satellites
   usually gets fixes). This pulls the HSMM toward the
   continuation candidate in the right circumstances without any
   binary cutoff.

Together, (1) makes "still at prior place" a candidate the HSMM can
consider; (2) gives that candidate the appropriate evidence weight
under sparse data. Both are mechanisms the existing factor-scorer
framework was built for — no new architecture, no Rule 4 violation.

## Relation to prior work

- **`2026-06-magnetic-focus-places.md` (shipped).** The magnet
  anchors *individual fixes* spatially to known focus_places by
  adding a soft `M_p × B_s` term to candidate scoring and relaxing
  the distance veto under strong magnet conditions. This proposal
  adds two complementary mechanisms: a temporal candidate seed for
  the prior-day end-place, and a no-fix-emission factor that
  evaluates the same candidate. Conceptually one axis (space) is
  shipped; this adds the second (time).

- **Threshold unification with the magnet.** The contradiction
  signals (what breaks the continuation candidate's score) re-use
  the magnet's `R_magnet(p) = R₀ + k · σ_p` — the same per-place,
  biometric-aware radius. A stay whose centroid lies outside
  `R_magnet(prior_place)` cannot be the continuation candidate;
  a movement segment whose displacement exceeds `R_magnet` for
  sustained time breaks it. This keeps the spatial and temporal
  anchors symmetric.

- **#186 sleep-place asymmetric trust + #189 backward-day fallback.**
  These shipped narrow forms of cross-day inheritance for sleep
  windows specifically (`detectKnownPlaceStays` reads next-day
  morning and prior-day evening fixes to attribute a sleep window).
  This proposal **explicitly subsumes them**:
  - The continuation candidate generated in (1) handles sleep
    windows the same way it handles waking hours — there's no
    sleep-specific path.
  - The new emission factor in (2) replaces the bespoke
    `detectKnownPlaceStays` lookup with a calibrated probability.
  - **Retirement plan**: `detectKnownPlaceStays` and its call sites
    in `src/sleep/*` are deleted in Phase 4, after Phase 3 has
    shown the unified mechanism handles the same shapes at least
    as well on the goldens. The behaviour-equivalence is verified
    on 04-29, 04-30, and 05-22 (the days the existing fallback
    fixes today). Until Phase 4 lands, both paths coexist; #186/
    #189 wins for sleep windows, continuation fills only the gap
    between them.

- **`../design/overview.md` (shipped Phase 1).** Adds
  time-of-day discrimination to focus_place attribution. Orthogonal
  to this proposal: the within-day spatial pick is unchanged; this
  adds a temporal-presence layer.

- **`../design/overview.md` (paused, fully
  reverted).** Burned on reported-accuracy-as-weight, dwell mining
  from a censored stays table, and an incremental accumulator
  losing reproducibility. This proposal honours all three
  constraints: no accuracy-weighting, no new mining of
  focus_places features, and `presence_log` is a pure function of
  a bounded raw-history window rebuilt nightly — same pattern as
  focus_places, not an incremental accumulator.

- **`decoder-roadmap.md` + the shipped HSMM
  (`../design/probabilistic-principles.md`).** This proposal extends the
  existing HSMM's state-space and emission factors. The HSMM is the right
  home for the mechanism per Rule 4; no new sequence model is
  introduced.

## Design

### 1. The `presence_log` table

A new persisted table, one row per (user, date), storing the day-
level "presence summary":

```sql
CREATE TABLE presence_log (
  user_id     VARCHAR(64) NOT NULL,
  date        DATE        NOT NULL,
  tz          VARCHAR(64) NOT NULL,
  -- The focus_place id that the HSMM assigned to the largest fraction
  -- of decoded minutes on this day. Null when no focus_place
  -- dominated (a travel day with movement-mode majority).
  dominant_place_id   BIGINT NULL,
  -- Fraction of decoded minutes (sleep-mode and waking-mode alike)
  -- assigned to dominant_place_id. 1.0 = entire day at one place.
  -- < 0.5 = a mixed / travel day.
  dominant_fraction   FLOAT NOT NULL,
  -- Last decoded minute's place id and the timestamp of that
  -- minute. Used by the next day's decoder as the seed for the
  -- continuation candidate.
  end_of_day_place_id BIGINT NULL,
  end_of_day_ts       TIMESTAMP NULL,
  -- Posterior probability that the HSMM assigned to
  -- (end_of_day_place_id, stationary) at end_of_day_ts. Carried
  -- forward into the next day's emission factor as the prior on
  -- the continuation candidate.
  end_of_day_posterior FLOAT NOT NULL,
  computed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, date)
);
```

DELETE+INSERT rebuilt nightly from a 30-day backfill window, in the
same cron that refreshes focus_places and rail_route_cache. Pure
function of (raw fixes, focus_places snapshot, current code).

"Decoded minutes" means: the HSMM's per-minute output sequence —
which already exists today as the `decoded_days.states` JSON
(shipped via `../design/probabilistic-principles.md`). The
`presence_log` is a roll-up of that, not a new decoding pass.

### 2. State-space extension: continuation candidate

`buildStateSpace` (`src/hmm/state-space.ts`) consumes a
`PresenceContinuity` input alongside its existing focus-places
seed:

```ts
interface PresenceContinuity {
  priorPlaceId: number | null;
  hoursSinceLastConfirmedFix: number;
  priorPosterior: number;  // from presence_log.end_of_day_posterior
}
```

When `priorPlaceId !== null` AND the focus_place exists in the
current snapshot, the state-space adds the state
`{ mode: "stationary", placeId: priorPlaceId }` to the candidate
set — even when no per-day cluster naturally suggests it. The HSMM
then weighs this candidate against the others using its normal
scoring; nothing is forced.

### 3. Emission factor: no-fix evidence under continuation

A new factor file `src/hmm/factors/presence-continuity.ts`. For each
minute, given a state hypothesis:

```ts
// Decays from a strong baseline as time-since-confirmed-fix
// accumulates. tau ≈ 24 h.
const tau = 24;
const decay = Math.exp(-continuity.hoursSinceLastConfirmedFix / tau);

if (state.placeId === continuity.priorPlaceId && obs.gps === null) {
  // Sitting at the known place, no fix this minute: highly
  // consistent. Pre-decay baseline calibrated against the
  // user's own historical no-fix rate inside known stays
  // (Phase 2 calibration target).
  return BASELINE_NOFIX_LIKELIHOOD * decay * continuity.priorPosterior;
}
if (state.placeId === continuity.priorPlaceId && obs.gps !== null) {
  // Sitting at the known place AND we have a fix: the fix's
  // distance from the place's stored centroid is the actual
  // signal. Falls through to the existing osm-distance /
  // place-prior factors — this factor is silent.
  return 0;  // log-prob neutral
}
// Other state hypotheses: this factor doesn't apply. Silent.
return 0;
```

The factor's pre-decay baseline (`BASELINE_NOFIX_LIKELIHOOD`) is
calibrated in Phase 2 against the user's *own* observed no-fix rate
during established stays — see Phase 2 for the procedure.

This is a soft factor in the existing factor-scorer framework. It
contributes positive log-probability for the continuation candidate
under no-fix evidence, decaying as time since the last confirmed
fix accumulates. No hard cutoff.

### 4. Contradiction by `R_magnet` (re-used from the magnet)

The continuation candidate's score collapses when any minute on the
day provides positive evidence of being elsewhere. Re-using the
magnet's per-place radius:

- A stationary segment whose centroid lies outside
  `R_magnet(priorPlace) = R₀ + k · σ_priorPlace` is positive
  evidence of a different stay. The HSMM's existing distance term
  already penalises a stationary candidate far from its centroid;
  the continuation factor adds no protection above and beyond
  the magnet's. So a stay outside `R_magnet` naturally outscores
  the continuation candidate.
- A movement segment with sustained displacement > `R_magnet` of
  the prior place is the temporal version of the magnet's
  detachment signal. The HSMM's mode-transition prior already
  handles "stationary → movement" transitions; what changes here is
  that, once movement is established, the continuation factor goes
  silent (the user has actually moved) and the prior-place
  candidate's score collapses naturally.

Re-using `R_magnet` is the unification the audit called out: the
spatial anchor and the temporal anchor break under the same
conditions, with the same per-place tolerance.

### 5. Causal model — bounded next-day look-ahead

The continuation factor uses `presence_log[date - 1]` for the
prior-place seed. It also performs a **bounded next-day look-ahead**
of ≤ 6 hours: the next day's first GPS fix, if it occurs within 6 h
of midnight, contributes to the current day's evidence (and vice
versa). This is honest look-ahead — not "no look-ahead" — and it
matches what `detectKnownPlaceStays` does today for sleep windows.
The bound is set so the look-ahead can resolve a sleep window that
straddles midnight, but not propagate a discharge taxi's evidence
backward into a hospital stay days earlier.

### 6. UI rendering — confidence as a continuous attribute

The end-of-day posterior decays as `decay(hoursSinceLastConfirmedFix)`
per the factor. The full continuous value is stored on the segment
(as a new `confidence` field) and per Rule 5 is preserved as a
distribution at the boundary between decoder and renderer. The
renderer can choose to bucket for human consumption:

- `confidence ≥ 0.7`: render plain (`Cleveland Clinic London`)
- `0.3 ≤ confidence < 0.7`: render with `· likely` suffix
- `confidence < 0.3`: render with `· presumed` suffix

These buckets are **render-time thresholds only** — the decoder
stores the continuous value. A future UI that wants a confidence bar
or per-state distribution can read the same field; the bucket
boundaries are not load-bearing.

## What this does NOT do

- **No per-fix imputation.** A continuation candidate produces a
  stay attribution per minute via the HSMM, not a sequence of
  synthesised individual fixes. The raw fix stream is untouched.

- **No incremental accumulator across days.** `presence_log` is
  DELETE+INSERT rebuilt nightly from raw history within a 30-day
  window. Change the algorithm, re-run, everything updates.

- **No mining of new focus_place features.** `presence_log` is a
  roll-up of the existing HSMM output. No new column on
  `focus_places`.

- **No new sequence model.** The mechanism extends the shipped HSMM
  via existing extension points (state-space builder + factor
  scorer).

## Phasing

- **Phase 1 — `presence_log` schema + nightly cron + rollup.**
  Build the table and the offline job that computes it from
  `decoded_days`. No runtime impact yet — the table is populated
  but unread by `velocity.ts`.

- **Phase 2 — calibration.** With the table populated, derive the
  baseline factor parameters from the user's own data:
  - `BASELINE_NOFIX_LIKELIHOOD`: the observed `P(no-fix-minute |
    inside-established-stay)` from per-minute decoded states +
    raw fixes, across the trailing 30 days.
  - `tau`: fit so confidence decays to ~0.3 (the "presumed"
    threshold) at the empirical 75th-percentile gap-between-fixes
    inside established stays.
  - Validate the calibration produces sensible attributions on a
    multi-day Cleveland Clinic fixture *without* the factor wired
    into the runtime — purely a backtest over `decoded_days`.

- **Phase 3 — wire the continuation factor + state-space extension
  into the HSMM, behind a feature flag.** Goldens compare the on/off
  paths. Hospital-stay days should label correctly with the flag
  on; existing goldens should stay unchanged.

- **Phase 4 — retire `detectKnownPlaceStays` and its call sites.**
  After the unified path has shown behaviour-equivalence on the
  04-29, 04-30, 05-22 cases that the existing sleep-fallback
  handles today.

- **Phase 5 — UI confidence rendering.** Add the `· likely` /
  `· presumed` suffixes to the timeline. Depends on Phase 3
  landing.

## Worked example — Cleveland Clinic 8-day stay

Day **05-25** (rich data, admission):
- HSMM decodes the day normally; the magnet pulls the afternoon's
  stays to Cleveland Clinic London.
- `presence_log[2026-05-25]`: dominant_place = Cleveland Clinic id,
  dominant_fraction = 0.6, end_of_day_place = Cleveland Clinic id,
  end_of_day_posterior = 0.95.

Day **05-26** (sparse data, ~30 fixes, all near hospital):
- State-space gains the continuation candidate at Cleveland Clinic.
- All 30 fixes are within `R_magnet` of Cleveland Clinic, no
  contradicting evidence. For minutes with a fix, the existing
  distance term scores the candidate well; for the many no-fix
  minutes, the new emission factor contributes
  `BASELINE_NOFIX_LIKELIHOOD · decay(24/24) · 0.95 ≈ 0.35 ·
  baseline`. The HSMM picks the continuation candidate across the
  full day.
- `presence_log[2026-05-26]`: dominant_fraction high,
  end_of_day_posterior ≈ 0.85 (decayed but still confident
  because today's fixes still confirm).

Day **05-29** (zero fixes — Owntracks fully off):
- No fixes to cluster. Without this proposal, the day would emit
  no segments. With Phase 3:
  - State-space adds the continuation candidate from
    `presence_log[2026-05-28]`.
  - Every minute is a no-fix minute. The continuation candidate
    scores `BASELINE_NOFIX_LIKELIHOOD · decay(72/24) · 0.5 ≈ 0.025
    · baseline · prior` — a small absolute number, but no
    competing candidate scores any better (the from-data
    candidates have no data).
  - The HSMM picks the continuation candidate. Day labels as
    Cleveland Clinic, confidence ≈ 0.025 — well below the
    `presumed` threshold. UI renders as `Cleveland Clinic London ·
    presumed`. Honest.

Day **06-02** (discharge):
- Per-day decode produces strong from-data evidence: a long
  movement segment with sustained speed, then a stationary stay at
  Home. The continuation candidate's score is dwarfed by the
  from-data Cleveland Clinic→drive→Home sequence.
- `presence_log[2026-06-02]`: end_of_day = Home. The chain reseeds.

## Testing

- **Real-data multi-day fixture: Cleveland Clinic 05-25 through
  06-02.** Capture all 9 days as a single fixture. Assert per day:
  the labelling matches the GT narrative (`@ Cleveland Clinic
  London` daytime + sleep for 05-26 through 06-01, even on
  zero-fix days; correct drive + Home on 06-02). The confidence
  drops on no-fix days but the label is preserved.

- **Synthetic regression — continuity must not cross a real move.**
  Two-day fixture: day 1 stays at place X; day 2 has a clear
  morning drive to place Y followed by all-day stay at Y. The
  continuation candidate MUST score below the from-data Y stay on
  day 2. The HSMM picks Y.

- **Calibration validation (Phase 2).** Backtest over
  `decoded_days` confirms the chosen `BASELINE_NOFIX_LIKELIHOOD`
  and `tau` produce continuation-wins-vs-loses distributions
  consistent with ground-truth multi-day stays.

- **No-regression on the 9 existing goldens.** None of them
  involve multi-day stays; the continuation candidate either
  doesn't fire (no `presence_log` seed) or scores well below the
  from-data candidates. Each golden must produce the same blessed
  output as today.

- **Behaviour-equivalence with #186/#189 (Phase 4 gate).** On the
  04-29, 04-30, 05-22 sleep cases that
  `detectKnownPlaceStays`+next-day-fallback handles today, the
  unified mechanism produces the same sleep-window attribution.
  Phase 4 retirement does not ship until this is true.

## Residual limits

- **First-time stays.** The continuation only fires after at least
  one day's `presence_log` exists. A user's first visit to
  Cleveland Clinic gets the standard per-day decode plus magnet,
  no temporal pull. By the second day the seed exists and
  continuation can fire.

- **Phone off elsewhere.** If the user travels somewhere else but
  their phone is off, the continuation will misattribute the day
  to the prior place. The contradiction signal can't fire without
  data. The confidence decay limits the damage but doesn't
  eliminate it. Honest reading: the `presumed` UI label is the
  user's first-line check ("does this match what I actually did?").

## Risks

- **Over-extension of presence.** Mitigated by confidence decay
  (`tau = 24 h`) and by re-using the magnet's `R_magnet`
  contradiction thresholds (so any fix outside the per-place radius
  collapses the candidate). Validated by the synthetic
  no-cross-real-move test and the multi-day fixture.

- **Stale `presence_log` after a focus_places re-mining.** The
  table stores focus_place IDs; if a focus_place is re-mined into
  a different id, lookups would fail. Mitigated by the nightly
  rebuild: the table is recomputed every day, so stale IDs from a
  prior algorithm version only live until the next nightly run.

- **Cron failure leaves yesterday's data missing.** If the nightly
  cron fails, today's HSMM has no continuation candidate. The
  decoder falls back to per-day decoding — graceful degradation,
  not a crash.

- **Calibration drift between users.** The baseline no-fix
  likelihood is per-user (mined from each user's own
  `decoded_days`), so cross-user drift is contained by
  construction.
