/**
 * `duration-dist` — per-mode duration distributions for HSMM.
 *
 * Tests pin:
 *   - Gamma fit via method-of-moments returns parameters whose
 *     mean / variance match the input samples.
 *   - `logDurationProb` evaluates Gamma PDF for d >= minDuration.
 *   - `logDurationProb` returns a hard-floor low log-prob for
 *     d < minDuration (physically-impossible durations).
 *   - Modes with no training data fall back to a default
 *     exponential.
 *   - log-prob is finite everywhere (no NaN/+Infinity).
 *   - Above the floor, prob is monotonically related to the
 *     fitted distribution shape (peaks near mean).
 */

import { describe, expect, it } from "vitest";
import {
	DEFAULT_MIN_DURATION_BY_MODE,
	fitDurationDistribution,
	type GammaFit,
	HARD_FLOOR_LOG_PROB,
	logDurationProb,
} from "../src/hmm/duration-dist.js";

describe("fitDurationDistribution", () => {
	it("returns Gamma parameters whose mean matches the input mean", () => {
		const values = [10, 15, 20, 25, 30, 35, 40]; // mean = 25
		const fit = fitDurationDistribution(values);
		const fittedMean = fit.alpha / fit.beta;
		expect(fittedMean).toBeCloseTo(25, 1);
	});

	it("returns Gamma parameters whose variance matches the input variance", () => {
		const values: number[] = [];
		for (let i = 0; i < 1000; i++) {
			// roughly uniform in [10, 60], so var ≈ (50)^2 / 12 ≈ 208
			values.push(10 + (i % 50));
		}
		const fit = fitDurationDistribution(values);
		const fittedVar = fit.alpha / (fit.beta * fit.beta);
		expect(Math.abs(fittedVar - 208)).toBeLessThan(50);
	});

	it("handles small sample count gracefully (returns fallback Gamma)", () => {
		const fit = fitDurationDistribution([10]);
		expect(fit.sampleCount).toBe(1);
		expect(Number.isFinite(fit.alpha)).toBe(true);
		expect(Number.isFinite(fit.beta)).toBe(true);
	});

	it("returns fallback Gamma for empty input (so HSMM doesn't crash)", () => {
		const fit = fitDurationDistribution([]);
		expect(fit.sampleCount).toBe(0);
		expect(fit.alpha).toBeGreaterThan(0);
		expect(fit.beta).toBeGreaterThan(0);
	});
});

describe("logDurationProb", () => {
	// Stationary: longish stays, fit a Gamma with mean ~30 min.
	const stationaryFit: GammaFit = { alpha: 4, beta: 4 / 30, sampleCount: 100 };

	it("returns the Gamma log-pdf for d above the minimum", () => {
		const lp30 = logDurationProb(30, "stationary", stationaryFit, 3);
		const lp60 = logDurationProb(60, "stationary", stationaryFit, 3);
		// Gamma(α=4, β=4/30) peaks near (α-1)/β = 22.5 min.
		// 30 is closer to the peak than 60, so log-prob higher.
		expect(lp30).toBeGreaterThan(lp60);
		expect(Number.isFinite(lp30)).toBe(true);
	});

	it("returns a hard-floor log-prob for d below minDuration (physically impossible)", () => {
		// A 1-minute stationary stay is below the typical 3-min floor.
		const lpShort = logDurationProb(1, "stationary", stationaryFit, 3);
		expect(lpShort).toBe(HARD_FLOOR_LOG_PROB);
	});

	it("the floor is much lower than any reasonable Gamma score above min", () => {
		const lpReasonable = logDurationProb(30, "stationary", stationaryFit, 3);
		expect(lpReasonable).toBeGreaterThan(HARD_FLOOR_LOG_PROB);
		// Concretely, the floor should be at least 4 nats below the peak.
		expect(lpReasonable - HARD_FLOOR_LOG_PROB).toBeGreaterThan(4);
	});

	it("never returns NaN or +Infinity", () => {
		const cases = [0, 1, 5, 30, 60, 120, 480, 1440];
		for (const d of cases) {
			const lp = logDurationProb(d, "stationary", stationaryFit, 3);
			expect(Number.isFinite(lp)).toBe(true);
		}
	});

	it("at minDuration boundary, returns the Gamma log-pdf (not the floor)", () => {
		// d=3 is exactly the minimum — should NOT be floored.
		const lpAtMin = logDurationProb(3, "stationary", stationaryFit, 3);
		expect(lpAtMin).not.toBe(HARD_FLOOR_LOG_PROB);
		expect(lpAtMin).toBeGreaterThan(HARD_FLOOR_LOG_PROB);
	});
});

describe("DEFAULT_MIN_DURATION_BY_MODE", () => {
	it("encodes the physical-floor durations for each mode", () => {
		// Spot-check the encoded knowledge:
		expect(DEFAULT_MIN_DURATION_BY_MODE.plane).toBeGreaterThanOrEqual(20);
		expect(DEFAULT_MIN_DURATION_BY_MODE.train).toBeGreaterThanOrEqual(2);
		expect(DEFAULT_MIN_DURATION_BY_MODE.stationary).toBeGreaterThanOrEqual(2);
		// Walking and driving have lower floors — short segments happen.
		expect(DEFAULT_MIN_DURATION_BY_MODE.walking).toBeLessThan(5);
	});
});
