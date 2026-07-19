import { describe, expect, it } from "vitest";
import { buildingCrossingM } from "../src/eval/walk-buildings.js";
import type { BuildingFootprint } from "../src/geo/osm-local.js";
import type { RoadGeometry } from "../src/geo/road-match.js";
import { correctWalkPath, DEFAULT_CORRECT_OPTIONS, snapPassages } from "../src/geo/walk-building-escape.js";

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
const distM = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
	Math.hypot((b.lat - a.lat) * 111_320, (b.lon - a.lon) * 111_320 * Math.cos((LAT * Math.PI) / 180));

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

	it("rounds the block geometrically when the network cannot route around (case 2.5)", () => {
		// Only West St exists: no street path around the block. The line must
		// still not cross the footprint — walk AROUND it along its corners (a
		// pavement exists along a wall even when OSM doesn't map it). Bounded:
		// endpoints exact, timestamps monotone, no invented loop.
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
		expect(out.length).toBeGreaterThan(2);
		expect(buildingCrossingM(out, [block])).toBeLessThan(1);
		const len = (xs: readonly { lat: number; lon: number }[]) => {
			let m = 0;
			for (let i = 1; i < xs.length; i++) m += distM(xs[i - 1], xs[i]);
			return m;
		};
		expect(len(out)).toBeLessThanOrEqual(len(drawn) * 2.5);
		expect(out[0].lon).toBeCloseTo(drawn[0].lon, 10);
		expect(out[out.length - 1].lon).toBeCloseTo(drawn[1].lon, 10);
		for (let i = 1; i < out.length; i++) expect(out[i].ts).toBeGreaterThanOrEqual(out[i - 1].ts);
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
		// The huge street loop stays refused. The corner detour (case 2.5) may
		// round the block instead — bounded, crossing-free — but nothing may
		// resemble the invented kilometre loop.
		const west = LON - dLon(200);
		expect(out.every((p) => p.lon > west)).toBe(true);
		expect(buildingCrossingM(out, [block])).toBeLessThan(1);
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

describe("snapPassages — passage snap (ride the mapped way exactly, not 2–3 m beside it)", () => {
	// An arcade way runs diagonally through the block: the badness metric
	// rightly exempts a line riding it (mapped passage) — but the exemption
	// tolerates onWayM (8 m) of lateral error, which draws the walker over the
	// buildings BESIDE the passage. If we excuse the stretch as "riding the
	// passage", we must DRAW it riding the passage.
	const arcadeWay: RoadGeometry = {
		ways: [
			{
				osmId: 11,
				name: "Parade Walk",
				subtype: "footway",
				coords: [
					[rN, bW],
					[LAT, LON],
					[rS, bE],
				],
			},
		],
	};
	const wayDist = (p: { lat: number; lon: number }) => {
		let best = Number.POSITIVE_INFINITY;
		const w = arcadeWay.ways[0].coords;
		for (let i = 1; i < w.length; i++) {
			const a = { lat: w[i - 1][0], lon: w[i - 1][1] };
			const b = { lat: w[i][0], lon: w[i][1] };
			// point-to-segment in metres via projection on the chord
			const ax = a.lon,
				ay = a.lat,
				bx = b.lon,
				by = b.lat;
			const dx = bx - ax,
				dy = by - ay;
			const L2 = dx * dx + dy * dy;
			const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.lon - ax) * dx + (p.lat - ay) * dy) / L2)) : 0;
			best = Math.min(best, distM(p, { lat: ay + t * dy, lon: ax + t * dx }));
		}
		return best;
	};

	it("snaps an in-building stretch onto the mapped passage way it rides beside", () => {
		// The drawn line parallels the arcade ~3 m to the north-east — inside the
		// footprint, within the exemption band. Every output vertex must land ON
		// the way (≤ ~1 m), so the render follows the passage, not the roof.
		const off = dLat(3);
		const drawn = [
			{ lat: rN + off, lon: bW, ts: 0 },
			{ lat: LAT + off, lon: LON, ts: 50 },
			{ lat: rS + off, lon: bE, ts: 100 },
		];
		const out = snapPassages(drawn, arcadeWay, [block]);
		// Every point in the passage (inside the block's extent) rides the way;
		// endpoints outside the footprint keep their honest GPS offset.
		const inBlock = out.filter((p) => p.lat < bN && p.lat > bS && p.lon > bW && p.lon < bE);
		expect(inBlock.length).toBeGreaterThan(3);
		for (const p of inBlock) expect(wayDist(p)).toBeLessThan(1.5);
		expect(out[0].ts).toBe(0);
		expect(out[out.length - 1].ts).toBe(100);
		for (let i = 1; i < out.length; i++) expect(out[i].ts).toBeGreaterThanOrEqual(out[i - 1].ts);
	});

	it("follows the passage way's own corner instead of chording across the footprint", () => {
		// Two vertices exactly ON the way either side of its bend: the straight
		// chord between them cuts through the block interior (within the
		// exemption band). The drawn line must pick up the way's bend.
		const drawn = [
			{ lat: rN, lon: bW, ts: 0 },
			{ lat: rS, lon: bE, ts: 100 },
		];
		const out = snapPassages(drawn, arcadeWay, [block]);
		const worst = Math.max(...out.map((p) => wayDist(p)));
		expect(worst).toBeLessThan(1.5);
		// the bend vertex is represented: some output point near (LAT, LON)
		expect(out.some((p) => distM(p, { lat: LAT, lon: LON }) < 3)).toBe(true);
	});

	it("does NOT snap lateral GPS offset on an open street (no footprint involved)", () => {
		// The same 3 m offset along North St with the block far away: lateral
		// placement is signal (which side you walked) — untouched.
		const drawn = [
			{ lat: rN + dLat(3), lon: rW, ts: 0 },
			{ lat: rN + dLat(3), lon: LON, ts: 60 },
			{ lat: rN + dLat(3), lon: rE, ts: 120 },
		];
		const out = snapPassages(drawn, streetRing, [block]);
		for (let i = 0; i < 3; i++) {
			expect(out[i].lat).toBeCloseTo(drawn[i].lat, 10);
			expect(out[i].lon).toBeCloseTo(drawn[i].lon, 10);
		}
	});
});

