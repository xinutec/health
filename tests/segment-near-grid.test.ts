/**
 * The SegmentNearGrid must be EXACT, not approximate: it replaced brute-force
 * nearest-chord scans on the walkMatch hot path (#332) under a byte-identical
 * contract, so these tests compare it against the brute force on
 * deterministically-generated geometry — same floats in, same min out.
 */

import { describe, expect, it } from "vitest";
import {
	maxPolylineOffRoad,
	nearestRoadDist,
	type OsmRoadWay,
	projectPointToSegment,
	SegmentNearGrid,
} from "../src/geo/map-match-core.js";

/** Deterministic LCG so the "random" geometry is stable across runs. */
function lcg(seed: number): () => number {
	let s = seed >>> 0;
	return () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 2 ** 32;
	};
}

/** Random ways around a London-ish origin, spanning a ~2 km disc. */
function randomWays(rand: () => number, nWays: number): OsmRoadWay[] {
	const ways: OsmRoadWay[] = [];
	for (let w = 0; w < nWays; w++) {
		const nPts = 2 + Math.floor(rand() * 6);
		let lat = 51.53 + (rand() - 0.5) * 0.02;
		let lon = -0.12 + (rand() - 0.5) * 0.03;
		const coords: Array<[number, number]> = [[lat, lon]];
		for (let i = 1; i < nPts; i++) {
			lat += (rand() - 0.5) * 0.002;
			lon += (rand() - 0.5) * 0.003;
			coords.push([lat, lon]);
		}
		ways.push({ osmId: w, name: null, subtype: "footway", coords });
	}
	return ways;
}

/** The reference the grid must reproduce exactly. */
function bruteNearest(p: { lat: number; lon: number }, ways: readonly OsmRoadWay[]): number {
	let best = Number.POSITIVE_INFINITY;
	for (const w of ways) {
		for (let i = 1; i < w.coords.length; i++) {
			const d = projectPointToSegment(
				p,
				{ lat: w.coords[i - 1][0], lon: w.coords[i - 1][1] },
				{ lat: w.coords[i][0], lon: w.coords[i][1] },
			).distM;
			if (d < best) best = d;
		}
	}
	return best;
}

describe("SegmentNearGrid — exactness vs brute force", () => {
	it("nearestDist equals the brute-force scan, including far off-grid queries", () => {
		const rand = lcg(42);
		const ways = randomWays(rand, 60);
		const grid = SegmentNearGrid.fromWays(ways, 64);
		expect(grid).not.toBeNull();
		if (!grid) return;
		for (let q = 0; q < 500; q++) {
			// Mix of on-network points and points hundreds of metres out.
			const spread = q % 5 === 0 ? 0.02 : 0.004;
			const p = { lat: 51.53 + (rand() - 0.5) * spread, lon: -0.12 + (rand() - 0.5) * spread * 1.5 };
			expect(grid.nearestDist(p.lat, p.lon)).toBe(bruteNearest(p, ways));
		}
	});

	it("clamped queries are exact below the clamp and clamped above it", () => {
		const rand = lcg(7);
		const ways = randomWays(rand, 40);
		const grid = SegmentNearGrid.fromWays(ways, 80);
		expect(grid).not.toBeNull();
		if (!grid) return;
		const clampM = 80;
		for (let q = 0; q < 300; q++) {
			const p = { lat: 51.53 + (rand() - 0.5) * 0.015, lon: -0.12 + (rand() - 0.5) * 0.02 };
			const truth = bruteNearest(p, ways);
			const got = grid.nearestDist(p.lat, p.lon, clampM);
			if (truth < clampM) expect(got).toBe(truth);
			else expect(got).toBe(clampM);
		}
	});

	it("nearestRoadDist with an index matches the index-free scan", () => {
		const rand = lcg(1234);
		const ways = randomWays(rand, 50);
		const geo = { ways };
		const grid = SegmentNearGrid.fromWays(ways, 64);
		for (let q = 0; q < 200; q++) {
			const p = { lat: 51.53 + (rand() - 0.5) * 0.01, lon: -0.12 + (rand() - 0.5) * 0.015 };
			expect(nearestRoadDist(p, geo, grid)).toBe(nearestRoadDist(p, geo));
		}
	});

	it("maxPolylineOffRoad (now grid-backed) matches a brute per-sample reference", () => {
		const rand = lcg(99);
		const ways = randomWays(rand, 50);
		const geo = { ways };
		for (let trial = 0; trial < 20; trial++) {
			const nPts = 3 + Math.floor(rand() * 10);
			const path: Array<{ lat: number; lon: number }> = [];
			let lat = 51.53 + (rand() - 0.5) * 0.01;
			let lon = -0.12 + (rand() - 0.5) * 0.015;
			for (let i = 0; i < nPts; i++) {
				path.push({ lat, lon });
				lat += (rand() - 0.5) * 0.003;
				lon += (rand() - 0.5) * 0.004;
			}
			// Reference: identical sampling loop, brute nearest per sample.
			let worst = 0;
			const stepM = 15;
			for (let i = 0; i < path.length; i++) {
				const consider = (p: { lat: number; lon: number }): void => {
					const d = bruteNearest(p, ways);
					if (d > worst) worst = d;
				};
				consider(path[i]);
				if (i + 1 < path.length) {
					const a = path[i];
					const b = path[i + 1];
					const dLat = (b.lat - a.lat) * 111_320;
					const dLon = (b.lon - a.lon) * 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
					const chord = Math.hypot(dLat, dLon);
					const n = Math.floor(chord / stepM);
					for (let k = 1; k < n; k++) {
						consider({ lat: a.lat + ((b.lat - a.lat) * k) / n, lon: a.lon + ((b.lon - a.lon) * k) / n });
					}
				}
			}
			expect(maxPolylineOffRoad(path, geo, stepM)).toBe(worst);
		}
	});
});
