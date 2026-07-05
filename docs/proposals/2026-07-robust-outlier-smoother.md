---
created: 2026-07-01
status: proposed
references:
  - 2026-06-map-constrained-positioning.md
  - 2026-07-true-path-reconstruction.md
  - ../design/episode-geometry.md
---

# Robust outlier smoother — the concrete build of #265 Phase 0–1

> One-line: make the **drawn moving-leg geometry accuracy-weighted and
> heavy-tailed**, and add a **per-minute step-displacement factor**, so a burst
> of low-accuracy fixes (underground / indoor) can never be drawn as an
> impossible high-speed path. This is the concrete, code-grounded implementation
> of `2026-06-map-constrained-positioning.md` Phase 0 (eval) + Phase 1 (robust
> emission). It is measured before anything is wired.

## Scope — one failure class, honestly

There are two distinct positioning failures, and they need different fixes:

1. **Outlier / teleport class (THIS plan).** A run of low-accuracy fixes
   (underground tube, indoor GPS) drifts hundreds of metres, and the estimator
   draws it as real motion. Concrete case, 2026-07-01 11:44–11:47: the tube tail
   under Baker St → Euston is drawn as a *walk* covering **965 m in 2 m 11 s
   (≈26 km/h, a 915 m / 75 s = 44 km/h burst)** across fixes with `accuracy`
   50–426 m and **zero steps** beneath them. Every good fix on either side is
   `accuracy ≤ 15 m`. This class is separable by accuracy + steps and is what
   robust estimation is *for*.

2. **Under-constrained detour class (NOT this plan).** The 2026-06-30 13:20
   "triangle" — a single plausible apex in familiar territory. Both proposal docs
   record measured proof that accuracy, robust kernels, step *gates*, and route
   priors **cannot** disambiguate it; only per-fix **heading/PDR** can
   (`2026-07-true-path-reconstruction.md` §1, §3). Out of scope here; owned by
   that doc's Phase 2.