describe("correctWalkPath — case 2.5 (geometric corner detour when the network cannot route)", () => {
	// A lone walkable way far to the west: anchors can exist, but no street
	// route around the block is possible. The detour must come from the
	// building's own corners.
	const lonelyWay: RoadGeometry = {
		ways: [
			{
				osmId: 9,
				name: "Far Lane",
				subtype: "residential",
				coords: [
					[rN, rW],
					[rS, rW],
				],
			},
		],
	};

	it("declines when the footprint is boxed in (both detour directions cross neighbours)", () => {
		// Flush neighbours on the north AND south walls: neither way around the
		// middle block is crossing-free. The honest answer stays the GPS chord.
		const north: BuildingFootprint = [
			{ lat: bN, lon: bW },
			{ lat: bN, lon: bE },
			{ lat: bN + dLat(30), lon: bE },
			{ lat: bN + dLat(30), lon: bW },
		];
		const south: BuildingFootprint = [
			{ lat: bS - dLat(30), lon: bW },
			{ lat: bS - dLat(30), lon: bE },
			{ lat: bS, lon: bE },
			{ lat: bS, lon: bW },
		];
		const drawn = [
			{ lat: LAT, lon: rW, ts: 0 },
			{ lat: LAT, lon: rE, ts: 100 },
		];
		const out = correctWalkPath(drawn, lonelyWay, [block, north, south]);
		expect(out.length).toBe(2);
		expect(out[0].lon).toBeCloseTo(drawn[0].lon, 10);
		expect(out[1].lon).toBeCloseTo(drawn[1].lon, 10);
	});

	it("declines an over-long detour (crossing an elongated building near its middle)", () => {
		// A 400 m × 12 m slab crossed across its narrow middle: going around
		// either end invents ~10× the straight line. Keep the chord.
		const slab: BuildingFootprint = [
			{ lat: LAT - dLat(6), lon: LON - dLon(200) },
			{ lat: LAT - dLat(6), lon: LON + dLon(200) },
			{ lat: LAT + dLat(6), lon: LON + dLon(200) },
			{ lat: LAT + dLat(6), lon: LON - dLon(200) },
		];
		const drawn = [
			{ lat: LAT - dLat(20), lon: LON, ts: 0 },
			{ lat: LAT + dLat(20), lon: LON, ts: 100 },
		];
		const out = correctWalkPath(drawn, lonelyWay, [slab]);
		expect(out.map((p) => [p.lat, p.lon])).toEqual(drawn.map((p) => [p.lat, p.lon]));
	});

	it("detours around BOTH footprints when a chord crosses two separated buildings", () => {
		const east: BuildingFootprint = [
			{ lat: bS, lon: bE + dLon(40) },
			{ lat: bS, lon: bE + dLon(80) },
			{ lat: bN, lon: bE + dLon(80) },
			{ lat: bN, lon: bE + dLon(40) },
		];
		const drawn = [
			{ lat: LAT, lon: rW, ts: 0 },
			{ lat: LAT, lon: bE + dLon(120), ts: 200 },
		];
		const out = correctWalkPath(drawn, lonelyWay, [block, east]);
		expect(buildingCrossingM(out, [block, east])).toBeLessThan(1);
		expect(out[0].ts).toBe(0);
		expect(out[out.length - 1].ts).toBe(200);
		for (let i = 1; i < out.length; i++) expect(out[i].ts).toBeGreaterThanOrEqual(out[i - 1].ts);
	});

	it("never fires in open ground (forest walk stays raw GPS)", () => {
		// No buildings anywhere near the chord: untouched, whatever the network.
		const drawn = [
			{ lat: LAT, lon: rW, ts: 0 },
			{ lat: LAT + dLat(50), lon: rE, ts: 100 },
		];
		const out = correctWalkPath(drawn, lonelyWay, []);
		expect(out.map((p) => [p.lat, p.lon])).toEqual(drawn.map((p) => [p.lat, p.lon]));
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

describe("correctWalkPath — step-budget honesty invariant (#347)", () => {
	// The chord through the block (~80 m) versus its street route around
	// (~136 m): the pedometer bar decides whether the reroute's distance was
	// real. The bar the caller passes is steps × stride × slack.
	const chord = [
		{ lat: LAT, lon: rW, ts: 1000 },
		{ lat: LAT, lon: rE, ts: 1120 },
	];

	it("reverts corrections that push the leg from within its step budget to beyond it", () => {
		const out = correctWalkPath(chord, streetRing, [block], { ...DEFAULT_CORRECT_OPTIONS, stepBudgetM: 100 });
		// The route around (~136 m) exceeds the 100 m bar the 80 m input fit —
		// the correction bought its building fix with distance the pedometer
		// says was never walked. The input chord comes back unchanged.
		expect(out.length).toBe(2);
		expect(out[0].lon).toBeCloseTo(chord[0].lon, 10);
		expect(out[1].lon).toBeCloseTo(chord[1].lon, 10);
	});

	it("keeps corrections that fit the step budget", () => {
		const out = correctWalkPath(chord, streetRing, [block], { ...DEFAULT_CORRECT_OPTIONS, stepBudgetM: 250 });
		expect(buildingCrossingM(out, [block])).toBeLessThan(2);
		expect(out.length).toBeGreaterThan(2);
	});

	it("does not fire on a leg already over budget (only under→over is the lie)", () => {
		// A sparse-fix leg whose GPS chords already exceed the pedometer bar:
		// the corrector's reroute cannot make the budget verdict WORSE, and the
		// building fix stands.
		const out = correctWalkPath(chord, streetRing, [block], { ...DEFAULT_CORRECT_OPTIONS, stepBudgetM: 60 });
		expect(buildingCrossingM(out, [block])).toBeLessThan(2);
	});

	it("is off without step data", () => {
		const out = correctWalkPath(chord, streetRing, [block]);
		expect(buildingCrossingM(out, [block])).toBeLessThan(2);
	});
});
