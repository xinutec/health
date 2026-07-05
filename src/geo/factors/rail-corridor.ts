/**
 * rail-corridor factor.
 *
 * Discriminates train from driving via the per-segment ratio of mean
 * fix-distance to rail vs mean fix-distance to drivable road. A
 * trajectory that hugs a rail-only OSM way and stays well off any
 * road is evidence for train; the inverse is evidence for driving.
 *
 * Why this is needed: the existing osm-distance factor scores a
 * candidate against the nearest way of its own kind, but it doesn't
 * compare modes against each other. A segment with fixes 2 m off the
 * Jubilee Line and 40 m off a parallel road generates both a train
 * candidate (osm-distance bonus ~+1.3 nats for the 2 m rail) and a
 * driving candidate (osm-distance bonus ~+0.5 nats for the 40 m
 * road); both still score well on speed-emission for vehicular
 * speeds, and the cascade picks the wrong one. This factor adds the
 * relative-proximity signal directly:
 *
 *   - train candidate: score = +log((roadDist + REF) / (railDist + REF))
 *   - driving candidate: score = -log((roadDist + REF) / (railDist + REF))
 *
 * The reference offset (25 m, matching osm-distance) prevents the
 * ratio from exploding when one distance approaches zero. Symmetric
 * sign means a road-hugging trajectory penalises train by the same
 * amount it bonuses driving — no unilateral bias.
 *
 * Bounded magnitude: a 20 m vs 2 m gap (10× ratio) gives ~+0.95
 * nats. A factor-of-100 gap gives ~+2.3 nats. Significant but
 * dominated by the speed-emission and biometric factors when those
 * have something to say. Per
 * [[feedback-weighted-over-binary]] and
 * [[feedback-layer2-rules-must-decompose]] —
 * this is the evidence half of the rail-vs-road distinction; the
 * stronger rail-only-mismatch factor (task #192) is the high-magnitude
 * companion for when no drivable road exists nearby.
 *
 * Returns null for modes other than train/driving (the signal doesn't
 * apply) and when either distance is unavailable.
 */

import type { Factor } from "./types.js";

const REFERENCE_DISTANCE_M = 25;

export const railCorridor: Factor = (candidate, ctx) => {
	const railD = ctx.meanRailDistM;
	const roadD = ctx.meanDrivableRoadDistM;
	if (railD == null || roadD == null) return null;
	if (candidate.mode !== "train" && candidate.mode !== "driving") return null;
	const ratio = Math.log((roadD + REFERENCE_DISTANCE_M) / (railD + REFERENCE_DISTANCE_M));
	const score = candidate.mode === "train" ? ratio : -ratio;
	return {
		name: "rail-corridor",
		score,
		rationale: rationaleFor(candidate.mode, railD, roadD, score),
	};
};

function rationaleFor(mode: string, railD: number, roadD: number, score: number): string {
	const direction = score > 0 ? "supports" : score < 0 ? "opposes" : "neutral on";
	const r = Math.round(railD);
	const d = Math.round(roadD);
	return `mean ${r}m to rail vs ${d}m to road — ${direction} ${mode}`;
}
