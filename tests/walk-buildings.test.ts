import { describe, expect, it } from "vitest";
import { buildingCrossingM, offPathBuildingCrossingM, pointInRing } from "../src/eval/walk-buildings.js";
import type { LatLon } from "../src/eval/walk-score.js";
import type { RoadGeometry } from "../src/geo/map-match-core.js";
import type { BuildingFootprint } from "../src/geo/osm-local.js";

/**
 * `buildingCrossingM` — the headline referee metric the off-walkable proxy is
 * blind to. It measures how much of the DRAWN line's length lies inside a
 * building footprint. Yesterday's snapped Ashvale line cut a diagonal chord
 * across a building block and still scored well on off-walkable-p90 (a chord on a
 * way centreline is "near a way"); this metric is what makes that defect visible.
 */

// A ~40 m square building near Ashvale (metres → degrees at this latitude).
const LAT = 51.563;
const LON = -0.281;
const dLat = (m: number) => m / 111_320;
const dLon = (m: number) => m / (111_320 * Math.cos((LAT * Math.PI) / 180));

// Square footprint, corners 40 m on a side, centred at (LAT, LON).
const H = 20;
const square: BuildingFootprint = [
	{ lat: LAT - dLat(H), lon: LON - dLon(H) },
	{ lat: LAT - dLat(H), lon: LON + dLon(H) },
	{ lat: LAT + dLat(H), lon: LON + dLon(H) },
	{ lat: LAT + dLat(H), lon: LON - dLon(H) },
];

describe("pointInRing", () => {
	it("is true at the centre, false well outside", () => {
		expect(pointInRing({ lat: LAT, lon: LON }, square)).toBe(true);
		expect(pointInRing({ lat: LAT + dLat(100), lon: LON }, square)).toBe(false);
	});

	it("is false just outside an edge", () => {
		expect(pointInRing({ lat: LAT, lon: LON + dLon(H + 5) }, square)).toBe(false);
	});
});

describe("buildingCrossingM", () => {
	it("is zero for a line that passes beside the building", () => {
		// A line 60 m north of the square, running west→east — never enters it.
		const drawn: LatLon[] = [
			{ lat: LAT + dLat(60), lon: LON - dLon(50) },
			{ lat: LAT + dLat(60), lon: LON + dLon(50) },
		];
		expect(buildingCrossingM(drawn, [square])).toBeLessThan(1);
	});

	it("measures the crossed length for a chord straight through the building", () => {
		// A west→east line through the centre: it is inside for the ~40 m width.
		const drawn: LatLon[] = [
			{ lat: LAT, lon: LON - dLon(50) },
			{ lat: LAT, lon: LON + dLon(50) },
		];
		const crossed = buildingCrossingM(drawn, [square]);
		expect(crossed).toBeGreaterThan(30);
		expect(crossed).toBeLessThan(50);
	});

	it("is zero when there are no buildings", () => {
		const drawn: LatLon[] = [
			{ lat: LAT, lon: LON - dLon(50) },
			{ lat: LAT, lon: LON + dLon(50) },
		];
		expect(buildingCrossingM(drawn, [])).toBe(0);
	});

	it("returns 0 for a degenerate (single-point) line", () => {
		expect(buildingCrossingM([{ lat: LAT, lon: LON }], [square])).toBe(0);
	});
});

describe("offPathBuildingCrossingM", () => {
	// The chord through the square's centre, west→east.
	const chord: LatLon[] = [
		{ lat: LAT, lon: LON - dLon(50) },
		{ lat: LAT, lon: LON + dLon(50) },
	];

	it("does not count a crossing that follows a mapped through-building way (arcade/concourse)", () => {
		// A footway runs straight through the building along the chord — OSM says
		// this is walkable (the Mill Road arcade / Elmford concourse case).
		const passage: RoadGeometry = {
			ways: [
				{
					osmId: 1,
					name: null,
					subtype: "footway",
					coords: [
						[LAT, LON - dLon(50)],
						[LAT, LON + dLon(50)],
					],
				},
			],
		};
		expect(offPathBuildingCrossingM(chord, [square], passage)).toBe(0);
		// The raw metric still sees it — the two lenses answer different questions.
		expect(buildingCrossingM(chord, [square])).toBeGreaterThan(30);
	});

	it("counts the full crossing when no way passes through the building", () => {
		// The only mapped way is a street 40 m north — the chord cuts the house.
		const street: RoadGeometry = {
			ways: [
				{
					osmId: 2,
					name: "Front Street",
					subtype: "residential",
					coords: [
						[LAT + dLat(40), LON - dLon(50)],
						[LAT + dLat(40), LON + dLon(50)],
					],
				},
			],
		};
		const offPath = offPathBuildingCrossingM(chord, [square], street);
		expect(offPath).toBeGreaterThan(30);
		expect(offPath).toBeLessThan(50);
	});

	it("counts everything when there are no ways at all", () => {
		expect(offPathBuildingCrossingM(chord, [square], { ways: [] })).toBeGreaterThan(30);
	});
});
