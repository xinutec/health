/**
 * Tests for the sleep-ingestion helper that derives the row tz from
 * the Fitbit log's local-time fields and the user's TzSource.
 *
 * Bug being fixed: the `sleep` summary table stores Fitbit's local-
 * time DATETIMEs but has no `tz` column, so consumers can't tell
 * whether to interpret start_time/end_time as UTC or local — and the
 * naive CONVERT_TZ(.., 'UTC', tz) pattern double-counts the offset.
 *
 * The fix: add a tz column populated from the user's TzSource at
 * ingestion time (same approach as sleep_stages.tz, line 48 of
 * src/fitbit/sync/sleep.ts).
 */

import { describe, expect, it } from "vitest";
import { asFitbitSleepLogId } from "../src/db/branded.js";
import { type FitbitSleepLog, parseSleepLog } from "../src/fitbit/sync/sleep.js";
import type { TzSource } from "../src/geo/fitbit-tz.js";

const sleepLog = (overrides: Partial<FitbitSleepLog> = {}): FitbitSleepLog => ({
	logId: asFitbitSleepLogId(12345n),
	dateOfSleep: "2026-05-12",
	startTime: "2026-05-12T00:06:00.000",
	endTime: "2026-05-12T08:51:00.000",
	duration: 31_500_000,
	efficiency: 88,
	minutesAsleep: 464,
	minutesAwake: 60,
	isMainSleep: true,
	levels: {
		summary: {
			deep: { minutes: 90 },
			light: { minutes: 280 },
			rem: { minutes: 94 },
			wake: { minutes: 60 },
		},
		data: [],
	},
	...overrides,
});

/** Fake TzSource that always returns a fixed tz; lets us assert that
 *  parseSleepLog calls forWallClock with the right arguments. */
function fixedTzSource(tz: string): TzSource {
	return { forWallClock: () => tz };
}

/** Spy TzSource that records what was asked. */
function spyingTzSource(): TzSource & { calls: Array<{ date: string; time: string }> } {
	const calls: Array<{ date: string; time: string }> = [];
	return {
		calls,
		forWallClock(date: string, time: string) {
			calls.push({ date, time });
			return "Europe/London";
		},
	};
}

describe("parseSleepLog", () => {
	it("returns a row with tz looked up from the TzSource at the sleep start", () => {
		const row = parseSleepLog(sleepLog(), "user-1", fixedTzSource("Europe/London"));
		// Row shape: [user_id, log_id, date, start_time, end_time, duration,
		//              efficiency, minutesAsleep, minutesAwake, deep, light,
		//              rem, wake, isMainSleep, tz, start_time_utc, end_time_utc]
		expect(row).toHaveLength(17);
		expect(row[14]).toBe("Europe/London");
	});

	it("populates start_time_utc and end_time_utc from the resolved tz", () => {
		const row = parseSleepLog(sleepLog(), "user-1", fixedTzSource("Europe/Amsterdam"));
		// 00:06 CEST = 22:06 UTC the previous day; 08:51 CEST = 06:51 UTC same day.
		expect(row[15]).toBe("2026-05-11 22:06:00");
		expect(row[16]).toBe("2026-05-12 06:51:00");
	});

	it("leaves *_utc null when tz is null", () => {
		const row = parseSleepLog(sleepLog(), "user-1", { forWallClock: () => null });
		expect(row[15]).toBeNull();
		expect(row[16]).toBeNull();
	});

	it("passes the dateOfSleep + the time portion of startTime to TzSource", () => {
		const tz = spyingTzSource();
		parseSleepLog(sleepLog(), "user-1", tz);
		expect(tz.calls).toHaveLength(1);
		expect(tz.calls[0]).toEqual({ date: "2026-05-12", time: "00:06:00" });
	});

	it("preserves the raw startTime / endTime DATETIMEs unchanged (still local-time)", () => {
		// The bug fix doesn't rewrite the timestamps — just adds tz
		// metadata. Existing consumers that read start_time/end_time as
		// local will continue working; tz-aware consumers can convert.
		const row = parseSleepLog(sleepLog(), "user-1", fixedTzSource("Europe/London"));
		expect(row[3]).toBe("2026-05-12T00:06:00.000");
		expect(row[4]).toBe("2026-05-12T08:51:00.000");
	});

	it("returns tz=null when the TzSource returns null", () => {
		const row = parseSleepLog(sleepLog(), "user-1", { forWallClock: () => null });
		expect(row[14]).toBeNull();
	});

	it("handles a sleep that started before midnight (dateOfSleep ≠ startTime date)", () => {
		// e.g. went to bed 23:30 on the 11th, dateOfSleep = "2026-05-12"
		// (Fitbit attributes the night to the wake-day). The tz lookup
		// uses dateOfSleep + startTime's time portion, which is the
		// pattern in parseSleepStages.
		const tz = spyingTzSource();
		parseSleepLog(
			sleepLog({
				dateOfSleep: "2026-05-12",
				startTime: "2026-05-11T23:30:00.000",
				endTime: "2026-05-12T07:30:00.000",
			}),
			"user-1",
			tz,
		);
		expect(tz.calls[0]).toEqual({ date: "2026-05-12", time: "23:30:00" });
	});
});
