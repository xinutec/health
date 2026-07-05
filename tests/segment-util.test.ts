import { describe, expect, it } from "vitest";
import { addRefinedKind, hasRefinedKind } from "../src/geo/segment-util.js";
import type { RefinedKind } from "../src/geo/segments.js";

describe("addRefinedKind", () => {
	it("creates a single-element list from no prior tags", () => {
		expect(addRefinedKind(undefined, "gps-jitter")).toEqual(["gps-jitter"]);
	});

	it("appends to existing tags without dropping them", () => {
		const prior: readonly RefinedKind[] = ["gps-gap-inferred"];
		expect(addRefinedKind(prior, "low-cadence")).toEqual(["gps-gap-inferred", "low-cadence"]);
	});

	it("does not mutate the input array", () => {
		const prior: readonly RefinedKind[] = ["gps-jitter"];
		addRefinedKind(prior, "low-cadence");
		expect(prior).toEqual(["gps-jitter"]);
	});

	it("tolerates a repeated kind (caller's choice — no dedup)", () => {
		expect(addRefinedKind(["gps-jitter"], "gps-jitter")).toEqual(["gps-jitter", "gps-jitter"]);
	});
});

describe("hasRefinedKind", () => {
	it("is false when no tags are present", () => {
		expect(hasRefinedKind({}, "gps-jitter")).toBe(false);
	});

	it("is false when the tag list omits the kind", () => {
		expect(hasRefinedKind({ refinedKinds: ["low-cadence"] }, "gps-jitter")).toBe(false);
	});

	it("is true when the kind is present, even among others", () => {
		expect(hasRefinedKind({ refinedKinds: ["gps-gap-inferred", "gps-jitter"] }, "gps-jitter")).toBe(true);
	});
});
