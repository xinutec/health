/**
 * The buffered-track row-set: coverage geometry and the assertion that keeps an
 * under-sized buffer loud. Step 2 of `docs/proposals/2026-07-osm-into-lean.md`.
 *
 * The property under test is the one the whole design rests on: a query is
 * answerable from the pushed rows exactly when its own extent, at its own
 * coordinate, lies inside a recorded coverage box. Everything else — cell size,
 * how many boxes, how they were merged — is free to change.
 */

import { describe, expect, it } from "vitest";
import {
	coverageBoxesForTrack,
	coverageForTrack,
	KERNEL_BUFFER_M,
	MAX_KERNEL_QUERY_RADIUS_M,
	methodIsCovered,
	queryIsCovered,
} from "../src/geo/osm-rowset.js";

/** The widest buffer in the table — `railway`, the only feature type asked at
 *  the 800 m rail-journey radius. */
const RAIL_BUFFER_M = KERNEL_BUFFER_M.railway;

/** Willesden Green-ish. */
const LAT = 51.5492;
const LON = -0.2215;

/** Metres → degrees at the test latitude, for placing points a known distance
 *  apart. Deliberately NOT the module's own conversion: a test that reuses the
 *  implementation's arithmetic cannot catch a sign or scale error in it. */
const M_PER_DEG_LAT = 111_194.682_298_463_45;
const mPerDegLon = (lat: number) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
const northOf = (lat: number, m: number) => lat + m / M_PER_DEG_LAT;
const eastOf = (lat: number, lon: number, m: number) => lon + m / mPerDegLon(lat);

describe("coverageBoxesForTrack", () => {
	it("returns no boxes for an empty track", () => {
		expect(coverageBoxesForTrack([], RAIL_BUFFER_M)).toEqual([]);
	});

	it("collapses fixes sharing a cell into one box", () => {
		const track = [
			{ lat: LAT, lon: LON },
			{ lat: northOf(LAT, 10), lon: eastOf(LAT, LON, 10) },
			{ lat: northOf(LAT, 20), lon: eastOf(LAT, LON, 20) },
		];
		expect(coverageBoxesForTrack(track, RAIL_BUFFER_M)).toHaveLength(1);
	});

	it("keeps distant fixes in separate boxes", () => {
		const track = [
			{ lat: LAT, lon: LON },
			// 50 km north — a train trip, not a neighbourhood.
			{ lat: northOf(LAT, 50_000), lon: LON },
		];
		expect(coverageBoxesForTrack(track, RAIL_BUFFER_M).length).toBeGreaterThan(1);
	});
});

describe("queryIsCovered", () => {
	const track = [{ lat: LAT, lon: LON }];
	const boxes = coverageBoxesForTrack(track, RAIL_BUFFER_M);

	it("covers a query at the fix itself, at the widest kernel radius", () => {
		expect(queryIsCovered(LAT, LON, MAX_KERNEL_QUERY_RADIUS_M, boxes)).toBe(true);
	});

	it("covers a query offset from the fix when offset + radius fits the buffer", () => {
		// The 2026-06-28 shape: a `linesAtPoint` at a resolved station coordinate
		// 428 m off the track, asking with the 800 m rail-journey radius.
		const offset = 428;
		expect(offset + 800).toBeLessThan(RAIL_BUFFER_M);
		expect(queryIsCovered(northOf(LAT, offset), LON, 800, boxes)).toBe(true);
		expect(queryIsCovered(LAT, eastOf(LAT, LON, offset), 800, boxes)).toBe(true);
	});

	it("refuses a query whose reach leaves the buffer", () => {
		// Same coordinate, but asking past the edge: offset + radius > buffer.
		const offset = RAIL_BUFFER_M - 100;
		expect(queryIsCovered(northOf(LAT, offset), LON, 400, boxes)).toBe(false);
	});

	it("refuses on the radius alone, with no offset at all", () => {
		expect(queryIsCovered(LAT, LON, RAIL_BUFFER_M + 1000, boxes)).toBe(false);
	});

	it("refuses everything when there are no boxes", () => {
		expect(queryIsCovered(LAT, LON, 1, [])).toBe(false);
	});

	it("does not let two abutting boxes cover a query neither contains", () => {
		// Coverage is per-box containment, not union containment: a query
		// straddling a seam is NOT covered even though every row it needs was
		// fetched. That is deliberate — the check is a cheap sufficient
		// condition, and a false "uncovered" costs a re-capture, while a false
		// "covered" would silently serve short results.
		const far = coverageBoxesForTrack(
			[
				{ lat: LAT, lon: LON },
				{ lat: northOf(LAT, 4 * RAIL_BUFFER_M), lon: LON },
			],
			RAIL_BUFFER_M,
		);
		expect(far.length).toBeGreaterThan(1);
		const seam = northOf(LAT, 2 * RAIL_BUFFER_M);
		expect(queryIsCovered(seam, LON, 400, far)).toBe(false);
	});

	it("is monotone in radius — widening a covered query can only uncover it", () => {
		const p = { lat: northOf(LAT, 200), lon: LON };
		let sawCovered = false;
		let sawUncovered = false;
		for (let r = 50; r <= 3000; r += 50) {
			const covered = queryIsCovered(p.lat, p.lon, r, boxes);
			if (covered) {
				expect(sawUncovered).toBe(false);
				sawCovered = true;
			} else {
				sawUncovered = true;
			}
		}
		expect(sawCovered).toBe(true);
		expect(sawUncovered).toBe(true);
	});
});

