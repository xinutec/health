/**
 * Tests for the pure layer of the share-token feature.
 *
 * `generateShareToken` produces a URL-safe random string with enough
 * entropy that guessing is infeasible. `buildShareUrl` formats the
 * public URL that gets sent to the recipient. `shareableDateRange`
 * computes the [from, to] date span shown for a given days_back
 * setting and "today" date.
 *
 * The DB-touching pieces (createShare, getShareByToken, revokeShare)
 * need a real connection and are exercised via integration tests at
 * deploy time — same pattern as nc_credentials.
 */

import { describe, expect, it } from "vitest";
import { buildShareUrl, clampShareDaysBack, generateShareToken, shareableDateRange } from "../src/share/token.js";

describe("clampShareDaysBack", () => {
	it("clamps below the minimum up to 1", () => {
		expect(clampShareDaysBack(0)).toBe(1);
		expect(clampShareDaysBack(-5)).toBe(1);
	});
	it("clamps above the maximum down to 365", () => {
		expect(clampShareDaysBack(1000)).toBe(365);
	});
	it("floors fractional values", () => {
		expect(clampShareDaysBack(7.9)).toBe(7);
	});
	it("passes a valid in-range value through", () => {
		expect(clampShareDaysBack(30)).toBe(30);
	});
	it("returns null for non-finite / non-number input so the caller can default or reject", () => {
		expect(clampShareDaysBack(undefined)).toBeNull();
		expect(clampShareDaysBack("7")).toBeNull();
		expect(clampShareDaysBack(Number.NaN)).toBeNull();
	});
});

describe("generateShareToken", () => {
	it("returns a URL-safe string of at least 32 characters", () => {
		const t = generateShareToken();
		expect(t.length).toBeGreaterThanOrEqual(32);
		// base64url alphabet: A-Z a-z 0-9 - _
		expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it("produces a distinct value on every call (random)", () => {
		const a = generateShareToken();
		const b = generateShareToken();
		expect(a).not.toBe(b);
	});
});

describe("buildShareUrl", () => {
	it("appends the token to the base URL with the /share/:token path", () => {
		expect(buildShareUrl("https://health.example.org", "tok_abc")).toBe("https://health.example.org/share/tok_abc");
	});

	it("trims trailing slash on the base URL", () => {
		expect(buildShareUrl("https://health.example.org/", "tok_abc")).toBe("https://health.example.org/share/tok_abc");
	});
});

describe("shareableDateRange", () => {
	// days_back = N means "today plus the previous (N-1) days", so a
	// days_back=7 share shows a 7-day window ending today. Both ends
	// are returned as ISO date strings (YYYY-MM-DD) in the user's tz.
	it("days_back=1 returns just today", () => {
		const r = shareableDateRange("2026-05-14", 1);
		expect(r).toEqual({ from: "2026-05-14", to: "2026-05-14" });
	});

	it("days_back=7 returns today and the prior 6 days", () => {
		const r = shareableDateRange("2026-05-14", 7);
		expect(r).toEqual({ from: "2026-05-08", to: "2026-05-14" });
	});

	it("days_back=30 crosses a month boundary correctly", () => {
		const r = shareableDateRange("2026-05-14", 30);
		expect(r).toEqual({ from: "2026-04-15", to: "2026-05-14" });
	});

	it("days_back=0 returns an empty range (degenerate, treated as no-share)", () => {
		const r = shareableDateRange("2026-05-14", 0);
		expect(r).toBeNull();
	});
});
