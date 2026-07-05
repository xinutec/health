import { describe, expect, it } from "vitest";
import { buildingCrossingM } from "../src/eval/walk-buildings.js";
import type { BuildingFootprint } from "../src/geo/osm-local.js";
import type { RoadGeometry } from "../src/geo/road-match.js";
import { correctWalkPath } from "../src/geo/walk-building-escape.js";

/**
 * `correctWalkPath` — the full case-based corrector: densify → escape vertices
 * off buildings onto the near-side street (case 1) → where a gap still crosses a
 * block, route it around along the streets (case 2) → no streets, trust GPS
 * (case 3). The output must never cross MORE building than the input (the
 * honesty invariant), and timestamps must stay monotone.
 */

const LAT = 51.563;
const LON = -0.281;
const dLat = (m: number) => m / 111_320;
const dLon = (m: number) => m / (111_320 * Math.cos((LAT * Math.PI) / 180));

// A ~60m × 36m building block with a street ring around it (10 m off each wall):
// the Mill Road shape — a chord across the block must go around on the ring.
const bN = LAT + dLat(18);
const bS = LAT - dLat(18);
const bW = LON - dLon(30);
const bE = LON + dLon(30);
const block: BuildingFootprint = [
	{ lat: bS, lon: bW },
	{ lat: bS, lon: bE },
	{ lat: bN, lon: bE },
	{ lat: bN, lon: bW },
];
const rN = LAT + dLat(28);
const rS = LAT - dLat(28);
const rW = LON - dLon(40);
const rE = LON + dLon(40);
const streetRing: RoadGeometry = {
	ways: [
		{
			osmId: 1,
			name: "North St",
			subtype: "residential",
			coords: [
				[rN, rW],
				[rN, rE],
			],
		},
		{
			osmId: 2,
			name: "South St",
			subtype: "residential",
			coords: [
				[rS, rW],
				[rS, rE],
			],
		},
		{
			osmId: 3,
			name: "West St",
			subtype: "residential",
			coords: [
				[rN, rW],
				[rS, rW],
			],
		},
		{
			osmId: 4,
			name: "East St",
			subtype: "residential",
			coords: [
				[rN, rE],
				[rS, rE],
			],
		},
	],
};

