/**
 * The buffered-track OSM row-set — raw rows pushed once per day, instead of
 * per-query answers pulled from MariaDB.
 *
 * Step 2 of `docs/proposals/2026-07-osm-into-lean.md`. The point is stated
 * there and worth restating here: `ST_Distance_Sphere(geom, point) < radius
 * ORDER BY distance` is a DECISION — which feature is nearest — taken inside
 * the database, where nothing about it can be stated or proved. Shipping the
 * rows instead moves that decision to `Verified.Geo.OsmSpatial`, where the
 * haversine is a definition rather than an oracle.
 *
 * # What is in scope, and why the rest is not
 *
 * Only the lookups built on the `queryPoints` / `queryLines` kernel:
 * `nearbyStations`, `nearbyWays`, `nearbyLandmarks`, `linesAtPoint`,
 * `nearbyTransitStops`.
 *
 * The three bulk readers — `queryDrivableRoads`, `queryWalkableRoads`,
 * `queryBuildingsNear` — are deliberately NOT pushed, and this is not a
 * deferral. Their SQL is `feature_type = … AND subtype IN (…) AND
 * MBRIntersects(geom, box) LIMIT 20000`: no distance, no ordering, no
 * selection. The answer is "every row in the box", and the box is a parameter
 * the caller chose, not a judgement the database made. There is no oracle to
 * remove, so porting them buys no theorem — the determinism they need is
 * already supplied by `FixtureOsmAdapter`. Pushing them would also cost:
 * their radii are leg-scaled (120–2240 m measured) rather than constants, so
 * no buffer bounds them, and `building` in particular is the density bomb that
 * already forced its own 500 m coverage box (cf. #255).
 *
 * # Why the buffer is the size it is
 *
 * A query is answerable from the row-set when every row within its own extent
 * of its own coordinate is present. So the buffer must cover
 *
 *     (distance from the query coordinate to the nearest fix) + (query radius)
 *
 * and NOT merely the first term. The two halves are different kinds of number:
 *
 *   - The radius half is PROVABLE. Every kernel call site passes a module
 *     constant — `RAIL_RUN_STATION_RADIUS_M` (400), `RAIL_JOURNEY_LINES_RADIUS_M`
 *     (800), `UNDERGROUND_STATION_RADIUS_M` (350), `UNDERGROUND_LINES_RADIUS_M`
 *     (300), `ENDPOINT_LINES_RADIUS_M` (300), `STATION_AT_ALIGHT_RADIUS_M`, and
 *     the `nearbyWays` / `nearbyLandmarks` / `nearbyTransitStops` defaults. None
 *     is computed from the data, so 800 m is a ceiling, not a sample maximum.
 *   - The offset half is EMPIRICAL: 428 m is the worst across the 32 golden
 *     days (`lean/experiments/osm-buffer-sizing.mts`). Queries land off-track
 *     because some passes ask at DERIVED points — matched-path vertices and
 *     resolved station coordinates — not at fixes.
 *
 * An empirical maximum is not a guarantee, which is why the row-set carries the
 * boxes it was built from and {@link queryIsCovered} is checked at every read.
 * An under-sized buffer then fails LOUDLY, the way `FixtureOsmAdapter` throws
 * on an uncaptured key, instead of quietly returning short results — the same
 * discipline the `isCovered` check already applies to the Overpass mirror.
 */

import { sql } from "kysely";
import { db } from "../db/pool.js";
import { lineNamesMatching } from "./line-stations.js";
import { METERS_PER_DEG_LAT, metersPerDegLon, parseLineStringWkt } from "./osm-local.js";
// The one transformation the pipeline applies to a line label before asking
// about it (`lineCannotServe`). Imported, not copied: a second implementation
// of the split would be free to drift from the asks it has to anticipate, and
// this module's whole job is to fetch what those asks will need.
import { expandTubeLineNames } from "./passes/rail-runs.js";

