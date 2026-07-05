import { describe, expect, it } from "vitest";

// These functions mirror the frontend's time-utils.ts.
// We test the logic here since the frontend tests need Angular TestBed.

function parseLocalTime(ts: string): { hours: number; minutes: number } {
	const match = ts.match(/(\d{2}):(\d{2})/);
	if (!match) throw new Error(`Cannot parse time from: ${ts}`);
	return { hours: parseInt(match[1], 10), minutes: parseInt(match[2], 10) };
}

function formatLocalTime(ts: string): string {
	const { hours, minutes } = parseLocalTime(ts);
	return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
}

function localEpoch(ts: string): number {
	const clean = ts.replace(/Z$/, "").replace("T", " ");
	const match = clean.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
	if (!match) throw new Error(`Cannot parse timestamp: ${ts}`);
	const [, y, mo, d, h, mi, s] = match.map(Number);
	return new Date(y, mo - 1, d, h, mi, s).getTime();
}

describe("time parsing", () => {
	it("preserves Fitbit local time from UTC-suffixed string", () => {
		// Fitbit says sleep ended at 08:44 local time.
		// MariaDB/API returns it with Z suffix: "2026-05-09T08:44:00.000Z"
		// We must display 08:44, NOT convert to browser timezone.
		const apiTimestamp = "2026-05-09T08:44:00.000Z";
		expect(formatLocalTime(apiTimestamp)).toBe("08:44");
	});

	it("preserves time without Z suffix", () => {
		const ts = "2026-05-09T23:01:00";
		expect(formatLocalTime(ts)).toBe("23:01");
	});

	it("preserves time from date-only + time format", () => {
		const ts = "2026-05-09 08:44:00";
		expect(formatLocalTime(ts)).toBe("08:44");
	});

	it("handles midnight correctly", () => {
		expect(formatLocalTime("2026-05-09T00:00:00.000Z")).toBe("00:00");
	});

	it("handles end of day correctly", () => {
		expect(formatLocalTime("2026-05-09T23:59:00.000Z")).toBe("23:59");
	});
});

describe("localEpoch", () => {
	it("treats UTC-suffixed timestamp as local time", () => {
		const epoch = localEpoch("2026-05-09T08:44:00.000Z");
		const d = new Date(epoch);
		// Should be 08:44 in local time, regardless of system timezone
		expect(d.getHours()).toBe(8);
		expect(d.getMinutes()).toBe(44);
	});

	it("handles timestamp without Z", () => {
		const epoch = localEpoch("2026-05-09T23:01:00");
		const d = new Date(epoch);
		expect(d.getHours()).toBe(23);
		expect(d.getMinutes()).toBe(1);
	});

	it("duration between two timestamps is correct", () => {
		const start = localEpoch("2026-05-09T23:01:00.000Z");
		const end = localEpoch("2026-05-10T08:44:00.000Z");
		const hours = (end - start) / 3600000;
		expect(hours).toBeCloseTo(9.717, 1); // ~9h 43m
	});
});

// We import from the frontend time-utils via a copy of the logic here,
// since the frontend code isn't directly importable in vitest.
// The real implementation is in frontend/src/app/time-utils.ts.
function formatDateInTz(d: Date, tz: string): string {
	const parts = new Intl.DateTimeFormat("en-CA", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		timeZone: tz,
	}).formatToParts(d);
	const part = (type: "year" | "month" | "day"): string => {
		const v = parts.find((p) => p.type === type)?.value;
		if (v === undefined) throw new Error(`Intl.DateTimeFormat returned no ${type} part`);
		return v;
	};
	return `${part("year")}-${part("month")}-${part("day")}`;
}

describe("formatDateInTz", () => {
	it("returns correct date in CEST when UTC is previous day", () => {
		// 00:30 CEST on May 10 = 22:30 UTC on May 9
		const d = new Date("2026-05-09T22:30:00Z");
		expect(formatDateInTz(d, "Europe/Amsterdam")).toBe("2026-05-10");
	});

	it("returns correct date in UTC", () => {
		const d = new Date("2026-05-09T22:30:00Z");
		expect(formatDateInTz(d, "UTC")).toBe("2026-05-09");
	});

	it("returns correct date in US Eastern", () => {
		// 01:00 UTC on May 10 = 21:00 EDT on May 9
		const d = new Date("2026-05-10T01:00:00Z");
		expect(formatDateInTz(d, "America/New_York")).toBe("2026-05-09");
	});

	it("returns correct date in Tokyo", () => {
		// 20:00 UTC on May 9 = 05:00 JST on May 10
		const d = new Date("2026-05-09T20:00:00Z");
		expect(formatDateInTz(d, "Asia/Tokyo")).toBe("2026-05-10");
	});

	it("returns correct date in BST when traveling from CEST", () => {
		// After traveling: 23:30 BST on May 10 = 22:30 UTC on May 10
		// In CEST this would be 00:30 May 11, but in BST it's still May 10
		const d = new Date("2026-05-10T22:30:00Z");
		expect(formatDateInTz(d, "Europe/London")).toBe("2026-05-10");
		expect(formatDateInTz(d, "Europe/Amsterdam")).toBe("2026-05-11");
	});
});
