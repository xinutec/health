/**
 * Road map-matcher pure-core test (task #261).
 *
 * The map draws driving / road-vehicle legs as the raw GPS polyline, so a
 * noisy urban fix that lands inside a block makes the line cut through
 * buildings, and a corner-cutting fix makes the car appear to drive
 * diagonally across the street grid. `matchRoadSegment` snaps the leg onto
 * the OSM road network (Newson-Krumm HMM map-matching) so the drawn path
 * follows the streets.
 *
 * These synthetic tests exercise the geometry + Viterbi mechanics on a tiny
 * hand-built network. They are NOT the verdict on the feature — the
 * rail-snap experience (every unit test green through three production
 * reverts) is the standing warning that synthetic fixes don't reproduce the
 * GPS pathologies that actually break matching. The real verdict is the
 * captured-day e2e (a follow-up), the same policy as `railsnap-e2e`.
 */

import { describe, expect, it } from "vitest";
import { fractionOffRoad, matchRoadSegment, projectPointToSegment, type RoadGeometry } from "../src/geo/road-match.js";

/** An L of two streets meeting at a shared corner:
 *  - "Larch Rise"  runs W→E along lat 51.5600, lon -0.2900 → -0.2800
 *  - "Quarry Lane" runs S→N along lon -0.2800, lat 51.5600 → 51.5700
 *  They share the corner node (51.5600, -0.2800). */
const L_NETWORK: RoadGeometry = {
	ways: [
		{
			osmId: 1,
			name: "Larch Rise",
			subtype: "residential",
			coords: [
				[51.56, -0.29],
				[51.56, -0.285],
				[51.56, -0.28],
			],
		},
		{
			osmId: 2,
			name: "Quarry Lane",
			subtype: "tertiary",
			coords: [
				[51.56, -0.28],
				[51.565, -0.28],
				[51.57, -0.28],
			],
		},
	],
};

/** Stamp a `[lat, lon]` track with 30 s-spaced timestamps. */
function track(coords: Array<[number, number]>): Array<{ lat: number; lon: number; ts: number }> {
	return coords.map(([lat, lon], i) => ({ lat, lon, ts: 1_000_000 + i * 30 }));
}

function metersBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
	const dLat = (bLat - aLat) * 111_320;
	const dLon = (bLon - aLon) * 111_320 * Math.cos((((aLat + bLat) / 2) * Math.PI) / 180);
	return Math.hypot(dLat, dLon);
}

/** Nearest distance (m) from a point to any road segment in the network. */
function distToNetwork(lat: number, lon: number, geo: RoadGeometry): number {
	let best = Number.POSITIVE_INFINITY;
	for (const w of geo.ways) {
		for (let i = 1; i < w.coords.length; i++) {
			const a = { lat: w.coords[i - 1][0], lon: w.coords[i - 1][1] };
			const b = { lat: w.coords[i][0], lon: w.coords[i][1] };
			const d = projectPointToSegment({ lat, lon }, a, b).distM;
			if (d < best) best = d;
		}
	}
	return best;
}

describe("projectPointToSegment", () => {
	it("projects onto the interior of a segment", () => {
		const a = { lat: 51.56, lon: -0.29 };
		const b = { lat: 51.56, lon: -0.28 };
		// A point ~11 m north of the midpoint.
		const r = projectPointToSegment({ lat: 51.5601, lon: -0.285 }, a, b);
		expect(r.t).toBeGreaterThan(0.45);
		expect(r.t).toBeLessThan(0.55);
		expect(r.distM).toBeGreaterThan(8);
		expect(r.distM).toBeLessThan(14);
		expect(Math.abs(r.lat - 51.56)).toBeLessThan(1e-6);
	});

	it("clamps to an endpoint when the foot falls beyond the segment", () => {
		const a = { lat: 51.56, lon: -0.29 };
		const b = { lat: 51.56, lon: -0.28 };
		const r = projectPointToSegment({ lat: 51.56, lon: -0.3 }, a, b);
		expect(r.t).toBe(0);
		expect(Math.abs(r.lon - -0.29)).toBeLessThan(1e-9);
	});
});

describe("fractionOffRoad (confidence gate)", () => {
	it("is near zero when the fixes already hug a road, high when they don't", () => {
		// Fixes within a few metres of Larch Rise (lat 51.5600).
		const onRoad = track([
			[51.5601, -0.2895],
			[51.5599, -0.288],
			[51.5602, -0.286],
		]);
		expect(fractionOffRoad(onRoad, L_NETWORK, 25)).toBe(0);

		// Fixes ~150 m north of any road in the L network.
		const offRoad = track([
			[51.5615, -0.2895],
			[51.5615, -0.288],
			[51.5615, -0.286],
		]);
		expect(fractionOffRoad(offRoad, L_NETWORK, 25)).toBe(1);
	});
});

