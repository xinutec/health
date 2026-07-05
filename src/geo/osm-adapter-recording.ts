/**
 * `RecordingOsmAdapter` — wraps another `OsmAdapter`, delegates every
 * call to it, and records the (args → result) pairs into an
 * `OsmTrace`.
 *
 * Phase 6e of `docs/proposals/2026-06-deterministic-fixtures.md`.
 *
 * Used by `capture-day-v2`: wrap `DbOsmAdapter` with this, run the
 * classification pipeline once, serialise the trace into the fixture
 * file. The replay side (`FixtureOsmAdapter`) consumes the same trace
 * and answers by exact-key lookup; the pipeline produces the same
 * output without touching the DB.
 *
 * Why exact-key replay (and not row-set filtering):
 *
 *   - The classification pipeline is deterministic given its inputs.
 *     Kalman is pure; segmentation is pure; OSM call sites are
 *     reached at the same (lat, lon, radius) for the same captured
 *     PhoneTrack window. Exact-key replay returns byte-identical
 *     results.
 *   - A code change that moves a call site (different coords,
 *     different radius) is exactly the kind of change the golden
 *     should catch. The replay throws "uncaptured query" and forces
 *     an explicit re-bless — that is the deliberate-capture
 *     property the proposal promises.
 *   - Serialisation is trivial: trace is `Record<string, T>` keyed
 *     by `${lat}|${lon}|${radius}`. No row-set parsing, no spatial
 *     kernel at replay time.
 */

import type { Station } from "./line-stations.js";
import type { NearbyLandmark, NearbyStation, NearbyTransitStop, NearbyWay, NominatimResult } from "./osm.js";
import type { OsmAdapter } from "./osm-adapter.js";
import type { BuildingFootprint } from "./osm-local.js";
import type { OsmRoadWay } from "./road-match.js";

/** Captured (args → result) pairs for one classification-pipeline run.
 *
 *  Keys are `${lat}|${lon}|${radius?}` (or `|${zoom?}` for
 *  reverseGeocode). `Set<string>` is serialised as `string[]` for JSON
 *  round-trip; deserialisation in `FixtureOsmAdapter` rebuilds the Set.
 *  Same-key collisions overwrite (last-call wins) — the prod cache is
 *  idempotent, so two calls at the same coord yield the same response,
 *  and overwrite is the right semantic. */
export interface OsmTrace {
	nearbyWays: Record<string, NearbyWay[]>;
	nearbyStations: Record<string, NearbyStation[]>;
	nearbyLandmarks: Record<string, NearbyLandmark[]>;
	/** `Set<string>` serialised as `string[]`. */
	linesAtPoint: Record<string, string[]>;
	reverseGeocode: Record<string, NominatimResult | null>;
	/** Optional: absent in fixtures captured before task #247 — the
	 *  replay adapter treats a missing SECTION as "no transit-stop data"
	 *  (empty results), while a missing KEY in a present section is the
	 *  usual uncaptured-query error. */
	nearbyTransitStops?: Record<string, NearbyTransitStop[]>;
	/** Keyed by line name. Optional: absent in fixtures captured before
	 *  task #222; missing SECTION = no data, missing KEY = uncaptured. */
	stationsOnLine?: Record<string, Station[]>;
	/** Drivable road geometry for road map-matching (#261). Optional: absent
	 *  in fixtures captured before #261 — missing SECTION = no road data (the
	 *  matcher falls back to the raw track, so old goldens are unchanged),
	 *  missing KEY in a present section = the usual uncaptured-query error. */
	drivableRoads?: Record<string, OsmRoadWay[]>;
	/** Walkable way geometry for the pedestrian smoother. Optional: absent in
	 *  fixtures captured before it — missing SECTION = no walkable data (the
	 *  smoother runs without the soft map factor, so old goldens are unchanged),
	 *  missing KEY in a present section = the usual uncaptured-query error. */
	walkableRoads?: Record<string, OsmRoadWay[]>;
	/** Building footprints for the pedestrian smoother's walkable-surface field.
	 *  Optional: absent in fixtures captured before it — missing SECTION = no
	 *  building data (the smoother runs without the impassability term, so old
	 *  goldens are unchanged), missing KEY in a present section = uncaptured. */
	buildingsNear?: Record<string, BuildingFootprint[]>;
}

