import { describe, expect, it } from "vitest";
import { isArmed, PTR_MAX_PULL_PX, PTR_THRESHOLD_PX, pullDistance, pullProgress } from "./pull-to-refresh.logic";

describe("pullDistance (rubber-band)", () => {
	it("is 0 for a non-positive delta (finger up / not moved)", () => {
		expect(pullDistance(0)).toBe(0);
		expect(pullDistance(-40)).toBe(0);
	});

	it("applies resistance so the indicator lags the finger", () => {
		expect(pullDistance(100, PTR_MAX_PULL_PX, 0.5)).toBe(50);
	});

	it("clamps to the max pull no matter how far the finger travels", () => {
		expect(pullDistance(10_000)).toBe(PTR_MAX_PULL_PX);
	});
});

describe("isArmed (release triggers a refresh)", () => {
	it("is false below the threshold", () => {
		expect(isArmed(PTR_THRESHOLD_PX - 1)).toBe(false);
	});
	it("is true at or beyond the threshold", () => {
		expect(isArmed(PTR_THRESHOLD_PX)).toBe(true);
		expect(isArmed(PTR_THRESHOLD_PX + 30)).toBe(true);
	});
});

describe("pullProgress (arrow opacity)", () => {
	it("ramps 0→1 across the threshold and clamps", () => {
		expect(pullProgress(0)).toBe(0);
		expect(pullProgress(PTR_THRESHOLD_PX / 2)).toBeCloseTo(0.5);
		expect(pullProgress(PTR_THRESHOLD_PX)).toBe(1);
		expect(pullProgress(PTR_THRESHOLD_PX * 3)).toBe(1);
	});
});
