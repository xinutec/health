/**
 * Tests for `absorbDriveStops` — the vehicle-coherence absorber that
 * collapses a phantom GPS-noise stop between two driving segments
 * back into one continuous drive when biometrics confirm the user
 * stayed in the vehicle.
 *
 * Drives the 2026-06-02 "phantom Lanesborough" case from conversation
 * context: zero steps + steady HR across a 10-min "stationary" segment
 * sandwiched between two taxi-ride segments.
 */

import { describe, expect, it } from "vitest";
import type { StepPoint } from "../src/geo/biometrics.js";
import { absorbDriveStops } from "../src/geo/passes/rail-absorbers.js";
import type { EnrichedSegment } from "../src/geo/velocity.js";

function seg(
	over: Partial<EnrichedSegment> & { startTs: number; endTs: number; mode: EnrichedSegment["mode"] },
): EnrichedSegment {
	return {
		confidence: 1,
		confidenceMargin: 10,
		avgSpeed: 0,
		maxSpeed: 0,
		linearity: 0,
		pointCount: 1,
		...over,
	};
}

describe("absorbDriveStops", () => {
	const t0 = 1_700_000_000;

	it("absorbs a 10-min phantom stop between two drives when steps are zero", () => {
		// The 2026-06-02 Lanesborough shape.
		const drives = [
			seg({ startTs: t0, endTs: t0 + 5 * 60, mode: "driving" }),
			seg({ startTs: t0 + 5 * 60, endTs: t0 + 15 * 60, mode: "stationary", place: "The Lanesborough (hotel)" }),
			seg({ startTs: t0 + 15 * 60, endTs: t0 + 57 * 60, mode: "driving" }),
		];
		const result = absorbDriveStops(drives, []);
		expect(result).toHaveLength(1);
		expect(result[0].mode).toBe("driving");
		expect(result[0].startTs).toBe(t0);
		expect(result[0].endTs).toBe(t0 + 57 * 60);
	});

	it("does NOT absorb when the stop accumulates steps (user got out)", () => {
		// Real brief stop: drop-off, ATM, coffee. Steps appear.
		const drives = [
			seg({ startTs: t0, endTs: t0 + 5 * 60, mode: "driving" }),
			seg({ startTs: t0 + 5 * 60, endTs: t0 + 15 * 60, mode: "stationary", place: "Petrol Station" }),
			seg({ startTs: t0 + 15 * 60, endTs: t0 + 57 * 60, mode: "driving" }),
		];
		const steps: StepPoint[] = [
			{ ts: t0 + 6 * 60, steps: 8 },
			{ ts: t0 + 7 * 60, steps: 12 },
		];
		const result = absorbDriveStops(drives, steps);
		expect(result).toHaveLength(3);
	});

	it("does NOT absorb a long stop (>15 min, regardless of step count)", () => {
		// 20-min "stop" — even with zero steps, that's too long to be GPS
		// noise. Probably a real wait (parking, queue, etc.).
		const drives = [
			seg({ startTs: t0, endTs: t0 + 5 * 60, mode: "driving" }),
			seg({ startTs: t0 + 5 * 60, endTs: t0 + 25 * 60, mode: "stationary" }),
			seg({ startTs: t0 + 25 * 60, endTs: t0 + 60 * 60, mode: "driving" }),
		];
		const result = absorbDriveStops(drives, []);
		expect(result).toHaveLength(3);
	});

	it("does NOT absorb when the stop ends the day (no second drive)", () => {
		const drives = [
			seg({ startTs: t0, endTs: t0 + 30 * 60, mode: "driving" }),
			seg({ startTs: t0 + 30 * 60, endTs: t0 + 40 * 60, mode: "stationary", place: "Home" }),
		];
		const result = absorbDriveStops(drives, []);
		expect(result).toHaveLength(2);
	});

	it("does NOT absorb a stop sandwiched by walking (only the drive→stop→drive shape applies)", () => {
		const segments = [
			seg({ startTs: t0, endTs: t0 + 10 * 60, mode: "walking" }),
			seg({ startTs: t0 + 10 * 60, endTs: t0 + 20 * 60, mode: "stationary" }),
			seg({ startTs: t0 + 20 * 60, endTs: t0 + 30 * 60, mode: "walking" }),
		];
		const result = absorbDriveStops(segments, []);
		expect(result).toHaveLength(3);
	});

	it("absorbs multiple phantom stops independently on a long taxi ride", () => {
		// Two phantom stops on the same ride: Knightsbridge + Marylebone.
		const segments = [
			seg({ startTs: t0, endTs: t0 + 5 * 60, mode: "driving" }),
			seg({ startTs: t0 + 5 * 60, endTs: t0 + 12 * 60, mode: "stationary", place: "POI A" }),
			seg({ startTs: t0 + 12 * 60, endTs: t0 + 20 * 60, mode: "driving" }),
			seg({ startTs: t0 + 20 * 60, endTs: t0 + 25 * 60, mode: "stationary", place: "POI B" }),
			seg({ startTs: t0 + 25 * 60, endTs: t0 + 60 * 60, mode: "driving" }),
		];
		const result = absorbDriveStops(segments, []);
		// Both phantom stops absorb; first absorption yields one combined
		// drive, then the loop iterates and absorbs the next phantom too.
		expect(result).toHaveLength(1);
		expect(result[0].mode).toBe("driving");
		expect(result[0].endTs).toBe(t0 + 60 * 60);
	});
});