/** The widest radius any kernel call site passes — `RAIL_JOURNEY_LINES_RADIUS_M`,
 *  asked of `railway`. A ceiling read off the call sites, not a sample maximum. */
export const MAX_KERNEL_QUERY_RADIUS_M = 800;

/**
 * How far beyond the track to fetch, PER FEATURE TYPE. `building` is absent by
 * design: only `queryBuildingsNear` reads it, and that is out of scope.
 *
 * A single global buffer would have to be the widest of these, and every
 * feature type would pay for it. That is the wrong trade by a wide margin,
 * because the widest requirement and the densest table are not the same one:
 * only `railway` is ever asked at 800 m (`linesAtPoint`), while `highway` —
 * far and away the biggest table — is asked exclusively by `nearbyWays` at
 * 50 m. Measured: a uniform 1500 m buffer pulls ~133k rows/day; per-type
 * sizing pulls a fraction of that, and the rows dropped are ones no query
 * could ever have reached.
 *
 * Each entry is a radius CEILING plus offset headroom (worst measured offsets,
 * `lean/experiments/osm-buffer-sizing.mts`, re-run 2026-08-15: railway 744.7 m,
 * highway/waterway/aeroway 241.6 m, landmark 182.2 m, transit_stop 39.1 m).
 *
 * ⚠ The railway figure is the one that moves, and it had already outgrown its
 * buffer: at 744.7 m offset the worst standing query needs 1544.7 m against a
 * configured 1500, and only survives because neighbouring coverage boxes cover
 * the remainder. It is not a margin to trim — a rail question is asked about a
 * STATION, and a station sits as far off the fix track as the walk to reach it,
 * which on a blackout leg is however far the ride went unobserved. 2026-04-29's
 * alight asks 1220 m off the nearest fix, so 800 + 1220 = 2020 is the real
 * requirement there and the old 1500 refused the query outright.
 */
export const KERNEL_BUFFER_M: Readonly<Record<string, number>> = {
	// 800 (linesAtPoint) + 1400.
	railway: 2200,
	// 50 (nearbyWays) + 450.
	highway: 500,
	waterway: 500,
	aeroway: 500,
	// 100 (nearbyLandmarks) + 400.
	landmark: 500,
	// 50 (nearbyTransitStops) + 450.
	transit_stop: 500,
};

/** The feature types the kernel lookups read. */
export const KERNEL_FEATURE_TYPES = Object.keys(KERNEL_BUFFER_M);

/** Which feature types each adapter method reads — the map that lets a query
 *  be checked against the right coverage set. Mirrors the `queryPoints` /
 *  `queryLines` call sites in `osm.ts`. */
export const METHOD_FEATURE_TYPES: Readonly<Record<string, readonly string[]>> = {
	nearbyWays: ["highway", "railway", "waterway", "aeroway"],
	nearbyStations: ["railway"],
	nearbyLandmarks: ["landmark"],
	linesAtPoint: ["railway"],
	nearbyTransitStops: ["transit_stop"],
};

/**
 * Grid cell the track is snapped to before buffering. Coverage does not depend
 * on it at all (see {@link coverageBoxesForTrack}), so this is purely a cost
 * knob — and a surprisingly effective one, because each box is `cell + 2×buffer`
 * wide and a coarse cell over-fetches around the parts of itself the track
 * never entered.
 *
 * Measured on 2026-07-10, total kernel rows / box count:
 *
 *     cell 1000 →  75,751 rows,  50 boxes
 *     cell  500 →  55,221 rows,  82 boxes
 *     cell  250 →  46,024 rows, 152 boxes
 *     cell  100 →  41,781 rows, 298 boxes
 *
 * 250 is where the curve flattens: it takes 61% of the rows for 3× the queries,
 * while going on to 100 buys a further 9% for another 2× the queries. The
 * queries are cheap (one MBR index scan each, offline) and the rows are not.
 */
const TRACK_CELL_M = 250;

