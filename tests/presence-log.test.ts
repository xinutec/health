/**
 * Tests for the `presence_log` rollup. Phase 1 of
 * `docs/proposals/2026-06-presence-continuity.md`.
 */

import { describe, expect, it } from "vitest";
import type { HmmSegment } from "../src/hmm/persist.js";
import { computeRow } from "../src/hmm/presence-log.js";

const T0 = 1_700_000_000;
function seg(over: Partial<HmmSegment> & { startTs: number; endTs: number; mode: HmmSegment["mode"] }): HmmSegment {
	return {
		placeId: null,
		lineName: null,
		...over,
	};
}

describe("computeRow", () => {
	it("returns null when there are no segments", () => {
		const row = computeRow({ user_id: "u", date: "2026-06-03", tz: "Europe/London", segments: [] });
		expect(row).toBeNull();
	});

	it("Cleveland Clinic day: 23 h stationary @ place 42 dominates", () => {
		const day = [
			seg({ startTs: T0, endTs: T0 + 23 * 3600, mode: "stationary", placeId: 42 }),
			seg({ startTs: T0 + 23 * 3600, endTs: T0 + 24 * 3600, mode: "stationary", placeId: 42 }),
		];
		const row = computeRow({ user_id: "u", date: "2026-05-29", tz: "Europe/London", segments: day });
		expect(row?.dominant_place_id).toBe(42);
		expect(row?.dominant_fraction).toBeCloseTo(1.0);
		expect(row?.end_of_day_place_id).toBe(42);
		expect(row?.end_of_day_posterior).toBeGreaterThan(0.9);
	});

	it("travel day: a long drive between two stays does not let the drive dominate", () => {
		const day = [
			seg({ startTs: T0, endTs: T0 + 3 * 3600, mode: "stationary", placeId: 1 }),
			seg({ startTs: T0 + 3 * 3600, endTs: T0 + 8 * 3600, mode: "driving" }),
			seg({ startTs: T0 + 8 * 3600, endTs: T0 + 24 * 3600, mode: "stationary", placeId: 2 }),
		];
		const row = computeRow({ user_id: "u", date: "2026-06-02", tz: "Europe/London", segments: day });
		// Place 2 wins (16 h vs 3 h vs 5 h drive that has no placeId).
		expect(row?.dominant_place_id).toBe(2);
		expect(row?.dominant_fraction).toBeCloseTo(16 / 24, 2);
		expect(row?.end_of_day_place_id).toBe(2);
	});

	it("travel-only day (no stationary): dominant_place is null, fraction 0", () => {
		const day = [
			seg({ startTs: T0, endTs: T0 + 12 * 3600, mode: "driving" }),
			seg({ startTs: T0 + 12 * 3600, endTs: T0 + 24 * 3600, mode: "train" }),
		];
		const row = computeRow({ user_id: "u", date: "2026-04-29", tz: "Europe/Amsterdam", segments: day });
		expect(row?.dominant_place_id).toBeNull();
		expect(row?.dominant_fraction).toBe(0);
		expect(row?.end_of_day_place_id).toBeNull();
		expect(row?.end_of_day_posterior).toBe(0);
	});

	it("end-of-day: a moving last segment leaves end_of_day_place_id null", () => {
		const day = [
			seg({ startTs: T0, endTs: T0 + 20 * 3600, mode: "stationary", placeId: 1 }),
			seg({ startTs: T0 + 20 * 3600, endTs: T0 + 24 * 3600, mode: "driving" }),
		];
		const row = computeRow({ user_id: "u", date: "2026-06-02", tz: "Europe/London", segments: day });
		// Place 1 still dominates by minute count.
		expect(row?.dominant_place_id).toBe(1);
		// But the end-of-day state was moving — no continuation seed.
		expect(row?.end_of_day_place_id).toBeNull();
	});

	it("end-of-day: a stationary @ unknown place last segment leaves end_of_day_place_id null", () => {
		const day = [
			seg({ startTs: T0, endTs: T0 + 20 * 3600, mode: "stationary", placeId: 1 }),
			seg({ startTs: T0 + 20 * 3600, endTs: T0 + 24 * 3600, mode: "stationary", placeId: null }),
		];
		const row = computeRow({ user_id: "u", date: "2026-06-02", tz: "Europe/London", segments: day });
		// Place 1 dominates the minute total — 20 h vs 4 h unknown.
		expect(row?.dominant_place_id).toBe(1);
		// End-of-day is a stationary @ unknown, not a focus_place — no seed.
		expect(row?.end_of_day_place_id).toBeNull();
	});
});
