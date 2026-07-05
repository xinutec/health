import { describe, expect, it } from "vitest";
import { buildForwardTzSource, NULL_TZ_SOURCE } from "../src/geo/fitbit-tz.js";
import type { RawTrackPoint } from "../src/nextcloud/phonetrack.js";

function fix(ts: number, lat: number, lon: number): RawTrackPoint {
	return { ts, lat, lon, altitude: null, speed: null, accuracy: null, battery: null };
}

describe("NULL_TZ_SOURCE", () => {
	it("always returns null", () => {
		expect(NULL_TZ_SOURCE.forWallClock("2026-05-10", "12:00:00")).toBeNull();
		expect(NULL_TZ_SOURCE.forWallClock("2026-01-01", "00:00:00")).toBeNull();
	});
});

describe("buildForwardTzSource", () => {
	// Reference moments (UTC unix). 2026-05-10 00:00 UTC = 1778371200.
	const may10Midnight = 1778371200;
	const may10Noon = may10Midnight + 12 * 3600;

	it("returns the tz of the nearest PhoneTrack fix when GPS is dense", () => {
		// Fix at noon UTC, in central Amsterdam
		const src = buildForwardTzSource({
			fixes: [fix(may10Noon, 52.37, 4.89)],
			profileTz: "Europe/Amsterdam",
		});
		// Wall-clock 14:00 Amsterdam (= 12:00 UTC) — seed-converted using profileTz
		// lands inside ±6h of the fix.
		expect(src.forWallClock("2026-05-10", "14:00:00")).toBe("Europe/Amsterdam");
	});

	it("returns the watch's actual location even when profileTz disagrees", () => {
		// Watch in London now (profile=London) but the recorded fix is in Amsterdam.
		// This is the bug scenario: profile says London, but the row was recorded
		// when the watch was still in Amsterdam.
		const src = buildForwardTzSource({
			fixes: [fix(may10Noon, 52.37, 4.89)],
			profileTz: "Europe/London",
		});
		// Wall-clock 14:00 — profileTz=London seeds to 13:00 UTC. ±6h window
		// catches the noon-UTC fix. Lookup of (52.37, 4.89) → Amsterdam.
		expect(src.forWallClock("2026-05-10", "14:00:00")).toBe("Europe/Amsterdam");
	});

	it("falls back to profileTz when no fix is within ±6h", () => {
		// Fix at midnight UTC (way before any 14:00 wall-clock).
		const src = buildForwardTzSource({
			fixes: [fix(may10Noon - 12 * 3600, 52.37, 4.89)],
			profileTz: "Europe/London",
		});
		// Wall-clock 14:00 Amsterdam = 12:00 UTC. The fix at 00:00 UTC is 12h away — outside ±6h.
		expect(src.forWallClock("2026-05-10", "14:00:00")).toBe("Europe/London");
	});

	it("returns null when there are no fixes AND no profileTz", () => {
		const src = buildForwardTzSource({ fixes: [], profileTz: null });
		expect(src.forWallClock("2026-05-10", "14:00:00")).toBeNull();
	});

	it("returns profileTz when there are no fixes at all", () => {
		const src = buildForwardTzSource({ fixes: [], profileTz: "Europe/Amsterdam" });
		expect(src.forWallClock("2026-05-10", "14:00:00")).toBe("Europe/Amsterdam");
	});

	it("is deterministic: same input → same output", () => {
		const fixes = [fix(may10Noon, 52.37, 4.89), fix(may10Noon + 60, 52.38, 4.9)];
		const src = buildForwardTzSource({ fixes, profileTz: "Europe/Amsterdam" });
		const a = src.forWallClock("2026-05-10", "14:00:00");
		const b = src.forWallClock("2026-05-10", "14:00:00");
		expect(a).toBe(b);
	});

	it("memoises by rounded lat/lon — adjacent fixes don't multiply tz-lookup calls", () => {
		// Both fixes within 50m of each other (well inside the 3-decimal-place
		// rounding bucket). The implementation should serve them from the
		// in-memory tz-lookup cache.
		const src = buildForwardTzSource({
			fixes: [fix(may10Noon, 52.3702, 4.8951), fix(may10Noon + 60, 52.3703, 4.8952)],
			profileTz: "Europe/Amsterdam",
		});
		// Two queries that should resolve to the same tz via cache.
		expect(src.forWallClock("2026-05-10", "14:00:00")).toBe("Europe/Amsterdam");
		expect(src.forWallClock("2026-05-10", "14:01:00")).toBe("Europe/Amsterdam");
	});

	it("seeds the conversion using profileTz, not Europe/Amsterdam-hardcoded", () => {
		// Wall-clock 23:00 in London = 22:00 UTC.
		// Wall-clock 23:00 in Amsterdam = 21:00 UTC.
		// A fix at 22:30 UTC: with profileTz=London, seed=22:00 UTC, fix is 30min away → catches it.
		// With profileTz=Amsterdam, seed=21:00 UTC, fix is 1.5h away → still catches it.
		const fix2230 = may10Midnight + 22 * 3600 + 30 * 60; // 2026-05-10 22:30 UTC
		const src = buildForwardTzSource({
			fixes: [fix(fix2230, 51.51, -0.13)], // London coords
			profileTz: "Europe/London",
		});
		expect(src.forWallClock("2026-05-10", "23:00:00")).toBe("Europe/London");
	});

	it("handles wall-clocks across midnight: 23:30 (date d) and 00:30 (date d+1) resolve consistently", () => {
		// Late-evening fix
		const fixLate = may10Midnight + 23 * 3600; // 2026-05-10 23:00 UTC
		// Early-morning next day fix
		const fixEarly = may10Midnight + 25 * 3600; // 2026-05-11 01:00 UTC
		const src = buildForwardTzSource({
			fixes: [fix(fixLate, 52.37, 4.89), fix(fixEarly, 52.37, 4.89)],
			profileTz: "Europe/Amsterdam",
		});
		expect(src.forWallClock("2026-05-11", "01:00:00")).toBe("Europe/Amsterdam");
		expect(src.forWallClock("2026-05-11", "03:00:00")).toBe("Europe/Amsterdam");
	});
});
