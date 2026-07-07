import { describe, expect, it } from "vitest";
import type { EnrichedSegment } from "../src/geo/enriched-segment.js";
import { walkEndpointAnchors } from "../src/geo/pedestrian-match-annotate.js";

/**
 * `walkEndpointAnchors` (#319) — a walking leg's endpoints derived from its
 * neighbours: the stay it left / arrived at (centroid) or the train it
 * alighted from / boarded (snapped track terminal ≈ station). Only a
 * temporally-adjacent neighbour testifies.
 */

const T0 = 1_750_000_000;

function seg(partial: Partial<EnrichedSegment> & Pick<EnrichedSegment, "startTs" | "endTs" | "mode">): EnrichedSegment {
	return { points: [], ...partial } as EnrichedSegment;
}

describe("walkEndpointAnchors", () => {
	it("anchors to the adjacent stay centroids on both sides", () => {
		const segments = [
			seg({ startTs: T0, endTs: T0 + 600, mode: "stationary", centroidLat: 51.52, centroidLon: -0.13 }),
			seg({ startTs: T0 + 610, endTs: T0 + 1200, mode: "walking" }),
			seg({ startTs: T0 + 1210, endTs: T0 + 3000, mode: "stationary", centroidLat: 51.525, centroidLon: -0.135 }),
		];
		const { start, end } = walkEndpointAnchors(segments, 1);
		expect(start).toMatchObject({ lat: 51.52, lon: -0.13 });
		expect(end).toMatchObject({ lat: 51.525, lon: -0.135 });
	});

	it("anchors to a train neighbour's snapped track terminal (the station)", () => {
		const track = [
			{ lat: 51.56, lon: -0.28, ts: T0 },
			{ lat: 51.54, lon: -0.2, ts: T0 + 300 },
			{ lat: 51.5235, lon: -0.1341, ts: T0 + 600 }, // alight station
		];
		const segments = [
			seg({ startTs: T0, endTs: T0 + 600, mode: "train", snappedPath: track }),
			seg({ startTs: T0 + 620, endTs: T0 + 1300, mode: "walking" }),
		];
		const { start, end } = walkEndpointAnchors(segments, 1);
		expect(start).toMatchObject({ lat: 51.5235, lon: -0.1341 }); // the track's LAST vertex
		expect(end).toBeUndefined();
	});

	it("uses the train's FIRST snapped vertex when the walk precedes it (boarding)", () => {
		const track = [
			{ lat: 51.5235, lon: -0.1341, ts: T0 + 1400 }, // board station
			{ lat: 51.56, lon: -0.28, ts: T0 + 2000 },
		];
		const segments = [
			seg({ startTs: T0, endTs: T0 + 1300, mode: "walking" }),
			seg({ startTs: T0 + 1320, endTs: T0 + 2000, mode: "train", snappedPath: track }),
		];
		const { start, end } = walkEndpointAnchors(segments, 0);
		expect(start).toBeUndefined();
		expect(end).toMatchObject({ lat: 51.5235, lon: -0.1341 });
	});

	it("refuses a neighbour across a long unobserved gap", () => {
		const segments = [
			seg({ startTs: T0, endTs: T0 + 600, mode: "stationary", centroidLat: 51.52, centroidLon: -0.13 }),
			seg({ startTs: T0 + 600 + 1200, endTs: T0 + 3000, mode: "walking" }), // 20-min gap
		];
		expect(walkEndpointAnchors(segments, 1).start).toBeUndefined();
	});

	it("has nothing to say next to an unsnapped train or a centroid-less stay", () => {
		const segments = [
			seg({ startTs: T0, endTs: T0 + 600, mode: "train" }), // no snappedPath
			seg({ startTs: T0 + 610, endTs: T0 + 1200, mode: "walking" }),
			seg({ startTs: T0 + 1210, endTs: T0 + 3000, mode: "stationary" }), // no centroid
		];
		const { start, end } = walkEndpointAnchors(segments, 1);
		expect(start).toBeUndefined();
		expect(end).toBeUndefined();
	});
});
