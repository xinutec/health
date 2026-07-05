/**
 * Tests for the long-stay gate that controls Move→Significant demotion.
 *
 * The proxy used to demote any time it saw 10 minutes of low-speed
 * history. That's wrong at places like supermarkets — you might be
 * there for 30 minutes browsing but the next move is imminent, so
 * dropping to Significant would lose Move-mode tracking right when
 * you start walking again. We only want to demote at places where
 * the user typically stays for hours.
 *
 * The gate uses two complementary signals from `focus_places`:
 *
 *   - `avg_dwell_sec = total_dwell_sec / visit_count` — captures
 *     workplaces (long stays, no sleep) and any other "spend-the-day"
 *     locations the user has built up history at.
 *   - `sleep_hours` — captures residences (overnight stays). High
 *     sleep_hours means this is somewhere the user routinely sleeps,
 *     so a daytime visit is also expected to last a long time.
 *
 * The radius check (100 m) is loose enough to absorb GPS jitter at a
 * known centroid but tight enough that the cluster next door doesn't
 * mistakenly gate you.
 */

import { describe, expect, it } from "vitest";
import type { DecisionSignals } from "../src/routes/owntracks.js";
import { decideTransition, demoteAfterStop } from "../src/routes/owntracks.js";
import { isLongStayLocation } from "../src/routes/owntracks-long-stay.js";

function fp(overrides: Partial<{ centroidLat: number; centroidLon: number; avgDwellSec: number; sleepHours: number }>) {
	return {
		centroidLat: 51.5,
		centroidLon: -0.1,
		avgDwellSec: 0,
		sleepHours: 0,
		...overrides,
	};
}

describe("isLongStayLocation", () => {
	it("returns false when there are no focus places at all", () => {
		expect(isLongStayLocation(51.5, -0.1, [])).toBe(false);
	});

	it("returns false when nearby focus places have neither long avg dwell nor sleep history", () => {
		// Cafe-shaped: tens of minutes per visit, no overnight stays.
		const cafe = fp({ avgDwellSec: 30 * 60, sleepHours: 0 });
		expect(isLongStayLocation(51.5, -0.1, [cafe])).toBe(false);
	});

	it("returns true at a home-like place (high sleep_hours)", () => {
		const home = fp({ avgDwellSec: 8 * 3600, sleepHours: 50 });
		expect(isLongStayLocation(51.5, -0.1, [home])).toBe(true);
	});

	it("returns true at a work-like place (long avg dwell, no sleep)", () => {
		// Workday cluster: ~8h per visit, never overnight.
		const work = fp({ avgDwellSec: 8 * 3600, sleepHours: 0 });
		expect(isLongStayLocation(51.5, -0.1, [work])).toBe(true);
	});

	it("returns false when avg dwell is below the threshold", () => {
		// 90-min "long coffee shop" — borderline but still transient.
		const longCafe = fp({ avgDwellSec: 90 * 60, sleepHours: 0 });
		expect(isLongStayLocation(51.5, -0.1, [longCafe])).toBe(false);
	});

	it("returns false when the long-stay focus place is too far away (> 100m)", () => {
		// 0.0018 degrees latitude ≈ 200m at the equator (also London).
		const home = fp({ avgDwellSec: 8 * 3600, sleepHours: 50 });
		expect(isLongStayLocation(51.5018, -0.1, [home])).toBe(false);
	});

	it("returns true if ANY of multiple candidates qualifies", () => {
		const lidl = fp({ avgDwellSec: 30 * 60, sleepHours: 0 });
		const home = fp({ centroidLat: 51.5, centroidLon: -0.1, avgDwellSec: 10 * 3600, sleepHours: 60 });
		expect(isLongStayLocation(51.5, -0.1, [lidl, home])).toBe(true);
	});

	it("ignores far-away long-stay places when the user is at a near-by transient one", () => {
		const lidl = fp({ avgDwellSec: 30 * 60, sleepHours: 0 });
		const distantHome = fp({ centroidLat: 51.55, centroidLon: -0.1, avgDwellSec: 10 * 3600, sleepHours: 60 });
		expect(isLongStayLocation(51.5, -0.1, [lidl, distantHome])).toBe(false);
	});
});

describe("demoteAfterStop with long-stay gating", () => {
	// Once gated, demoteAfterStop only returns "stationary" at long-stay
	// locations. Existing callers that don't pass a location context will
	// see the conservative default (no demote anywhere) — see test below.

	const stationarySignals: DecisionSignals = {
		reportedVelKmh: 0,
		computedVelKmh: 0,
		gapSinceLastFixSec: 30,
		effectiveSpeedKmh: 0.5,
		straightness: 0.3,
		historySpanSec: 700, // > 10 min
		trigger: null,
		monitoringMode: 2,
	};

	it("does not demote at a transient location even with long stationary history", () => {
		// "I've been at Asda for 30 minutes shopping" — don't demote.
		const r = demoteAfterStop(stationarySignals, { atLongStayLocation: false });
		expect(r).toBeNull();
	});

	it("demotes at a long-stay location with long stationary history", () => {
		// "I've been at home for 10 minutes" — demote to save battery.
		const r = demoteAfterStop(stationarySignals, { atLongStayLocation: true });
		expect(r).toBe("stationary");
	});

	it("does not demote even at a long-stay location if history is too short", () => {
		const tooShort: DecisionSignals = { ...stationarySignals, historySpanSec: 240 };
		expect(demoteAfterStop(tooShort, { atLongStayLocation: true })).toBeNull();
	});

	it("does not demote at a long-stay location if effective speed is still walking-band", () => {
		// Moving around the house — keep tracking.
		const walking: DecisionSignals = { ...stationarySignals, effectiveSpeedKmh: 3 };
		expect(demoteAfterStop(walking, { atLongStayLocation: true })).toBeNull();
	});

	// Manual-override hold: the user pushed "high frequency now". Honour it —
	// don't demote while the hold is active, even with stale stationary
	// history at home, so a walk that starts moments later is caught.
	it("does not demote while a manual-override hold is active", () => {
		expect(demoteAfterStop(stationarySignals, { atLongStayLocation: true }, true)).toBeNull();
	});

	it("resumes demoting once the manual-override hold has expired", () => {
		// Same stale evidence; hold gone → demote exactly as before.
		expect(demoteAfterStop(stationarySignals, { atLongStayLocation: true }, false)).toBe("stationary");
	});

	it("decideTransition keeps Move mode under a manual hold instead of demoting", () => {
		// Phone in Move (m=2), sitting at home with >10 min stationary history.
		expect(decideTransition(stationarySignals, "walking", { atLongStayLocation: true }, true)).toBe("keep");
		expect(decideTransition(stationarySignals, "walking", { atLongStayLocation: true }, false)).toBe("stationary");
	});
});