/** An axis-aligned lat/lon box, in degrees. */
export interface CoverageBox {
	minLat: number;
	maxLat: number;
	minLon: number;
	maxLon: number;
}

/** A row of `osm_points`, as `Verified.Geo.OsmSpatial.PointRow` consumes it. */
export interface OsmPointRow {
	osmId: number;
	featureType: string;
	subtype: string | null;
	name: string | null;
	lat: number;
	lon: number;
	tags: Record<string, string>;
}

/** A row of `osm_lines`. `coords` is `[lat, lon]` in OSM order, matching
 *  `Verified.Geo.OsmSpatial.Lines.LineRow`. */
export interface OsmLineRow {
	osmId: number;
	featureType: string;
	subtype: string | null;
	name: string | null;
	coords: Array<[number, number]>;
	tags: Record<string, string>;
}

/** Coverage boxes per feature type — the buffers differ, so the boxes do too. */
export type OsmCoverage = Record<string, CoverageBox[]>;

/**
 * The inputs `stationsOnLine` needs, pushed rather than queried (#414).
 *
 * This one is not bbox-keyed and so could not ride on the coverage boxes above:
 * a line is selected by NAME and its ways run the length of the line, far
 * outside any buffer around a day's track. It is pushed anyway because the key
 * set turned out to be enumerable in advance — every line name the 33-day
 * corpus asked for is a name already present on a railway row inside the day's
 * own boxes (`lean/experiments/delegated-lookup-keys.mts`, 24 of 24) — and
 * because the geometry is small: under 0.6 MiB for a worst-case day, against
 * the 20-40 MiB the bbox rows already cost (`stationsonline-push-size.mts`).
 *
 * What is pushed is the INPUT, not the answer. The 300 m proximity decision
 * stays a computation (`filterStationsByLineProximityParsed`), for the reason
 * the proposal gives for the five kernel lookups: a captured value IS the
 * answer, and storing it keeps the predicate an oracle.
 */
export interface OsmRailLineSet {
	/** Every distinct `osm_lines` railway name in the mirror. `lineNamesMatching`
	 *  resolves a line label against this list, and it has to be the WHOLE list
	 *  or the resolution differs from the DB path's: a name absent here is a
	 *  match that silently does not happen. ~1090 names, ~17 KiB. */
	allNames: string[];
	/** The way names this set was built to answer — the union of
	 *  `lineNamesMatching(c, allNames)` over the candidate lines. A name may
	 *  legitimately have no ways, so this records what was ASKED FOR, which is
	 *  what coverage has to be judged against; deriving it from `ways` instead
	 *  would read an empty line as an uncovered one. */
	fetchedNames: string[];
	/** Railway way geometry for `fetchedNames`, `[lat, lon]` as elsewhere. */
	ways: Array<{ name: string; coords: Array<[number, number]> }>;
	/** Every named railway station in the mirror. The DB path filters an
	 *  in-memory list of all of them per line rather than querying per line —
	 *  a London-wide MBR scan is slower than the filter — so the pushed set
	 *  mirrors that and stays a whole-table copy. ~1232 rows. */
	stations: Array<{ name: string; lat: number; lon: number }>;
}

/** One day's pushed rows, with the boxes that bound what they cover. */
export interface OsmRowSet {
	coverage: OsmCoverage;
	points: OsmPointRow[];
	lines: OsmLineRow[];
	/** Absent in row-sets captured before #414 — those delegate `stationsOnLine`
	 *  to the recorded trace, exactly as they did. Present means the lookup is
	 *  computed, and an out-of-coverage line is then a hard error. */
	railLines?: OsmRailLineSet;
}

