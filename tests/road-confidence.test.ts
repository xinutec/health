import { describe, expect, it } from "vitest";
import { roadSupportedConfidence } from "../src/geo/segments.js";

/**
 * `roadSupportedConfidence` tempers a road-vehicle segment's motion-only
 * confidence by whether the GPS actually followed a road (#296) — so a Tube that
 * scores as "driving" doesn't read a confident 100% car.
 */
describe("roadSupportedConfidence", () => {
	it("leaves a driving leg that hugs a road unchanged", () => {
		expect(roadSupportedConfidence("driving", 1.0, 1.0)).toBe(1.0);
		expect(roadSupportedConfidence("driving", 0.9, 0.5)).toBe(0.9); // ≥0.5 = full support
	});

	it("halves the confidence of a driving leg with no road under the track", () => {
		expect(roadSupportedConfidence("driving", 1.0, 0.0)).toBe(0.5);
	});

	it("scales linearly between (a Tube at fraction 0.2 → ×0.7)", () => {
		expect(roadSupportedConfidence("driving", 1.0, 0.2)).toBeCloseTo(0.7, 5);
	});

	it("never touches train / walking / cycling", () => {
		expect(roadSupportedConfidence("train", 1.0, 0.0)).toBe(1.0);
		expect(roadSupportedConfidence("walking", 0.8, 0.0)).toBe(0.8);
		expect(roadSupportedConfidence("cycling", 0.8, 0.1)).toBe(0.8);
	});

	it("leaves confidence unchanged when there is no road data", () => {
		expect(roadSupportedConfidence("driving", 1.0, null)).toBe(1.0);
	});
});
