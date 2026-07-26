/**
 * `RowSetOsmAdapter` — answers the kernel lookups from a pushed row-set instead
 * of from MariaDB. Step 3 of `docs/proposals/2026-07-osm-into-lean.md`.
 *
 * The five kernel methods (`nearbyWays`, `nearbyStations`, `nearbyLandmarks`,
 * `linesAtPoint`, `nearbyTransitStops`) are computed here, out of raw rows, via
 * `osm-rowset-query.ts` — the TS twin of `Verified.Geo.OsmSpatial`. Everything
 * else is delegated to an inner adapter, unchanged:
 *
 *   - `reverseGeocode` — Nominatim, a third-party HTTP service not mirrored.
 *   - `stationsOnLine` — keyed by line name, so there is no bbox to take.
 *   - `drivableRoads` / `walkableRoads` / `buildingsNear` — bulk readers whose
 *     SQL selects nothing (`feature_type = … AND MBRIntersects(…)`); the answer
 *     is "every row in the box" and the box is the caller's own parameter, so
 *     there is no oracle to lift. See the proposal's "Why the bulk readers are
 *     NOT pushed".
 *
 * # Why this throws instead of degrading
 *
 * Every kernel call is gated on {@link methodIsCovered} and an uncovered query
 * is a hard error. That is the same contract `FixtureOsmAdapter` has for an
 * uncaptured key, and for the same reason: the alternative is returning the
 * features that happen to be present, which is a WRONG answer wearing the shape
 * of a right one. A short `nearbyStations` result does not look like an error —
 * it looks like a place with fewer stations, and the pipeline will happily pick
 * the wrong one and carry it into the timeline.
 *
 * The error is therefore worth reading as "the row-set was built with too small
 * a buffer, or the call site moved", not as a bug in the caller.
 */

import type { Station } from "./line-stations.js";
import {
	DEFAULT_RADIUS_M,
	type NearbyLandmark,
	type NearbyStation,
	type NearbyTransitStop,
	type NearbyWay,
	type NominatimResult,
	shapeLandmarks,
	shapeLineNames,
	shapeStations,
	shapeTransitStops,
	shapeWays,
} from "./osm.js";
import type { OsmAdapter } from "./osm-adapter.js";
import type { BuildingFootprint } from "./osm-local.js";
import { methodIsCovered, type OsmRowSet } from "./osm-rowset.js";
import { queryLinesFromRows, queryPointsFromRows } from "./osm-rowset-query.js";
import type { OsmRoadWay } from "./road-match.js";

/** The subtypes `nearbyStations` asks for. */
const STATION_SUBTYPES = ["station", "subway_entrance", "halt", "stop", "tram_stop"];
/** The rail classes `linesAtPoint` asks for. */
const RAIL_SUBTYPES = ["rail", "subway", "light_rail", "tram", "narrow_gauge"];

export class RowSetOsmAdapter implements OsmAdapter {
	constructor(
		private readonly rowSet: OsmRowSet,
		private readonly inner: OsmAdapter,
	) {}

	/** Refuse a query the row-set cannot answer in full. See the header. */
	private gate(method: string, lat: number, lon: number, radiusM: number): void {
		if (!methodIsCovered(method, lat, lon, radiusM, this.rowSet.coverage)) {
			throw new Error(
				`RowSetOsmAdapter: ${method}(${lat}, ${lon}, ${radiusM}) is outside the pushed coverage — ` +
					"the row-set cannot answer it in full, and answering it in part would be wrong. " +
					"Re-capture with a wider buffer, or check whether this call site moved.",
			);
		}
	}

	async nearbyWays(lat: number, lon: number, radiusM: number = DEFAULT_RADIUS_M.nearbyWays): Promise<NearbyWay[]> {
		this.gate("nearbyWays", lat, lon, radiusM);
		// Four line buckets plus the aeroway points — OSM tags airports as both
		// ways (runways, taxiways) and nodes (aerodrome markers, terminals).
		return shapeWays({
			highways: queryLinesFromRows(this.rowSet.lines, lat, lon, radiusM, "highway"),
			railways: queryLinesFromRows(this.rowSet.lines, lat, lon, radiusM, "railway"),
			waterways: queryLinesFromRows(this.rowSet.lines, lat, lon, radiusM, "waterway"),
			aerowayLines: queryLinesFromRows(this.rowSet.lines, lat, lon, radiusM, "aeroway"),
			aerowayPoints: queryPointsFromRows(this.rowSet.points, lat, lon, radiusM, "aeroway"),
		});
	}

	async nearbyStations(
		lat: number,
		lon: number,
		radiusM: number = DEFAULT_RADIUS_M.nearbyStations,
	): Promise<NearbyStation[]> {
		this.gate("nearbyStations", lat, lon, radiusM);
		return shapeStations(queryPointsFromRows(this.rowSet.points, lat, lon, radiusM, "railway", STATION_SUBTYPES));
	}

	async nearbyLandmarks(
		lat: number,
		lon: number,
		radiusM: number = DEFAULT_RADIUS_M.nearbyLandmarks,
	): Promise<NearbyLandmark[]> {
		this.gate("nearbyLandmarks", lat, lon, radiusM);
		// Both tables: OSM has venue POIs (node) and building outlines (way).
		return shapeLandmarks(
			queryPointsFromRows(this.rowSet.points, lat, lon, radiusM, "landmark"),
			queryLinesFromRows(this.rowSet.lines, lat, lon, radiusM, "landmark"),
		);
	}

	async linesAtPoint(lat: number, lon: number, radiusM: number = DEFAULT_RADIUS_M.linesAtPoint): Promise<Set<string>> {
		this.gate("linesAtPoint", lat, lon, radiusM);
		return shapeLineNames(queryLinesFromRows(this.rowSet.lines, lat, lon, radiusM, "railway", RAIL_SUBTYPES));
	}

	async nearbyTransitStops(
		lat: number,
		lon: number,
		radiusM: number = DEFAULT_RADIUS_M.nearbyTransitStops,
	): Promise<NearbyTransitStop[]> {
		this.gate("nearbyTransitStops", lat, lon, radiusM);
		return shapeTransitStops(queryPointsFromRows(this.rowSet.points, lat, lon, radiusM, "transit_stop"));
	}

	// --- Delegated: not spatial, or shipping rows already. See the header. ---

	async reverseGeocode(lat: number, lon: number, zoom?: number): Promise<NominatimResult | null> {
		return this.inner.reverseGeocode(lat, lon, zoom);
	}

	async stationsOnLine(lineName: string): Promise<Station[]> {
		return this.inner.stationsOnLine(lineName);
	}

	async drivableRoads(lat: number, lon: number, radiusM?: number): Promise<OsmRoadWay[]> {
		return this.inner.drivableRoads(lat, lon, radiusM);
	}

	async walkableRoads(lat: number, lon: number, radiusM?: number): Promise<OsmRoadWay[]> {
		return this.inner.walkableRoads(lat, lon, radiusM);
	}

	async buildingsNear(lat: number, lon: number, radiusM?: number): Promise<BuildingFootprint[]> {
		return this.inner.buildingsNear(lat, lon, radiusM);
	}
}
