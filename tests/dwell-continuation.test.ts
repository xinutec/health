import { describe, expect, it } from "vitest";
import { CONFIDENCE_FLOOR, dwellContinuation, dwellSurvival, meanDwellSec } from "../src/geo/dwell-continuation.js";

const HOUR = 3600;

describe("meanDwellSec", () => {
	it("is total dwell over visits", () => {
		expect(meanDwellSec({ totalDwellSec: 100 * HOUR, visitCount: 10, uniqueDays: 10 })).toBe(10 * HOUR);
	});
	it("is null for unusable stats", () => {
		expect(meanDwellSec({ totalDwellSec: 0, visitCount: 0, uniqueDays: 10 })).toBeNull();
	});
});

describe("dwellSurvival", () => {
	it("is 1 at zero elapsed and decays with time", () => {
		expect(dwellSurvival(0, 10 * HOUR)).toBe(1);
		expect(dwellSurvival(10 * HOUR, 10 * HOUR)).toBeCloseTo(Math.exp(-1), 6);
	});
});

describe("dwellContinuation", () => {
	const dayStart = 1_000_000;
	const dayEnd = dayStart + 24 * HOUR;
	const lastEnd = dayStart + 18 * HOUR; // 6h of day left

	it("a strong home anchor (long mean dwell) fills the rest of the day", () => {
		// τ = 10h → horizon = 10h·ln2 ≈ 6.93h > the 6h remaining → clamps to dayEnd.
		const home = { totalDwellSec: 900 * HOUR, visitCount: 90, uniqueDays: 90 };
		const out = dwellContinuation({ place: home, lastEndTs: lastEnd, dayEndTs: dayEnd });
		expect(out).not.toBeNull();
		expect(out?.endTs).toBe(dayEnd);
		expect(out?.tauSec).toBe(10 * HOUR);
	});

	it("a café (short mean dwell) fills only briefly, then leaves an honest gap", () => {
		// τ = 1h → horizon = ln2 h ≈ 0.69h → ends well before dayEnd.
		const cafe = { totalDwellSec: 20 * HOUR, visitCount: 20, uniqueDays: 12 };
		const out = dwellContinuation({ place: cafe, lastEndTs: lastEnd, dayEndTs: dayEnd });
		expect(out).not.toBeNull();
		expect(out?.endTs).toBeLessThan(dayEnd);
		expect(out?.endTs).toBe(lastEnd + Math.round(1 * HOUR * Math.log(1 / CONFIDENCE_FLOOR)));
	});

	it("declines a weakly-established place (too few days to trust τ)", () => {
		const oneOff = { totalDwellSec: 5 * HOUR, visitCount: 2, uniqueDays: 2 };
		expect(dwellContinuation({ place: oneOff, lastEndTs: lastEnd, dayEndTs: dayEnd })).toBeNull();
	});

	it("declines when there is no trailing room", () => {
		const home = { totalDwellSec: 900 * HOUR, visitCount: 90, uniqueDays: 90 };
		expect(dwellContinuation({ place: home, lastEndTs: dayEnd, dayEndTs: dayEnd })).toBeNull();
	});
});
