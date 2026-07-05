/**
 * `MockOsmAdapter` — a tiny in-memory adapter for unit tests.
 *
 * Two responsibilities:
 *
 *   1. **Record every call** — `calls.nearbyWays` etc. are arrays of
 *      the args each call received, in invocation order. Tests assert
 *      against these to verify adapter threading.
 *   2. **Serve canned responses** — `responses.nearbyWays` etc. let a
 *      test pre-seed the answers `nearbyWays(...)` should return.
 *      Without an entry, each method returns an empty result so the
 *      pipeline can still run.
 *
 * Use this when testing Phase 6d call-site threading. For full-fixture
 * replay (Phase 6e onward), use `FixtureOsmAdapter` instead — same
 * interface, different storage.
 */

import type { Station } from "../../src/geo/line-stations.js";
import type {
	NearbyLandmark,
	NearbyStation,
	NearbyTransitStop,
	NearbyWay,
	NominatimResult,
} from "../../src/geo/osm.js";
import type { OsmAdapter } from "../../src/geo/osm-adapter.js";
import type { BuildingFootprint } from "../../src/geo/osm-local.js";
import type { OsmRoadWay } from "../../src/geo/road-match.js";

/** A recorded invocation of an adapter primitive. */
export interface RecordedCall<Args extends readonly unknown[]> {
	args: Args;
}

/** A response stub: a function from args to result, so a test can vary
 *  the response by call args (e.g. return different landmarks at
 *  different coordinates). */
type Stub<Args extends readonly unknown[], R> = (...args: Args) => R;

export interface MockOsmAdapterOptions {
	nearbyWays?: Stub<[number, number, number | undefined], NearbyWay[]>;
	nearbyStations?: Stub<[number, number, number | undefined], NearbyStation[]>;
	nearbyLandmarks?: Stub<[number, number, number | undefined], NearbyLandmark[]>;
	linesAtPoint?: Stub<[number, number, number | undefined], Set<string>>;
	reverseGeocode?: Stub<[number, number, number | undefined], NominatimResult | null>;
	nearbyTransitStops?: Stub<[number, number, number | undefined], NearbyTransitStop[]>;
	stationsOnLine?: Stub<[string], Station[]>;
	drivableRoads?: Stub<[number, number, number | undefined], OsmRoadWay[]>;
	walkableRoads?: Stub<[number, number, number | undefined], OsmRoadWay[]>;
	buildingsNear?: Stub<[number, number, number | undefined], BuildingFootprint[]>;
}

export interface MockOsmAdapter extends OsmAdapter {
	readonly calls: {
		nearbyWays: Array<RecordedCall<[number, number, number | undefined]>>;
		nearbyStations: Array<RecordedCall<[number, number, number | undefined]>>;
		nearbyLandmarks: Array<RecordedCall<[number, number, number | undefined]>>;
		linesAtPoint: Array<RecordedCall<[number, number, number | undefined]>>;
		reverseGeocode: Array<RecordedCall<[number, number, number | undefined]>>;
		nearbyTransitStops: Array<RecordedCall<[number, number, number | undefined]>>;
		stationsOnLine: Array<RecordedCall<[string]>>;
		drivableRoads: Array<RecordedCall<[number, number, number | undefined]>>;
		walkableRoads: Array<RecordedCall<[number, number, number | undefined]>>;
		buildingsNear: Array<RecordedCall<[number, number, number | undefined]>>;
	};
}

/** Build a `MockOsmAdapter`. Without `options`, every primitive
 *  returns an empty result. With `options`, the named primitives
 *  return whatever the stub returns. All calls are recorded
 *  regardless. */
export function mockOsmAdapter(options: MockOsmAdapterOptions = {}): MockOsmAdapter {
	const calls: MockOsmAdapter["calls"] = {
		nearbyWays: [],
		nearbyStations: [],
		nearbyLandmarks: [],
		linesAtPoint: [],
		reverseGeocode: [],
		nearbyTransitStops: [],
		stationsOnLine: [],
		drivableRoads: [],
		walkableRoads: [],
		buildingsNear: [],
	};
	return {
		calls,
		async nearbyWays(lat, lon, radiusM) {
			calls.nearbyWays.push({ args: [lat, lon, radiusM] });
			return options.nearbyWays?.(lat, lon, radiusM) ?? [];
		},
		async nearbyStations(lat, lon, radiusM) {
			calls.nearbyStations.push({ args: [lat, lon, radiusM] });
			return options.nearbyStations?.(lat, lon, radiusM) ?? [];
		},
		async nearbyLandmarks(lat, lon, radiusM) {
			calls.nearbyLandmarks.push({ args: [lat, lon, radiusM] });
			return options.nearbyLandmarks?.(lat, lon, radiusM) ?? [];
		},
		async linesAtPoint(lat, lon, radiusM) {
			calls.linesAtPoint.push({ args: [lat, lon, radiusM] });
			return options.linesAtPoint?.(lat, lon, radiusM) ?? new Set<string>();
		},
		async reverseGeocode(lat, lon, zoom) {
			calls.reverseGeocode.push({ args: [lat, lon, zoom] });
			return options.reverseGeocode?.(lat, lon, zoom) ?? null;
		},
		async nearbyTransitStops(lat, lon, radiusM) {
			calls.nearbyTransitStops.push({ args: [lat, lon, radiusM] });
			return options.nearbyTransitStops?.(lat, lon, radiusM) ?? [];
		},
		async stationsOnLine(lineName) {
			calls.stationsOnLine.push({ args: [lineName] });
			return options.stationsOnLine?.(lineName) ?? [];
		},
		async drivableRoads(lat, lon, radiusM) {
			calls.drivableRoads.push({ args: [lat, lon, radiusM] });
			return options.drivableRoads?.(lat, lon, radiusM) ?? [];
		},
		async walkableRoads(lat, lon, radiusM) {
			calls.walkableRoads.push({ args: [lat, lon, radiusM] });
			return options.walkableRoads?.(lat, lon, radiusM) ?? [];
		},
		async buildingsNear(lat, lon, radiusM) {
			calls.buildingsNear.push({ args: [lat, lon, radiusM] });
			return options.buildingsNear?.(lat, lon, radiusM) ?? [];
		},
	};
}
