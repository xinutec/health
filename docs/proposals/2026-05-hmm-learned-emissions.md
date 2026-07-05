---
status: partly shipped
created: 2026-05-24
updated: 2026-05-24
---

# HMM learned emissions (Phase 2 of joint-sequence-model)

## Why now

The Phase 1.7 audit on 5 blessed days regressed against Phase 1.6
across the board (every day −2 to −11pp). The static-prior surface
has plateaued: every hand-tune trades one day against another. We
hit the model-class ceiling.

The fundamental problem is structural, not parametric. A 1-D
Gaussian per `(mode, modality)` (`stationary.hrMean=70 σ=15`)
discards all the conditioning that matters:

- This user's HR baseline
- HR at Home overnight vs at Work typing vs at a clinic anxious
- Multimodal distributions (sedentary baseline + active baseline)
- Drift over weeks/months

We have ~180 days of heuristic-labeled minutes (~260k labeled
samples). That's a training set. The proposal's Phase 2 was
"EM-learned transitions and emissions" — deferred for MVP reasons.
Time to do it.

## What this proposal is, and is not

Is:
- Replace hand-tuned `MODE_PRIORS` with distributions FIT from
  heuristic-labeled minutes
- Keep transition matrix hand-tuned for now (separate concern;
  ~36 mode-pair transitions vs ~1500 emission samples per mode —
  emissions are the higher-leverage learning target)
- Add a `learned_hmm_models` table to persist fitted models;
  audit/decode CLIs can load by version
- Train per-mode (no per-place yet — that's the next iteration if
  per-mode wins)

Is not:
- A switch from HMM to CRF or neural seq model. The framework
  stays HMM; we change how its parameters are computed.
- A change to the state space, transition structure, or hard
  constraints.
- An end-to-end training pipeline that re-labels minutes and
  re-fits (EM). Supervised MLE from heuristic labels only —
  bootstrap bias accepted as MVP cost.
- Wired into prod. Audit CLI is still the only consumer. Decision
  to enable in prod comes after audit shows learned-emission HMM
  beats both heuristic AND hand-tuned-HMM.

## Approach

### Training signal

For each labeled day:

1. Build the observation tensor (1440 minutes × HR/cad/speed/GPS).
2. Get heuristic segments for the day. Convert to per-minute mode
   labels.
3. For each minute where the heuristic emits a CONFIDENT mode
   (stationary / walking / cycling / driving / train / plane —
   NOT unknown, NOT no-segment), pair the observation with the
   mode label.
4. Stream these `(obs, label)` pairs into per-mode sample buckets.

Skip:
- Unknown segments — heuristic explicitly says "I don't know"
- No-segment minutes — no label at all
- Null observation modalities — can't fit on missing data

### Per-mode parameter fitting

For each mode `M`:

- **HR**: collect all `obs.hr` where `obs.hr !== null AND label = M`.
  Fit Gaussian via MLE: μ = mean, σ = stddev (corrected for
  Bessel's correction with N-1).
- **Cadence**: zero-inflated.
  - `expectedZeroProb = count(cad === 0) / count(cad !== null)`
  - Positive Gaussian fit on `cad > 0` samples.
- **Speed**: Gaussian fit on `gps !== null AND label = M` samples.
- **GPS-present probability**: `count(gps !== null) / count(label = M)`.

Edge cases:
- Mode with < 50 samples: fall back to hand-tuned MODE_PRIORS for
  that mode (insufficient data to learn). Log this.
- Cadence with zero positive samples: keep zero-inflated with no
  positive component (i.e. `positiveProb = 0`).
- HR stddev that's pathologically small (< 5): floor it so the
  Gaussian doesn't pin too tightly to its mean (overfitting to
  training minute idiosyncrasies).

### Storage

```sql
CREATE TABLE learned_hmm_models (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL,
  version VARCHAR(64) NOT NULL,
  notes TEXT,
  -- Serialised LearnedEmissionParameters JSON
  emissions_json MEDIUMTEXT NOT NULL,
  training_day_count INT NOT NULL,
  training_minute_count INT NOT NULL,
  trained_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_user_version (user_id, version)
);
```

Blob shape:

```typescript
interface LearnedEmissionParameters {
  perMode: Record<TransportMode, {
    gpsPresentProb: number;       // P(GPS observed | mode)
    speed: GaussianFit;           // mean, std, sampleCount
    hr: GaussianFit;
    cadence: ZeroInflatedFit;     // expectedZeroProb, positiveMean, positiveStd, sampleCount
  } | "fallback">;                // "fallback" = use hand-tuned MODE_PRIORS for this mode
  trainingSummary: {
    dayCount: number;
    totalMinuteCount: number;
    minutesPerMode: Record<TransportMode, number>;
  };
}
```

### Inference

