import { describe, expect, it } from "vitest";
import { fitbitTsToUnix, isValidTimezone, wallClockToUtcString } from "../src/geo/timezone.js";

describe("isValidTimezone", () => {
	it("accepts well-known IANA names", () => {
		expect(isValidTimezone("Europe/Amsterdam")).toBe(true);
		expect(isValidTimezone("America/New_York")).toBe(true);
		expect(isValidTimezone("UTC")).toBe(true);
	});

	it("rejects clearly invalid strings", () => {
		expect(isValidTimezone("Not/A/Real/Zone")).toBe(false);
		expect(isValidTimezone("")).toBe(false);
		expect(isValidTimezone("zzz")).toBe(false);
		expect(isValidTimezone("../etc/passwd")).toBe(false);
	});

	it("matches whatever Intl.DateTimeFormat would accept", () => {
		// We deliberately delegate to Intl so the validator and the
		// downstream consumers (formatToParts etc.) agree. Both case
		// variants and offset strings are Intl-acceptable.
		expect(isValidTimezone("europe/amsterdam")).toBe(true);
		expect(isValidTimezone("+02:00")).toBe(true);
	});
});

// The block formerly here documented an incorrect claim that PhoneTrack
// stores timestamps as "local time encoded as unix epoch." Empirically,
// PhoneTrack/OwnTracks stores true UTC unix timestamps; the downstream
// dateBoundsUtc consumer treats them as UTC and produces correct segments.
// The misleading test was removed as part of the Fitbit per-row-tz refactor;
// see TIMEZONE.md.

describe("fitbitTsToUnix", () => {
	it("returns NaN for a malformed string", () => {
		expect(Number.isNaN(fitbitTsToUnix("not a timestamp"))).toBe(true);
	});

	it("treats components as UTC when no tz is provided", () => {
		// 2026-05-10 12:00:00 UTC = unix 1778371200 + 12*3600 = 1778414400
		expect(fitbitTsToUnix("2026-05-10 12:00:00")).toBe(1778414400);
	});

	it("converts Europe/Amsterdam summer wall-clock (CEST = UTC+2)", () => {
		// 14:00 CEST = 12:00 UTC = 1778414400 unix
		expect(fitbitTsToUnix("2026-05-10 14:00:00", "Europe/Amsterdam")).toBe(1778414400);
	});

	it("converts Europe/London summer wall-clock (BST = UTC+1)", () => {
		// 14:00 BST = 13:00 UTC = 1778418000 unix
		expect(fitbitTsToUnix("2026-05-10 14:00:00", "Europe/London")).toBe(1778418000);
	});

	it("handles CET/CEST DST transitions consistently", () => {
		// October fall-back: at 03:00 CEST → 02:00 CET. 02:30 occurs twice;
		// the Intl round-trip resolves to one of them deterministically.
		// We just verify the call doesn't throw and returns a plausible value.
		const noon = fitbitTsToUnix("2026-10-25 12:00:00", "Europe/Amsterdam");
		expect(Number.isNaN(noon)).toBe(false);
		// Noon Amsterdam in late October is CET (UTC+1): 12:00 CET = 11:00 UTC.
		// Unix epoch for 2026-10-25 11:00 UTC = (296 days into year, Oct 25)
		// We don't compute the exact value; instead assert the conversion is
		// applied (result differs from UTC interpretation by exactly 1h).
		const noonUtc = fitbitTsToUnix("2026-10-25 12:00:00");
		expect(noonUtc - noon).toBe(3600); // 1 hour offset
	});

	it("accepts a Date input (mariadb driver shape) and parses it like a string", () => {
		// new Date("2026-05-10T14:00:00Z").toISOString() == "2026-05-10T14:00:00.000Z"
		const asDate = new Date("2026-05-10T14:00:00Z");
		expect(fitbitTsToUnix(asDate, "Europe/Amsterdam")).toBe(
			fitbitTsToUnix("2026-05-10T14:00:00.000Z", "Europe/Amsterdam"),
		);
	});
});

describe("wallClockToUtcString", () => {
	it("returns null when tz is null", () => {
		expect(wallClockToUtcString("2026-05-10 14:00:00", null)).toBeNull();
	});

	it("returns null for a malformed wall-clock", () => {
		expect(wallClockToUtcString("not a timestamp", "Europe/Amsterdam")).toBeNull();
	});

	it("converts Amsterdam summer wall-clock to UTC DATETIME string", () => {
		// 14:00 CEST = 12:00 UTC
		expect(wallClockToUtcString("2026-05-10 14:00:00", "Europe/Amsterdam")).toBe("2026-05-10 12:00:00");
	});

	it("converts London summer wall-clock to UTC DATETIME string", () => {
		// 14:00 BST = 13:00 UTC
		expect(wallClockToUtcString("2026-05-10 14:00:00", "Europe/London")).toBe("2026-05-10 13:00:00");
	});

	it("handles date crossing for east-of-UTC midnights", () => {
		// 00:30 CEST = 22:30 UTC the previous day
		expect(wallClockToUtcString("2026-05-10 00:30:00", "Europe/Amsterdam")).toBe("2026-05-09 22:30:00");
	});

	it("handles date crossing for west-of-UTC late-evenings", () => {
		// 23:00 EST = 04:00 UTC the next day
		expect(wallClockToUtcString("2026-01-15 23:00:00", "America/New_York")).toBe("2026-01-16 04:00:00");
	});

	it("respects CET/CEST transition (October = CET = UTC+1)", () => {
		// 12:00 CET = 11:00 UTC
		expect(wallClockToUtcString("2026-10-25 12:00:00", "Europe/Amsterdam")).toBe("2026-10-25 11:00:00");
	});

	it("accepts a Date input (mariadb driver shape) just like fitbitTsToUnix", () => {
		const asDate = new Date("2026-05-10T14:00:00Z");
		expect(wallClockToUtcString(asDate, "Europe/Amsterdam")).toBe(
			wallClockToUtcString("2026-05-10T14:00:00.000Z", "Europe/Amsterdam"),
		);
	});

	it("round-trips through fitbitTsToUnix", () => {
		const wall = "2026-05-10 14:00:00";
		const tz = "Europe/Amsterdam";
		const utcString = wallClockToUtcString(wall, tz);
		expect(utcString).not.toBeNull();
		const reparsed = Math.floor(Date.parse(`${utcString}Z`) / 1000);
		expect(reparsed).toBe(fitbitTsToUnix(wall, tz));
	});
});
