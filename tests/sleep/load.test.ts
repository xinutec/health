/**
 * Tests for sleep loaders — the pure parts that don't need a DB.
 * The DB-touching `loadDaySleepWindows` is verified end-to-end via
 * analyze-day on a real fixture.
 */

import { describe, expect, it } from "vitest";
import type { EnrichedSegment } from "../../src/geo/velocity.js";
import { derivePlaceForSleep, nextDateString } from "../../src/sleep/load.js";

function stationary(startTs: number, endTs: number, place?: string): EnrichedSegment {
	return {
		startTs,
		endTs,
		mode: "stationary",
		confidence: 1,
		confidenceMargin: Number.POSITIVE_INFINITY,
		avgSpeed: 0,
		maxSpeed: 0,
		linearity: 0,
		pointCount: 10,
		place,
	};
}

describe("nextDateString", () => {
	it("rolls forward by one day", () => {
		expect(nextDateString("2026-05-12")).toBe("2026-05-13");
	});

	it("handles month boundaries", () => {
		expect(nextDateString("2026-05-31")).toBe("2026-06-01");
	});

	it("handles year boundaries", () => {
		expect(nextDateString("2026-12-31")).toBe("2027-01-01");
	});

	it("handles leap-year February", () => {
		expect(nextDateString("2024-02-28")).toBe("2024-02-29");
		expect(nextDateString("2024-02-29")).toBe("2024-03-01");
	});

	it("handles non-leap-year February", () => {
		expect(nextDateString("2025-02-28")).toBe("2025-03-01");
	});
});

describe("derivePlaceForSleep", () => {
	it("finds the place of a stationary segment overlapping the sleep window", () => {
		const segs = [stationary(0, 1000, "Home"), stationary(1000, 2000, "Work")];
		const window = { startTs: 200, endTs: 800 };
		expect(derivePlaceForSleep(window, segs)).toBe("Home");
	});

	it("handles morning sleep: window starts before any segment but wake-up overlaps", () => {
		// Real case: today's "morning sleep" event has startTs the
		// previous evening. The first stationary segment in today's
		// data covers the wake-up endpoint of the sleep window.
		const segs = [stationary(800, 2000, "Home")];
		const window = { startTs: 100, endTs: 1500 }; // starts before segment, ends inside it
		expect(derivePlaceForSleep(window, segs)).toBe("Home");
	});

	it("handles evening sleep: window starts inside a segment, ends after it", () => {
		const segs = [stationary(0, 1500, "Home")];
		const window = { startTs: 1000, endTs: 3000 }; // starts inside, ends after the segment
		expect(derivePlaceForSleep(window, segs)).toBe("Home");
	});

	it("returns null when sleep is entirely inside moving segments (overnight train)", () => {
		const segs: EnrichedSegment[] = [
			{
				startTs: 0,
				endTs: 1000,
				mode: "train",
				confidence: 0.9,
				confidenceMargin: Number.POSITIVE_INFINITY,
				avgSpeed: 70,
				maxSpeed: 100,
				linearity: 0.95,
				pointCount: 20,
			},
		];
		const window = { startTs: 200, endTs: 800 };
		expect(derivePlaceForSleep(window, segs)).toBeNull();
	});

	it("falls back to the nearest stationary segment within 6h after the sleep ends", () => {
		// Concrete case: user wakes at 08:19 (window ends), first GPS
		// fix is a stationary period at 11:40 — same morning, same
		// place, but no overlap with the sleep window. The fallback
		// should pick up the post-wake segment's place since it's
		// well within the 6h tolerance.
		const wakeTs = 8 * 3600 + 19 * 60;
		const firstFixStart = 11 * 3600 + 40 * 60;
		const segs = [stationary(firstFixStart, firstFixStart + 3600, "Home")];
		const window = { startTs: 0, endTs: wakeTs };
		expect(derivePlaceForSleep(window, segs)).toBe("Home");
	});

	it("falls back to the nearest stationary segment within 6h before the sleep starts", () => {
		// Evening sleep: starts at 23:43, no stationary segment after
		// (haven't synced tomorrow yet), but the user's last
		// stationary period was 17:22-22:43 @ Home — within 6h before
		// the sleep started.
		const segs = [stationary(17 * 3600 + 22 * 60, 22 * 3600 + 43 * 60, "Home")];
		const window = { startTs: 23 * 3600 + 43 * 60, endTs: 32 * 3600 + 19 * 60 };
		expect(derivePlaceForSleep(window, segs)).toBe("Home");
	});

	it("returns null when the nearest stationary segment is more than 6h from the sleep window", () => {
		// Segment ends at 00:00; window starts at 07:00 — gap is 7h,
		// outside the trust window.
		const segs = [stationary(0, 100, "Home")];
		const window = { startTs: 7 * 3600 + 100, endTs: 8 * 3600 };
		expect(derivePlaceForSleep(window, segs)).toBeNull();
	});

	it("returns null when the overlapping stationary segment has no place tag", () => {
		const segs = [stationary(0, 1000)]; // no place
		const window = { startTs: 200, endTs: 800 };
		expect(derivePlaceForSleep(window, segs)).toBeNull();
	});

	it("prefers an overlapping segment over a more-distant nearby one", () => {
		// The user briefly slept on a Tube during a long commute,
		// then a stationary segment at Work started 2h later. We
		// should pick the (in this case non-existent overlapping)
		// segment first — and since there isn't one, fall back to
		// the Work segment via proximity. Verifies tie-breaking
		// across multiple candidates.
		const segs = [stationary(0, 1000, "Home"), stationary(10_000, 20_000, "Work")];
		const window = { startTs: 500, endTs: 800 };
		expect(derivePlaceForSleep(window, segs)).toBe("Home"); // overlap wins
	});
});

