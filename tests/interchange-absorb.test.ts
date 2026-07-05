/**
 * absorbInterchanges — a run of short `stationary` segments between a
 * train and onward movement is a transit interchange (platform-to-
 * platform walk, a wait, an underground hop the classifier couldn't
 * resolve), not a stay. It is absorbed into the preceding train so the
 * journey reads train → onward with no phantom "@ <venue>" stop.
 */

import { describe, expect, it } from "vitest";
import { absorbInterchanges } from "../src/geo/passes/rail-absorbers.js";
import type { EnrichedSegment } from "../src/geo/velocity.js";

/** Build an EnrichedSegment; times given in whole minutes for clarity. */
function seg(
	mode: EnrichedSegment["mode"],
	startMin: number,
	endMin: number,
	extra: Partial<EnrichedSegment> = {},
): EnrichedSegment {
	return {
		startTs: startMin * 60,
		endTs: endMin * 60,
		mode,
		refinedMode: mode,
		confidence: 0.9,
		confidenceMargin: 5,
		avgSpeed: 0,
		maxSpeed: 0,
		linearity: 0,
		pointCount: 10,
		...extra,
	};
}

const modes = (segs: EnrichedSegment[]): string[] => segs.map((s) => s.refinedMode ?? s.mode);

describe("absorbInterchanges", () => {
	it("absorbs a run of short stationary segments between a train and onward movement", () => {
		const segs = [
			seg("train", 0, 10),
			seg("stationary", 12, 16, { place: "Some Cafe" }),
			seg("stationary", 18, 22, { place: "Some Shop" }),
			seg("walking", 25, 45),
		];
		const out = absorbInterchanges(segs);
		expect(modes(out)).toEqual(["train", "walking"]);
		// The train is extended over the interchange run.
		expect(out[0].endTs).toBe(22 * 60);
	});

	it("absorbs an interchange between two trains", () => {
		const segs = [seg("train", 0, 10), seg("stationary", 12, 16), seg("train", 18, 30)];
		const out = absorbInterchanges(segs);
		expect(modes(out)).toEqual(["train", "train"]);
		expect(out[0].endTs).toBe(16 * 60);
	});

	it("keeps a short stationary that ends the day — a terminal stay, not an interchange", () => {
		const segs = [seg("train", 0, 10), seg("stationary", 12, 16, { place: "Home" })];
		expect(absorbInterchanges(segs)).toHaveLength(2);
	});

	it("keeps a short stationary that precedes a longer stay", () => {
		// The run of *short* stationaries is just [12-16]; it is followed
		// by a stationary stay, not by movement, so it is left alone.
		const segs = [
			seg("train", 0, 10),
			seg("stationary", 12, 16),
			seg("stationary", 18, 140, { place: "Work" }),
			seg("walking", 145, 150),
		];
		expect(absorbInterchanges(segs)).toHaveLength(4);
	});

	it("does not absorb a long stationary segment after a train", () => {
		// 20 minutes exceeds the interchange cap — a real stay.
		const segs = [seg("train", 0, 10), seg("stationary", 12, 32, { place: "Cafe" }), seg("walking", 35, 50)];
		expect(absorbInterchanges(segs)).toHaveLength(3);
	});

	it("leaves a journey with no post-train interchange untouched", () => {
		const segs = [seg("train", 0, 10), seg("walking", 11, 20), seg("stationary", 21, 200, { place: "Work" })];
		expect(absorbInterchanges(segs)).toHaveLength(3);
	});
});
