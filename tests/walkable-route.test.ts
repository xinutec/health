import { describe, expect, it } from "vitest";
import type { RoadGeometry } from "../src/geo/road-match.js";
import { buildWalkGraph, routeOnWalkable } from "../src/geo/walkable-route.js";

/**
 * `routeOnWalkable` — the case-2 router: the street path between two
 * GPS-anchored points, used to take a drawn walk *around* a building block its
 * straight chord would cut through. Local Dijkstra over the walkable ways, with
 * both endpoints snapped onto the nearest way edge (not just the nearest graph
 * node, so a mid-street start doesn't detour to a distant junction first).
 */

const LAT = 51.563;
const LON = -0.281;
const dLat = (m: number) => m / 111_320;
const dLon = (m: number) => m / (111_320 * Math.cos((LAT * Math.PI) / 180));

// A rectangular street ring around a block: four streets forming a ~100m × 60m
// rectangle, sharing corner coordinates exactly (as OSM junction nodes do).
const N = LAT + dLat(30);
const S = LAT - dLat(30);
const W = LON - dLon(50);
const E = LON + dLon(50);
const ring: RoadGeometry = {
	ways: [
		{
			osmId: 1,
			name: "North St",
			subtype: "residential",
			coords: [
				[N, W],
				[N, E],
			],
		},
		{
			osmId: 2,
			name: "South St",
			subtype: "residential",
			coords: [
				[S, W],
				[S, E],
			],
		},
		{
			osmId: 3,
			name: "West St",
			subtype: "residential",
			coords: [
				[N, W],
				[S, W],
			],
		},
		{
			osmId: 4,
			name: "East St",
			subtype: "residential",
			coords: [
				[N, E],
				[S, E],
			],
		},
	],
};

const distM = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
	Math.hypot((b.lat - a.lat) * 111_320, (b.lon - a.lon) * 111_320 * Math.cos((LAT * Math.PI) / 180));

function pathLength(pts: ReadonlyArray<{ lat: number; lon: number }>): number {
	let len = 0;
	for (let i = 1; i < pts.length; i++) len += distM(pts[i - 1], pts[i]);
	return len;
}

describe("buildWalkGraph", () => {
	it("joins ways at shared junction coordinates", () => {
		const g = buildWalkGraph(ring);
		// 4 corners only (each shared by two ways) — deduped, not 8.
		expect(g.nodes.length).toBe(4);
		// Every corner connects to exactly 2 neighbours (the rectangle).
		for (const edges of g.adj) expect(edges.length).toBe(2);
	});
});

describe("routeOnWalkable", () => {
	it("routes around the block between mid-points of opposite streets", () => {
		// From the middle of West St to the middle of East St. The straight chord
		// (~100 m) crosses the block; the street route must go around a corner:
		// ~30 m up + ~100 m across + ~30 m down ≈ 160 m.
		const a = { lat: LAT, lon: W };
		const b = { lat: LAT, lon: E };
		const route = routeOnWalkable(a, b, ring);
		expect(route).not.toBeNull();
		if (!route) return;
		const len = pathLength(route);
		expect(len).toBeGreaterThan(140);
		expect(len).toBeLessThan(180);
		// Starts and ends at the snapped endpoints.
		expect(distM(route[0], a)).toBeLessThan(2);
		expect(distM(route[route.length - 1], b)).toBeLessThan(2);
		// Never dips inside the block interior (every vertex on the ring).
		for (const p of route) {
			const onNS = Math.abs(p.lat - N) < dLat(2) || Math.abs(p.lat - S) < dLat(2);
			const onWE = Math.abs(p.lon - W) < dLon(2) || Math.abs(p.lon - E) < dLon(2);
			expect(onNS || onWE).toBe(true);
		}
	});

	it("routes along a single street without a detour", () => {
		// Two points on North St, 60 m apart — the route is the street itself.
		const a = { lat: N, lon: LON - dLon(30) };
		const b = { lat: N, lon: LON + dLon(30) };
		const route = routeOnWalkable(a, b, ring);
		expect(route).not.toBeNull();
		if (!route) return;
		expect(pathLength(route)).toBeLessThan(70);
	});

	it("returns null when an endpoint is too far from any way", () => {
		const a = { lat: LAT + dLat(500), lon: LON };
		const b = { lat: LAT, lon: E };
		expect(routeOnWalkable(a, b, ring, { snapRadiusM: 30 })).toBeNull();
	});

	it("returns null on a disconnected network", () => {
		// Two separate streets with no connection between them.
		const disconnected: RoadGeometry = {
			ways: [
				{
					osmId: 1,
					name: "A",
					subtype: "residential",
					coords: [
						[N, W],
						[N, LON - dLon(10)],
					],
				},
				{
					osmId: 2,
					name: "B",
					subtype: "residential",
					coords: [
						[S, LON + dLon(10)],
						[S, E],
					],
				},
			],
		};
		const route = routeOnWalkable({ lat: N, lon: W }, { lat: S, lon: E }, disconnected);
		expect(route).toBeNull();
	});

	it("returns null on an empty network", () => {
		expect(routeOnWalkable({ lat: LAT, lon: W }, { lat: LAT, lon: E }, { ways: [] })).toBeNull();
	});

	it("bounds the ROUTE, not the search frontier", () => {
		// One straight street with nodes at 0, 50, 100, 145 and 400 m. The
		// destination sits at 148 m — mid-way along the LONG 145→400 edge, so its
		// far splice node is 400 m out. Dijkstra settles the near splice node at
		// 145 (route total 148), then must pop the far one at 545 before both
		// ends of the destination edge are settled.
		//
		// `maxRouteM` is a bound on the ROUTE the caller would draw. A 148 m route
		// under a 150 m bound is admissible, and the search reaching past 150 to
		// prove it is the shortest is not the caller's business. Aborting there
		// reports "no walkable path exists" for a street the walker is standing
		// on — which the corrector reads as a data gap and answers by trusting
		// the GPS straight through a building.
		const street: RoadGeometry = {
			ways: [
				{
					osmId: 1,
					name: "Long St",
					subtype: "residential",
					coords: [
						[LAT, LON],
						[LAT, LON + dLon(50)],
						[LAT, LON + dLon(100)],
						[LAT, LON + dLon(145)],
						[LAT, LON + dLon(400)],
					],
				},
			],
		};
		const route = routeOnWalkable({ lat: LAT, lon: LON }, { lat: LAT, lon: LON + dLon(148) }, street, {
			maxRouteM: 150,
		});
		expect(route).not.toBeNull();
		if (!route) return;
		expect(pathLength(route)).toBeCloseTo(148, 0);
	});

	it("still refuses a route that is itself over the bound", () => {
		// Same geometry, destination beyond the bound: 400 m of street under a
		// 150 m bound has no admissible route, and the answer stays null.
		const street: RoadGeometry = {
			ways: [
				{
					osmId: 1,
					name: "Long St",
					subtype: "residential",
					coords: [
						[LAT, LON],
						[LAT, LON + dLon(400)],
					],
				},
			],
		};
		expect(
			routeOnWalkable({ lat: LAT, lon: LON }, { lat: LAT, lon: LON + dLon(400) }, street, { maxRouteM: 150 }),
		).toBeNull();
	});
});
