import { describe, expect, it } from "vitest";
import { isLiveDay } from "../src/routes/velocity-cache.js";

// 2026-07-12T10:12:00Z — a Sunday mid-morning in London (BST, UTC+1), so the
// local wall clock reads 11:12. This is the moment the "driving on rails" bug
// was reported: mid-tube-ride, with the day still in progress.
const NOW = Date.UTC(2026, 6, 12, 10, 12, 0);

describe("isLiveDay", () => {
	// The day being viewed is still happening, so its classification is still
	// changing: the ride in progress gains fixes every minute, and a label that
	// was defensible one minute in ("some vehicle") becomes a train the next.
	// A 5-minute cache freezes the earlier answer — which is exactly how a
	// two-minutes-stale "driving" survived on screen for another four.
	it("is live for the current local day", () => {
		expect(isLiveDay("2026-07-12", "Europe/London", NOW)).toBe(true);
	});

	it("is not live for a day that has finished", () => {
		expect(isLiveDay("2026-07-11", "Europe/London", NOW)).toBe(false);
	});

	it("is not live for a future day", () => {
		expect(isLiveDay("2026-07-13", "Europe/London", NOW)).toBe(false);
	});

	// The day boundary is the *viewer's* boundary, not UTC's. At 10:12 UTC it is
	// already the 12th everywhere relevant, but the tz still has to be honoured
	// rather than assumed — in Auckland (UTC+12) the local date is the 12th too,
	// while a UTC-11 zone is still on the 11th.
	it("honours the timezone's day boundary, not UTC's", () => {
		expect(isLiveDay("2026-07-12", "Pacific/Auckland", NOW)).toBe(true);
		expect(isLiveDay("2026-07-11", "Pacific/Midway", NOW)).toBe(true); // UTC-11 → still the 11th
		expect(isLiveDay("2026-07-12", "Pacific/Midway", NOW)).toBe(false);
	});

	// Just after local midnight the previous day is over, even though barely.
	it("flips at local midnight", () => {
		const justBefore = Date.UTC(2026, 6, 12, 22, 59, 0); // 23:59 BST on the 12th
		const justAfter = Date.UTC(2026, 6, 12, 23, 1, 0); // 00:01 BST on the 13th
		expect(isLiveDay("2026-07-12", "Europe/London", justBefore)).toBe(true);
		expect(isLiveDay("2026-07-12", "Europe/London", justAfter)).toBe(false);
		expect(isLiveDay("2026-07-13", "Europe/London", justAfter)).toBe(true);
	});

	// No tz supplied → the API treats the date as UTC, so the boundary is UTC's.
	it("falls back to UTC when no timezone is given", () => {
		expect(isLiveDay("2026-07-12", undefined, NOW)).toBe(true);
		expect(isLiveDay("2026-07-11", undefined, NOW)).toBe(false);
	});
});