/**
 * Half-extents in degrees of a metric radius at a latitude, rounded OUTWARD.
 *
 * Both conversions err the same way, deliberately. Latitude divides by 111000,
 * an understatement of the sphere's true 111194.68 m/deg, so the degree extent
 * overstates the metric one. Longitude is evaluated at the POLEWARD edge of the
 * resulting latitude band, where a degree of longitude is shortest and the
 * degree extent is therefore largest — a circle reaches its extreme longitude
 * not beside its centre but at the tangent point poleward of it. The box the
 * pair describes is never smaller than the circle it stands for.
 *
 * The poleward evaluation is NOT observable at the sizes this module uses, and
 * that is measured rather than hoped: the 111000-against-111194.68
 * understatement is 0.1754% of slack, while `cos` varies by at most 0.1339%
 * across a 1500 m band anywhere up to latitude 80. Evaluating at the centre, or
 * even equatorward, would give the same answers here. It starts to matter near
 * 5 km, which is why the invariant is pinned at that radius in
 * `tests/osm-rowset.test.ts` rather than at the operating one.
 */
function degreeExtent(lat: number, m: number): { dLat: number; dLon: number } {
	const dLat = m / METERS_PER_DEG_LAT;
	// Clamped short of the pole, where a degree of longitude vanishes and the
	// whole flat-box scheme degenerates. No track this serves goes there.
	const poleward = Math.min(89, Math.abs(lat) + dLat);
	return { dLat, dLon: m / metersPerDegLon(poleward) };
}

/** The latitude band index a fix falls in, and the band's degree height. */
function latBand(lat: number, cellM: number): { index: number; height: number } {
	const height = cellM / METERS_PER_DEG_LAT;
	return { index: Math.floor(lat / height), height };
}

/** Longitude cell width for a latitude band, in degrees. Evaluated at the
 *  band's poleward edge, which makes the cell at least `cellM` wide throughout —
 *  though nothing depends on that: coverage is unaffected by where the grid
 *  lines fall (probed: switching to the equatorward edge, and separately
 *  changing the cell size 1000 → 250 m, leave every one of the 2521 corpus
 *  queries covered). All this needs to be is deterministic. */
function lonCellWidth(bandIndex: number, height: number, cellM: number): number {
	const poleward = Math.min(89, Math.max(Math.abs(bandIndex * height), Math.abs((bandIndex + 1) * height)));
	return cellM / metersPerDegLon(poleward);
}

/**
 * The boxes to fetch for a track: snap the fixes to a grid, keep the distinct
 * cells, and expand each by `bufferM`.
 *
 * The covering property this must have, and the reason the cell size is free:
 * take any fix `f` in cell `C` and any query at `q` with radius `r`, where
 * `dist(q, f) + r ≤ bufferM`. Then `q`'s extent-box lies inside `C`'s expanded
 * box. In latitude that is immediate. In longitude it holds because the box's
 * expansion is evaluated at `C`'s poleward edge PLUS the buffer — which is
 * poleward of anything `q` can reach, since `q` is inside the buffer — so the
 * box's degree expansion is at least as generous as `q`'s own. Cell size enters
 * neither side of that argument.
 *
 * Cells are not merged. Merging would preserve the property, but a day
 * containing a train trip has a continuous chain of adjacent cells, and merging
 * them collapses to the whole trip's bounding box — measured at 5.6× the rows.
 */
export function coverageBoxesForTrack(
	track: ReadonlyArray<{ lat: number; lon: number }>,
	bufferM: number,
	cellM: number = TRACK_CELL_M,
): CoverageBox[] {
	const cells = new Map<string, { i: number; j: number; height: number; width: number }>();
	for (const f of track) {
		const { index: i, height } = latBand(f.lat, cellM);
		const width = lonCellWidth(i, height, cellM);
		const j = Math.floor(f.lon / width);
		cells.set(`${i}|${j}`, { i, j, height, width });
	}

	const boxes: CoverageBox[] = [];
	for (const { i, j, height, width } of cells.values()) {
		const minLat = i * height;
		const maxLat = (i + 1) * height;
		// Expansion is computed at the poleward edge of the ALREADY-buffered
		// band — see the covering argument above.
		const poleward = Math.max(Math.abs(minLat), Math.abs(maxLat));
		const { dLat, dLon } = degreeExtent(poleward, bufferM);
		boxes.push({
			minLat: minLat - dLat,
			maxLat: maxLat + dLat,
			minLon: j * width - dLon,
			maxLon: (j + 1) * width + dLon,
		});
	}
	return boxes;
}

