/**
 * `mbrBoxWkt` — the MBR pre-filter box for the OSM spatial queries.
 *
 * This replaced `ST_Buffer(point, dDeg)` after MariaDB 12.3 started returning
 * SRID 0 from `ST_Buffer` (even for a 4326 input) AND rejecting mixed-SRID
 * geometry comparisons, which broke every OSM spatial query at once. The
 * replacement is only sound if the box is exactly the buffer's envelope, so
 * pin the corners and — the easiest thing to get silently wrong — the WKT
 * axis order.
 */

import { describe, expect, it } from "vitest";
import { mbrBoxWkt } from "../src/geo/osm-local.js";

const corners = (wkt: string): Array<[number, number]> => {
	const inner = wkt.replace(/^POLYGON\(\(/, "").replace(/\)\)$/, "");
	return inner.split(",").map((p) => {
		const [x, y] = p.trim().split(/\s+/).map(Number);
		return [x, y];
	});
};

describe("mbrBoxWkt", () => {
	it("emits WKT in x y order — longitude FIRST, matching the POINT(lon lat) the queries already build", () => {
		// Reversing these silently searches a box on the other side of the
		// planet, and every query just returns nothing.
		const c = corners(mbrBoxWkt(51.5, -0.2, 0.01));
		for (const [x, y] of c) {
			expect(x).toBeCloseTo(-0.2, 1); // longitude
			expect(y).toBeCloseTo(51.5, 1); // latitude
		}
	});

	it("spans exactly lon±d by lat±d", () => {
		const c = corners(mbrBoxWkt(51.5, -0.2, 0.01));
		const xs = c.map(([x]) => x);
		const ys = c.map(([, y]) => y);
		expect(Math.min(...xs)).toBe(-0.2 - 0.01);
		expect(Math.max(...xs)).toBe(-0.2 + 0.01);
		expect(Math.min(...ys)).toBe(51.5 - 0.01);
		expect(Math.max(...ys)).toBe(51.5 + 0.01);
	});

	it("uses the same JS double arithmetic ST_Buffer used, so the box is bit-identical to its envelope", () => {
		// -0.2 - 0.01 is NOT -0.21 in binary floating point. Formatting the
		// bound as a rounded decimal would shrink the box, so the WKT has to
		// carry the double's own round-trip representation.
		expect(mbrBoxWkt(51.5, -0.2, 0.01)).toContain(String(-0.2 - 0.01));
	});

	it("closes the ring — first vertex repeated last, or MariaDB rejects the polygon", () => {
		const c = corners(mbrBoxWkt(51.5, -0.2, 0.01));
		expect(c).toHaveLength(5);
		expect(c[0]).toEqual(c[4]);
	});

	it("winds the ring as a simple rectangle, visiting each corner once", () => {
		const c = corners(mbrBoxWkt(51.5, -0.2, 0.01)).slice(0, 4);
		expect(new Set(c.map((p) => p.join(","))).size).toBe(4);
	});

	it("handles a southern/western point without sign confusion", () => {
		const c = corners(mbrBoxWkt(-33.9, 151.2, 0.5));
		const xs = c.map(([x]) => x);
		const ys = c.map(([, y]) => y);
		expect(Math.min(...xs)).toBe(150.7);
		expect(Math.max(...ys)).toBe(-33.4);
	});
});