describe("correctWalkPath — case 2 (chord through a block routes around it)", () => {
	it("replaces a two-point chord through the block with a street route around it", () => {
		// Two fixes on West/East St at the block's mid-height: the chord runs
		// straight through the building (~60 m inside). No vertex is inside, so
		// case-1 escape alone cannot fix it.
		const drawn = [
			{ lat: LAT, lon: rW, ts: 1000 },
			{ lat: LAT, lon: rE, ts: 1120 },
		];
		expect(buildingCrossingM(drawn, [block])).toBeGreaterThan(50);

		const out = correctWalkPath(drawn, streetRing, [block]);
		// The honest line no longer crosses the block…
		expect(buildingCrossingM(out, [block])).toBeLessThan(2);
		// …and it is a real route around it (longer than the chord, bounded by the
		// half-perimeter detour).
		expect(out.length).toBeGreaterThan(2);
		// Timestamps stay monotone from first to last.
		for (let i = 1; i < out.length; i++) expect(out[i].ts).toBeGreaterThanOrEqual(out[i - 1].ts);
		expect(out[0].ts).toBe(1000);
		expect(out[out.length - 1].ts).toBe(1120);
	});

	it("leaves a line riding a mapped through-building footway alone (arcade/concourse)", () => {
		// OSM maps a footway straight through the block — a covered arcade (the
		// Mill Road parade) or a station concourse. Walking it is correct;
		// the corrector must not reroute a line that follows a mapped passage.
		const arcade: RoadGeometry = {
			ways: [
				...streetRing.ways,
				{
					osmId: 9,
					name: null,
					subtype: "footway",
					coords: [
						[LAT, rW],
						[LAT, rE],
					],
				},
			],
		};
		const drawn = [
			{ lat: LAT, lon: rW, ts: 1000 },
			{ lat: LAT, lon: LON, ts: 1060 },
			{ lat: LAT, lon: rE, ts: 1120 },
		];
		const out = correctWalkPath(drawn, arcade, [block]);
		expect(out.length).toBe(3);
		for (let i = 0; i < 3; i++) {
			expect(out[i].lat).toBeCloseTo(drawn[i].lat, 10);
			expect(out[i].lon).toBeCloseTo(drawn[i].lon, 10);
		}
	});

	it("keeps a clean on-street line unchanged", () => {
		// A line along North St, never near the block: nothing to correct.
		const drawn = [
			{ lat: rN, lon: rW, ts: 0 },
			{ lat: rN, lon: LON, ts: 60 },
			{ lat: rN, lon: rE, ts: 120 },
		];
		const out = correctWalkPath(drawn, streetRing, [block]);
		expect(out.length).toBe(3);
		for (let i = 0; i < 3; i++) {
			expect(out[i].lat).toBeCloseTo(drawn[i].lat, 10);
			expect(out[i].lon).toBeCloseTo(drawn[i].lon, 10);
		}
	});

	it("falls back to the original chord when the network cannot route around", () => {
		// Only West St exists: no path around the block. The honest answer is the
		// unmodified GPS chord (case 3 degradation), never an invented line.
		const westOnly: RoadGeometry = {
			ways: [
				{
					osmId: 3,
					name: "West St",
					subtype: "residential",
					coords: [
						[rN, rW],
						[rS, rW],
					],
				},
			],
		};
		const drawn = [
			{ lat: LAT, lon: rW, ts: 0 },
			{ lat: LAT, lon: rE, ts: 100 },
		];
		const out = correctWalkPath(drawn, westOnly, [block]);
		expect(out.length).toBe(2);
		expect(out[0].lon).toBeCloseTo(drawn[0].lon, 10);
		expect(out[1].lon).toBeCloseTo(drawn[1].lon, 10);
	});

	it("rejects an implausibly long detour (honesty guard)", () => {
		// The only route around is via a huge loop (~20× the chord): drawing it
		// would invent a walk that plainly didn't happen. Keep the chord.
		const far = dLon(1000);
		const loop: RoadGeometry = {
			ways: [
				{
					osmId: 1,
					name: "W",
					subtype: "residential",
					coords: [
						[rN, rW],
						[rS, rW],
					],
				},
				{
					osmId: 2,
					name: "E",
					subtype: "residential",
					coords: [
						[rN, rE],
						[rS, rE],
					],
				},
				{
					osmId: 3,
					name: "LongWayRound",
					subtype: "residential",
					coords: [
						[rN, rW],
						[rN, LON - far],
						[LAT + dLat(800), LON - far],
						[LAT + dLat(800), LON + far],
						[rN, LON + far],
						[rN, rE],
					],
				},
			],
		};
		const drawn = [
			{ lat: LAT, lon: rW, ts: 0 },
			{ lat: LAT, lon: rE, ts: 100 },
		];
		const out = correctWalkPath(drawn, loop, [block]);
		expect(out.length).toBe(2); // unchanged — the loop was refused
	});

	it("is a no-op when there are no buildings", () => {
		const drawn = [
			{ lat: LAT, lon: rW, ts: 0 },
			{ lat: LAT, lon: rE, ts: 100 },
		];
		const out = correctWalkPath(drawn, streetRing, []);
		expect(out.length).toBe(2);
	});
});

