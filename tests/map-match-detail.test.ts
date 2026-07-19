/**
 * `spliceRouteDetail` (#369) — carry the assembled route's curve geometry back
 * into the cleaned matched line's chords. Only CURVES are re-inserted (extra
 * length well below deviation); anything the tuned pipeline deliberately
 * excised — spur out-and-backs, despiked apexes — fails the curve signature
 * (extra ≈ 2×deviation) and stays a chord.
 */
import { describe, expect, it } from "vitest";
import { spliceRouteDetail } from "../src/geo/map-match-core.js";

const LAT0 = 51.5;
const LON0 = -0.1;
const LON_M = 111_320 * Math.cos((LAT0 * Math.PI) / 180);

function pt(north: number, east: number, ts: number): { lat: number; lon: number; ts: number } {
	return { lat: LAT0 + north / 111_320, lon: LON0 + east / LON_M, ts };
}

describe("spliceRouteDetail", () => {
	it("re-inserts a curve's way geometry into a chord that cut it", () => {
		// Route bows 4 m north over 200 m; the cleaned line chorded it.
		const route = [
			pt(0, 0, 0),
			pt(1, 25, 10),
			pt(2, 50, 20),
			pt(3, 75, 30),
			pt(4, 100, 40),
			pt(3, 125, 50),
			pt(2, 150, 60),
			pt(1, 175, 70),
			pt(0, 200, 80),
		];
		const coarse = [route[0], route[8]];
		const out = spliceRouteDetail(coarse, route, 5);
		expect(out.length).toBeGreaterThan(2);
		expect(out.some((p) => Math.abs(p.lat - (LAT0 + 4 / 111_320)) < 1e-9)).toBe(true);
		// Timestamps stay monotone.
		for (let i = 1; i < out.length; i++) expect(out[i].ts).toBeGreaterThanOrEqual(out[i - 1].ts);
	});

	it("leaves a chord over an excised out-and-back alone (extra ≈ 2×dev)", () => {
		// Route goes 20 m out and back mid-chord — a spur the pipeline excised.
		const route = [pt(0, 0, 0), pt(0, 50, 10), pt(20, 52, 20), pt(0, 54, 30), pt(0, 120, 40)];
		const coarse = [route[0], route[4]];
		const out = spliceRouteDetail(coarse, route, 5);
		expect(out).toHaveLength(2);
	});

	it("keeps a straight chord untouched", () => {
		const route = [pt(0, 0, 0), pt(0.3, 50, 10), pt(0, 100, 20)];
		const coarse = [route[0], route[2]];
		expect(spliceRouteDetail(coarse, route, 5)).toHaveLength(2);
	});

	it("splices per-chord: a curve carries while a neighbouring spur chord stays flat", () => {
		const route = [
			// Chord 1 (0→100): gentle 3 m bulge — carried.
			pt(0, 0, 0),
			pt(3, 50, 10),
			pt(0, 100, 20),
			// Chord 2 (100→200): 15 m out-and-back — stays a chord.
			pt(15, 148, 30),
			pt(0, 152, 40),
			pt(0, 200, 50),
		];
		const coarse = [route[0], route[2], route[5]];
		const out = spliceRouteDetail(coarse, route, 5);
		expect(out.some((p) => Math.abs(p.lat - (LAT0 + 3 / 111_320)) < 1e-9)).toBe(true);
		expect(out.some((p) => Math.abs(p.lat - (LAT0 + 15 / 111_320)) < 1e-9)).toBe(false);
	});
});