/** Build an empty trace. */
export function emptyOsmTrace(): OsmTrace {
	return {
		nearbyWays: {},
		nearbyStations: {},
		nearbyLandmarks: {},
		linesAtPoint: {},
		reverseGeocode: {},
		nearbyTransitStops: {},
		stationsOnLine: {},
		drivableRoads: {},
		walkableRoads: {},
		buildingsNear: {},
	};
}

function key3(lat: number, lon: number, third: number | undefined): string {
	return `${lat}|${lon}|${third ?? ""}`;
}

/** Records every adapter call into an `OsmTrace`. The trace is
 *  reachable via `.trace` after the recording run. */
export class RecordingOsmAdapter implements OsmAdapter {
	readonly trace: OsmTrace = emptyOsmTrace();

	constructor(private readonly inner: OsmAdapter) {}

	async nearbyWays(lat: number, lon: number, radiusM?: number): Promise<NearbyWay[]> {
		const result = await this.inner.nearbyWays(lat, lon, radiusM);
		this.trace.nearbyWays[key3(lat, lon, radiusM)] = result;
		return result;
	}

	async nearbyStations(lat: number, lon: number, radiusM?: number): Promise<NearbyStation[]> {
		const result = await this.inner.nearbyStations(lat, lon, radiusM);
		this.trace.nearbyStations[key3(lat, lon, radiusM)] = result;
		return result;
	}

	async nearbyLandmarks(lat: number, lon: number, radiusM?: number): Promise<NearbyLandmark[]> {
		const result = await this.inner.nearbyLandmarks(lat, lon, radiusM);
		this.trace.nearbyLandmarks[key3(lat, lon, radiusM)] = result;
		return result;
	}

	async linesAtPoint(lat: number, lon: number, radiusM?: number): Promise<Set<string>> {
		const result = await this.inner.linesAtPoint(lat, lon, radiusM);
		this.trace.linesAtPoint[key3(lat, lon, radiusM)] = [...result];
		return result;
	}

	async reverseGeocode(lat: number, lon: number, zoom?: number): Promise<NominatimResult | null> {
		const result = await this.inner.reverseGeocode(lat, lon, zoom);
		this.trace.reverseGeocode[key3(lat, lon, zoom)] = result;
		return result;
	}

	async nearbyTransitStops(lat: number, lon: number, radiusM?: number): Promise<NearbyTransitStop[]> {
		const result = await this.inner.nearbyTransitStops(lat, lon, radiusM);
		if (!this.trace.nearbyTransitStops) this.trace.nearbyTransitStops = {};
		this.trace.nearbyTransitStops[key3(lat, lon, radiusM)] = result;
		return result;
	}

	async stationsOnLine(lineName: string): Promise<Station[]> {
		const result = await this.inner.stationsOnLine(lineName);
		if (!this.trace.stationsOnLine) this.trace.stationsOnLine = {};
		this.trace.stationsOnLine[lineName] = result;
		return result;
	}

	async drivableRoads(lat: number, lon: number, radiusM?: number): Promise<OsmRoadWay[]> {
		const result = await this.inner.drivableRoads(lat, lon, radiusM);
		if (!this.trace.drivableRoads) this.trace.drivableRoads = {};
		this.trace.drivableRoads[key3(lat, lon, radiusM)] = result;
		return result;
	}

	async walkableRoads(lat: number, lon: number, radiusM?: number): Promise<OsmRoadWay[]> {
		const result = await this.inner.walkableRoads(lat, lon, radiusM);
		if (!this.trace.walkableRoads) this.trace.walkableRoads = {};
		this.trace.walkableRoads[key3(lat, lon, radiusM)] = result;
		return result;
	}

	async buildingsNear(lat: number, lon: number, radiusM?: number): Promise<BuildingFootprint[]> {
		const result = await this.inner.buildingsNear(lat, lon, radiusM);
		if (!this.trace.buildingsNear) this.trace.buildingsNear = {};
		this.trace.buildingsNear[key3(lat, lon, radiusM)] = result;
		return result;
	}
}