This plan also does **not** fix mode misclassification. The 11:44 leg should not
be a "walk" at all — it is the tube tail — and that is the joint mode+position
work (#257, `2026-06-map-constrained-positioning.md` Phase 3). What this plan
guarantees is narrower and still valuable: **whatever the leg is labelled, its
drawn geometry is physically plausible** — a bad-GPS stretch resolves to
"roughly stationary here", never a 44 km/h sprint.

## Where the geometry actually comes from (verified)

- The drawn walk line is the **Viterbi map-match** output (`walkMatchedPath`),
  preferred over the raw/smoothed track in `episode-geometry.ts:179-183`.
- That matcher is **accuracy-blind**: `RoadFix` is `{lat, lon, ts}` with no
  accuracy (`map-match-core.ts:42`), and accuracy is explicitly dropped when
  building matcher input (`pedestrian-match-annotate.ts:127`). Its emission is a
  **constant-σ Gaussian**: `emission(distM, sigmaZ) = -0.5·(distM/sigmaZ)²`
  (`map-match-core.ts:887`), `WALK_PROFILE.sigmaZ = 8` (`pedestrian-match.ts:42`).
- When the match bails, the fallback drawn line is the **Kalman** output
  (`kalman.ts`), which *does* read accuracy (`R = accuracy²`, `kalman.ts:257`)
  but teleports anyway: after `MAX_CONSECUTIVE_REJECTS = 3` gated fixes
  (`kalman.ts:131`) it **re-acquires** — jumps onto the outlier cluster — which
  is exactly the many-consecutive-bad-fix underground case.

So the outlier survives by two independent paths: the matcher never sees
accuracy, and the Kalman fallback re-acquires to the junk. Both are addressed
below.

## Slice 0 — the plausibility metric (measurement first, ships nothing)

Per #265 Phase 0 and the "measured caveat" in
`2026-07-true-path-reconstruction.md` §6: the current scorer
(`score-walk-match.ts`, off-walkable p90) is **blind to teleports** — a path can
sprint 900 m and still sit on a pavement. We cannot tune what we cannot see, so
the metric comes first.

Add to `src/eval/walk-plausibility.ts` (and surface in `score-walk-match.ts`):

- `maxDrawnSpeedKmh` — max over consecutive **drawn** vertices of
  `distM / dtSec · 3.6`. The 11:44 leg reads ~44; a real walk is < ~9.
- `drawnVsStepBudgetRatio` — `drawnLengthM / (totalSteps · STRIDE_MAX_M)`. Coarse
  global magnitude check (the reverted gate's one honest signal, §1) — kept as a
  *reported number*, never a gate.
- Keep `offWalkableP90M` and `corridorStallM` as guard rails (must not regress).

Deliverable: run across all 22 golden days, record the baseline — how many walks
exceed a plausible walking-speed ceiling today. That count going to ~0 without
regressing off-walkable p90 is the ship gate for Slices A–C. TDD: unit tests in
`tests/walk-plausibility.test.ts` for both new fields (a teleport leg → high
speed + high ratio; a faithful leg → walking speed + ~1.0).

## Slice A — accuracy-weighted emission in the matcher

Thread accuracy into the matcher and scale the emission σ per fix.

- `RoadFix` → `{lat, lon, ts, accuracy?: number}` (`map-match-core.ts:42`); stop
  dropping accuracy at `pedestrian-match-annotate.ts:127`.
- Emission becomes per-fix: `sigmaFor(fix) = clamp(SIGMA_FLOOR, fix.accuracy ??
  SIGMA_DEFAULT, SIGMA_CEIL)` with e.g. `SIGMA_FLOOR = 8` (today's constant),
  `SIGMA_CEIL = 120`, `SIGMA_DEFAULT = 20`. `emission(distM, sigmaFor(fix))`.
  A 426 m fix now contributes ~`(8/120)² ≈ 1/225` the weight of a good fix, so
  the matched path stops chasing it.
- `ROAD_PROFILE` keeps today's behaviour by defaulting missing accuracy to the
  constant σ (byte-identical golden for driving; proven by re-running `npm run
  golden` with no re-bless).
- TDD: `tests/pedestrian-match.test.ts` — a synthetic leg with one 400 m-accuracy
  outlier fix must not bend the matched path toward it (vs the constant-σ
  baseline which does).

## Slice B — heavy-tailed kernel + honest Kalman fallback

Accuracy-weighting alone still trusts a *tight cluster* of bad fixes (the
underground fixes report `accuracy` 20–80 while agreeing with each other on a
wrong location). The heavy tail is what caps a *consistent* outlier run.

- **Matcher:** replace the Gaussian log-emission with **Student-t**:
  `logEmission(d, σ, ν) = -((ν+1)/2)·log(1 + (d/σ)²/ν)`, `ν ≈ 4`. An 11σ outlier
  costs ~ −8.6 nats instead of −60, so the Viterbi prefers a plausible on-network
  path over paying to follow the jump. Single new profile param
  `emissionDof` (Gaussian recovered as `ν → ∞`, so `ROAD_PROFILE` stays exact).
- **Kalman fallback (`kalman.ts`):** the re-acquire is the teleport's second
  door. Two guards: (1) a **robust (Mahalanobis-tapered) update** so a
  high-innovation fix is continuously down-weighted, not hard-gated then chased;
  (2) gate re-acquisition on fix quality — do **not** reset the trajectory onto a
  cluster whose fixes are all `accuracy > REACQUIRE_ACC_CEIL` (≈60 m). Result: a
  bad-GPS run holds the last good estimate (≈stationary) instead of jumping.
  Per #265: down-weight by innovation, not by trusting the phone's number.
- TDD: a 6-fix underground run (consistent, `accuracy` 60–420, 900 m off the
  bracketing good fixes) → matched/smoothed output stays within ~50 m of the good
  bracket, `maxDrawnSpeedKmh` < walking ceiling.

## Slice C — per-minute step-displacement factor (soft, not a gate)

The corrected form of the reverted whole-walk gate (§1): steps constrain
displacement **per minute**, fused as a soft cost — not a single global
threshold that rejected 27/63 good walks.

- New helper beside `meanInWindow` (`velocity.ts:287`): bin drawn-path length
  into per-minute buckets and join to `StepPoint[]` (`biometrics.ts:32`).
- Per minute `m`: `budget(m) = steps(m)·STRIDE_MAX_M + SLACK_M`; add a one-sided
  penalty `w · softplus(drawnLen(m) − budget(m))` into the matcher's transition
  cost accumulated across the fixes in that minute. A **0-step minute** ⇒ budget
  ≈ slack ⇒ any displacement is penalised — directly vetoing the 915 m jump,
  which sits under a 0-step minute — while a normal walking minute (budget
  comfortably above its drawn length) pays nothing, so good walks are untouched.
- Because it is per-minute and soft, it is a scalpel where the whole-walk gate
  was a hammer.
- TDD: the 0-step teleport minute is penalised into near-stationary; a real
  115-steps/min walking minute of the same drawn length pays ~0.

## Measurement & ship gate (every slice)

1. `node dist/cli/score-walk-match.js` across all 22 golden days: `maxDrawnSpeedKmh`
   implausible-walk count → ~0, `offWalkableP90M` and `corridorStallM`
   non-regressing.
2. `npm run golden` — Slice A driving byte-identical (no re-bless); walk diffs
   re-blessed only after the scorer confirms each is an improvement.
3. `npm run verify` (typecheck + lint + backend + frontend).
4. Visual spot-check via `render-walk-match` on the 11:44 tube-tail and a
   known-good corpus walk.

## Non-goals (stated so they are not silently assumed)

- Does not fix train/walk **misclassification** (that leg shouldn't be a walk) —
  joint mode+position, #257 / #265 Phase 3.
- Does not fix the **triangle** class — needs heading/PDR,
  `2026-07-true-path-reconstruction.md` Phase 2.
- No new sensors; uses only `accuracy` (already stored) and `steps_intraday`
  (already loaded).
