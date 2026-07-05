/**
 * `fitPerModeEmissions` — supervised MLE fit of per-mode emission
 * distributions from heuristic-labeled minute samples.
 *
 * Tests pin:
 *   - Per-mode Gaussian mean/std are MLE estimates from the labeled
 *     samples (Bessel-corrected stddev).
 *   - Cadence is zero-inflated: expectedZeroProb + positive Gaussian.
 *   - Speed only counts GPS-present samples (no speed without fix).
 *   - GPS-present probability is empirical: count(gps) / count(label).
 *   - Modes with < MIN_SAMPLES are marked "fallback" so the caller
 *     can use hand-tuned priors instead.
 *   - HR std is floored at HR_STD_FLOOR to prevent pathological
 *     overfitting on a small/clustered training set.
 *   - Training summary reflects what went in.
 */

import { describe, expect, it } from "vitest";
import {
	fitPerModeEmissions,
	HR_STD_FLOOR,
	type LabeledSample,
	MIN_SAMPLES_PER_MODE,
} from "../src/hmm/fit-emissions.js";

function sample(over: Partial<LabeledSample> = {}): LabeledSample {
	return {
		mode: "stationary",
		hr: 70,
		cadence: 0,
		speedKmh: 0,
		gpsPresent: true,
		placeId: null,
		...over,
	};
}

