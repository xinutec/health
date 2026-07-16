/**
 * `buildEmissionFn` — per-state emission log-likelihood for the MVP
 * HMM.
 *
 * Tests pin the per-mode preferences:
 *   - High speed favours train/driving over walking.
 *   - Walking-cadence steps favour walking over driving.
 *   - Zero cadence + high HR favours cycling over driving.
 *   - GPS absence with rail tunnel context favours train over walking.
 *   - The unknown mode is a uniform "no preference" fallback.
 */

import { describe, expect, it } from "vitest";
import { buildEmissionFn } from "../src/hmm/emissions.js";
import type { LearnedEmissionParameters } from "../src/hmm/fit-emissions.js";
import type { Observation } from "../src/hmm/observation.js";
import type { State } from "../src/hmm/state-space.js";

function obs(over: Partial<Observation> = {}): Observation {
	return {
		ts: 1_700_000_000,
		gps: { lat: 51.5, lon: -0.1, speedKmh: 0 },
		hr: 70,
		cadence: 0,
		hourLocal: 12,
		dayOfWeekLocal: 3,
		inBed: false,
		prevGpsFix: null,
		nextGpsFix: null,
		...over,
	};
}

function state(mode: State["mode"], placeId: number | null = null, lineName: string | null = null): State {
	return { mode, placeId, lineName, trainEdgeId: null };
}

const emission = buildEmissionFn({});

const HOME_LAT = 51.57;
const HOME_LON = -0.279;
const placeCoords = new Map<number, { lat: number; lon: number }>([[1, { lat: HOME_LAT, lon: HOME_LON }]]);
const emissionWithPlaces = buildEmissionFn({ placeCoords });