/** Coverage boxes for every kernel feature type, each at its own buffer. */
export function coverageForTrack(track: ReadonlyArray<{ lat: number; lon: number }>): OsmCoverage {
	const out: OsmCoverage = {};
	for (const [featureType, bufferM] of Object.entries(KERNEL_BUFFER_M)) {
		out[featureType] = coverageBoxesForTrack(track, bufferM);
	}
	return out;
}

/**
 * Is a query at (lat, lon) with `radiusM` answerable from rows fetched for
 * `boxes`? True when the query's extent-box lies inside a SINGLE box.
 *
 * Single-box, not union-of-boxes: a query straddling the seam between two
 * abutting boxes reads as uncovered even though every row it needs was in fact
 * fetched. That asymmetry is the safe one. A false "uncovered" costs a
 * re-capture with a wider buffer; a false "covered" would serve a silently
 * short answer, which is exactly the failure this whole mechanism exists to
 * make impossible.
 */
export function queryIsCovered(lat: number, lon: number, radiusM: number, boxes: readonly CoverageBox[]): boolean {
	const { dLat, dLon } = degreeExtent(lat, radiusM);
	const minLat = lat - dLat;
	const maxLat = lat + dLat;
	const minLon = lon - dLon;
	const maxLon = lon + dLon;
	return boxes.some((b) => b.minLat <= minLat && b.maxLat >= maxLat && b.minLon <= minLon && b.maxLon >= maxLon);
}

/**
 * Is an adapter call answerable from the row-set? Every feature type the method
 * reads must cover it — a `nearbyWays` answer merges four tables, and a short
 * result from any one of them is a wrong answer, not a partial one.
 *
 * This is the assertion the whole design leans on. Call it before serving a
 * query from pushed rows, and throw when it fails: an under-sized buffer then
 * announces itself instead of quietly returning fewer features than exist.
 */
export function methodIsCovered(
	method: string,
	lat: number,
	lon: number,
	radiusM: number,
	coverage: OsmCoverage,
): boolean {
	const types = METHOD_FEATURE_TYPES[method];
	if (!types) throw new Error(`methodIsCovered: unknown method ${method}`);
	return types.every((t) => queryIsCovered(lat, lon, radiusM, coverage[t] ?? []));
}

/**
 * Is `stationsOnLine(lineName)` answerable from a pushed rail-line set?
 *
 * The test is on the RESOLVED names, not on the label: `stationsOnLine` never
 * looks a label up directly, it expands it through `lineNamesMatching` and
 * fetches the ways of everything that comes back. So the set can answer a line
 * it has never heard of, provided that line resolves to names already fetched —
 * which is the common case, because a label and its directional variant
 * ("Victoria Line", "Victoria Line Northbound") share a base token and expand
 * to the SAME set.
 *
 * Conservative in the same direction as {@link queryIsCovered}: a name missing
 * from `fetchedNames` reads as uncovered even if it happens to have no ways in
 * the mirror, because "no ways were fetched" and "no ways exist" are the same
 * observation from here and only one of them is a correct empty answer.
 *
 * Exact string comparison is right HERE, unlike in the adapter's way filter,
 * which has to fold case to match MariaDB's collation: both sides of this test
 * are produced by `lineNamesMatching` over the same stored `allNames`, so equal
 * names are the identical string. The fold is only needed where a pushed WAY
 * name meets a name list, because the DB selected those ways case-insensitively.
 */
export function lineIsCovered(lineName: string, set: OsmRailLineSet): boolean {
	const fetched = new Set(set.fetchedNames);
	return lineNamesMatching(lineName, set.allNames).every((n) => fetched.has(n));
}

