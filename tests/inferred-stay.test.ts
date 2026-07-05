import { describe, expect, it } from "vitest";
import { bracketedStayPlaceId, buildInferredStayState } from "../src/geo/inferred-stay.js";

describe("bracketedStayPlaceId", () => {
	it("infers the place when the previous end and next dominant agree", () => {
		// 05-29 ended at place 7 (hospital); 05-31's dominant is place 7 →
		// the no-data 05-30 was place 7 the whole time.
		expect(bracketedStayPlaceId(7, 7)).toBe(7);
	});

	it("returns null when the bracketing places differ (genuinely unknown)", () => {
		expect(bracketedStayPlaceId(7, 9)).toBeNull();
	});

	it("returns null when either side is missing", () => {
		expect(bracketedStayPlaceId(null, 7)).toBeNull();
		expect(bracketedStayPlaceId(7, null)).toBeNull();
		expect(bracketedStayPlaceId(null, null)).toBeNull();
	});
});

describe("buildInferredStayState", () => {
	it("spans the whole day as an inferred stationary stay at the place", () => {
		const s = buildInferredStayState({
			place: "Cleveland Clinic London",
			tz: "Europe/London",
			startTs: 1_000,
			endTs: 87_400,
		});
		expect(s).toEqual({
			startTs: 1_000,
			endTs: 87_400,
			mode: "stationary",
			place: "Cleveland Clinic London",
			inferred: true,
			tz: "Europe/London",
		});
	});

	it("omits tz when null", () => {
		const s = buildInferredStayState({ place: "X", tz: null, startTs: 0, endTs: 10 });
		expect(s.tz).toBeUndefined();
		expect(s.inferred).toBe(true);
		expect(s.mode).toBe("stationary");
	});
});
