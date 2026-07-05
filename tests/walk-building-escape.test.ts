import { describe, expect, it } from "vitest";
import type { BuildingFootprint } from "../src/geo/osm-local.js";
import type { RoadGeometry } from "../src/geo/road-match.js";
import { escapeBuildings } from "../src/geo/walk-building-escape.js";

/**
 * `escapeBuildings` — Pippijn's case-based walk corrector, case 1: a drawn vertex
 * that lands inside a building is moved OUT onto the nearest street *on that
 * building's side* (escape the near wall, then snap to the near street). Case 3
 * (no streets → trust GPS) means a vertex over open ground is never moved.
 */

const LAT = 51.563;
const LON = -0.281;
const dLat = (m: number) => m / 111_320;
const dLon = (m: number) => m / (111_320 * Math.cos((LAT * Math.PI) / 180));

// A ~30 m square building. Its south wall is at LAT - dLat(15); a street runs
// east-west just south of it at LAT - dLat(22) (7 m off the south wall).
const H = 15;
const building: BuildingFootprint = [
	{ lat: LAT - dLat(H), lon: LON - dLon(H) },
	{ lat: LAT - dLat(H), lon: LON + dLon(H) },
	{ lat: LAT + dLat(H), lon: LON + dLon(H) },
	{ lat: LAT + dLat(H), lon: LON - dLon(H) },
];
const streetLat = LAT - dLat(22);
const southStreet: RoadGeometry = {
	ways: [
		{
			osmId: 1,
			name: "South Street",
			subtype: "residential",
			coords: [
				[streetLat, LON - dLon(60)],
				[streetLat, LON + dLon(60)],
			],
		},
	],
};

// distance (m) between two lat/lon
const distM = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
	Math.hypot((b.lat - a.lat) * 111_320, (b.lon - a.lon) * 111_320 * Math.cos((LAT * Math.PI) / 180));

// point-in-ring (even-odd) mirrored from the eval metric, for asserting "no
// longer inside a building".
function inRing(p: { lat: number; lon: number }, ring: BuildingFootprint): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const hit =
			ring[i].lat > p.lat !== ring[j].lat > p.lat &&
			p.lon < ((ring[j].lon - ring[i].lon) * (p.lat - ring[i].lat)) / (ring[j].lat - ring[i].lat) + ring[i].lon;
		if (hit) inside = !inside;
	}
	return inside;
}

describe("escapeBuildings — case 1 (vertex inside a building)", () => {
	it("moves a vertex just inside the south wall out onto the south street", () => {
		// A vertex 3 m inside the south wall (nearest wall is the south one).
		const p = { lat: LAT - dLat(12), lon: LON, ts: 100 };
		const out = escapeBuildings([p, p], southStreet, [building]);
		const moved = out[0];
		expect(inRing(moved, building)).toBe(false); // left the building
		// landed near the south street (within a couple of metres of streetLat)
		expect(distM(moved, { lat: streetLat, lon: LON })).toBeLessThan(4);
		expect(moved.ts).toBe(100); // timestamp preserved
	});

	it("does not move a vertex that is already outside every building", () => {
		const p = { lat: streetLat, lon: LON, ts: 5 };
		const out = escapeBuildings([p, p], southStreet, [building]);
		expect(out[0].lat).toBeCloseTo(p.lat, 10);
		expect(out[0].lon).toBeCloseTo(p.lon, 10);
	});
});

describe("escapeBuildings — case 3 (no streets → trust GPS)", () => {
	it("leaves an inside-building vertex where it is when there is no walkable network", () => {
		const p = { lat: LAT - dLat(12), lon: LON, ts: 1 };
		const empty: RoadGeometry = { ways: [] };
		const out = escapeBuildings([p, p], empty, [building]);
		// No street to escape to → do not invent; leave the vertex (trust GPS).
		expect(out[0].lat).toBeCloseTo(p.lat, 10);
		expect(out[0].lon).toBeCloseTo(p.lon, 10);
	});

	it("is a no-op when there are no buildings", () => {
		const p = { lat: LAT, lon: LON, ts: 1 };
		const out = escapeBuildings([p, p], southStreet, []);
		expect(out[0].lat).toBeCloseTo(p.lat, 10);
		expect(out[0].lon).toBeCloseTo(p.lon, 10);
	});
});