/**
 * Does a point lie in the box? Boundary-inclusive, matching `MBRIntersects`
 * against a POINT geometry.
 */
export function boxContainsPoint(b: CoverageBox, lat: number, lon: number): boolean {
	return lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon;
}

/**
 * Does a polyline's own bounding rectangle overlap the box? This is exactly what
 * `MBRIntersects(geom, box)` tests for a LINESTRING, and it is deliberately
 * weaker than "some vertex is inside": a long road can cross a small box with
 * every vertex outside it.
 */
export function boxIntersectsLine(b: CoverageBox, coords: ReadonlyArray<[number, number]>): boolean {
	if (coords.length === 0) return false;
	let minLat = Number.POSITIVE_INFINITY;
	let maxLat = Number.NEGATIVE_INFINITY;
	let minLon = Number.POSITIVE_INFINITY;
	let maxLon = Number.NEGATIVE_INFINITY;
	for (const [lat, lon] of coords) {
		if (lat < minLat) minLat = lat;
		if (lat > maxLat) maxLat = lat;
		if (lon < minLon) minLon = lon;
		if (lon > maxLon) maxLon = lon;
	}
	return minLat <= b.maxLat && maxLat >= b.minLat && minLon <= b.maxLon && maxLon >= b.minLon;
}

/**
 * The box as a closed-ring POLYGON WKT for an MBR spatial filter.
 *
 * WKT coordinate order is `x y` = `lon lat`, the reverse of how the box names
 * its own fields. Exported so the order can be pinned directly, because the
 * post-conditions in {@link loadOsmRowSet} CANNOT catch getting it wrong: at
 * these latitudes a swap sends the query to open ocean, the mirror returns no
 * rows, and a post-condition over an empty result set passes vacuously while
 * `methodIsCovered` still reports every query answerable from the unchanged
 * boxes. Silently wrong, in exactly the way this module exists to prevent —
 * so the guard has to be here, on the conversion itself.
 */
export function boxWkt(b: CoverageBox): string {
	return `POLYGON((${b.minLon} ${b.minLat},${b.maxLon} ${b.minLat},${b.maxLon} ${b.maxLat},${b.minLon} ${b.maxLat},${b.minLon} ${b.minLat}))`;
}

/** MariaDB's JSON column may arrive as a string or as a parsed object
 *  depending on driver version — the same both-ways handling `queryPoints`
 *  already does. */
function parseTags(raw: unknown): Record<string, string> {
	if (!raw) return {};
	if (typeof raw === "string") return JSON.parse(raw) as Record<string, string>;
	return raw as Record<string, string>;
}

/**
 * Read every kernel-scope OSM row within `bufferM` of the track.
 *
 * One query per coverage box per table. Boxes overlap heavily — that is the
 * cost of not merging them — so rows are de-duplicated here by `(osm_id,
 * feature_type)`. `osm_id` alone is NOT a key: the mirror stores a way's rows
 * under whichever feature_type bucket its tags matched, and the same OSM id can
 * legitimately appear under two.
 *
 * Offline only. This is a heavy spatial read, run by the capture path, never on
 * a request.
 */
