/**
 * mode-prior factor.
 *
 * Fixed per-mode log-prior bonuses or penalties capturing the
 * asymmetric flip rules the legacy biometric corrector enforced as
 * hard cascade gates. Today's only entry is cycling — the cascade's
 * `NEVER_FLIP_TARGET` set in `mode-biometrics.ts` blocked relabeling
 * into cycling regardless of biometric evidence, on the basis that
 * cycling is rare for this user and the cycling-as-driving misclass
 * is a chronic bug. Under the factor scorer this becomes a soft
 * negative prior that the (yet-to-be-added) `cycling-signature`
 * factor's explicit joint speed/HR/cadence evidence can overcome
 * when cycling is genuinely happening.
 *
 * Calibration: the cascade rule was binary (never flip in). As a
 * soft factor, the magnitude must be large enough that the existing
 * `biometric-ll` factor (~+1 nat for cycling on an ambiguous
 * low-HR/low-cadence sitting segment) *plus* the `classifier-prior`
 * bonus (up to +4 nats when segments.ts itself confidently labelled
 * the segment as cycling, which happens on short urban segments
 * with cycling-ish speed signatures around a tube station) does NOT
 * flip a non-cycling segment to cycling. The 2026-05-23 backtest
 * surfaced multiple Wembley-Park-tube-as-cycling regressions at
 * `-1.5` because classifier-prior + biometric-ll out-scored the
 * penalty. Bumped to `-4` so that even a confidently-cycling-original
 * segment with biometric agreement (~+5 nats combined) needs at
 * least +1 nat of additional independent evidence to actually win
 * — and the upcoming `cycling-signature` factor, with explicit joint
 * evidence (sustained 15–25 km/h + elevated HR + zero cadence),
 * provides exactly that. Re-calibrate when `cycling-signature` lands.
 *
 * The factor returns `null` for modes without a prior — both because
 * "no per-mode prior is set" is meaningfully distinct from "the
 * prior is zero" (the aggregator drops null contributions from the
 * factor breakdown rather than rendering them as 0), and because
 * adding more modes later should be a one-line table edit rather
 * than a refactor.
 */

import type { Factor, ModeCandidate } from "./types.js";

const MODE_PRIORS: Partial<Record<ModeCandidate["mode"], number>> = {
	cycling: -4,
};

export const modePrior: Factor = (candidate, _ctx) => {
	const score = MODE_PRIORS[candidate.mode];
	if (score === undefined) return null;
	const sign = score >= 0 ? "+" : "";
	return {
		name: "mode-prior",
		score,
		rationale: `${candidate.mode} prior ${sign}${score.toFixed(1)} nats (asymmetric flip rule)`,
	};
};
