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

	// C4.1 watch-liveness imputation (the cadence hole,
	// docs/proposals/2026-07-continuity-c4.md): steps_intraday only writes
	// non-zero minutes, so a truly-still minute arrives as `null` and the
	// zero-inflated cadence emission SKIPS — walking pays no step penalty
	// exactly where steps would refute it. When the watch is demonstrably
	// alive around the minute, no step row means zero steps.
	describe("watch-liveness cadence imputation", () => {
		const hrAt = (...mins: number[]): HrPoint[] => mins.map((m) => ({ ts: minTs(m) + 10, bpm: 70 }));

		it("is OFF by default — a rowless minute stays null without the flag", () => {
			const tensor = buildObservationTensor({
				date: dateStr,
				tz,
				points: [],
				hr: hrAt(400),
				steps: [{ ts: minTs(500), steps: 30 }],
			});
			expect(tensor[400].cadence).toBeNull();
		});

		it("imputes 0 for a rowless minute with HR in the same minute", () => {
			const tensor = buildObservationTensor({
				date: dateStr,
				tz,
				points: [],
				imputeCadence: true,
				hr: hrAt(400),
				steps: [{ ts: minTs(500), steps: 30 }],
			});
			expect(tensor[400].cadence).toBe(0);
		});

		it("imputes 0 inside an HR-covered blackout window (alive on both sides)", () => {
			// HR at minutes 398 and 402 — minute 400 has no HR row of its own
			// but the device is alive within the window on both sides.
			const tensor = buildObservationTensor({
				date: dateStr,
				tz,
				points: [],
				imputeCadence: true,
				hr: hrAt(398, 402),
				steps: [{ ts: minTs(500), steps: 30 }],
			});
			expect(tensor[400].cadence).toBe(0);
		});

		it("keeps null when the watch is silent beyond the window on either side", () => {
			const tensor = buildObservationTensor({
				date: dateStr,
				tz,
				points: [],
				imputeCadence: true,
				hr: hrAt(100, 130),
				steps: [{ ts: minTs(100), steps: 30 }],
			});
			// Minute 115: nearest liveness 15 min away on both sides — off-wrist
			// (or charge gap), not a measured stillness.
			expect(tensor[115].cadence).toBeNull();
		});

		it("keeps null after the watch goes silent (one-sided evidence)", () => {
			const tensor = buildObservationTensor({
				date: dateStr,
				tz,
				points: [],
				imputeCadence: true,
				hr: hrAt(100, 101, 102),
				steps: [{ ts: minTs(100), steps: 30 }],
			});
			// Minute 104: alive 2 min before, but nothing ever after — the
			// device may have come off mid-window; do not assert stillness.
			expect(tensor[104].cadence).toBeNull();
		});

		it("a step row counts as liveness for its neighbours", () => {
			const tensor = buildObservationTensor({
				date: dateStr,
				tz,
				points: [],
				imputeCadence: true,
				hr: [],
				steps: [
					{ ts: minTs(600), steps: 20 },
					{ ts: minTs(604), steps: 15 },
				],
			});
			expect(tensor[602].cadence).toBe(0);
		});

		it("never imputes on a day with no step rows at all", () => {
			// HR everywhere but a step stream that never wrote a single row is
			// indistinguishable from a steps sync failure — imputing zeros would
			// decode the whole day as still.
			const tensor = buildObservationTensor({
				date: dateStr,
				tz,
				points: [],
				imputeCadence: true,
				hr: hrAt(400, 401, 402),
				steps: [],
			});
			expect(tensor[401].cadence).toBeNull();
		});

		it("a gap wider than the window imputes nothing, even between two alive edges", () => {
			// Alive at 700 and 712: every minute in between fails the window on
			// at least one side. Imputed zeros must not chain to bridge it —
			// liveness comes from measured rows only.
			const tensor = buildObservationTensor({
				date: dateStr,
				tz,
				points: [],
				imputeCadence: true,
				hr: hrAt(700, 712),
				steps: [{ ts: minTs(650), steps: 10 }],
			});
			for (let m = 701; m < 712; m++) expect(tensor[m].cadence).toBeNull();
		});

		it("leaves measured cadence values untouched", () => {
			const tensor = buildObservationTensor({
				date: dateStr,
				tz,
				points: [],
				imputeCadence: true,
				hr: hrAt(300, 301),
				steps: [
					{ ts: minTs(300), steps: 12 },
					{ ts: minTs(301), steps: 0 },
				],
			});
			expect(tensor[300].cadence).toBe(12);
			expect(tensor[301].cadence).toBe(0);
		});
	});

	describe("reacquire age", () => {
		it("a bright run after a long gap counts 0, 1, 2 … from its first fix", () => {
			// Fixes at minutes 100-104 (leading overnight stretch = a gap).
			const points = [100, 101, 102, 103, 104].map((m) => fix(minTs(m) + 10, 51.5, -0.1, 6));
			const tensor = buildObservationTensor({ date: dateStr, tz, points, hr: [], steps: [] });
			expect(tensor[100].reacquireAgeMin).toBe(0);
			expect(tensor[101].reacquireAgeMin).toBe(1);
			expect(tensor[104].reacquireAgeMin).toBe(4);
			expect(tensor[99].reacquireAgeMin).toBeNull();
			expect(tensor[105].reacquireAgeMin).toBeNull();
		});

		it("a short sampling hiccup does not restart the reacquire clock", () => {
			// Bright 100-104, dark 105-106 (2 min < REACQUIRE_GAP_MIN), bright
			// 107-108: the second run follows a sub-threshold gap → null.
			const points = [100, 101, 102, 103, 104, 107, 108].map((m) => fix(minTs(m) + 10, 51.5, -0.1, 6));
			const tensor = buildObservationTensor({ date: dateStr, tz, points, hr: [], steps: [] });
			expect(tensor[104].reacquireAgeMin).toBe(4);
			expect(tensor[107].reacquireAgeMin).toBeNull();
			expect(tensor[108].reacquireAgeMin).toBeNull();
		});

		it("a qualifying mid-day gap restarts the clock at 0", () => {
			// Bright 100-104, dark 105-112 (8 min), bright 113+.
			const points = [100, 101, 102, 103, 104, 113, 114].map((m) => fix(minTs(m) + 10, 51.5, -0.1, 6));
			const tensor = buildObservationTensor({ date: dateStr, tz, points, hr: [], steps: [] });
			expect(tensor[113].reacquireAgeMin).toBe(0);
			expect(tensor[114].reacquireAgeMin).toBe(1);
		});
	});
});
