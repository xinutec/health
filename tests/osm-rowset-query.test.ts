/**
 * `queryPointsFromRows` / `queryLinesFromRows` against the SAME fixtures and the
 * SAME literals as the Lean guards in `lean/Verified/Geo/OsmSpatial.lean`.
 *
 * That correspondence is the point. The Lean kernel was pinned against V8
 * reference values (`lean/experiments/osm-spatial-refs.mts`); this pins the TS
 * side to the values Lean now asserts. Two implementations committed to one set
 * of numbers, so a change to either that the other does not follow shows up
 * here instead of at the golden re-bless, where it would be one diff among
 * hundreds.
 *
 * Keep the fixtures byte-identical to the Lean ones. If a case needs to change,
 * change it in both files in the same commit — a fixture that has silently
 * drifted apart tests nothing while continuing to pass.
 */

import { describe, expect, it } from "vitest";
import type { OsmLineRow, OsmPointRow } from "../src/geo/osm-rowset.js";
import { haversineMeters, mPerDegAt, queryLinesFromRows, queryPointsFromRows } from "../src/geo/osm-rowset-query.js";

const QLAT = 51.5492;
const QLON = -0.2215;
/** Metres per degree of latitude on the 6371000 m sphere. */
const MDEG = 111_194.682_298_463_45;

const STATION_SUBTYPES = ["station", "subway_entrance", "halt", "stop", "tram_stop"];
const RAIL_SUBTYPES = ["rail", "subway", "light_rail", "tram", "narrow_gauge"];

function pr(
	osmId: number,
	subtype: string,
	name: string | null,
	lat: number,
	lon: number,
	tags: Record<string, string> = {},
): OsmPointRow {
	return { osmId, featureType: "railway", subtype, name, lat, lon, tags };
}

/** Mirrors `FEATURES` in the Lean SpatialGuards section, in order. */
const FEATURES: OsmPointRow[] = [
	pr(1, "station", "Willesden Green", 51.54925, -0.22095),
	pr(2, "subway_entrance", "Willesden Green", 51.54921, -0.22141),
	pr(3, "subway_entrance", "Willesden Green", 51.54935, -0.22162),
	pr(4, "subway_entrance", "Dollis Hill", 51.54928, -0.22148),
	pr(5, "station", "Dollis Hill", 51.552, -0.239),
	pr(6, "halt", "Far Halt", 51.56, -0.25),
	pr(7, "tram_stop", null, 51.5493, -0.2212),
	pr(8, "station", "Just In", QLAT + 99 / MDEG, QLON),
	pr(9, "station", "Just Out", QLAT + 101 / MDEG, QLON),
	pr(10, "level_crossing", "Not A Station", 51.54926, -0.2213),
	// A SECOND Dollis Hill entrance — see the Lean comment.
	pr(12, "subway_entrance", "Dollis Hill", 51.5494, -0.2218),
	pr(11, "station", "On The Bar", QLAT + 100 / MDEG, QLON),
];

const ids = (q: Array<{ osm_id: number }>) => q.map((f) => f.osm_id);

describe("queryPointsFromRows agrees with the Lean kernel", () => {
	it("computes the same distances on the 6371000 m sphere", () => {
		// Lean: `approxD (haversineAt LEAN_EARTH_R QLAT QLON 51.54925 (-0.22095)) 38.43437398766941`
		expect(haversineMeters(QLAT, QLON, 51.54925, -0.22095)).toBeCloseTo(38.434_373_987_669_41, 9);
		expect(haversineMeters(QLAT, QLON, QLAT + 99 / MDEG, QLON)).toBeCloseTo(99.000_217_548_788_16, 9);
	});

	it("applies a STRICT radius bar and the subtype filter", () => {
		expect(ids(queryPointsFromRows(FEATURES, QLAT, QLON, 100, "railway", STATION_SUBTYPES))).toEqual([
			2, 4, 3, 7, 12, 1, 8,
		]);
		expect(ids(queryPointsFromRows(FEATURES, QLAT, QLON, 400, "railway", STATION_SUBTYPES))).toEqual([
			2, 4, 3, 7, 12, 1, 8, 11, 9,
		]);
	});

	it("excludes a feature sitting exactly on the bar", () => {
		// No latitude gives exactly 100 m — the haversine steps from
		// 99.99999999946 to 100.00000000025 — so strictness is pinned by setting
		// the radius to a feature's OWN distance. Under `<` it is excluded;
		// under `<=` it would be kept.
		const own = haversineMeters(QLAT, QLON, QLAT + 99 / MDEG, QLON);
		expect(ids(queryPointsFromRows(FEATURES, QLAT, QLON, own, "railway", STATION_SUBTYPES))).toEqual([
			2, 4, 3, 7, 12, 1,
		]);
	});

	it("keeps the level crossing when no subtype filter is given", () => {
		expect(ids(queryPointsFromRows(FEATURES, QLAT, QLON, 100, "railway"))).toEqual([2, 4, 10, 3, 7, 12, 1, 8]);
	});

	it("filters by feature type", () => {
		expect(queryPointsFromRows(FEATURES, QLAT, QLON, 400, "landmark")).toEqual([]);
	});

	it("reports points as never enclosing", () => {
		const q = queryPointsFromRows(FEATURES, QLAT, QLON, 400, "railway", STATION_SUBTYPES);
		expect(q.every((f) => f.encloses === false)).toBe(true);
	});
});

