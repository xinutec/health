import { describe, expect, it } from "vitest";
import { type WatchBatteryRow, watchBatterySeries } from "../src/fitbit/watch-battery.js";

/**
 * `watchBatterySeries` shapes raw `device_battery_log` rows into the day's
 * watch-battery trace: phone pseudo-tracker dropped, Fitbit wall-clock → epoch
 * in the day's tz, window-filtered, sorted, equal-level runs collapsed. Uses
 * UTC so the wall-clock equals the epoch and the cases stay legible.
 */
const DAY_START = Date.UTC(2026, 5, 30, 0, 0, 0) / 1000; // 2026-06-30 00:00 UTC
const DAY_END = DAY_START + 86_400;
const at = (h: number, m = 0) => `2026-06-30T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
const tsAt = (h: number, m = 0) => Date.UTC(2026, 5, 30, h, m, 0) / 1000;

const row = (
	lastSyncTime: string,
	batteryLevel: number,
	deviceVersion: string | null = "Inspire 3",
): WatchBatteryRow => ({
	lastSyncTime,
	batteryLevel,
	deviceVersion,
});

describe("watchBatterySeries", () => {
	it("maps in-window watch readings to {ts, level}, sorted by time", () => {
		const out = watchBatterySeries([row(at(14), 57), row(at(9), 80)], "UTC", DAY_START, DAY_END);
		expect(out).toEqual([
			{ ts: tsAt(9), level: 80 },
			{ ts: tsAt(14), level: 57 },
		]);
	});

	it("drops the MobileTrack phone pseudo-tracker", () => {
		const out = watchBatterySeries(
			[row(at(10), 0, "MobileTrack"), row(at(10), 57, "Inspire 3")],
			"UTC",
			DAY_START,
			DAY_END,
		);
		expect(out).toEqual([{ ts: tsAt(10), level: 57 }]);
	});

	it("excludes readings outside the day window", () => {
		const prevDay = "2026-06-29T23:30:00";
		const nextDay = "2026-07-01T00:30:00";
		const out = watchBatterySeries([row(prevDay, 90), row(at(12), 60), row(nextDay, 40)], "UTC", DAY_START, DAY_END);
		expect(out).toEqual([{ ts: tsAt(12), level: 60 }]);
	});

	it("collapses runs of equal level to the first reading (flat step)", () => {
		const out = watchBatterySeries([row(at(9), 80), row(at(11), 80), row(at(13), 65)], "UTC", DAY_START, DAY_END);
		expect(out).toEqual([
			{ ts: tsAt(9), level: 80 },
			{ ts: tsAt(13), level: 65 },
		]);
	});

	it("keeps the later reading when two devices report at the same instant", () => {
		const out = watchBatterySeries(
			[row(at(10), 80, "Inspire 3"), row(at(10), 55, "Charge 6")],
			"UTC",
			DAY_START,
			DAY_END,
		);
		expect(out).toHaveLength(1);
		expect(out[0].ts).toBe(tsAt(10));
	});

	it("converts the Fitbit wall-clock through the day's timezone", () => {
		// 10:00 wall-clock in BST (UTC+1) is 09:00 UTC.
		const out = watchBatterySeries([row(at(10), 57)], "Europe/London", DAY_START, DAY_END);
		expect(out[0].ts).toBe(Date.UTC(2026, 5, 30, 9, 0, 0) / 1000);
	});

	it("returns an empty series when there are no readings", () => {
		expect(watchBatterySeries([], "UTC", DAY_START, DAY_END)).toEqual([]);
	});
});