export async function loadOsmRowSet(track: ReadonlyArray<{ lat: number; lon: number }>): Promise<OsmRowSet> {
	const coverage = coverageForTrack(track);
	const points = new Map<string, OsmPointRow>();
	const lines = new Map<string, OsmLineRow>();

	// Feature types sharing a buffer share their boxes, so they share the query
	// too. Without this the worst day issues ~1700 box queries per table; with
	// it, one per box per distinct buffer — the table has only two.
	const byBuffer = new Map<number, string[]>();
	for (const [featureType, bufferM] of Object.entries(KERNEL_BUFFER_M)) {
		byBuffer.set(bufferM, [...(byBuffer.get(bufferM) ?? []), featureType]);
	}

	for (const [bufferM, featureTypes] of byBuffer) {
		for (const box of coverageBoxesForTrack(track, bufferM)) {
			const poly = boxWkt(box);

			const pointRows = (
				await sql<{
					osm_id: bigint;
					feature_type: string;
					subtype: string | null;
					name: string | null;
					tags_json: unknown;
					lat: number;
					lon: number;
				}>`
					SELECT osm_id, feature_type, subtype, name, tags_json,
					       ST_Y(geom) AS lat, ST_X(geom) AS lon
					FROM osm_points
					WHERE feature_type IN (${sql.join(featureTypes)})
					  AND MBRIntersects(geom, ST_GeomFromText(${poly}, 4326))
				`.execute(db())
			).rows;
			for (const r of pointRows) {
				const lat = Number(r.lat);
				const lon = Number(r.lon);
				// Post-condition: the rows we GOT must lie in the box we RECORDED.
				// The box travels to MariaDB as `lon lat` WKT and comes back as
				// ST_X/ST_Y, while the box's own fields are named lat/lon — a swap
				// anywhere along that path returns plausible rows from the wrong
				// place, and every downstream check would pass on them. This is the
				// mirror of `methodIsCovered`: that one asks whether a query is
				// answerable, this one whether the answer came from where it claims.
				if (!boxContainsPoint(box, lat, lon)) {
					throw new Error(
						`loadOsmRowSet: osm_points ${r.osm_id} (${lat}, ${lon}) fell outside the box it was ` +
							`queried from [${box.minLat}, ${box.maxLat}] x [${box.minLon}, ${box.maxLon}] — ` +
							"the WKT sent and the box recorded disagree",
					);
				}
				points.set(`${r.osm_id}|${r.feature_type}`, {
					osmId: Number(r.osm_id),
					featureType: r.feature_type,
					subtype: r.subtype,
					name: r.name,
					lat,
					lon,
					tags: parseTags(r.tags_json),
				});
			}

			const lineRows = (
				await sql<{
					osm_id: bigint;
					feature_type: string;
					subtype: string | null;
					name: string | null;
					tags_json: unknown;
					wkt: string;
				}>`
					SELECT osm_id, feature_type, subtype, name, tags_json, ST_AsText(geom) AS wkt
					FROM osm_lines
					WHERE feature_type IN (${sql.join(featureTypes)})
					  AND MBRIntersects(geom, ST_GeomFromText(${poly}, 4326))
				`.execute(db())
			).rows;
			for (const r of lineRows) {
				const key = `${r.osm_id}|${r.feature_type}`;
				if (lines.has(key)) continue;
				const coords = parseLineStringWkt(r.wkt);
				// Same post-condition as the points, weakened to what MBRIntersects
				// actually promises for a linestring. `parseLineStringWkt` is the
				// second place the coordinate order could invert — WKT is `lon lat`
				// and it returns `[lat, lon]` — so this is not a redundant check.
				if (coords.length > 0 && !boxIntersectsLine(box, coords)) {
					throw new Error(
						`loadOsmRowSet: osm_lines ${r.osm_id} does not overlap the box it was queried from ` +
							`[${box.minLat}, ${box.maxLat}] x [${box.minLon}, ${box.maxLon}] — ` +
							"the WKT sent, the box recorded, or the parsed coordinate order disagree",
					);
				}
				lines.set(key, {
					osmId: Number(r.osm_id),
					featureType: r.feature_type,
					subtype: r.subtype,
					name: r.name,
					coords,
					tags: parseTags(r.tags_json),
				});
			}
		}
	}

	const railLines = await loadRailLineSet([...lines.values()]);
	return { coverage, points: [...points.values()], lines: [...lines.values()], railLines };
}

/**
 * The line labels a day can ask `stationsOnLine` about: the railway names on
 * its own rows, closed under the compound-label split `lineCannotServe`
 * applies before asking. Pure, and exported for the test that pins the closure
 * — the DB-bound caller cannot be unit-tested, and an unpinned closure is what
 * #741 was.
 */
