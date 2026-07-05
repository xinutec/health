import { describe, expect, it } from "vitest";
import { utcDatetimeStrToSeconds, utcSecondsToDatetimeStr } from "../src/geo/velocity.js";

describe("UTC datetime helpers", () => {
	it("round-trips between unix seconds and the 'YYYY-MM-DD HH:MM:SS' UTC string", () => {
		// 1778414400 = 2026-05-10T12:00:00Z
		const unix = 1778414400;
		expect(utcSecondsToDatetimeStr(unix)).toBe("2026-05-10 12:00:00");
		expect(utcDatetimeStrToSeconds("2026-05-10 12:00:00")).toBe(unix);
		expect(utcDatetimeStrToSeconds(utcSecondsToDatetimeStr(unix))).toBe(unix);
	});

	it("parses both shapes the mariadb driver returns: ISO string and Date", () => {
		// REGRESSION: the prod hot-fix bug — the driver returns a Date object for
		// `select(["ts_utc"])` (raw column) but a string for `DATE_FORMAT(...)`.
		// Both must work; an earlier version called `s.replace(...)` and crashed
		// on the Date case.
		expect(utcDatetimeStrToSeconds("2026-05-10T12:00:00.000Z")).toBe(1778414400);
		expect(utcDatetimeStrToSeconds(new Date("2026-05-10T12:00:00.000Z"))).toBe(1778414400);
	});

	it("returns NaN for a malformed input", () => {
		expect(Number.isNaN(utcDatetimeStrToSeconds("not a date"))).toBe(true);
	});
});