describe("buildEmissionFn", () => {
	it("favours train over walking at high speed", () => {
		const fast = obs({ gps: { lat: 51.5, lon: -0.1, speedKmh: 60 }, cadence: 0 });
		const trainScore = emission(state("train", null, "Metropolitan Line"), fast);
		const walkScore = emission(state("walking"), fast);
		expect(trainScore).toBeGreaterThan(walkScore);
	});

	it("favours walking over driving at walking pace with cadence steps", () => {
		const walking = obs({ gps: { lat: 51.5, lon: -0.1, speedKmh: 5 }, cadence: 100, hr: 95 });
		const walkScore = emission(state("walking"), walking);
		const driveScore = emission(state("driving"), walking);
		expect(walkScore).toBeGreaterThan(driveScore);
	});

	it("favours cycling over driving at cycling pace with zero cadence and elevated HR", () => {
		const cycling = obs({ gps: { lat: 51.5, lon: -0.1, speedKmh: 18 }, cadence: 0, hr: 130 });
		const cycleScore = emission(state("cycling"), cycling);
		const driveScore = emission(state("driving"), cycling);
		expect(cycleScore).toBeGreaterThan(driveScore);
	});

	it("favours stationary at near-zero speed", () => {
		const still = obs({ gps: { lat: 51.5, lon: -0.1, speedKmh: 0 }, cadence: 0, hr: 65 });
		const statScore = emission(state("stationary"), still);
		const walkScore = emission(state("walking"), still);
		expect(statScore).toBeGreaterThan(walkScore);
	});

	it("decides GPS-absent minutes by HR + cadence, not by GPS-presence (which is uniform across modes)", () => {
		// Tunnel-like: GPS absent, restful HR 80, zero cadence.
		// Without uniform GPS-presence, train would win because its
		// p_gps_present was set lower (tunnel-aware). Under the
		// uniform setting (post Phase 1.5 audit), HR + cadence have
		// to discriminate — train's HR mean (75) is closer to 80
		// than walking's HR mean (100), so train still wins, but
		// for the right reason.
		const noFix = obs({ gps: null, hr: 80, cadence: 0 });
		const trainScore = emission(state("train", null, "Metropolitan Line"), noFix);
		const walkScore = emission(state("walking"), noFix);
		expect(trainScore).toBeGreaterThan(walkScore);
	});

	it("unknown is a uniform low-prior fallback (always loses to a positive-evidence state)", () => {
		const walking = obs({ gps: { lat: 51.5, lon: -0.1, speedKmh: 5 }, cadence: 100, hr: 95 });
		const unknownScore = emission(state("unknown"), walking);
		const walkScore = emission(state("walking"), walking);
		expect(walkScore).toBeGreaterThan(unknownScore);
	});

	it("handles missing biometrics by skipping that factor (not penalising)", () => {
		// Speed strongly suggests walking; HR + cadence missing.
		const partial = obs({ gps: { lat: 51.5, lon: -0.1, speedKmh: 5 }, hr: null, cadence: null });
		const walkScore = emission(state("walking"), partial);
		const stationaryScore = emission(state("stationary"), partial);
		// Walking still wins on speed alone.
		expect(walkScore).toBeGreaterThan(stationaryScore);
	});

	it("favours stationary@placeId when GPS is close to that place's centroid", () => {
		const atHome = obs({ gps: { lat: HOME_LAT, lon: HOME_LON, speedKmh: 0 }, hr: 65, cadence: 0 });
		const homeScore = emissionWithPlaces(state("stationary", 1), atHome);
		const offNetworkScore = emissionWithPlaces(state("stationary", null), atHome);
		const trainScore = emissionWithPlaces(state("train", null, "Metropolitan Line"), atHome);
		// stationary @ Home should beat stationary @ none AND any movement state.
		expect(homeScore).toBeGreaterThan(offNetworkScore);
		expect(homeScore).toBeGreaterThan(trainScore);
	});

	it("penalises stationary@placeId when GPS is far from that place's centroid", () => {
		const farFromHome = obs({
			gps: { lat: HOME_LAT + 0.05, lon: HOME_LON + 0.05, speedKmh: 0 },
			hr: 65,
			cadence: 0,
		});
		const homeScore = emissionWithPlaces(state("stationary", 1), farFromHome);
		const offNetworkScore = emissionWithPlaces(state("stationary", null), farFromHome);
		// 5km away from home: stationary @ none should beat stationary @ Home.
		expect(offNetworkScore).toBeGreaterThan(homeScore);
	});

	it("does not apply place-distance penalty when GPS is null (overnight at home)", () => {
		const overnightCharging = obs({ gps: null, hr: 60, cadence: null });
		const withPlaceScore = emissionWithPlaces(state("stationary", 1), overnightCharging);
		const withoutPlaceScore = emission(state("stationary", 1), overnightCharging);
		// When GPS is null, both emission functions agree — no place-distance term to apply.
		expect(withPlaceScore).toBe(withoutPlaceScore);
	});

	// Time-of-day boost moved to src/hmm/entry-prior.ts — see
	// tests/hmm-entry-prior.test.ts. Emission no longer applies it.

	it("plane needs very high speed", () => {
		const cruise = obs({ gps: { lat: 51.5, lon: -0.1, speedKmh: 600 }, cadence: 0, hr: 70 });
		const planeScore = emission(state("plane"), cruise);
		const trainScore = emission(state("train", null, "Metropolitan Line"), cruise);
		expect(planeScore).toBeGreaterThan(trainScore);
	});

	it("learnedEmissions overrides per-mode prior with the fitted distribution", () => {
		// Construct a learned model where stationary's HR mean is 90
		// (instead of the hand-tuned 70). At HR=90 observed, the
		// learned model should score stationary HIGHER than the
		// hand-tuned model does, because the fit is centred on 90.
		const learned: LearnedEmissionParameters = {
			perMode: {
				stationary: {
					gpsPresentProb: 0.85,
					speed: { mean: 0, std: 2, sampleCount: 100 },
					hr: { mean: 90, std: 10, sampleCount: 100 },
					cadence: {
						expectedZeroProb: 0.99,
						positiveMean: 10,
						positiveStd: 20,
						positiveSampleCount: 1,
						totalSampleCount: 100,
					},
				},
			},
			perPlaceHr: {},
			trainingSummary: { totalSampleCount: 100, samplesPerMode: { stationary: 100 }, samplesPerPlace: {} },
		};
		const handTuned = buildEmissionFn({});
		const learnedFn = buildEmissionFn({ learnedEmissions: learned });
		const o = obs({ hr: 90, cadence: 0, gps: { lat: 51.5, lon: -0.1, speedKmh: 0 } });
		expect(learnedFn(state("stationary"), o)).toBeGreaterThan(handTuned(state("stationary"), o));
	});

	it("learnedEmissions 'fallback' for a mode keeps the hand-tuned prior", () => {
		const learned: LearnedEmissionParameters = {
			perMode: {
				cycling: "fallback", // not enough cycling samples to fit
			},
			perPlaceHr: {},
			trainingSummary: { totalSampleCount: 0, samplesPerMode: { cycling: 5 }, samplesPerPlace: {} },
		};
		const handTuned = buildEmissionFn({});
		const learnedFn = buildEmissionFn({ learnedEmissions: learned });
		const o = obs({ gps: { lat: 51.5, lon: -0.1, speedKmh: 18 }, hr: 130, cadence: 0 });
		// cycling falls back to hand-tuned — scores must match.
		expect(learnedFn(state("cycling"), o)).toBe(handTuned(state("cycling"), o));
	});

	it("per-place HR overrides per-mode HR for stationary @ knownPlace", () => {
		// Per-place fit puts place 42's HR baseline at 120 (e.g., an
		// elevated-HR location). Per-mode stationary fit stays at 70.
		// At an observation with HR=120, stationary @ 42 should score
		// HIGHER than stationary @ none (which uses per-mode 70).
		const learned: LearnedEmissionParameters = {
			perMode: {
				stationary: {
					gpsPresentProb: 0.85,
					speed: { mean: 0, std: 2, sampleCount: 100 },
					hr: { mean: 70, std: 15, sampleCount: 100 },
					cadence: {
						expectedZeroProb: 0.99,
						positiveMean: 10,
						positiveStd: 20,
						positiveSampleCount: 1,
						totalSampleCount: 100,
					},
				},
			},
			perPlaceHr: {
				"42": { mean: 120, std: 8, sampleCount: 100 },
			},
			trainingSummary: { totalSampleCount: 100, samplesPerMode: { stationary: 100 }, samplesPerPlace: { "42": 100 } },
		};
		const fn = buildEmissionFn({ learnedEmissions: learned });
		const o = obs({ hr: 120, cadence: 0, gps: null });
		const at42 = fn(state("stationary", 42), o);
		const atNone = fn(state("stationary", null), o);
		// At HR=120, the per-place fit (μ=120) scores much higher than
		// the per-mode fit (μ=70 σ=15: z=3.33).
		expect(at42).toBeGreaterThan(atNone);
	});

	it("per-place HR falls through to per-mode when no per-place fit exists", () => {
		// Place 999 has no per-place fit. Should score identically to
		// stationary @ none on a HR=70 observation.
		const learned: LearnedEmissionParameters = {
			perMode: {
				stationary: {
					gpsPresentProb: 0.85,
					speed: { mean: 0, std: 2, sampleCount: 100 },
					hr: { mean: 70, std: 15, sampleCount: 100 },
					cadence: {
						expectedZeroProb: 0.99,
						positiveMean: 10,
						positiveStd: 20,
						positiveSampleCount: 1,
						totalSampleCount: 100,
					},
				},
			},
			perPlaceHr: { "42": { mean: 120, std: 8, sampleCount: 100 } },
			trainingSummary: { totalSampleCount: 100, samplesPerMode: { stationary: 100 }, samplesPerPlace: {} },
		};
		const fn = buildEmissionFn({ learnedEmissions: learned });
		const o = obs({ hr: 70, cadence: 0, gps: null });
		// Place 999 has no fit → use per-mode (which is the same as
		// stationary @ null since neither has place geometry).
		expect(fn(state("stationary", 999), o)).toBe(fn(state("stationary", null), o));
	});

	it("never returns NaN or +Infinity", () => {
		const cases: Observation[] = [
			obs({ gps: null, hr: null, cadence: null }),
			obs({ gps: { lat: 0, lon: 0, speedKmh: 0 } }),
			obs({ gps: { lat: 0, lon: 0, speedKmh: 1000 }, hr: 200, cadence: 300 }),
		];
		const states: State[] = [
			state("stationary"),
			state("walking"),
			state("cycling"),
			state("driving"),
			state("train", null, "Metropolitan Line"),
			state("plane"),
			state("unknown"),
		];
		for (const o of cases) {
			for (const s of states) {
				const score = emission(s, o);
				expect(Number.isFinite(score) || score === Number.NEGATIVE_INFINITY).toBe(true);
			}
		}
	});

	describe("reacquire-robust stationary speed", () => {
		const robust = buildEmissionFn({ reacquireRobustSpeed: true });
		const driftObs = (age: number | null) =>
			obs({ gps: { lat: 51.5, lon: -0.1, speedKmh: 12 }, cadence: 0, reacquireAgeMin: age });

		it("tolerates drift-speed fixes right after reacquisition", () => {
			// 12 km/h at N(0,2) is z=6 — the measured phantom-buying charge.
			// At reacquire age 0 the widened σ makes it ordinary noise.
			const fresh = robust(state("stationary"), driftObs(0));
			const unconditioned = robust(state("stationary"), driftObs(null));
			expect(fresh - unconditioned).toBeGreaterThan(10);
		});

		it("the tolerance decays as the filter settles", () => {
			const at0 = robust(state("stationary"), driftObs(0));
			const at4 = robust(state("stationary"), driftObs(4));
			const at12 = robust(state("stationary"), driftObs(12));
			expect(at0).toBeGreaterThan(at4);
			expect(at4).toBeGreaterThan(at12);
			// Far past the settle window it is barely distinguishable from
			// the unconditioned charge.
			expect(at12 - robust(state("stationary"), driftObs(null))).toBeLessThan(3);
		});

		it("a genuine ride speed stays convicted even at reacquire age 0", () => {
			const rideObs = obs({ gps: { lat: 51.5, lon: -0.1, speedKmh: 70 }, cadence: 0, reacquireAgeMin: 0 });
			const still = robust(state("stationary"), rideObs);
			const train = robust(state("train", null, "Metropolitan Line"), rideObs);
			expect(train).toBeGreaterThan(still + 5);
		});

		it("default-off keeps the emission unchanged", () => {
			const plain = buildEmissionFn({});
			expect(plain(state("stationary"), driftObs(0))).toBe(plain(state("stationary"), driftObs(null)));
		});

		it("moving modes are not widened", () => {
			// Walking at 12 km/h (z=3.5 on N(5,2)) pays the same regardless
			// of reacquire age — only the still-user lie is corrected.
			expect(robust(state("walking"), driftObs(0))).toBe(robust(state("walking"), driftObs(null)));
		});

		it("a reacquire fix ON a rail corridor is not sheltered", () => {
			// A dark ride's reacquisition looks exactly like this: fresh fix,
			// moving speed, on the track. Off-rail drift keeps the tolerance.
			const onRail = obs({ gps: { lat: 51.5, lon: -0.1, speedKmh: 22 }, reacquireAgeMin: 0, railDistM: 5 });
			const offRail = obs({ gps: { lat: 51.5, lon: -0.1, speedKmh: 22 }, reacquireAgeMin: 0, railDistM: 280 });
			expect(robust(state("stationary"), offRail) - robust(state("stationary"), onRail)).toBeGreaterThan(20);
		});
	});
});