describe("matchRoadSegment", () => {
	it("follows the streets around the corner instead of cutting across the block", () => {
		// A car drives Larch Rise W→E then turns N onto Quarry Lane. The raw
		// fixes are noisy (±~12 m) and one cuts the corner toward the
		// diagonal — the exact pattern that draws a line through the block.
		const fixes = track([
			[51.5601, -0.2895],
			[51.5599, -0.287],
			[51.5602, -0.2845],
			[51.5606, -0.2815], // corner-cut: NE of the bend
			[51.5615, -0.2802],
			[51.564, -0.2798],
			[51.5668, -0.2801],
		]);

		const result = matchRoadSegment(fixes, L_NETWORK);
		expect(result).not.toBeNull();
		if (!result) return;

		// Every drawn vertex sits on the road network (≤ a couple of metres).
		for (const p of result.path) {
			expect(distToNetwork(p.lat, p.lon, L_NETWORK)).toBeLessThan(3);
		}

		// The path actually rounds the corner: some vertex is within ~15 m of
		// the bend (51.5600, -0.2800). A diagonal short-cut would miss it.
		const nearCorner = result.path.some((p) => metersBetween(p.lat, p.lon, 51.56, -0.28) < 15);
		expect(nearCorner).toBe(true);

		// No drawn vertex strays into the NW block interior — a diagonal
		// cut would put points at e.g. (51.563, -0.285), off both streets.
		for (const p of result.path) {
			const inBlock = p.lat > 51.5605 && p.lon < -0.2805;
			expect(inBlock).toBe(false);
		}

		// Timestamps are monotonic and anchored to the fix window.
		expect(result.path[0].ts).toBe(fixes[0].ts);
		expect(result.path.at(-1)?.ts).toBe(fixes.at(-1)?.ts);
		for (let i = 1; i < result.path.length; i++) {
			expect(result.path[i].ts).toBeGreaterThanOrEqual(result.path[i - 1].ts);
		}
	});

	it("follows the GPS-traced road over a geometric shortcut, and simplifies junction noise", () => {
		// Two roads join the same ends: "Bend" curves north, "Shortcut" runs
		// straight (shorter). The GPS traced the Bend. A plain shortest-path
		// matcher would be tempted by the Shortcut; the corridor penalty keeps
		// the route on the road the GPS actually drove.
		const network: RoadGeometry = {
			ways: [
				{
					osmId: 10,
					name: "Bend",
					subtype: "tertiary",
					coords: [
						[51.5, 0.0],
						[51.5016, 0.005],
						[51.5, 0.01],
					],
				},
				{
					osmId: 11,
					name: "Shortcut",
					subtype: "residential",
					coords: [
						[51.5, 0.0],
						[51.5, 0.01],
					],
				},
			],
		};
		const fixes = track([
			[51.5002, 0.0008],
			[51.501, 0.0028],
			[51.5016, 0.005],
			[51.501, 0.0072],
			[51.5002, 0.0092],
		]);
		const result = matchRoadSegment(fixes, network);
		expect(result).not.toBeNull();
		if (!result) return;
		// Followed the Bend: some vertex sits well north of the Shortcut line.
		expect(result.path.some((p) => p.lat > 51.5012)).toBe(true);
		// Simplified: not one vertex per OSM node along the curve.
		expect(result.path.length).toBeLessThanOrEqual(fixes.length + 2);
	});

	it("does not duck into a dead-end cul-de-sac and back (routing spur)", () => {
		// "Main Road" runs W→E; "Dead End" is a cul-de-sac hanging off its
		// midpoint. The GPS drove straight along Main Road — no fix up the
		// cul-de-sac — so the path must not detour into it and back.
		const network: RoadGeometry = {
			ways: [
				{
					osmId: 20,
					name: "Main Road",
					subtype: "residential",
					coords: [
						[51.5, 0.0],
						[51.5, 0.004],
						[51.5, 0.008],
					],
				},
				{
					osmId: 21,
					name: "Dead End",
					subtype: "service",
					coords: [
						[51.5, 0.004],
						[51.5012, 0.004],
					],
				},
			],
		};
		const fixes = track([
			[51.5001, 0.0006],
			[51.4999, 0.0021],
			[51.5002, 0.0039],
			[51.4999, 0.0058],
			[51.5001, 0.0074],
		]);
		const result = matchRoadSegment(fixes, network);
		expect(result).not.toBeNull();
		if (!result) return;
		// No vertex sits up the cul-de-sac (well north of Main Road).
		expect(result.path.every((p) => p.lat < 51.5006)).toBe(true);
	});

	it("returns null for too few fixes to map-match", () => {
		const fixes = [
			{ lat: 51.56, lon: -0.289, ts: 1 },
			{ lat: 51.56, lon: -0.286, ts: 2 },
		];
		expect(matchRoadSegment(fixes, L_NETWORK)).toBeNull();
	});

	it("returns null when the fixes are nowhere near any road", () => {
		const fixes = track([
			[52.2, 0.1],
			[52.2001, 0.1005],
			[52.2003, 0.101],
			[52.2006, 0.1016],
		]);
		expect(matchRoadSegment(fixes, L_NETWORK)).toBeNull();
	});

	it("does not return a wildly longer detour than the raw track", () => {
		// Straight drive E along Larch Rise — the match must stay on the
		// street, never loop around via Quarry Lane.
		const fixes = track([
			[51.5601, -0.2895],
			[51.5599, -0.288],
			[51.5602, -0.286],
			[51.56, -0.284],
			[51.5601, -0.282],
		]);
		const result = matchRoadSegment(fixes, L_NETWORK);
		expect(result).not.toBeNull();
		if (!result) return;
		for (const p of result.path) {
			// Stays on Larch Rise: latitude pinned, never wanders up Quarry Lane.
			expect(Math.abs(p.lat - 51.56)).toBeLessThan(1e-4);
		}
	});
});
