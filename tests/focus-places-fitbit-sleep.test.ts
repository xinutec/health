/**
 * Tests for the Fitbit-sleep-window mining helper.
 *
 * The old `sleepHoursOf(cluster)` used a local-clock 02:00–06:00
 * heuristic — counts a stay's full duration if it covers any of
 * the deep-night window. That captures the easy case but:
 *
 *   - misses shifted sleep (you actually slept 04:00–12:00)
 *   - over-counts stay-up-watching-TV-through-deep-night nights
 *     (you were AWAKE at home from 22:00–04:00, then slept 04:00–
 *     11:00 → old heuristic counts the WHOLE stay).
 *
 * The new function joins each stay against Fitbit's `sleep` table
 * and sums the actual minutes of overlap. Strictly more accurate
 * when sleep data is available; we keep the old heuristic as a
 * fallback for users without Fitbit.
 *
 * Pure function — no DB. Caller passes in the user's Fitbit sleep
 * windows for the relevant period.
 */

import { describe, expect, it } from "vitest";
import { type FitbitSleepWindow, type Stay, sleepHoursFromFitbit } from "../src/geo/focus-places.js";

function stay(startTs: number, endTs: number): Stay {
	return {
		startTs,
		endTs,
		centroidLat: 51.85,
		centroidLon: 5.86,
		pointCount: 1,
		durationSec: endTs - startTs,
	};
}

function sleepWindow(startTs: number, endTs: number): FitbitSleepWindow {
	return { startTs, endTs };
}

describe("sleepHoursFromFitbit", () => {
	it("returns 0 when there are no Fitbit sleep windows (user without Fitbit)", () => {
		const stays = [stay(0, 8 * 3600)];
		expect(sleepHoursFromFitbit(stays, [])).toBe(0);
	});

	it("returns 0 when the stay doesn't overlap any sleep window", () => {
		// Stay 14:00–18:00 (daytime cafe visit), sleep was last night 22:00–06:00
		const stays = [stay(14 * 3600, 18 * 3600)];
		const sleeps = [sleepWindow(-2 * 3600, 6 * 3600)]; // previous night
		expect(sleepHoursFromFitbit(stays, sleeps)).toBe(0);
	});

	it("returns the full stay duration in hours when the stay is fully inside a sleep window", () => {
		// Stay 00:00–06:00 (overnight), Fitbit sleep 22:00 prev day–07:00 today
		const stays = [stay(0, 6 * 3600)];
		const sleeps = [sleepWindow(-2 * 3600, 7 * 3600)];
		expect(sleepHoursFromFitbit(stays, sleeps)).toBeCloseTo(6, 5);
	});

	it("returns just the overlap when the stay straddles a sleep window boundary", () => {
		// Stay 04:00–12:00 (slept in, then awake). Sleep window 22:00 prev–08:00.
		// Overlap = 04:00–08:00 = 4h.
		const stays = [stay(4 * 3600, 12 * 3600)];
		const sleeps = [sleepWindow(-2 * 3600, 8 * 3600)];
		expect(sleepHoursFromFitbit(stays, sleeps)).toBeCloseTo(4, 5);
	});

	it("sums overlap across multiple stays", () => {
		// Two nights at the same place: 5h + 6h of actual sleep
		const stays = [
			stay(0, 5 * 3600), // first night, fully inside sleep window
			stay(24 * 3600, 30 * 3600), // second night, fully inside next sleep window
		];
		const sleeps = [
			sleepWindow(-2 * 3600, 6 * 3600), // night 1
			sleepWindow(22 * 3600, 32 * 3600), // night 2 (22:00→08:00 next day)
		];
		expect(sleepHoursFromFitbit(stays, sleeps)).toBeCloseTo(5 + 6, 5);
	});

	it("counts each stay/sleep-window overlap independently (no double-count)", () => {
		// Pathological: a stay that straddles two sleep windows (shouldn't
		// really happen in practice — you'd have to be at a place
		// continuously across multiple nights without GPS recording).
		// Each window contributes its own overlap; sum them.
		const stays = [stay(0, 100 * 3600)];
		const sleeps = [
			sleepWindow(0, 5 * 3600), // 5h
			sleepWindow(25 * 3600, 31 * 3600), // 6h
		];
		expect(sleepHoursFromFitbit(stays, sleeps)).toBeCloseTo(5 + 6, 5);
	});

	it("excludes stay-up-past-deep-night nights when Fitbit said you weren't asleep", () => {
		// The case the old heuristic over-counted: you were at the place
		// from 22:00 to 06:00, but Fitbit only registered sleep from
		// 04:00 to 06:00 (you stayed up watching TV until 04:00).
		// Old: counts full 8h. New: counts only the 2h that overlaps
		// actual sleep.
		const stays = [stay(22 * 3600, 30 * 3600)]; // 22:00 → 06:00 next day
		const sleeps = [sleepWindow(28 * 3600, 30 * 3600)]; // 04:00 → 06:00
		expect(sleepHoursFromFitbit(stays, sleeps)).toBeCloseTo(2, 5);
	});

	it("captures shifted sleep that the old 02:00-06:00 heuristic would have missed", () => {
		// Weekend sleep-in: actual sleep 04:00 → 12:00. Stay covers the
		// whole window. Old heuristic counts only the local-clock-deep-
		// night overlap (02:00-06:00 → 2h). New gives the full 8h.
		const stays = [stay(4 * 3600, 12 * 3600)];
		const sleeps = [sleepWindow(4 * 3600, 12 * 3600)];
		expect(sleepHoursFromFitbit(stays, sleeps)).toBeCloseTo(8, 5);
	});
});
