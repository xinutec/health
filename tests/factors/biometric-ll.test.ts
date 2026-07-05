/**
 * Tests for the biometric-ll factor.
 *
 * Wraps the existing `scoreModeLogLikelihood` from
 * `src/geo/mode-biometrics.ts`. The underlying function already
 * returns log-likelihood in nats, so the factor is a thin adapter
 * that translates `(MinuteObservation, ModeStats[])` into a
 * `FactorScore` for the candidate's mode.
 *
 * Behavioural assertions:
 *
 *   - Returns null when no biometric observation is in context
 *     (e.g. segment had no HR/cadence/speed available).
 *   - Returns null when the candidate's mode has no per-user stats
 *     yet (cold-start for that mode).
 *   - Returns a FactorScore with a finite log-likelihood when both
 *     obs and matching stats are present and at least one modality
 *     contributes.
 *   - Higher log-likelihood for the well-fitting mode than for a
 *     bad-fitting one (a sitting-HR observation prefers driving
 *     stats over walking stats).
 */

import { describe, expect, it } from "vitest";
import { biometricLL } from "../../src/geo/factors/biometric-ll.js";
import type { FactorContext, ModeCandidate } from "../../src/geo/factors/types.js";
import type { ModeStats } from "../../src/geo/mode-biometrics.js";

const drivingStats: ModeStats = {
	mode: "driving",
	hrMean: 75,
	hrStd: 8,
	hrSampleCount: 1000,
	cadenceMean: 0,
	cadenceStd: 1,
	cadenceSampleCount: 1000,
	speedMean: 50,
	speedStd: 15,
	speedSampleCount: 1000,
	sampleCount: 1000,
};

const walkingStats: ModeStats = {
	mode: "walking",
	hrMean: 105,
	hrStd: 10,
	hrSampleCount: 1000,
	cadenceMean: 105,
	cadenceStd: 12,
	cadenceSampleCount: 1000,
	speedMean: 5,
	speedStd: 1.2,
	speedSampleCount: 1000,
	sampleCount: 1000,
};

const allStats: ModeStats[] = [drivingStats, walkingStats];

const ctxBio = (
	obs: { hr?: number | null; cadence?: number | null; speed?: number | null },
	stats: ModeStats[] = allStats,
): FactorContext => ({
	biometricObs: {
		hr: obs.hr ?? null,
		cadence: obs.cadence ?? null,
		speed: obs.speed ?? null,
	},
	modeStats: stats,
});

const driving: ModeCandidate = { mode: "driving" };
const walking: ModeCandidate = { mode: "walking" };

describe("biometricLL factor", () => {
	it("scores driving higher than walking on a sitting-HR observation", () => {
		const obs = ctxBio({ hr: 72, cadence: 0, speed: 55 });
		const d = biometricLL(driving, obs);
		const w = biometricLL(walking, obs);
		expect(d).not.toBeNull();
		expect(w).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: the asserts above guard
		expect(d!.score).toBeGreaterThan(w!.score);
	});

	it("scores walking higher than driving on a walking-cadence observation", () => {
		const obs = ctxBio({ hr: 108, cadence: 102, speed: 5 });
		const w = biometricLL(walking, obs);
		const d = biometricLL(driving, obs);
		expect(w).not.toBeNull();
		expect(d).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: the asserts above guard
		expect(w!.score).toBeGreaterThan(d!.score);
	});

	it("returns null when context has no biometric observation", () => {
		const r = biometricLL(driving, { modeStats: allStats });
		expect(r).toBeNull();
	});

	it("returns null when context has no mode stats for the candidate", () => {
		// Cycling not in our stats list → no signature → no factor contribution
		const cycling: ModeCandidate = { mode: "cycling" };
		const r = biometricLL(cycling, ctxBio({ hr: 130, cadence: 0, speed: 22 }));
		expect(r).toBeNull();
	});

	it("returns null when no modality actually contributes (all obs null)", () => {
		const r = biometricLL(driving, ctxBio({ hr: null, cadence: null, speed: null }));
		expect(r).toBeNull();
	});

	it("populates name and rationale fields", () => {
		const r = biometricLL(driving, ctxBio({ hr: 72, cadence: 0, speed: 55 }));
		expect(r).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: the assert above guards
		expect(r!.name).toBe("biometric-ll");
		// biome-ignore lint/style/noNonNullAssertion: the assert above guards
		expect(r!.rationale.length).toBeGreaterThan(0);
	});

	it("returns scores in nats — small numbers, not raw probabilities", () => {
		const r = biometricLL(driving, ctxBio({ hr: 72, cadence: 0, speed: 55 }));
		expect(r).not.toBeNull();
		// Perfect-fit observation under Gaussian emissions: log-lik
		// around -0.5 per modality at the mean; total a few nats either
		// way. Definitely not -1000 (would mean raw mass) or +1000.
		// biome-ignore lint/style/noNonNullAssertion: the assert above guards
		expect(r!.score).toBeGreaterThan(-50);
		// biome-ignore lint/style/noNonNullAssertion: the assert above guards
		expect(r!.score).toBeLessThan(5);
	});
});
