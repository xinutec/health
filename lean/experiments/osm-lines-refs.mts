/**
 * V8 reference values for the LINE side of the OSM spatial kernel —
 * `queryLines` in `src/geo/osm-local.ts` and `linesAtPoint` in `src/geo/osm.ts`
 * (`docs/proposals/2026-07-osm-into-lean.md`).
 *
 * The metric is NOT the great-circle distance the point side uses. MariaDB's
 * `ST_Distance` is PLANAR, in degree space, and the result is scaled back to
 * metres by a single `mPerDeg = min(111000, 111000·cos lat)`. At 51.5°N a
 * degree of longitude is about 62% of a degree of latitude, and this metric
 * ignores that difference entirely: a way lying due east of the query point is
 * measured as though those degrees were as long as northward ones, so its
 * distance comes out ~1.6× too large. The radius filter inherits the same
 * distortion — `< dDeg` where `dDeg = radiusM / mPerDeg`.
 *
 * That is an approximation the algorithm has always run on, and the corpus was
 * blessed under it, so it is reproduced exactly rather than corrected. Fixing
 * it would be a behaviour change, not a port.
 *
 * Semantics confirmed against the live server rather than assumed:
 *  - `ST_Distance(line, point)` is the planar minimum over segments, clamped at
 *    the endpoints (a point beyond the end measures to the endpoint).
 *  - `MBRContains` is boundary-INCLUSIVE: a point on the bbox edge, on a
 *    corner, or on a degenerate zero-height bbox all return 1.
 *
 * Run: nix develop /Users/pippijn/Code/health --command npx tsx lean/experiments/osm-lines-refs.mts
 */

const show = (label: string, v: unknown): void => {
	// eslint-disable-next-line no-console
	console.log(`${label}: ${JSON.stringify(v)}`);
};

const METERS_PER_DEG_LAT = 111_000;
const metersPerDegLon = (lat: number): number => 111_000 * Math.cos((lat * Math.PI) / 180);
const mPerDegAt = (lat: number): number => Math.min(METERS_PER_DEG_LAT, metersPerDegLon(lat));

/** Planar point-to-segment distance in degree space (x = lon, y = lat). */
const segDist = (px: number, py: number, ax: number, ay: number, bx: number, by: number): number => {
	const dx = bx - ax;
	const dy = by - ay;
	const len2 = dx * dx + dy * dy;
	const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
	const qx = ax + t * dx;
	const qy = ay + t * dy;
	return Math.hypot(px - qx, py - qy);
};

/** `ST_Distance(linestring, point)` — the minimum over the way's segments. */
const lineDistDeg = (coords: Array<[number, number]>, lat: number, lon: number): number => {
	if (coords.length === 0) return Number.POSITIVE_INFINITY;
	if (coords.length === 1) return Math.hypot(lon - coords[0][1], lat - coords[0][0]);
	let best = Number.POSITIVE_INFINITY;
	for (let i = 0; i + 1 < coords.length; i++) {
		const d = segDist(lon, lat, coords[i][1], coords[i][0], coords[i + 1][1], coords[i + 1][0]);
		if (d < best) best = d;
	}
	return best;
};

/** `MBRContains(linestring, point)` — boundary-inclusive. */
const mbrContains = (coords: Array<[number, number]>, lat: number, lon: number): boolean => {
	if (coords.length === 0) return false;
	const lats = coords.map((c) => c[0]);
	const lons = coords.map((c) => c[1]);
	return (
		lat >= Math.min(...lats) && lat <= Math.max(...lats) && lon >= Math.min(...lons) && lon <= Math.max(...lons)
	);
};

const QLAT = 51.5492;
const QLON = -0.2215;
const MPD = mPerDegAt(QLAT);
show("mPerDeg", MPD);

type Line = { osm_id: number; subtype: string; name: string | null; coords: Array<[number, number]> };

/** A north–south way and an east–west way at the SAME true ground distance from
 *  the query point — the planar-degree metric scores them very differently. */
const D_LAT = 100 / 111194.68229846345;
const D_LON = 100 / (111194.68229846345 * Math.cos((QLAT * Math.PI) / 180));

