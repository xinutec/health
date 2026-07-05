/**
 * `buildObservationTensor` — pure function that stitches Kalman-
 * filtered GPS points, HR samples, and step counts into a per-minute
 * Observation array spanning a date.
 *
 * The HMM decoder (Phase 1) consumes one Observation per minute. The
 * tensor is the bridge between the existing data-loaders (which
 * return raw streams in their native cadence) and the model's
 * 1-minute discrete-time assumption.
 *
 * Tests pin the per-minute aggregation rules:
 *   - GPS: median lat/lon over fixes in the minute; speed_kmh
 *     averaged. Null when no fixes.
 *   - HR: mean bpm over samples in the minute. Null when no samples.
 *   - Cadence: sum of steps. Null when no step rows touched the
 *     minute (distinguishes "no row written" from "0 steps recorded").
 *   - Context: hour and day-of-week in the user's displayTz.
 */

import { describe, expect, it } from "vitest";
import type { HrPoint, StepPoint } from "../src/geo/biometrics.js";
import type { FilteredPoint } from "../src/geo/kalman.js";
import { buildObservationTensor } from "../src/hmm/observation.js";

function fix(ts: number, lat: number, lon: number, speed = 0): FilteredPoint {
	return { ts, lat, lon, speed_kmh: speed, bearing: 0 };
}

describe("buildObservationTensor", () => {
	// 2026-04-29 is a Wednesday, BST (UTC+1) in London.
	const dateStr = "2026-04-29";
	const tz = "Europe/London";

	// Derive the local-day start ts from the function-under-test's own
	// output rather than hardcoding — keeps the test resilient to any
	// future date-bounds drift.
	const baseTensor = buildObservationTensor({ date: dateStr, tz, points: [], hr: [], steps: [] });
	const dayStartTs = baseTensor[0].ts;
	const minTs = (m: number): number => dayStartTs + m * 60;

	it("produces 1440 minute slots covering the full local day", () => {
		expect(baseTensor.length).toBe(1440);
		expect(baseTensor[1].ts - baseTensor[0].ts).toBe(60);
		expect(baseTensor[1439].ts - baseTensor[0].ts).toBe(1439 * 60);
	});

	it("marks GPS, HR, cadence null on minutes with no observations", () => {
		for (const o of baseTensor.slice(0, 5)) {
			expect(o.gps).toBeNull();
			expect(o.hr).toBeNull();
			expect(o.cadence).toBeNull();
		}
	});

	it("derives hour and day-of-week in the user's displayTz", () => {
		// 2026-04-29 is a Wednesday → dayOfWeekLocal = 3.
		expect(baseTensor[0].hourLocal).toBe(0);
		expect(baseTensor[0].dayOfWeekLocal).toBe(3);
		// Minute at 09:30 local = 570 minutes in.
		expect(baseTensor[570].hourLocal).toBe(9);
		// Minute at 23:59 = 1439 minutes in.
		expect(baseTensor[1439].hourLocal).toBe(23);
	});

	it("aggregates GPS fixes by minute (median lat/lon, mean speed)", () => {
		const t = minTs(100);
		const points: FilteredPoint[] = [
			fix(t + 5, 51.5, -0.1, 5),
			fix(t + 25, 51.5005, -0.1005, 7),
			fix(t + 45, 51.501, -0.101, 9),
		];
		const tensor = buildObservationTensor({ date: dateStr, tz, points, hr: [], steps: [] });
		const slot = tensor[100];
		expect(slot.gps).not.toBeNull();
		expect(slot.gps?.lat).toBe(51.5005);
		expect(slot.gps?.lon).toBe(-0.1005);
		expect(slot.gps?.speedKmh).toBe(7);
	});

	it("aggregates HR samples by minute (mean bpm)", () => {
		const t = minTs(200);
		const hr: HrPoint[] = [
			{ ts: t + 10, bpm: 70 },
			{ ts: t + 40, bpm: 80 },
		];
		const tensor = buildObservationTensor({ date: dateStr, tz, points: [], hr, steps: [] });
		expect(tensor[200].hr).toBe(75);
	});

	it("aggregates step counts by minute (sum) and distinguishes null vs zero", () => {
		// Minute 300: 12 steps. Minute 301: explicit 0. Minute 302: no row.
		const steps: StepPoint[] = [
			{ ts: minTs(300), steps: 12 },
			{ ts: minTs(301), steps: 0 },
		];
		const tensor = buildObservationTensor({ date: dateStr, tz, points: [], hr: [], steps });
		expect(tensor[300].cadence).toBe(12);
		expect(tensor[301].cadence).toBe(0);
		expect(tensor[302].cadence).toBeNull();
	});

	it("drops observations outside the day's local boundaries", () => {
		const points: FilteredPoint[] = [fix(dayStartTs - 1, 51.5, -0.1)];
		const tensor = buildObservationTensor({ date: dateStr, tz, points, hr: [], steps: [] });
		expect(tensor[0].gps).toBeNull();
	});
});
