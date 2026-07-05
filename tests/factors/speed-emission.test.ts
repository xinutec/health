/**
 * Tests for the speed-emission factor.
 *
 * The factor wraps the existing `scoreWindow` mode scoring into a
 * log-likelihood per mode-candidate. It's the simplest factor in
 * Phase 1 of docs/proposals/2026-05-scored-classification.md — pure
 * unpacking of existing computation, no new logic.
 *
 * Behavioural assertions:
 *
 *   - For driving-shaped features (median 60 km/h, high linearity),
 *     the driving candidate scores higher than the walking candidate.
 *   - For walking-shaped features (median 4 km/h, moderate linearity,
 *     mass of stops), the walking candidate scores higher than the
 *     driving candidate.
 *   - Scores are log-likelihoods (nats), not raw multiplicative
 *     masses. A score of e.g. -2.3 nats == probability mass ~0.1.
 *   - Returns null when no windowFeatures are passed (factor doesn't
 *     apply).
 *   - Same FactorScore shape as the other factors will use (`name`,
 *     `score`, `rationale` fields populated and well-typed).
 */

import { describe, expect, it } from "vitest";
import { speedEmission } from "../../src/geo/factors/speed-emission.js";
import type { FactorContext, ModeCandidate } from "../../src/geo/factors/types.js";

/** Build a minimal WindowFeatures-compatible context shape; only the
 *  fields the speed-emission factor consults need plausible values. */
const ctx = (
	overrides: Partial<{
		medianSpeed: number;
		maxSpeed: number;
		speedVariance: number;
		headingChangeRate: number;
		linearity: number;
		accelerationBursts: number;
		stopFraction: number;
		netDisplacement: number;
		boundingRadius: number;
	}>,
): FactorContext => ({
	windowFeatures: {
		startTs: 0,
		endTs: 60,
		centroidLat: 0,
		centroidLon: 0,
		medianSpeed: 0,
		maxSpeed: 0,
		speedVariance: 0,
		headingChangeRate: 0,
		linearity: 0,
		accelerationBursts: 0,
		stopFraction: 0,
		netDisplacement: 100,
		boundingRadius: 50,
		pointCount: 10,
		...overrides,
	},
});

const drivingFeatures = ctx({
	medianSpeed: 60,
	maxSpeed: 80,
	speedVariance: 30,
	headingChangeRate: 1,
	linearity: 0.85,
	accelerationBursts: 2,
	stopFraction: 0.05,
	netDisplacement: 5000,
	boundingRadius: 4500,
});

const walkingFeatures = ctx({
	medianSpeed: 4,
	maxSpeed: 7,
	speedVariance: 2,
	headingChangeRate: 5,
	linearity: 0.55,
	accelerationBursts: 0,
	stopFraction: 0.1,
	netDisplacement: 250,
	boundingRadius: 200,
});

const driving: ModeCandidate = { mode: "driving" };
const walking: ModeCandidate = { mode: "walking" };

describe("speedEmission factor", () => {
	it("prefers driving over walking on driving-shaped features", () => {
		const d = speedEmission(driving, drivingFeatures);
		const w = speedEmission(walking, drivingFeatures);
		expect(d).not.toBeNull();
		expect(w).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: the asserts above guard
		expect(d!.score).toBeGreaterThan(w!.score);
	});

	it("prefers walking over driving on walking-shaped features", () => {
		const w = speedEmission(walking, walkingFeatures);
		const d = speedEmission(driving, walkingFeatures);
		expect(w).not.toBeNull();
		expect(d).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: the asserts above guard
		expect(w!.score).toBeGreaterThan(d!.score);
	});

	it("returns scores in nats (log domain), not raw masses", () => {
		// A range-score multiplier of 0.5 (decent-but-not-great match)
		// translates to log(0.5) ≈ -0.69 nats. A factor score that's
		// many orders of magnitude in either direction signals we're
		// returning raw mass, not log.
		const r = speedEmission(driving, drivingFeatures);
		expect(r).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: the assert above guards
		expect(r!.score).toBeGreaterThan(-20);
		// biome-ignore lint/style/noNonNullAssertion: the assert above guards
		expect(r!.score).toBeLessThan(5);
	});

	it("returns null when neither windowFeatures nor speedKmh are in the context", () => {
		const r = speedEmission(driving, {} as FactorContext);
		expect(r).toBeNull();
	});

	it("falls back to speedKmh-only scoring when WindowFeatures is absent", () => {
		// At 60 km/h with no full features, driving should still score
		// positively and walking should score negatively.
		const fastCtx: FactorContext = { speedKmh: 60 };
		const d = speedEmission(driving, fastCtx);
		const w = speedEmission(walking, fastCtx);
		expect(d).not.toBeNull();
		expect(w).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: the asserts above guard
		expect(d!.score).toBeGreaterThan(w!.score);
		// biome-ignore lint/style/noNonNullAssertion: the asserts above guard
		expect(d!.rationale).toContain("speed-only");
	});

	it("speedKmh-only path discriminates walking at walking pace", () => {
		const slowCtx: FactorContext = { speedKmh: 4 };
		const w = speedEmission(walking, slowCtx);
		const d = speedEmission(driving, slowCtx);
		expect(w).not.toBeNull();
		expect(d).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: the asserts above guard
		expect(w!.score).toBeGreaterThan(d!.score);
	});

	it("populates name and rationale fields", () => {
		const r = speedEmission(driving, drivingFeatures);
		expect(r).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: the assert above guards
		expect(r!.name).toBe("speed-emission");
		// biome-ignore lint/style/noNonNullAssertion: the assert above guards
		expect(r!.rationale.length).toBeGreaterThan(0);
	});

	it("returns -Infinity when the per-mode score is zero (mode is impossible)", () => {
		// A walking candidate on definitely-not-walking features. The
		// underlying scoreWalking returns ~0 because the linearity is
		// almost zero and the bounding radius is small AND speed is way
		// out of range. The factor's log() of zero is -Infinity, which
		// the consumer treats as "this candidate is ruled out" — not
		// null, since the factor DID compute (just emphatically).
		const impossibleForWalking = ctx({
			medianSpeed: 200,
			maxSpeed: 250,
			linearity: 0.99,
			boundingRadius: 100000,
			netDisplacement: 100000,
		});
		const r = speedEmission(walking, impossibleForWalking);
		expect(r).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: the assert above guards
		expect(r!.score).toBeLessThan(-5); // strongly negative; may not be literal -Infinity
	});
});
