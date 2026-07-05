/**
 * classifier-prior factor — gives the segment's original (pre-refinement)
 * mode a bonus that grows logarithmically with the upstream classifier's
 * `confidenceMargin` (a ratio of top-mode score over runner-up). Replaces
 * the cascade's binary `confidenceMargin >= RELABEL_MAX_MARGIN` gate
 * that locked an unambiguous classification against biometric override.
 * The soft version fires only above a margin-ratio floor (so
 * genuinely-ambiguous classifications are freely overridable) and caps
 * at a saturation bonus.
 *
 * The unit on `confidenceMargin` is a ratio, not a log-likelihood —
 * that's why the bonus is `K * log(margin / floor)`, not `K * margin`.
 * Earlier versions of this factor scaled linearly on the ratio and
 * over-fired on low-margin classifications; see the comment block in
 * the implementation.
 */

import { describe, expect, it } from "vitest";
import { classifierPrior } from "../../src/geo/factors/classifier-prior.js";
import type { FactorContext, ModeCandidate } from "../../src/geo/factors/types.js";

function ctx(over: Partial<FactorContext> = {}): FactorContext {
	return { originalMode: "walking", confidenceMargin: 5, ...over };
}

function cand(mode: ModeCandidate["mode"]): ModeCandidate {
	return { mode };
}

describe("classifierPrior", () => {
	it("awards a positive bonus to the candidate matching the original mode (above floor)", () => {
		const r = classifierPrior(cand("walking"), ctx({ originalMode: "walking", confidenceMargin: 5 }));
		expect(r).not.toBeNull();
		expect(r?.score).toBeGreaterThan(0);
		expect(r?.name).toBe("classifier-prior");
	});

	it("returns null for candidates whose mode is not the original", () => {
		const r = classifierPrior(cand("driving"), ctx({ originalMode: "walking", confidenceMargin: 5 }));
		expect(r).toBeNull();
	});

	it("scales the bonus with confidenceMargin (log-of-ratio: margin 3 < margin 5 < margin 10)", () => {
		const low = classifierPrior(cand("walking"), ctx({ originalMode: "walking", confidenceMargin: 3 }));
		const mid = classifierPrior(cand("walking"), ctx({ originalMode: "walking", confidenceMargin: 5 }));
		const high = classifierPrior(cand("walking"), ctx({ originalMode: "walking", confidenceMargin: 10 }));
		expect(low?.score).toBeGreaterThan(0);
		expect(mid?.score).toBeGreaterThan(low?.score ?? 0);
		expect(high?.score).toBeGreaterThan(mid?.score ?? 0);
	});

	it("caps the bonus at MAX_BONUS_NATS for very confident classifications", () => {
		// MARGIN_MAX_FINITE = 1000 in segments.ts represents a definitive
		// stationary classification. The cap kicks in well before that.
		const high = classifierPrior(cand("walking"), ctx({ originalMode: "walking", confidenceMargin: 100 }));
		const veryHigh = classifierPrior(cand("walking"), ctx({ originalMode: "walking", confidenceMargin: 1000 }));
		expect(high?.score).toEqual(veryHigh?.score);
	});

	it("returns null at the margin-ratio floor (margin 2 — meaningfully ambiguous between two modes)", () => {
		const r = classifierPrior(cand("walking"), ctx({ originalMode: "walking", confidenceMargin: 2 }));
		expect(r).toBeNull();
	});

	it("returns null below the margin-ratio floor (margin 1.5 — genuinely ambiguous)", () => {
		// This is the load-bearing change vs the original linear-on-ratio
		// implementation: underground tube segments come in with margins
		// around 1.2–1.8 and were getting locked as walking by the old
		// linear scaling. The floor lets the rest of the factor scorer
		// override them.
		const r = classifierPrior(cand("walking"), ctx({ originalMode: "walking", confidenceMargin: 1.5 }));
		expect(r).toBeNull();
	});

	it("returns null at margin 1 (coin flip)", () => {
		const r = classifierPrior(cand("walking"), ctx({ originalMode: "walking", confidenceMargin: 1 }));
		expect(r).toBeNull();
	});

	it("returns null when originalMode is missing from the context", () => {
		const r = classifierPrior(cand("walking"), ctx({ originalMode: undefined, confidenceMargin: 5 }));
		expect(r).toBeNull();
	});

	it("returns null when confidenceMargin is missing from the context", () => {
		const r = classifierPrior(cand("walking"), ctx({ originalMode: "walking", confidenceMargin: undefined }));
		expect(r).toBeNull();
	});

	it("at the cascade-gate margin (3), the bonus is modest — not enough to dominate +2 nats of biometric-LL", () => {
		// Calibration sanity check: at margin 3 (the cascade's
		// RELABEL_MAX_MARGIN), the soft factor is intentionally weaker
		// than the cascade's binary lock. The cascade BOUND the
		// classification at margin >= 3; the soft factor only nudges.
		// This keeps the migration's behaviour at moderate confidence
		// substantially overridable by joint evidence.
		const r = classifierPrior(cand("walking"), ctx({ originalMode: "walking", confidenceMargin: 3 }));
		expect(r?.score).toBeLessThan(2);
	});

	it("at very high margin, the bonus is large enough to dominate single-factor noise", () => {
		const r = classifierPrior(cand("walking"), ctx({ originalMode: "walking", confidenceMargin: 1000 }));
		// At a definitive classification, +4 nats should beat any single
		// realistic biometric-LL delta (~+2 nats favouring an alternative).
		expect(r?.score).toBeGreaterThanOrEqual(3);
	});
});