// --- The line side ---

const D_LAT = 100 / MDEG;
const D_LON = 100 / (MDEG * Math.cos((QLAT * Math.PI) / 180));

function lr(osmId: number, subtype: string, name: string | null, coords: Array<[number, number]>): OsmLineRow {
	return { osmId, featureType: "railway", subtype, name, coords, tags: {} };
}

/** Mirrors `LINES` in the Lean LineGuards section, in order. */
const LINES: OsmLineRow[] = [
	lr(1, "subway", "Jubilee Line", [
		[QLAT + D_LAT, QLON - 0.01],
		[QLAT + D_LAT, QLON + 0.01],
	]),
	lr(2, "subway", "Metropolitan Line", [
		[QLAT - 0.01, QLON + D_LON],
		[QLAT + 0.01, QLON + D_LON],
	]),
	lr(3, "rail", "Chiltern Main Line", [
		[QLAT - 0.005, QLON - 0.005],
		[QLAT + 0.005, QLON + 0.005],
	]),
	lr(4, "subway", "Jubilee Line", [
		[QLAT + 2 * D_LAT, QLON - 0.01],
		[QLAT + 2 * D_LAT, QLON + 0.01],
	]),
	lr(5, "tram", null, [
		[QLAT, QLON - 0.002],
		[QLAT, QLON + 0.002],
	]),
	lr(6, "motorway", "North Circular", [
		[QLAT, QLON - 0.001],
		[QLAT, QLON + 0.001],
	]),
	lr(7, "rail", "Far Line", [
		[51.6, -0.3],
		[51.61, -0.3],
	]),
	lr(8, "rail", "Degenerate", [[QLAT, QLON]]),
	lr(9, "rail", "Stub West", [
		[QLAT + D_LAT, QLON - 0.01],
		[QLAT + D_LAT, QLON - 0.005],
	]),
];

describe("queryLinesFromRows agrees with the Lean kernel", () => {
	it("uses the same single degree scale", () => {
		expect(mPerDegAt(QLAT)).toBeCloseTo(69_024.504_182_826_1, 9);
	});

	it("reproduces the planar-metric anisotropy exactly", () => {
		// Two ways at the SAME true ground distance of 100 m, one due north and
		// one due east, score 62.1 m and 99.8 m. The search reaches ~1.6x
		// further north. This is the approximation the corpus was blessed under.
		const r150 = queryLinesFromRows(LINES, QLAT, QLON, 150, "railway", RAIL_SUBTYPES);
		const north = r150.find((f) => f.osm_id === 1);
		const east = r150.find((f) => f.osm_id === 2);
		expect(north?.distance_m).toBeCloseTo(62.075_364_357_577_93, 9);
		expect(east?.distance_m).toBeCloseTo(99.824_917_617_965_7, 9);
	});

	it("lets the radius filter inherit that distortion", () => {
		expect(ids(queryLinesFromRows(LINES, QLAT, QLON, 80, "railway", RAIL_SUBTYPES))).toEqual([3, 5, 8, 1]);
		expect(ids(queryLinesFromRows(LINES, QLAT, QLON, 150, "railway", RAIL_SUBTYPES))).toEqual([3, 5, 8, 1, 2, 4]);
	});

	it("applies a STRICT bar on the line side too", () => {
		expect(ids(queryLinesFromRows(LINES, QLAT, QLON, 62.075_364_357_577_93, "railway", RAIL_SUBTYPES))).toEqual([
			3, 5, 8,
		]);
	});

	it("reports enclosure by the way's bounding box, inclusively", () => {
		const r150 = queryLinesFromRows(LINES, QLAT, QLON, 150, "railway", RAIL_SUBTYPES);
		// A way through the point measures zero and encloses it; so does the
		// single-vertex way, whose bbox has zero extent.
		expect(r150.find((f) => f.osm_id === 3)?.encloses).toBe(true);
		expect(r150.find((f) => f.osm_id === 8)?.encloses).toBe(true);
		expect(r150.find((f) => f.osm_id === 8)?.distance_m).toBeCloseTo(0, 9);
		expect(r150.find((f) => f.osm_id === 1)?.encloses).toBe(false);
	});

	it("clamps to the segment: a stub is measured to its endpoint", () => {
		// "Stub West" lies at the same 100 m northward offset as way 1 but ends
		// well to the west. Unclamped, the infinite line through it would measure
		// just that offset and pull it into both radii; clamped, its nearest
		// approach is its eastern endpoint and it appears in neither.
		expect(ids(queryLinesFromRows(LINES, QLAT, QLON, 150, "railway", RAIL_SUBTYPES))).not.toContain(9);
	});
});