describe("derivePlaceForSleep — bedtime side beats wake side (sleep-onset anchor)", () => {
	// You fall asleep where you are at bedtime and don't relocate while
	// asleep, so the sleep place is anchored on the bedtime side; the wake
	// side is only confirmation. These pin the 2026-06-24 regression and the
	// inpatient counter-case so neither can silently break the other.

	const H = 3600;
	// Sleep 23:24 → 07:17 the next morning, expressed in seconds from an
	// arbitrary midnight (the previous evening, so the window straddles it).
	const window = { startTs: -36 * 60, endTs: 7 * H + 17 * 60 };

	it("2026-06-24: a bedtime-side home beats a wake-side hospital that is NEARER in time", () => {
		// Home stay ends 20:01 the evening before → 3h23m before sleep onset.
		// Hospital stay starts 09:29 → 2h12m after wake (nearer), because the
		// user walked straight out of home (no morning Home sit). Bedtime wins.
		const home = stationary(-8 * H, -(3 * H + 23 * 60), "Home"); // ends well before onset
		const hospital = stationary(9 * H + 29 * 60, 11 * H + 30 * 60, "University College Hospital");
		expect(derivePlaceForSleep(window, [hospital, home])).toBe("Home");
	});

	it("inpatient: a stay overlapping sleep onset (hospital) beats a wake-side home", () => {
		// 2026-05-25 shape: admitted in the evening, the hospital stay runs up
		// to and through bedtime (overlaps the window); a Home stay only
		// appears the next day (wake side). The overlap (where you actually lay
		// down) wins — the inpatient night stays at the hospital.
		const hospital = stationary(-5 * H, 30 * 60, "Cleveland Clinic London"); // overlaps onset
		const home = stationary(12 * H, 13 * H, "Home"); // wake side, next day
		expect(derivePlaceForSleep(window, [hospital, home])).toBe("Cleveland Clinic London");
	});

	it("still uses the wake side when it is the only evidence", () => {
		const home = stationary(9 * H, 11 * H, "Home"); // wake side, sole candidate
		expect(derivePlaceForSleep(window, [home])).toBe("Home");
	});

	it("a nearer bedtime stay beats a farther bedtime stay (within-side tie-break)", () => {
		const dinner = stationary(-9 * H, -8 * H, "Restaurant"); // farther before onset
		const home = stationary(-2 * H, -30 * 60, "Home"); // nearer before onset
		expect(derivePlaceForSleep(window, [dinner, home])).toBe("Home");
	});
});
