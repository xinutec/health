/**
 * Tests for `bridgeStaysWithBiometrics` — the multi-signal merge
 * that heals stationary stays fragmented by a brief no-fix gap
 * when biometrics confirm the user was at rest.
 *
 * Drives the 2026-05-22 Pizza Union case (ground-truth #185).
 * Synthetic-first; the 05-22 fixture replay will follow as a
 * real-data E2E test per the project's real-data-fixture rule.
 */

import { describe, expect, it } from "vitest";
import type { HrPoint, StepPoint } from "../src/geo/biometrics.js";
import { bridgeStaysWithBiometrics } from "../src/geo/bridge-stays-biometrics.js";
import type { TrackSegment } from "../src/geo/segments.js";

const PIZZA_LAT = 51.5345;
const PIZZA_LON = -0.1187;

function makeStay(startTs: number, endTs: number, pointCount = 10): TrackSegment {
	return {
		startTs,
		endTs,
		mode: "stationary",
		confidence: 0.9,
		confidenceMargin: 100,
		avgSpeed: 0,
		maxSpeed: 0,
		linearity: 0,
		pointCount,
	};
}

function restingHr(startTs: number, endTs: number, bpm = 68): HrPoint[] {
	const out: HrPoint[] = [];
	for (let t = startTs; t <= endTs; t += 5) out.push({ ts: t, bpm });
	return out;
}