describe("methodIsCovered", () => {
	const coverage = coverageForTrack([{ lat: LAT, lon: LON }]);

	it("rejects a method it does not know", () => {
		expect(() => methodIsCovered("nearbyUnicorns", LAT, LON, 50, coverage)).toThrow(/unknown method/);
	});

	it("covers the rail lookups out to their own 800 m radius", () => {
		expect(methodIsCovered("linesAtPoint", LAT, LON, 800, coverage)).toBe(true);
		expect(methodIsCovered("nearbyStations", LAT, LON, 400, coverage)).toBe(true);
	});

	it("does NOT cover a rail-width query on the narrow feature types", () => {
		// `nearbyWays` reads highway/waterway/aeroway alongside railway, and those
		// are fetched at 500 m because nothing ever asks them for more than 50.
		// Asking at 800 must fail even though the railway half would be fine —
		// otherwise a widened call site would silently return roads short.
		expect(methodIsCovered("nearbyWays", LAT, LON, 800, coverage)).toBe(false);
		expect(methodIsCovered("nearbyWays", LAT, LON, 50, coverage)).toBe(true);
	});

	it("fails when ANY of a method's feature types is short", () => {
		// railway boxes present, highway boxes missing entirely.
		const partial = { ...coverage, highway: [] };
		expect(methodIsCovered("nearbyWays", LAT, LON, 50, partial)).toBe(false);
		// The railway-only method is unaffected by the same gap.
		expect(methodIsCovered("linesAtPoint", LAT, LON, 800, partial)).toBe(true);
	});

	it("gives railway a wider buffer than the dense tables", () => {
		expect(KERNEL_BUFFER_M.railway).toBeGreaterThan(KERNEL_BUFFER_M.highway);
	});
});

describe("a coverage box is never smaller than the circle it stands for", () => {
	/** Great-circle destination from a point, on the sphere the module's
	 *  conversions approximate. */
	const destination = (lat: number, lon: number, m: number, bearingDeg: number) => {
		const R = 6_371_000;
		const d = m / R;
		const br = (bearingDeg * Math.PI) / 180;
		const p1 = (lat * Math.PI) / 180;
		const l1 = (lon * Math.PI) / 180;
		const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(br));
		const l2 = l1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
		return { lat: (p2 * 180) / Math.PI, lon: (l2 * 180) / Math.PI };
	};

	// The invariant `degreeExtent` exists to hold: every point on the metric
	// circle lands inside the degree box. Exercised at 5 km, where the poleward
	// evaluation actually decides the answer — at the 1500 m operating buffer
	// the 111000-vs-111194.68 slack swallows the difference and a centre or
	// equatorward evaluation would pass too (measured: 0.1339% variation
	// against 0.1754% slack). Testing only the operating size would leave the
	// rule looking arbitrary and free to rot.
	for (const lat of [0, 30, 51.5, 60, 70, 80]) {
		it(`holds at latitude ${lat}`, () => {
			const m = 5000;
			// A one-fix track gives a box whose expansion is exactly the buffer.
			const boxes = coverageBoxesForTrack([{ lat, lon: 0 }], m);
			expect(boxes).toHaveLength(1);
			for (let bearing = 0; bearing < 360; bearing += 1) {
				const p = destination(lat, 0, m, bearing);
				const inside = boxes.some(
					(b) => p.lat >= b.minLat && p.lat <= b.maxLat && p.lon >= b.minLon && p.lon <= b.maxLon,
				);
				expect(inside, `bearing ${bearing} at lat ${lat} escaped the box`).toBe(true);
			}
		});
	}
});

describe("the buffer constant", () => {
	it("leaves room for the widest kernel query plus a real offset", () => {
		// The two halves of the buffer are different KINDS of number. The radius
		// half is provable — every kernel call site passes a module constant, and
		// 800 m (RAIL_JOURNEY_LINES_RADIUS_M) is the largest. The offset half is
		// empirical: 428 m is the worst measured across 32 golden days
		// (`lean/experiments/osm-buffer-sizing.mts`). This asserts the headroom
		// over the measured worst case is not silently spent by a future edit.
		const worstMeasuredOffset = 428;
		expect(RAIL_BUFFER_M - MAX_KERNEL_QUERY_RADIUS_M).toBeGreaterThan(worstMeasuredOffset * 1.5);
	});
});
