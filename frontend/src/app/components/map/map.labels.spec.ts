import { describe, expect, it } from "vitest";
import { SOURCE_LABEL, sourceLabel } from "./map.labels";

describe("map tap-inspector source labels", () => {
	it("calls an unmatched moving leg's points raw, because they are", () => {
		// These draw `displayFixes`: the cleaned PhoneTrack track, pre-Kalman and
		// un-snapped. The popup asserting "raw GPS fix" is accurate here.
		for (const mode of ["walking", "cycling", "driving", "bus"]) {
			expect(sourceLabel("raw", mode)).toBe("raw GPS fix");
		}
	});

	it("does not call a train leg's points raw — they are Kalman-filtered (#266)", () => {
		// An uncached overground train leg draws the FILTERED points while still
		// shipping `kind: "raw"`, so the kind alone would overstate them.
		expect(sourceLabel("raw", "train")).toBe("GPS fix (Kalman-filtered)");
	});

	it("leaves every other kind decided by the kind alone", () => {
		for (const mode of ["walking", "train", "stationary"]) {
			expect(sourceLabel("matched", mode)).toBe("map-matched to road/path");
			expect(sourceLabel("snapped", mode)).toBe("snapped to rail line");
			expect(sourceLabel("smoothed", mode)).toBe("smoothed GPS (denoised)");
			expect(sourceLabel("anchor", mode)).toBe("stay centre (computed average)");
			expect(sourceLabel("tentative", mode)).toBe("gap connector (inferred, no GPS)");
			expect(sourceLabel("live", mode)).toBe("live position (latest fix)");
		}
	});

	it("falls back to the slug for a kind this build has never heard of", () => {
		// `kind` comes off the wire as JSON, so a backend shipping a newer kind
		// lands here at runtime even though the compiler thinks the lookup total.
		expect(sourceLabel("teleported" as keyof typeof SOURCE_LABEL, "walking")).toBe("teleported");
	});
});
