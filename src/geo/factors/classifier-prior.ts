/**
 * classifier-prior factor.
 *
 * Soft-replaces the cascade's `RELABEL_MAX_MARGIN` gate: when the
 * upstream GPS-feature classifier in `segments.ts` chose the original
 * mode by a comfortable margin over the runner-up, biometric evidence
 * alone should not flip the classification. The cascade enforced this
 * as a binary gate (margin >= 3 → biometric override suppressed
 * entirely). Under the factor scorer the same intuition becomes a
 * smooth positive bonus on the candidate whose mode matches the
 * original, that fires only above a minimum-margin floor and grows
 * logarithmically with margin past the floor.
 *
 * Critical: `confidenceMargin` is a **ratio** (top mode's score over
 * the runner-up), NOT a delta in nats. A margin of 1 means a coin
 * flip; a margin of 3 was the cascade's "authoritative" threshold;
 * `MARGIN_MAX_FINITE = 1000` in `segments.ts` represents a definitive
 * stationary classification. Earlier versions of this factor scaled
 * linearly on the ratio and over-fired on low-margin classifications;
 * the regression backtest on 2026-05-23 surfaced underground-tube
 * trips getting locked as walking because the underground sections
 * had margin 1.2 (genuinely ambiguous) yet still received a stickiness
 * bonus. The current shape — log-of-ratio with a margin floor —
 * preserves the cascade's "only protect confident classifications"
 * intent.
 *
 * Returns `null` for any candidate whose mode differs from the
 * original (no anti-bonus — the factor is unidirectional, only
 * rewards the incumbent; other factors are responsible for evidence
 * against alternatives), and also for margins at or below the floor
 * (the classifier didn't have a meaningful preference, so the prior
 * has nothing to say).
 *
 * **Calibration starting values.**
 *   - `MIN_MARGIN_RATIO = 2` — below this the factor returns null.
 *     The cascade gate sat at 3; using 2 here gives the soft curve
 *     a little room to grow before the cascade's binary breakpoint,
 *     so the factor and the cascade behave similarly in the
 *     interesting regime.
 *   - `K = 1.5` — multiplier on the log-margin. With the floor at 2
 *     and saturation cap of 4 nats, the curve hits +1 nat at margin
 *     ~3.8, +2 nats at margin ~7.4, and the cap at margin ~14.
 *   - `MAX_BONUS_NATS = 4` — cap. Large enough to dominate combined
 *     biometric-LL noise (~+2 nats favouring an alternative mode)
 *     plus small osm/mode-coherence wiggles. Small enough that a
 *     wrong original mode + strong joint evidence against can still
 *     overcome it.
 *
 * Re-calibrate against the fixture days in the same pass that lands
 * `cycling-signature` (the cycling positive-evidence factor that
 * pairs with `mode-prior`).
 */

import type { Factor } from "./types.js";

const MIN_MARGIN_RATIO = 2;
const K = 1.5;
const MAX_BONUS_NATS = 4;

export const classifierPrior: Factor = (candidate, ctx) => {
	const { originalMode, confidenceMargin } = ctx;
	if (originalMode === undefined || confidenceMargin === undefined) return null;
	if (confidenceMargin <= MIN_MARGIN_RATIO) return null;
	if (candidate.mode !== originalMode) return null;
	const rawNats = K * Math.log(confidenceMargin / MIN_MARGIN_RATIO);
	const score = Math.min(rawNats, MAX_BONUS_NATS);
	return {
		name: "classifier-prior",
		score,
		rationale: `original-mode bonus +${score.toFixed(2)} nats (margin ratio ${confidenceMargin.toFixed(2)}${
			rawNats > MAX_BONUS_NATS ? `, capped at ${MAX_BONUS_NATS}` : ""
		})`,
	};
};