describe("fitPerModeEmissions", () => {
	it("fits per-mode HR mean/std via MLE", () => {
		// 100 stationary samples with HR drawn from a known Gaussian
		// centred at 65, std 8. Fit should recover those parameters.
		const samples: LabeledSample[] = [];
		const rng = mulberry32(42);
		for (let i = 0; i < 100; i++) {
			samples.push(sample({ hr: gaussianSample(rng, 65, 8) }));
		}
		const fit = fitPerModeEmissions(samples);
		const stationary = fit.perMode.stationary;
		if (stationary === undefined || stationary === "fallback") throw new Error("expected fitted stationary");
		expect(stationary.hr.mean).toBeCloseTo(65, 0); // within 1 bpm
		expect(stationary.hr.std).toBeCloseTo(8, 0); // within 1 bpm
		expect(stationary.hr.sampleCount).toBe(100);
	});

	it("zero-inflated cadence: expectedZeroProb + positive Gaussian", () => {
		// 1000 walking samples: 800 with cadence ~ Gaussian(100, 15),
		// 200 with cadence = 0 (pauses). Larger N so the fitted mean
		// lands within ±0.5 of true (SE ≈ 15 / √800 ≈ 0.53).
		const samples: LabeledSample[] = [];
		const rng = mulberry32(7);
		for (let i = 0; i < 800; i++) {
			samples.push(sample({ mode: "walking", cadence: gaussianSample(rng, 100, 15) }));
		}
		for (let i = 0; i < 200; i++) {
			samples.push(sample({ mode: "walking", cadence: 0 }));
		}
		const fit = fitPerModeEmissions(samples);
		const walking = fit.perMode.walking;
		if (walking === undefined || walking === "fallback") throw new Error("expected fitted walking");
		expect(walking.cadence.expectedZeroProb).toBeCloseTo(0.2, 1); // 200/1000
		// MLE on Box-Muller samples: SE ≈ 15/√800 ≈ 0.53. Test the fit
		// is within sampling noise rather than within unrealistic tolerance.
		expect(Math.abs(walking.cadence.positiveMean - 100)).toBeLessThan(2);
		expect(Math.abs(walking.cadence.positiveStd - 15)).toBeLessThan(2);
		expect(walking.cadence.totalSampleCount).toBe(1000);
		expect(walking.cadence.positiveSampleCount).toBe(800);
	});

	it("speed only counts GPS-present samples", () => {
		// 50 driving samples with GPS present (speed 40km/h),
		// 50 with GPS absent (speed null). Fitter must use only the
		// 50 GPS-present ones — speed without a fix is meaningless.
		const samples: LabeledSample[] = [];
		for (let i = 0; i < 50; i++) {
			samples.push(sample({ mode: "driving", speedKmh: 40, gpsPresent: true }));
		}
		for (let i = 0; i < 50; i++) {
			samples.push(sample({ mode: "driving", speedKmh: null, gpsPresent: false }));
		}
		const fit = fitPerModeEmissions(samples);
		const driving = fit.perMode.driving;
		if (driving === undefined || driving === "fallback") throw new Error("expected fitted driving");
		expect(driving.speed.mean).toBeCloseTo(40, 1);
		expect(driving.speed.sampleCount).toBe(50);
	});

	it("GPS-present probability is empirical fraction over the mode's samples", () => {
		// 80/100 train samples have GPS (rest are tunnels).
		const samples: LabeledSample[] = [];
		for (let i = 0; i < 80; i++) {
			samples.push(sample({ mode: "train", gpsPresent: true, speedKmh: 50 }));
		}
		for (let i = 0; i < 20; i++) {
			samples.push(sample({ mode: "train", gpsPresent: false, speedKmh: null }));
		}
		const fit = fitPerModeEmissions(samples);
		const train = fit.perMode.train;
		if (train === undefined || train === "fallback") throw new Error("expected fitted train");
		expect(train.gpsPresentProb).toBeCloseTo(0.8, 2);
	});

	it("marks modes with < MIN_SAMPLES_PER_MODE as fallback", () => {
		const samples: LabeledSample[] = [];
		for (let i = 0; i < MIN_SAMPLES_PER_MODE - 1; i++) {
			samples.push(sample({ mode: "plane", speedKmh: 600 }));
		}
		const fit = fitPerModeEmissions(samples);
		expect(fit.perMode.plane).toBe("fallback");
	});

	it("floors HR std at HR_STD_FLOOR to prevent overfitting", () => {
		// 100 samples all at HR = 72 exactly. Raw std = 0; should be
		// floored.
		const samples: LabeledSample[] = [];
		for (let i = 0; i < 100; i++) {
			samples.push(sample({ hr: 72 }));
		}
		const fit = fitPerModeEmissions(samples);
		const stationary = fit.perMode.stationary;
		if (stationary === undefined || stationary === "fallback") throw new Error("expected fitted");
		expect(stationary.hr.std).toBeGreaterThanOrEqual(HR_STD_FLOOR);
	});

	it("returns training summary keyed by mode", () => {
		const samples: LabeledSample[] = [];
		for (let i = 0; i < 100; i++) samples.push(sample({ mode: "stationary" }));
		for (let i = 0; i < 60; i++) samples.push(sample({ mode: "walking" }));
		const fit = fitPerModeEmissions(samples);
		expect(fit.trainingSummary.totalSampleCount).toBe(160);
		expect(fit.trainingSummary.samplesPerMode.stationary).toBe(100);
		expect(fit.trainingSummary.samplesPerMode.walking).toBe(60);
	});

	it("handles missing modalities — skips factors with no data", () => {
		// 100 stationary samples with HR=null, cadence=null, GPS=null
		// (all null observations). Speed/HR should have sampleCount=0
		// and we expect fallback so emission falls back to hand-tuned.
		const samples: LabeledSample[] = [];
		for (let i = 0; i < 100; i++) {
			samples.push(sample({ hr: null, cadence: null, speedKmh: null, gpsPresent: false }));
		}
		const fit = fitPerModeEmissions(samples);
		const stationary = fit.perMode.stationary;
		if (stationary === undefined || stationary === "fallback") throw new Error("expected fitted");
		// With no HR samples, hr.sampleCount = 0; downstream code must
		// be tolerant of that (use fallback or skip the HR factor).
		expect(stationary.hr.sampleCount).toBe(0);
		expect(stationary.gpsPresentProb).toBeCloseTo(0, 2);
	});

	it("returns empty perMode + zero summary for empty input", () => {
		const fit = fitPerModeEmissions([]);
		expect(fit.trainingSummary.totalSampleCount).toBe(0);
		expect(Object.keys(fit.perMode)).toHaveLength(0);
		expect(Object.keys(fit.perPlaceHr)).toHaveLength(0);
	});

	it("fits per-place HR for stationary states with sufficient samples", () => {
		// Two synthetic places with different HR baselines: place A
		// peaked at 120, place B peaked at 65. A global per-mode
		// stationary fit couldn't represent both well; per-place
		// distinguishes them.
		const samples: LabeledSample[] = [];
		const rng = mulberry32(101);
		for (let i = 0; i < 100; i++) {
			samples.push(sample({ mode: "stationary", placeId: 42, hr: gaussianSample(rng, 120, 8) }));
		}
		for (let i = 0; i < 200; i++) {
			samples.push(sample({ mode: "stationary", placeId: 1, hr: gaussianSample(rng, 65, 6) }));
		}
		const fit = fitPerModeEmissions(samples);
		const placeHi = fit.perPlaceHr["42"];
		const placeLo = fit.perPlaceHr["1"];
		expect(placeHi).toBeDefined();
		expect(placeLo).toBeDefined();
		expect(Math.abs(placeHi.mean - 120)).toBeLessThan(3);
		expect(Math.abs(placeLo.mean - 65)).toBeLessThan(2);
		// Per-place fits are distinct (the whole point).
		expect(Math.abs(placeHi.mean - placeLo.mean)).toBeGreaterThan(40);
	});

	it("drops per-place fits below MIN_SAMPLES_PER_PLACE — falls through to per-mode at inference", () => {
		const samples: LabeledSample[] = [];
		// Place 7: only 10 samples (insufficient).
		for (let i = 0; i < 10; i++) samples.push(sample({ mode: "stationary", placeId: 7, hr: 80 }));
		// Bulk stationary @ no place so the mode-level fit still happens.
		for (let i = 0; i < MIN_SAMPLES_PER_MODE; i++) {
			samples.push(sample({ mode: "stationary", placeId: null, hr: 70 }));
		}
		const fit = fitPerModeEmissions(samples);
		expect(fit.perPlaceHr["7"]).toBeUndefined();
		// summary still tracks the count, for diagnostics.
		expect(fit.trainingSummary.samplesPerPlace["7"]).toBe(10);
	});

	it("ignores moving-mode samples for per-place fits (only stationary contributes)", () => {
		const samples: LabeledSample[] = [];
		// 100 walking samples labeled with placeId — shouldn't contribute
		// per-place. (In reality moving modes set placeId=null, but
		// defensive against a caller wiring it differently.)
		for (let i = 0; i < 100; i++) {
			samples.push(sample({ mode: "walking", placeId: 5, hr: 100 }));
		}
		const fit = fitPerModeEmissions(samples);
		expect(fit.perPlaceHr["5"]).toBeUndefined();
	});

	it("skips samples with null HR for per-place fit (rest of sample still counted)", () => {
		const samples: LabeledSample[] = [];
		// 100 stationary @ place 9 with HR present.
		for (let i = 0; i < 100; i++) samples.push(sample({ mode: "stationary", placeId: 9, hr: 70 }));
		// 100 stationary @ place 9 with HR null — these contribute to
		// samplesPerPlace count but not to the HR fit.
		for (let i = 0; i < 100; i++) samples.push(sample({ mode: "stationary", placeId: 9, hr: null }));
		const fit = fitPerModeEmissions(samples);
		expect(fit.perPlaceHr["9"].sampleCount).toBe(100);
		expect(fit.trainingSummary.samplesPerPlace["9"]).toBe(200);
	});
});

/** Deterministic PRNG for reproducible tests. */
function mulberry32(seed: number): () => number {
	let s = seed >>> 0;
	return (): number => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Box-Muller transform → standard normal → shift/scale. */
function gaussianSample(rng: () => number, mean: number, std: number): number {
	const u1 = rng();
	const u2 = rng();
	const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
	return mean + std * z;
}
