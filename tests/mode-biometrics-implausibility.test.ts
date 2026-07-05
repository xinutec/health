/**
 * Tests for the pure-predicate implausibility helpers extracted from
 * vetoImplausibleHr / vetoImplausibleCadence.
 *
 * The full veto functions still do the demote-to-alternative logic the
 * legacy cascade needs. These predicates split off the "is this mode
 * biologically impossible given the observation?" question so the factor
 * scorer's candidate generator can filter implausible candidates without
 * pulling in the demote logic (which the factor scorer's aggregator
 * handles via picking the next-best surviving candidate).
 */

import { describe, expect, it } from "vitest";
import { isCadenceImplausibleForMode, isHrImplausibleForMode, type ModeStats } from "../src/geo/mode-biometrics.js";

const STATS: ModeStats[] = [
	{
		mode: "walking",
		hrMean: 110,
		hrStd: 12,
		hrSampleCount: 500,
		cadenceMean: 100,
		cadenceStd: 15,
		cadenceSampleCount: 500,
		speedMean: 4.5,
		speedStd: 1,
		speedSampleCount: 500,
		sampleCount: 500,
	},
	{
		mode: "cycling",
		hrMean: 135,
		hrStd: 14,
		hrSampleCount: 200,
		cadenceMean: 5,
		cadenceStd: 3,
		cadenceSampleCount: 200,
		speedMean: 18,
		speedStd: 4,
		speedSampleCount: 200,
		sampleCount: 200,
	},
	{
		mode: "driving",
		hrMean: 75,
		hrStd: 8,
		hrSampleCount: 800,
		cadenceMean: 2,
		cadenceStd: 2,
		cadenceSampleCount: 800,
		speedMean: 35,
		speedStd: 15,
		speedSampleCount: 800,
		sampleCount: 800,
	},
	{
		mode: "train",
		hrMean: 78,
		hrStd: 9,
		hrSampleCount: 600,
		cadenceMean: 1,
		cadenceStd: 1,
		cadenceSampleCount: 600,
		speedMean: 50,
		speedStd: 20,
		speedSampleCount: 600,
		sampleCount: 600,
	},
];

describe("isHrImplausibleForMode", () => {
	it("flags cycling as implausible when HR is more than 2σ below cycling-mean", () => {
		// Cycling mean 135 ± 14 → minPlausible = 135 - 28 = 107. HR 100 < 107 → implausible.
		expect(isHrImplausibleForMode("cycling", 100, STATS)).toBe(true);
	});

	it("does not flag cycling when HR is in the cycling band", () => {
		expect(isHrImplausibleForMode("cycling", 140, STATS)).toBe(false);
	});

	it("does not flag the boundary HR (exactly at minPlausible) — strict <", () => {
		// Cycling minPlausible = 107. HR 107 is NOT < 107.
		expect(isHrImplausibleForMode("cycling", 107, STATS)).toBe(false);
	});

	it("never flags stationary (HR-veto doesn't apply — resting HR IS the stationary distribution)", () => {
		expect(isHrImplausibleForMode("stationary", 50, STATS)).toBe(false);
	});

	it("returns false when HR observation is missing (no evidence)", () => {
		expect(isHrImplausibleForMode("cycling", null, STATS)).toBe(false);
	});

	it("returns false when no stats row for the mode (cold-start user)", () => {
		expect(isHrImplausibleForMode("cycling", 100, [])).toBe(false);
	});

	it("returns false when stats row has no HR distribution", () => {
		const noHr = STATS.map((s) => (s.mode === "cycling" ? { ...s, hrMean: null, hrStd: null } : s));
		expect(isHrImplausibleForMode("cycling", 100, noHr)).toBe(false);
	});
});

describe("isCadenceImplausibleForMode", () => {
	it("flags cycling as implausible when cadence is in walking range at slow speed", () => {
		// Cycling cadence mean 5 ± 3 → maxPlausible = max(5+6, 30) = 30. Cadence 80 > 30 → implausible.
		// Speed 10 ≤ 15 km/h ceiling, so the veto premise (walking) holds.
		expect(isCadenceImplausibleForMode("cycling", 80, 10, STATS)).toBe(true);
	});

	it("does NOT flag cycling when speed is above the walking-plausible ceiling", () => {
		// Above 15 km/h, the cadence reading is more likely vehicle vibration
		// than steps — the veto premise (this was walking) fails.
		expect(isCadenceImplausibleForMode("cycling", 80, 20, STATS)).toBe(false);
	});

	it("does NOT flag walking — LOW_CADENCE_MODES doesn't include walking", () => {
		expect(isCadenceImplausibleForMode("walking", 100, 4.5, STATS)).toBe(false);
	});

	it("flags driving on implausibly high cadence at slow speed (in-traffic stuck-as-walking case)", () => {
		expect(isCadenceImplausibleForMode("driving", 90, 5, STATS)).toBe(true);
	});

	it("returns false when cadence observation is missing", () => {
		expect(isCadenceImplausibleForMode("cycling", null, 10, STATS)).toBe(false);
	});

	it("returns false when no stats row for the mode", () => {
		expect(isCadenceImplausibleForMode("cycling", 80, 10, [])).toBe(false);
	});

	it("respects the cadence floor — modes with very-tight cadence distributions still allow up to FLOOR_SPM", () => {
		// Cycling stats: mean 5, std 3 → 5+2·3 = 11. But FLOOR is 30, so any cadence
		// at-or-below 30 should not trigger the veto even though it's many σ above the mean.
		expect(isCadenceImplausibleForMode("cycling", 28, 10, STATS)).toBe(false);
		expect(isCadenceImplausibleForMode("cycling", 32, 10, STATS)).toBe(true);
	});

	it("when speed is null (unknown), the veto premise holds — apply the check anyway", () => {
		// Conservative: without speed evidence we can't rule out walking, so
		// the implausibility check fires if cadence is high.
		expect(isCadenceImplausibleForMode("cycling", 80, null, STATS)).toBe(true);
	});
});