describe("correctWalkPath — off-network chord in built surroundings (urban block cut)", () => {
	// Two small buildings INSIDE the ring, flanking the mid-line with a gap
	// between them: a chord across the block threads BETWEEN them (zero
	// building-crossing — the class the containment rule is blind to) but is far
	// off every street, in clearly built surroundings. The 2026-07-01 10:18
	// Mill Road diagonal, distilled.
	const north = { c: LAT + dLat(9) };
	const south = { c: LAT - dLat(9) };
	const flankNorth: BuildingFootprint = [
		{ lat: north.c - dLat(4), lon: LON - dLon(20) },
		{ lat: north.c - dLat(4), lon: LON + dLon(20) },
		{ lat: north.c + dLat(4), lon: LON + dLon(20) },
		{ lat: north.c + dLat(4), lon: LON - dLon(20) },
	];
	const flankSouth: BuildingFootprint = [
		{ lat: south.c - dLat(4), lon: LON - dLon(20) },
		{ lat: south.c - dLat(4), lon: LON + dLon(20) },
		{ lat: south.c + dLat(4), lon: LON + dLon(20) },
		{ lat: south.c + dLat(4), lon: LON - dLon(20) },
	];

	it("routes a between-buildings chord around the block along the streets", () => {
		const drawn = [
			{ lat: LAT, lon: rW, ts: 0 },
			{ lat: LAT, lon: rE, ts: 120 },
		];
		// Sanity: the chord crosses NO building (it threads the gap)…
		expect(buildingCrossingM(drawn, [flankNorth, flankSouth])).toBeLessThan(1);

		const out = correctWalkPath(drawn, streetRing, [flankNorth, flankSouth]);
		// …but it is an urban block cut, so it must be rerouted along the ring:
		// more vertices, and no vertex left in the gap corridor between the flanks.
		expect(out.length).toBeGreaterThan(2);
		const inGap = out.filter(
			(p) =>
				Math.abs(p.lat - LAT) * 111_320 < 5 && Math.abs(p.lon - LON) * 111_320 * Math.cos((LAT * Math.PI) / 180) < 10,
		);
		expect(inGap.length).toBe(0);
		// Timestamps monotone, ends preserved.
		for (let i = 1; i < out.length; i++) expect(out[i].ts).toBeGreaterThanOrEqual(out[i - 1].ts);
		expect(out[0].ts).toBe(0);
		expect(out[out.length - 1].ts).toBe(120);
	});

	it("leaves an off-network chord alone in open ground (no buildings near)", () => {
		// Same geometry but the buildings are FAR outside the ring: the chord is
		// off-network but the surroundings are open ground — trust the GPS
		// (a walk across a park lawn is not an artifact).
		const farBuilding: BuildingFootprint = [
			{ lat: LAT + dLat(200), lon: LON - dLon(10) },
			{ lat: LAT + dLat(200), lon: LON + dLon(10) },
			{ lat: LAT + dLat(215), lon: LON + dLon(10) },
			{ lat: LAT + dLat(215), lon: LON - dLon(10) },
		];
		const drawn = [
			{ lat: LAT, lon: rW, ts: 0 },
			{ lat: LAT, lon: rE, ts: 120 },
		];
		const out = correctWalkPath(drawn, streetRing, [farBuilding]);
		expect(out.length).toBe(2);
		expect(out[0].lon).toBeCloseTo(drawn[0].lon, 10);
		expect(out[1].lon).toBeCloseTo(drawn[1].lon, 10);
	});

	it("does not touch a line that follows the streets", () => {
		// Along North St end to end: on-network the whole way, buildings nearby —
		// nothing to correct.
		const drawn = [
			{ lat: rN, lon: rW, ts: 0 },
			{ lat: rN, lon: LON, ts: 60 },
			{ lat: rN, lon: rE, ts: 120 },
		];
		const out = correctWalkPath(drawn, streetRing, [flankNorth, flankSouth]);
		expect(out.length).toBe(3);
		for (let i = 0; i < 3; i++) {
			expect(out[i].lat).toBeCloseTo(drawn[i].lat, 10);
			expect(out[i].lon).toBeCloseTo(drawn[i].lon, 10);
		}
	});
});
