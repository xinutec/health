/**
 * V8 reference values for `walkEndpointAnchors` (#319) — the last exported pure
 * leaf in `computeVelocity`'s dependency set.
 *
 * A walking leg's endpoints are often confidently known from its NEIGHBOURS:
 * the stay it left or arrived at (its centroid), or the train it alighted from
 * or boarded (the snapped track's terminal vertex, which sits at the station to
 * about platform precision). A post-tunnel reacquire smear contradicts both, so
 * the anchors pin the reconstruction between the known truths.
 *
 * Everything else `pedestrian-match-annotate.ts` exports is either a mutable
 * diagnostic sink or the async `annotateWalkMatches`, both shell.
 *
 * Run: nix develop /Users/pippijn/Code/health --command npx tsx lean/experiments/walk-anchors-refs.mts
 */

import type { EnrichedSegment } from "../../src/geo/enriched-segment.js";
import { walkEndpointAnchors } from "../../src/geo/pedestrian-match-annotate.js";
import type { SnappedPoint } from "../../src/geo/rail-snap.js";
import type { TransportMode } from "../../src/geo/segments.js";

const show = (label: string, v: unknown): void => {
	// eslint-disable-next-line no-console
	console.log(`${label}: ${JSON.stringify(v)}`);
};

function seg(
	startTs: number,
	endTs: number,
	mode: TransportMode,
	extra: Partial<EnrichedSegment> = {},
): EnrichedSegment {
	return {
		startTs,
		endTs,
		mode,
		confidence: 0.8,
		confidenceMargin: 2,
		avgSpeed: 0,
		maxSpeed: 0,
		linearity: 0.5,
		pointCount: 10,
		...extra,
	};
}

const TRACK: SnappedPoint[] = [
	{ lat: 51.5, lon: -0.1, ts: 0 },
	{ lat: 51.51, lon: -0.11, ts: 300 },
	{ lat: 51.52, lon: -0.12, ts: 600 },
];

/** A stay with a centroid, and a train with a snapped track. */
const stay = (a: number, b: number) => seg(a, b, "stationary", { centroidLat: 51.4, centroidLon: -0.2 });
const train = (a: number, b: number) => seg(a, b, "train", { snappedPath: TRACK });

/** The walk under test always sits at index 1 of a three-segment list. */
const walk = seg(1000, 2000, "walking");

const CASES: Record<string, EnrichedSegment[]> = {
	// A stay before and a train after: the stay contributes its centroid at the
	// softer sigma, the train its FIRST track vertex (the walk precedes it).
	stayThenTrain: [stay(0, 1000), walk, train(2000, 3000)],
	// Mirror image — the train is BEFORE, so its LAST vertex is the one that
	// touches the walk.
	trainThenStay: [train(0, 1000), walk, stay(2000, 3000)],
	// A gap of 181 s is past the bar on the left: that neighbour no longer
	// testifies, because across a long unknown gap the endpoint is genuinely
	// unknown.
	leftGapTooBig: [stay(0, 819), walk, train(2000, 3000)],
	// 180 s exactly still testifies.
	leftGapExactlyAtBar: [stay(0, 820), walk, train(2000, 3000)],
	// …and the same bar on the right.
	rightGapTooBig: [stay(0, 1000), walk, train(2181, 3000)],
	rightGapExactlyAtBar: [stay(0, 1000), walk, train(2180, 3000)],
	// A NEGATIVE gap (the neighbour overlaps the walk) is well under the bar, so
	// it testifies — the test is one-sided.
	overlappingNeighbour: [stay(0, 1500), walk, train(2000, 3000)],
	// A stay with no centroid has nothing confident to say.
	stayWithoutCentroid: [seg(0, 1000, "stationary"), walk, train(2000, 3000)],
	// A train with no snapped path, or one too short to have a terminal vertex.
	trainWithoutTrack: [stay(0, 1000), walk, seg(2000, 3000, "train")],
	trainTrackTooShort: [
		stay(0, 1000),
		walk,
		seg(2000, 3000, "train", { snappedPath: [TRACK[0]] }),
	],
	// Neither mode contributes: a walk between two walks is unanchored.
	walkingNeighbours: [seg(0, 1000, "walking"), walk, seg(2000, 3000, "walking")],
	// effectiveMode: a leg refined TO stationary contributes its centroid.
	refinedToStationary: [
		seg(0, 1000, "walking", { refinedMode: "stationary", centroidLat: 51.4, centroidLon: -0.2 }),
		walk,
		train(2000, 3000),
	],
	// …and one refined AWAY from train does not contribute its track.
	refinedAwayFromTrain: [
		stay(0, 1000),
		walk,
		seg(2000, 3000, "train", { refinedMode: "walking", snappedPath: TRACK }),
	],
	// No neighbour at all on either side.
	noNeighbours: [walk],
};

for (const [name, segs] of Object.entries(CASES)) {
	const i = segs.length === 1 ? 0 : 1;
	show(`anchors.${name}`, walkEndpointAnchors(segs, i));
}