`buildEmissionFn` gains an optional `learnedEmissions` parameter.
When present, per-mode parameters override `MODE_PRIORS` for that
mode. Modes flagged `"fallback"` (insufficient training data)
continue to use `MODE_PRIORS`.

The function shape is unchanged — same `(state, obs) → log-prob`.
The geometric place-distance term, off-network log-prior, and
GPS-presence Bernoulli all remain as-is. Only the per-mode
HR/cadence/speed/GPS-present parameters become data-fit.

### Wiring

- New CLI `train-hmm.ts`: loads days, fits, persists. Flags:
  `--user`, `--from-date`, `--to-date`, `--version`, `--notes`.
- Modified `compare-hmm-vs-heuristic.ts`: optional
  `--model <version>` flag. When omitted, uses hand-tuned. When
  present, loads the named model and passes to `buildEmissionFn`.
- Audit comparison: ideally run side-by-side, hand-tuned vs
  learned-vN, on the same 5 blessed days.

## Evaluation

The validation challenge: heuristic IS our training labels.
Comparing learned-emission HMM to heuristic per-minute gives an
agreement score that conflates two things:

1. How well the learned model fits the training labels (high =
   good fit, but tells us nothing about generalisation).
2. How well the HMM structure smooths heuristic flicker (the
   intended benefit of joint sequence decoding over per-minute
   classification).

For the first cut, accept this limitation. Report agreement %
side-by-side with hand-tuned-HMM agreement %. If learned beats
hand-tuned across the board on the blessed days (without
overfitting to those days specifically — they MUST be excluded
from training), that's signal.

Two evaluation runs to do:
- **Train-on-all-eval-on-all**: pure fit measurement. Should be
  near-100% for modes with enough samples; tells us if the model
  class can represent the data.
- **Train-on-non-blessed-eval-on-blessed**: held-out generalisation.
  This is the real comparison. Numbers will be lower; that's fine
  — the question is whether they beat hand-tuned-HMM on the same
  blessed days.

Render-mode side-by-side is still the qualitative check. Aggregate
agreement % alone is noisy; visible day shape tells the truer
story.

## What this DOESN'T fix (deferred to next iteration)

- **Per-place HR**: Cleveland Clinic stays attributed to wrong
  state because HR runs hot there. Per-mode learning makes the
  global stationary HR distribution wider (absorbs anxious-at-
  clinic into the variance), which helps marginally but doesn't
  solve the place-specific case. Per-(state, place) fitting,
  with amenity-class fallback for rare places, is the actual fix.
  Defer to Phase 2.5 if Phase 2 ships meaningful improvement.
- **Learned transitions**: hand-tuned transitions stay. If
  emissions learning works, transitions are the next natural
  target — empirical counts + Dirichlet smoothing over the
  6×6 mode-pair matrix.
- **Time-of-day conditioning**: learning `(mode, hour)` joint
  emission would handle the at-Work-2pm-typing case naturally
  but adds parameters fast (6 modes × 24 hours × 4 modalities
  = 576 parameters). Defer until we see if it's needed.
- **GMM emissions**: mixtures over Gaussians for inherently
  multimodal modalities (e.g. cadence-when-walking has a slow-
  walk and brisk-walk peak). Single-Gaussian fit captures the
  centroid but loses the bimodal shape. Defer to Phase 3.

## Plan

1. Schema + types: `LearnedHmmModelsTable`, migration, `LearnedEmissionParameters` shape.
2. Pure module: `src/hmm/learned-model.ts` — load, save, parameter
   shape, JSON (de)serialisation, fallback handling.
3. Pure fitter: `src/hmm/fit-emissions.ts` — takes labeled
   minute samples, returns `LearnedEmissionParameters`. Pure
   function; testable on synthetic samples.
4. `src/hmm/emissions.ts`: accept `learnedEmissions` opt parameter
   that overrides per-mode priors.
5. `src/cli/train-hmm.ts`: orchestrator. Loads days, derives
   labels, calls fitter, persists.
6. `src/cli/compare-hmm-vs-heuristic.ts`: `--model <version>`
   flag wiring.
7. Train v1; audit on 5 blessed days; compare vs hand-tuned.
8. Render side-by-side on the day that moved most (positive or
   negative); decide whether per-mode-learned beats hand-tuned.

## Expected outcome

If the model class is well-matched to the data, learned-emission
HMM should beat hand-tuned-HMM by single-digit pp on dense days
and not regress sparse days. Specifically the at-Work-elevated-HR
case should resolve because the learned stationary HR
distribution will have wider variance (absorbing the realistic
range of at-work HR values) than the hand-tuned σ=15.

If learning DOESN'T help, that says emissions weren't the
bottleneck. Likely culprits then: transitions (next learning
target), or model class itself (push to CRF / neural).
