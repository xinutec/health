import { describe, expect, it } from "vitest";
import { type RailGeometry, snapTrainSegmentOnLine } from "../src/geo/rail-snap.js";

/**
 * `snapTrainSegmentOnLine` — snap a confident tube leg onto its KNOWN line
 * between its two named stations, WITHOUT any historic fix cloud (so a thin /
 * one-off underground ride still draws on-track). The line name is the
 * disambiguator against parallel routes.
 */

// A synthetic two-line network sharing endpoints A (Carfax) and C (Ashvale
// Park): the Metropolitan line runs A→B→C, a parallel Jubilee line A→D→C.
const A: [number, number] = [51.5226, -0.1571]; // Carfax
const B: [number, number] = [51.55, -0.2]; // Met intermediate
const C: [number, number] = [51.563, -0.279]; // Ashvale
const D: [number, number] = [51.53, -0.2]; // Jubilee intermediate (parallel)

const geo: RailGeometry = {
	lines: [
		{ osmId: 1, name: "Metropolitan Line", subtype: "subway", coords: [A, B, C] },
		{ osmId: 2, name: "Jubilee Line", subtype: "subway", coords: [A, D, C] },
	],
	wayRoutes: [],
	stations: [
		{ name: "Carfax", subtype: "station", lat: A[0], lon: A[1] },
		{ name: "Ashvale", subtype: "station", lat: C[0], lon: C[1] },
	],
};

describe("snapTrainSegmentOnLine", () => {
	it("routes a known-line leg over ONLY that line — no fix cloud, disambiguates parallel routes", () => {
		const r = snapTrainSegmentOnLine(
			{ startTs: 1000, endTs: 1600, wayName: "Carfax → Ashvale · Metropolitan Line" },
			geo,
		);
		expect(r).not.toBeNull();
		const lats = r?.path.map((p) => p.lat) ?? [];
		expect(lats).toContain(B[0]); // Met intermediate present
		expect(lats).not.toContain(D[0]); // Jubilee intermediate absent
		expect(r?.path[0].ts).toBe(1000);
		expect(r?.path[(r?.path.length ?? 1) - 1].ts).toBe(1600);
	});

	it("returns null when the label carries no line (can't line-restrict)", () => {
		expect(snapTrainSegmentOnLine({ startTs: 0, endTs: 1, wayName: "Carfax → Ashvale" }, geo)).toBeNull();
	});

	it("returns null when a station name is unknown to the geometry", () => {
		expect(
			snapTrainSegmentOnLine({ startTs: 0, endTs: 1, wayName: "Nowhere → Ashvale · Metropolitan Line" }, geo),
		).toBeNull();
	});

	it("matches a shared-track way tagged with several lines (includes the target line)", () => {
		const shared: RailGeometry = {
			lines: [{ osmId: 3, name: "Metropolitan Line Westbound", subtype: "subway", coords: [A, B, C] }],
			wayRoutes: [],
			stations: geo.stations,
		};
		const r = snapTrainSegmentOnLine(
			{ startTs: 0, endTs: 60, wayName: "Carfax → Ashvale · Metropolitan Line" },
			shared,
		);
		expect(r).not.toBeNull(); // directional suffix still resolves to the Met line
	});
});