const LINES: Line[] = [
	// Runs east–west, offset due NORTH by 100 true metres.
	{ osm_id: 1, subtype: "subway", name: "Jubilee Line", coords: [[QLAT + D_LAT, QLON - 0.01], [QLAT + D_LAT, QLON + 0.01]] },
	// Runs north–south, offset due EAST by 100 true metres.
	{ osm_id: 2, subtype: "subway", name: "Metropolitan Line", coords: [[QLAT - 0.01, QLON + D_LON], [QLAT + 0.01, QLON + D_LON]] },
	// Passes directly through the query point.
	{ osm_id: 3, subtype: "rail", name: "Chiltern Main Line", coords: [[QLAT - 0.005, QLON - 0.005], [QLAT + 0.005, QLON + 0.005]] },
	// Same name as 1 — a second tagged way of the same line.
	{ osm_id: 4, subtype: "subway", name: "Jubilee Line", coords: [[QLAT + 2 * D_LAT, QLON - 0.01], [QLAT + 2 * D_LAT, QLON + 0.01]] },
	// Rail-class but unnamed: dropped from the name set.
	{ osm_id: 5, subtype: "tram", name: null, coords: [[QLAT, QLON - 0.002], [QLAT, QLON + 0.002]] },
	// Not a rail subtype.
	{ osm_id: 6, subtype: "motorway", name: "North Circular", coords: [[QLAT, QLON - 0.001], [QLAT, QLON + 0.001]] },
	// Far away.
	{ osm_id: 7, subtype: "rail", name: "Far Line", coords: [[51.60, -0.30], [51.61, -0.30]] },
	// A SHORT way lying entirely WEST of the point, at the same 100 m northward
	// offset. Its nearest approach is its eastern ENDPOINT, so the segment clamp
	// decides: unclamped, the infinite line through it runs due east-west at that
	// latitude and would measure just the 100 m offset.
	{ osm_id: 9, subtype: "rail", name: "Stub West", coords: [[QLAT + D_LAT, QLON - 0.01], [QLAT + D_LAT, QLON - 0.005]] },
	// A single-vertex degenerate way whose bbox has zero extent.
	{ osm_id: 8, subtype: "rail", name: "Degenerate", coords: [[QLAT, QLON]] },
];

const RAIL_SUBTYPES = ["rail", "subway", "light_rail", "tram", "narrow_gauge"];

/** `buildLinesQuery` + `queryLines`. */
const queryLines = (rows: Line[], radiusM: number, subtypes: string[] | undefined) => {
	const dDeg = radiusM / MPD;
	let out = rows
		.map((r) => ({
			...r,
			distance_deg: lineDistDeg(r.coords, QLAT, QLON),
			encloses: mbrContains(r.coords, QLAT, QLON),
		}))
		.filter((r) => r.distance_deg < dDeg);
	if (subtypes && subtypes.length > 0) out = out.filter((r) => subtypes.includes(r.subtype));
	return out
		.sort((a, b) => a.distance_deg - b.distance_deg)
		.slice(0, 50)
		.map((r) => ({ ...r, distance_m: r.distance_deg * MPD }));
};

for (const radius of [80, 150]) {
	const q = queryLines(LINES, radius, RAIL_SUBTYPES);
	show(`lines.r${radius}`, q.map((r) => [r.osm_id, r.distance_m, r.encloses]));
	// `linesAtPoint`: names into a Set, first occurrence wins, unnamed dropped.
	const names = new Set<string>();
	for (const f of q) if (f.name) names.add(f.name);
	show(`linesAtPoint.r${radius}`, [...names]);
}

// Radius set to the northward way's OWN distance: `<` excludes it, `<=` keeps it.
show("lines.onExactBar", queryLines(LINES, 62.07536435757793, RAIL_SUBTYPES).map((r) => r.osm_id));

// The anisotropy, stated as a number: two ways at the SAME true ground distance
// score differently because the metric treats a degree of longitude as though
// it were as long as a degree of latitude.
const northWay = queryLines(LINES, 100000, ["subway"]).find((r) => r.osm_id === 1);
const eastWay = queryLines(LINES, 100000, ["subway"]).find((r) => r.osm_id === 2);
show("anisotropy.north100m", northWay?.distance_m);
show("anisotropy.east100m", eastWay?.distance_m);
show("anisotropy.ratio", (eastWay?.distance_m ?? 0) / (northWay?.distance_m ?? 1));