export function railLineCandidates(dayLines: readonly OsmLineRow[]): string[] {
	const candidates = new Set<string>();
	for (const l of dayLines) {
		if (l.featureType !== "railway" || l.name === null) continue;
		candidates.add(l.name);
		for (const component of expandTubeLineNames(l.name)) candidates.add(component);
	}
	return [...candidates];
}

/**
 * The `stationsOnLine` inputs for a day, derived from the day's own railway rows.
 *
 * The candidates start as the distinct names on the railway rows already
 * fetched. `linesAtPoint` answers out of these same rows, so no name it can
 * return for this day is outside them — but that bounds only the names the day
 * READS, and the day does not only ask about names it read (#741).
 *
 * `lineCannotServe` splits a compound OSM label into the physical lines it
 * denotes and asks about each ("Circle, Hammersmith & City and Metropolitan
 * Lines" → "Circle Line", "Hammersmith & City Line", "Metropolitan Line"), so
 * the reachable ask set is the row names CLOSED UNDER that expansion, and the
 * closure is what is fetched here. The distinction is not academic: across the
 * 35-day corpus the closure adds exactly one name, "Hammersmith & City Line",
 * on 33 of the 35 days — a standalone way name that lives on the Hammersmith
 * branch, outside every one of those days' boxes, while the other components
 * ("Circle Line", "Metropolitan Line") are tagged standalone somewhere along
 * the track and were already candidates. So every day was one un-short-circuited
 * `lineCannotServe` away from an uncapturable capture, and 2026-08-08 is where
 * that branch was finally taken.
 *
 * Whether the day only asks about lines in this closure is still a separate
 * question, and a measured one — 24 of 24 across the corpus
 * (`lean/experiments/delegated-lookup-keys.mts`). {@link lineIsCovered} is what
 * holds that claim to account per call rather than trusting the measurement,
 * and it is what caught this: the guard was right and the derivation was wrong.
 *
 * Offline only, like its caller. Two queries plus one per distinct buffer.
 */
async function loadRailLineSet(dayLines: readonly OsmLineRow[]): Promise<OsmRailLineSet> {
	const allNames = (
		(await db()
			.selectFrom("osm_lines")
			.where("feature_type", "=", "railway")
			.where("name", "is not", null)
			.select("name")
			.distinct()
			.execute()) as Array<{ name: string | null }>
	)
		.map((r) => r.name)
		.filter((n): n is string => n !== null);

	const fetched = new Set<string>();
	for (const c of railLineCandidates(dayLines)) {
		for (const n of lineNamesMatching(c, allNames)) fetched.add(n);
	}
	const fetchedNames = [...fetched];

	const ways: OsmRailLineSet["ways"] = [];
	if (fetchedNames.length > 0) {
		const rows = (await db()
			.selectFrom("osm_lines")
			.where("feature_type", "=", "railway")
			.where("name", "in", fetchedNames)
			.select(["name", sql<string>`ST_AsText(geom)`.as("wkt")])
			.execute()) as Array<{ name: string | null; wkt: string }>;
		for (const r of rows) {
			if (r.name === null) continue;
			ways.push({ name: r.name, coords: parseLineStringWkt(r.wkt) });
		}
	}

	// The whole station table, matching what the DB path caches process-wide.
	// Filtering an in-memory list per line is faster than a per-line MBR query
	// at these bbox sizes, and copying that shape keeps the two paths identical.
	const stations = (
		(await db()
			.selectFrom("osm_points")
			.where("feature_type", "=", "railway")
			.where("subtype", "=", "station")
			.select(["name", sql<number>`ST_Y(geom)`.as("lat"), sql<number>`ST_X(geom)`.as("lon")])
			.execute()) as Array<{ name: string | null; lat: number; lon: number }>
	)
		.filter((r): r is { name: string; lat: number; lon: number } => r.name !== null)
		.map((r) => ({ name: r.name, lat: Number(r.lat), lon: Number(r.lon) }));

	return { allNames, fetchedNames, ways, stations };
}
