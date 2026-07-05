import { describe, expect, it } from "vitest";
import { dateBoundsUtc, fitbitTsToUnix } from "../src/geo/timezone.js";

describe("dateBoundsUtc", () => {
	it("returns UTC midnight boundaries when no timezone given", () => {
		const { startUtc, endUtc } = dateBoundsUtc("2026-05-09");
		expect(startUtc).toBe(new Date("2026-05-09T00:00:00Z").getTime() / 1000);
		expect(endUtc).toBe(new Date("2026-05-10T00:00:00Z").getTime() / 1000);
		expect(endUtc - startUtc).toBe(86400);
	});

	it("handles CEST (UTC+2): midnight local = 22:00 UTC previous day", () => {
		const { startUtc, endUtc } = dateBoundsUtc("2026-05-09", "Europe/Amsterdam");
		// May 9 00:00 CEST = May 8 22:00 UTC
		expect(startUtc).toBe(new Date("2026-05-08T22:00:00Z").getTime() / 1000);
		expect(endUtc - startUtc).toBe(86400);
	});

	it("handles BST (UTC+1): midnight local = 23:00 UTC previous day", () => {
		const { startUtc, endUtc } = dateBoundsUtc("2026-05-09", "Europe/London");
		// May 9 00:00 BST = May 8 23:00 UTC
		expect(startUtc).toBe(new Date("2026-05-08T23:00:00Z").getTime() / 1000);
		expect(endUtc - startUtc).toBe(86400);
	});

	it("handles UTC timezone explicitly", () => {
		const { startUtc, endUtc } = dateBoundsUtc("2026-05-09", "UTC");
		expect(startUtc).toBe(new Date("2026-05-09T00:00:00Z").getTime() / 1000);
		expect(endUtc).toBe(new Date("2026-05-10T00:00:00Z").getTime() / 1000);
	});

	it("handles US Eastern (UTC-4 in summer)", () => {
		const { startUtc, endUtc } = dateBoundsUtc("2026-05-09", "America/New_York");
		// May 9 00:00 EDT = May 9 04:00 UTC
		expect(startUtc).toBe(new Date("2026-05-09T04:00:00Z").getTime() / 1000);
		expect(endUtc - startUtc).toBe(86400);
	});

	it("handles Japan (UTC+9, no DST)", () => {
		const { startUtc, endUtc } = dateBoundsUtc("2026-05-09", "Asia/Tokyo");
		// May 9 00:00 JST = May 8 15:00 UTC
		expect(startUtc).toBe(new Date("2026-05-08T15:00:00Z").getTime() / 1000);
		expect(endUtc - startUtc).toBe(86400);
	});

	it("always returns exactly 24 hours", () => {
		const timezones = ["Europe/Amsterdam", "Europe/London", "America/New_York", "Asia/Tokyo", "UTC"];
		for (const tz of timezones) {
			const { startUtc, endUtc } = dateBoundsUtc("2026-05-09", tz);
			expect(endUtc - startUtc, `${tz} should be 24h`).toBe(86400);
		}
	});

	it("start is before end", () => {
		const { startUtc, endUtc } = dateBoundsUtc("2026-05-09", "Pacific/Auckland");
		expect(startUtc).toBeLessThan(endUtc);
	});
});

describe("fitbitTsToUnix", () => {
	it("parses with no timezone as UTC", () => {
		const ts = fitbitTsToUnix("2026-05-10 03:30:00");
		expect(ts).toBe(new Date("2026-05-10T03:30:00Z").getTime() / 1000);
	});

	it("CEST (UTC+2 in May) — 03:30 local = 01:30 UTC", () => {
		const ts = fitbitTsToUnix("2026-05-10 03:30:00", "Europe/Amsterdam");
		expect(ts).toBe(new Date("2026-05-10T01:30:00Z").getTime() / 1000);
	});

	it("CET (UTC+1 in January) — 12:00 local = 11:00 UTC", () => {
		const ts = fitbitTsToUnix("2026-01-15 12:00:00", "Europe/Amsterdam");
		expect(ts).toBe(new Date("2026-01-15T11:00:00Z").getTime() / 1000);
	});

	it("PDT (UTC-7 in May) — 12:00 local = 19:00 UTC same day", () => {
		const ts = fitbitTsToUnix("2026-05-10 12:00:00", "America/Los_Angeles");
		expect(ts).toBe(new Date("2026-05-10T19:00:00Z").getTime() / 1000);
	});

	it("accepts ISO-style 'T' separator with optional Z (mariadb driver quirk)", () => {
		const ts = fitbitTsToUnix("2026-05-10T03:30:00.000Z", "Europe/Amsterdam");
		expect(ts).toBe(new Date("2026-05-10T01:30:00Z").getTime() / 1000);
	});

	it("returns NaN on unparseable input", () => {
		expect(Number.isNaN(fitbitTsToUnix("not a date"))).toBe(true);
	});

	it("accepts Date objects (mariadb driver returns DATETIME as Date, not string)", () => {
		// Date whose UTC components are 03:30 — same as the string form
		const d = new Date("2026-05-10T03:30:00Z");
		const ts = fitbitTsToUnix(d, "Europe/Amsterdam");
		expect(ts).toBe(new Date("2026-05-10T01:30:00Z").getTime() / 1000);
	});

	it("Asia/Tokyo (UTC+9, no DST) — 09:00 local = 00:00 UTC", () => {
		const ts = fitbitTsToUnix("2026-05-10 09:00:00", "Asia/Tokyo");
		expect(ts).toBe(new Date("2026-05-10T00:00:00Z").getTime() / 1000);
	});
});
