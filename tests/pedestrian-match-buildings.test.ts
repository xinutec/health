/**
 * Building-aware route choice in the walk matcher (#304): a graph edge that
 * crosses a building footprint costs extra UNLESS raw fixes support the
 * crossing — so an unsupported through-building passage loses to the street
 * around the block, while a genuinely-walked concourse (fixes on it) is kept.
 * This is the "insert points so connections avoid buildings, if possible"
 * principle embedded in the Viterbi itself, with the GPS as the override.
 */
import { describe, expect, it } from "vitest";
import { buildingCrossingM } from "../src/eval/walk-buildings.js";
import type { OsmRoadWay, RoadFix } from "../src/geo/map-match-core.js";
import type { BuildingFootprint } from "../src/geo/osm-local.js";
import { matchWalkSegment } from "../src/geo/pedestrian-match.js";

const LAT0 = 51.5;
const LON0 = -0.1;
const LON_M = 111_320 * Math.cos((LAT0 * Math.PI) / 180);

/** A point `north`/`east` metres from the base, as [lat, lon]. */
function at(north: number, east: number): [number, number] {
	return [LAT0 + north / 111_320, LON0 + east / LON_M];
}

function way(id: number, name: string | null, pts: Array<[number, number]>): OsmRoadWay {
	return { osmId: id, name, subtype: "footway", coords: pts.map(([n, e]) => at(n, e)) };
}

function fix(north: number, east: number, ts: number): RoadFix {
	const [lat, lon] = at(north, east);
	return { lat, lon, ts };
}

function pt(north: number, east: number): { lat: number; lon: number } {
	const [lat, lon] = at(north, east);
	return { lat, lon };
}

// A city block: two street stubs joined by TWO route options —
//   the "passage" footway straight through a building (east 60 → 140 at n=0),
//   and the "around" way over the block's north side (via n=30).
const west = way(1, "Front Street", [
	[0, -40],
	[0, 20],
	[0, 60],
]);
const east = way(2, "Front Street", [
	[0, 140],
	[0, 180],
	[0, 220],
]);
const passage = way(3, null, [
	[0, 60],
	[0, 100],
	[0, 140],
]);
const around = way(4, "Block Way", [
	[0, 60],
	[30, 60],
	[30, 100],
	[30, 140],
	[0, 140],
]);
// The building the passage cuts through: n ∈ [-10, 10], e ∈ [80, 120].
const building: BuildingFootprint = [pt(-10, 80), pt(-10, 120), pt(10, 120), pt(10, 80), pt(-10, 80)];
const ways = [west, east, passage, around];

// Fixes on the street stubs with a GPS gap across the block — nothing near the
// building. The straight chord (and the passage) has no fix support there.
const gapFixes = [
	fix(0, 0, 0),
	fix(0, 20, 15),
	fix(0, 40, 30),
	fix(0, 60, 45),
	fix(0, 140, 105),
	fix(0, 160, 120),
	fix(0, 180, 135),
	fix(0, 200, 150),
];

describe("matchWalkSegment building-aware route choice", () => {
	it("routes an unsupported gap around the building, not through the passage", () => {
		const result = matchWalkSegment(gapFixes, { ways, buildings: [building] });
		expect(result).not.toBeNull();
		const matched = (result?.path ?? []).map((p) => ({ lat: p.lat, lon: p.lon }));
		expect(buildingCrossingM(matched, [building])).toBe(0);
		// It went around the block's north side (simplify drops the collinear
		// mid-vertex, so probe the corner row, not a single point).
		const topRow = pt(30, 0);
		const nearTop = matched.some((p) => Math.abs(p.lat - topRow.lat) * 111_320 < 5);
		expect(nearTop).toBe(true);
	});

	it("keeps the through-building passage when raw fixes actually support it", () => {
		// Same block, but the walker's GPS traces the passage itself (a concourse
		// walk): fixes inside the crossing waive the penalty — honesty over tidiness.
		const passageFixes = [
			fix(0, 0, 0),
			fix(0, 20, 15),
			fix(0, 40, 30),
			fix(0, 60, 45),
			fix(0, 85, 65),
			fix(0, 100, 75),
			fix(0, 115, 90),
			fix(0, 140, 105),
			fix(0, 160, 120),
			fix(0, 180, 135),
			fix(0, 200, 150),
		];
		const result = matchWalkSegment(passageFixes, { ways, buildings: [building] });
		expect(result).not.toBeNull();
		const matched = (result?.path ?? []).map((p) => ({ lat: p.lat, lon: p.lon }));
		// The drawn line runs straight through — the crossing is real.
		expect(buildingCrossingM(matched, [building])).toBeGreaterThan(30);
	});

	it("takes the shorter passage when no building data is supplied", () => {
		// Building-blind geometry (every fixture but 07-01 today): behaviour is
		// unchanged — the direct passage is the shorter route and wins.
		const result = matchWalkSegment(gapFixes, { ways });
		expect(result).not.toBeNull();
		const matched = (result?.path ?? []).map((p) => ({ lat: p.lat, lon: p.lon }));
		expect(buildingCrossingM(matched, [building])).toBeGreaterThan(30);
	});
});