describe("bridgeStaysWithBiometrics", () => {
	it("merges two co-located stays with resting HR and zero steps across the gap", () => {
		// Pizza Union pattern: stay 1 (11 min) → 5 min gap → stay 2 (15 min)
		// HR resting throughout; zero steps in the gap.
		const t0 = 1_700_000_000;
		const stay1 = makeStay(t0, t0 + 11 * 60);
		const stay2 = makeStay(t0 + 16 * 60, t0 + 31 * 60);
		const hr = restingHr(t0, t0 + 31 * 60);
		const result = bridgeStaysWithBiometrics({
			segments: [stay1, stay2],
			centroids: [
				[PIZZA_LAT, PIZZA_LON],
				[PIZZA_LAT, PIZZA_LON],
			],
			hr,
			steps: [],
		});
		expect(result).toHaveLength(1);
		expect(result[0].startTs).toBe(stay1.startTs);
		expect(result[0].endTs).toBe(stay2.endTs);
	});

	it("does NOT merge when the gap shows step activity (user actually walked away)", () => {
		const t0 = 1_700_000_000;
		const stay1 = makeStay(t0, t0 + 11 * 60);
		const stay2 = makeStay(t0 + 16 * 60, t0 + 31 * 60);
		const hr = restingHr(t0, t0 + 31 * 60);
		const stepsInGap: StepPoint[] = [
			{ ts: t0 + 12 * 60, steps: 40 },
			{ ts: t0 + 14 * 60, steps: 35 },
		];
		const result = bridgeStaysWithBiometrics({
			segments: [stay1, stay2],
			centroids: [
				[PIZZA_LAT, PIZZA_LON],
				[PIZZA_LAT, PIZZA_LON],
			],
			hr,
			steps: stepsInGap,
		});
		expect(result).toHaveLength(2);
	});

	it("does NOT merge when the gap HR is elevated (some exertion)", () => {
		const t0 = 1_700_000_000;
		const stay1 = makeStay(t0, t0 + 11 * 60);
		const stay2 = makeStay(t0 + 16 * 60, t0 + 31 * 60);
		// HR average 110 over the gap window — well above resting.
		const hr: HrPoint[] = [];
		for (let t = t0; t <= t0 + 11 * 60; t += 5) hr.push({ ts: t, bpm: 68 });
		for (let t = t0 + 11 * 60 + 5; t < t0 + 16 * 60; t += 5) hr.push({ ts: t, bpm: 110 });
		for (let t = t0 + 16 * 60; t <= t0 + 31 * 60; t += 5) hr.push({ ts: t, bpm: 68 });
		const result = bridgeStaysWithBiometrics({
			segments: [stay1, stay2],
			centroids: [
				[PIZZA_LAT, PIZZA_LON],
				[PIZZA_LAT, PIZZA_LON],
			],
			hr,
			steps: [],
		});
		expect(result).toHaveLength(2);
	});

	it("does NOT merge when stays are too far apart in space", () => {
		const t0 = 1_700_000_000;
		const stay1 = makeStay(t0, t0 + 11 * 60);
		const stay2 = makeStay(t0 + 16 * 60, t0 + 31 * 60);
		const hr = restingHr(t0, t0 + 31 * 60);
		const result = bridgeStaysWithBiometrics({
			segments: [stay1, stay2],
			centroids: [
				[PIZZA_LAT, PIZZA_LON],
				[PIZZA_LAT + 0.01, PIZZA_LON], // ~1.1 km north
			],
			hr,
			steps: [],
		});
		expect(result).toHaveLength(2);
	});

	it("does NOT merge when the gap is longer than the MAX_GAP_SEC threshold", () => {
		const t0 = 1_700_000_000;
		const stay1 = makeStay(t0, t0 + 11 * 60);
		// Gap of 12 minutes, above the 10-min ceiling.
		const stay2 = makeStay(t0 + 23 * 60, t0 + 40 * 60);
		const hr = restingHr(t0, t0 + 40 * 60);
		const result = bridgeStaysWithBiometrics({
			segments: [stay1, stay2],
			centroids: [
				[PIZZA_LAT, PIZZA_LON],
				[PIZZA_LAT, PIZZA_LON],
			],
			hr,
			steps: [],
		});
		expect(result).toHaveLength(2);
	});

	it("does NOT merge when HR samples in the gap are too sparse", () => {
		const t0 = 1_700_000_000;
		const stay1 = makeStay(t0, t0 + 11 * 60);
		const stay2 = makeStay(t0 + 16 * 60, t0 + 31 * 60);
		// HR only outside the gap window. Single sample in the gap
		// isn't enough evidence — conservative.
		const hr: HrPoint[] = [];
		for (let t = t0; t <= t0 + 11 * 60; t += 5) hr.push({ ts: t, bpm: 68 });
		hr.push({ ts: t0 + 13 * 60, bpm: 68 });
		for (let t = t0 + 16 * 60; t <= t0 + 31 * 60; t += 5) hr.push({ ts: t, bpm: 68 });
		const result = bridgeStaysWithBiometrics({
			segments: [stay1, stay2],
			centroids: [
				[PIZZA_LAT, PIZZA_LON],
				[PIZZA_LAT, PIZZA_LON],
			],
			hr,
			steps: [],
		});
		expect(result).toHaveLength(2);
	});

	it("merges back-to-back stationary stays at the same place (no gap, the 05-12 Work pattern)", () => {
		// Real shape: stationary @ Work (184 min) → stationary "was walking"
		// reclassified (5 min) → stationary @ Work (26 min), all centroids
		// at Work, no time gap between any of them.
		const t0 = 1_700_000_000;
		const stay1 = makeStay(t0, t0 + 184 * 60);
		const stay2 = makeStay(t0 + 184 * 60, t0 + 189 * 60, 3);
		const stay3 = makeStay(t0 + 189 * 60, t0 + 215 * 60);
		const hr = restingHr(t0, t0 + 215 * 60);
		const result = bridgeStaysWithBiometrics({
			segments: [stay1, stay2, stay3],
			centroids: [
				[PIZZA_LAT, PIZZA_LON],
				[PIZZA_LAT, PIZZA_LON],
				[PIZZA_LAT, PIZZA_LON],
			],
			hr,
			steps: [],
		});
		expect(result).toHaveLength(1);
		expect(result[0].endTs - result[0].startTs).toBe(215 * 60);
	});

	it("does NOT merge co-located stays when the combined window shows exercise-grade HR", () => {
		// Same shape as above but HR averages 140 — user was working out
		// at a fixed place, not just sitting.
		const t0 = 1_700_000_000;
		const stay1 = makeStay(t0, t0 + 30 * 60);
		const stay2 = makeStay(t0 + 30 * 60, t0 + 35 * 60, 3);
		const stay3 = makeStay(t0 + 35 * 60, t0 + 60 * 60);
		const hr: HrPoint[] = [];
		for (let t = t0; t <= t0 + 60 * 60; t += 5) hr.push({ ts: t, bpm: 140 });
		const result = bridgeStaysWithBiometrics({
			segments: [stay1, stay2, stay3],
			centroids: [
				[PIZZA_LAT, PIZZA_LON],
				[PIZZA_LAT, PIZZA_LON],
				[PIZZA_LAT, PIZZA_LON],
			],
			hr,
			steps: [],
		});
		expect(result).toHaveLength(3);
	});

	it("passes non-stationary segments through unchanged", () => {
		const t0 = 1_700_000_000;
		const stay = makeStay(t0, t0 + 11 * 60);
		const walk: TrackSegment = { ...stay, startTs: t0 + 12 * 60, endTs: t0 + 18 * 60, mode: "walking" };
		const stay2 = makeStay(t0 + 19 * 60, t0 + 34 * 60);
		const hr = restingHr(t0, t0 + 34 * 60);
		const result = bridgeStaysWithBiometrics({
			segments: [stay, walk, stay2],
			centroids: [[PIZZA_LAT, PIZZA_LON], null, [PIZZA_LAT, PIZZA_LON]],
			hr,
			steps: [],
		});
		// Walking segment between two stays prevents bridging — they
		// are not adjacent stationary pairs.
		expect(result).toHaveLength(3);
		expect(result[1].mode).toBe("walking");
	});
});
