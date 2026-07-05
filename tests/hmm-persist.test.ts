import { describe, expect, it } from "vitest";
import { groupStatesIntoSegments } from "../src/hmm/persist.js";
import type { State } from "../src/hmm/state-space.js";

/**
 * `groupStatesIntoSegments` collapses runs of consecutive identical
 * states into segments, producing the compact shape that gets
 * persisted to `decoded_days`. Tests pin the shape, that timestamps
 * carry through correctly, and that state-identity uses (mode,
 * placeId, lineName).
 */

function s(mode: State["mode"], placeId: number | null = null, lineName: string | null = null): State {
	return { mode, placeId, lineName, trainEdgeId: null };
}

function ts(min: number): number {
	return 1_716_000_000 + min * 60;
}

describe("groupStatesIntoSegments", () => {
	it("returns an empty array for empty input", () => {
		expect(groupStatesIntoSegments([], [])).toEqual([]);
	});

	it("collapses one continuous run into a single segment", () => {
		const states = [s("stationary", 1), s("stationary", 1), s("stationary", 1)];
		const timestamps = [ts(0), ts(1), ts(2)];
		const segments = groupStatesIntoSegments(states, timestamps);
		expect(segments.length).toBe(1);
		expect(segments[0].mode).toBe("stationary");
		expect(segments[0].placeId).toBe(1);
		expect(segments[0].startTs).toBe(ts(0));
		expect(segments[0].endTs).toBe(ts(3)); // exclusive end = last ts + 60s
	});

	it("splits on mode change", () => {
		const states = [s("stationary", 1), s("stationary", 1), s("walking"), s("walking")];
		const timestamps = [ts(0), ts(1), ts(2), ts(3)];
		const segments = groupStatesIntoSegments(states, timestamps);
		expect(segments.length).toBe(2);
		expect(segments[0]).toEqual({
			startTs: ts(0),
			endTs: ts(2),
			mode: "stationary",
			placeId: 1,
			lineName: null,
		});
		expect(segments[1]).toEqual({
			startTs: ts(2),
			endTs: ts(4),
			mode: "walking",
			placeId: null,
			lineName: null,
		});
	});

	it("splits on placeId change within the same mode", () => {
		const states = [s("stationary", 1), s("stationary", 2)];
		const timestamps = [ts(0), ts(1)];
		const segments = groupStatesIntoSegments(states, timestamps);
		expect(segments.length).toBe(2);
		expect(segments[0].placeId).toBe(1);
		expect(segments[1].placeId).toBe(2);
	});

	it("splits on lineName change for train segments", () => {
		const states = [
			s("train", null, "Metropolitan Line"),
			s("train", null, "Metropolitan Line"),
			s("train", null, "Jubilee Line"),
		];
		const timestamps = [ts(0), ts(1), ts(2)];
		const segments = groupStatesIntoSegments(states, timestamps);
		expect(segments.length).toBe(2);
		expect(segments[0].lineName).toBe("Metropolitan Line");
		expect(segments[1].lineName).toBe("Jubilee Line");
	});

	it("preserves all states including unknown / off-network", () => {
		const states = [s("stationary", null), s("stationary", null), s("unknown"), s("stationary", 5)];
		const timestamps = [ts(0), ts(1), ts(2), ts(3)];
		const segments = groupStatesIntoSegments(states, timestamps);
		expect(segments.length).toBe(3);
		expect(segments[0].mode).toBe("stationary");
		expect(segments[0].placeId).toBeNull();
		expect(segments[1].mode).toBe("unknown");
		expect(segments[2].placeId).toBe(5);
	});

	it("throws when timestamps length does not match states length", () => {
		const states = [s("walking"), s("walking")];
		const timestamps = [ts(0)];
		expect(() => groupStatesIntoSegments(states, timestamps)).toThrow();
	});
});
