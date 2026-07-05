import { describe, expect, it } from "vitest";
import { type Bbox, clusterIntoRegions, tileBbox } from "../src/geo/route-graph-loader.js";

describe("clusterIntoRegions", () => {
	// pippijn's focus places span three metros from travel history.
	const london = [
		{ lat: 51.56, lon: -0.28 },
		{ lat: 51.5, lon: -0.14 },
		{ lat: 51.46, lon: -0.49 },
	];
	const sf = [
		{ lat: 37.76, lon: -122.5 },
		{ lat: 37.42, lon: -122.07 },
	];
	const toronto = [{ lat: 43.68, lon: -79.6 }];

	it("separates metros into distinct regions", () => {
		const regions = clusterIntoRegions([...london, ...sf, ...toronto], 80);
		expect(regions).toHaveLength(3);
	});

	it("keeps a single metro's spread-out places in one region", () => {
		const regions = clusterIntoRegions(london, 80);
		expect(regions).toHaveLength(1);
		expect(regions[0]).toHaveLength(3);
	});

	it("picks the largest region as 'home' (most places)", () => {
		const regions = clusterIntoRegions([...london, ...sf, ...toronto], 80);
		const home = regions.reduce((a, b) => (b.length > a.length ? b : a));
		expect(home).toHaveLength(3); // London
		expect(home.every((p) => p.lon < 0 && p.lon > -1)).toBe(true);
	});

	it("returns one region per point when all are far apart", () => {
		expect(clusterIntoRegions([london[0], sf[0], toronto[0]], 80)).toHaveLength(3);
	});
});

/**
 * `tileBbox` splits an area into bounded cells for the refresh-bus-routes
 * mirror — one whole-London `route=bus` query is too heavy, so it is
 * fetched cell by cell and unioned. Pins: exact non-overlapping tiling,
 * a single cell for an already-small bbox, and full coverage.
 */

const box: Bbox = { minLat: 51.5, maxLat: 51.8, minLon: -0.3, maxLon: -0.1 };

describe("tileBbox", () => {
	it("returns the bbox itself as a single cell when it is already small", () => {
		const small: Bbox = { minLat: 51.5, maxLat: 51.52, minLon: -0.2, maxLon: -0.18 };
		const cells = tileBbox(small, 0.05);
		expect(cells).toHaveLength(1);
		expect(cells[0]).toEqual(small);
	});

	it("splits a larger bbox into a grid of cells no bigger than maxCellDeg", () => {
		// 0.3° lat / 0.05 = 6 rows; 0.2° lon / 0.05 = 4 cols → 24 cells.
		const cells = tileBbox(box, 0.05);
		expect(cells).toHaveLength(24);
		for (const c of cells) {
			expect(c.maxLat - c.minLat).toBeLessThanOrEqual(0.05 + 1e-9);
			expect(c.maxLon - c.minLon).toBeLessThanOrEqual(0.05 + 1e-9);
		}
	});

	it("tiles exactly with no gaps or overlap (cells cover the whole bbox)", () => {
		const cells = tileBbox(box, 0.05);
		expect(Math.min(...cells.map((c) => c.minLat))).toBeCloseTo(box.minLat, 9);
		expect(Math.max(...cells.map((c) => c.maxLat))).toBeCloseTo(box.maxLat, 9);
		expect(Math.min(...cells.map((c) => c.minLon))).toBeCloseTo(box.minLon, 9);
		expect(Math.max(...cells.map((c) => c.maxLon))).toBeCloseTo(box.maxLon, 9);
		// Total area of cells equals the bbox area (no overlap).
		const cellArea = cells.reduce((s, c) => s + (c.maxLat - c.minLat) * (c.maxLon - c.minLon), 0);
		const bboxArea = (box.maxLat - box.minLat) * (box.maxLon - box.minLon);
		expect(cellArea).toBeCloseTo(bboxArea, 9);
	});
});
