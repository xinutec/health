/**
 * `RowSetOsmAdapter`: the gate, the shaping, and the delegation boundary.
 *
 * The behaviour worth protecting here is the REFUSAL. Answering an uncovered
 * query with whatever rows happen to be present returns a wrong answer wearing
 * the shape of a right one — a short `nearbyStations` result does not look like
 * an error, it looks like a place with fewer stations, and the pipeline will
 * pick the wrong one and carry it into the timeline. So the tests below care
 * more about what the adapter refuses than about what it returns.
 */

import { describe, expect, it } from "vitest";
import { filterStationsByLineProximity, type Station } from "../src/geo/line-stations.js";
import type { NominatimResult } from "../src/geo/osm.js";
import type { OsmAdapter } from "../src/geo/osm-adapter.js";
import { RowSetOsmAdapter } from "../src/geo/osm-adapter-rowset.js";
import type { BuildingFootprint } from "../src/geo/osm-local.js";
import {
	coverageForTrack,
	type OsmLineRow,
	type OsmPointRow,
	type OsmRailLineSet,
	type OsmRowSet,
} from "../src/geo/osm-rowset.js";
import type { OsmRoadWay } from "../src/geo/road-match.js";

const LAT = 51.5492;
const LON = -0.2215;
const MDEG = 111_194.682_298_463_45;

/** Records which delegated methods were reached, so the boundary can be
 *  asserted rather than assumed. */
class RecordingInner implements OsmAdapter {
	readonly calls: string[] = [];
	async nearbyWays(): Promise<never[]> {
		this.calls.push("nearbyWays");
		return [];
	}
	async nearbyStations(): Promise<never[]> {
		this.calls.push("nearbyStations");
		return [];
	}
	async nearbyLandmarks(): Promise<never[]> {
		this.calls.push("nearbyLandmarks");
		return [];
	}
	async linesAtPoint(): Promise<Set<string>> {
		this.calls.push("linesAtPoint");
		return new Set();
	}
	async reverseGeocode(): Promise<NominatimResult | null> {
		this.calls.push("reverseGeocode");
		return null;
	}
	async nearbyTransitStops(): Promise<never[]> {
		this.calls.push("nearbyTransitStops");
		return [];
	}
	async stationsOnLine(): Promise<Station[]> {
		this.calls.push("stationsOnLine");
		return [];
	}
	async drivableRoads(): Promise<OsmRoadWay[]> {
		this.calls.push("drivableRoads");
		return [];
	}
	async walkableRoads(): Promise<OsmRoadWay[]> {
		this.calls.push("walkableRoads");
		return [];
	}
	async buildingsNear(): Promise<BuildingFootprint[]> {
		this.calls.push("buildingsNear");
		return [];
	}
}

function pt(
	osmId: number,
	featureType: string,
	subtype: string,
	name: string | null,
	lat: number,
	lon: number,
	tags: Record<string, string> = {},
): OsmPointRow {
	return { osmId, featureType, subtype, name, lat, lon, tags };
}

function ln(
	osmId: number,
	featureType: string,
	subtype: string,
	name: string | null,
	coords: Array<[number, number]>,
	tags: Record<string, string> = {},
): OsmLineRow {
	return { osmId, featureType, subtype, name, coords, tags };
}

function makeRowSet(): OsmRowSet {
	return {
		coverage: coverageForTrack([{ lat: LAT, lon: LON }]),
		points: [
			// Willesden Green: an entrance CLOSER than the station node. The
			// station must still win — see `dedupeStationsByName`.
			pt(1, "railway", "subway_entrance", "Willesden Green", LAT + 5 / MDEG, LON),
			pt(2, "railway", "station", "Willesden Green", LAT + 30 / MDEG, LON),
			pt(3, "transit_stop", "bus_stop", "Chapter Road", LAT + 10 / MDEG, LON),
			pt(4, "landmark", "cafe", "A Cafe", LAT + 12 / MDEG, LON, { amenity: "cafe" }),
			pt(5, "aeroway", "terminal", "A Terminal", LAT + 8 / MDEG, LON),
			// A railway point that is NOT a station kind. Present so dropping the
			// subtype filter is observable — without it the filter is untested.
			pt(6, "railway", "level_crossing", "Not A Station", LAT + 15 / MDEG, LON),
			// Between the drifted-default trap (20 m) and the real default
			// (200 m), so a shrunken default radius is observable.
			pt(7, "railway", "station", "Dollis Hill", LAT + 150 / MDEG, LON),
		],
		lines: [
			ln(10, "railway", "subway", "Jubilee Line", [
				[LAT + 20 / MDEG, LON - 0.01],
				[LAT + 20 / MDEG, LON + 0.01],
			]),
			ln(11, "highway", "residential", "Some Road", [
				[LAT + 5 / MDEG, LON - 0.01],
				[LAT + 5 / MDEG, LON + 0.01],
			]),
			// A landmark mapped as a WAY (a building outline), not a node —
			// present so dropping the line half of `nearbyLandmarks` is
			// observable. OSM maps institutions both ways and the picker treats
			// an enclosing footprint differently from a point POI.
			ln(
				12,
				"landmark",
				"museum",
				"A Museum",
				[
					[LAT + 10 / MDEG, LON - 0.0005],
					[LAT + 10 / MDEG, LON + 0.0005],
				],
				{ tourism: "museum" },
			),
		],
	};
}

describe("RowSetOsmAdapter refuses what it cannot answer", () => {
	const inner = new RecordingInner();
	const a = new RowSetOsmAdapter(makeRowSet(), inner);

	it("throws on a query past the coverage, naming the cause", async () => {
		// railway is buffered to 1500 m; asking at 5000 leaves it.
		await expect(a.nearbyStations(LAT, LON, 5000)).rejects.toThrow(/outside the pushed coverage/);
		await expect(a.nearbyStations(LAT, LON, 5000)).rejects.toThrow(/wider buffer/);
	});

	it("throws rather than returning the rows it happens to hold", async () => {
		// The decisive property: there ARE stations in the row-set, so a
		// degrading implementation would return them and look successful.
		const covered = await a.nearbyStations(LAT, LON, 400);
		expect(covered.length).toBeGreaterThan(0);
		await expect(a.nearbyStations(LAT, LON, 5000)).rejects.toThrow();
	});

	it("refuses a nearbyWays wider than the narrow buckets, even though railway would be fine", async () => {
		// highway/waterway/aeroway are buffered to 500 m. 800 is inside the
		// railway buffer but outside theirs, and a partial answer would silently
		// return roads short.
		await expect(a.nearbyWays(LAT, LON, 800)).rejects.toThrow(/outside the pushed coverage/);
	});

	it("does not fall back to the inner adapter on a refusal", async () => {
		const spy = new RecordingInner();
		const b = new RowSetOsmAdapter(makeRowSet(), spy);
		await expect(b.nearbyStations(LAT, LON, 5000)).rejects.toThrow();
		expect(spy.calls).not.toContain("nearbyStations");
	});
});

describe("RowSetOsmAdapter answers the kernel lookups from rows", () => {
	const a = new RowSetOsmAdapter(makeRowSet(), new RecordingInner());

	it("resolves a station through the entrance-beats-distance rule", async () => {
		const stations = await a.nearbyStations(LAT, LON, 400);
		const wg = stations.find((s) => s.name === "Willesden Green");
		// The entrance is 5 m away and the station node 30 m, and the STATION
		// wins — the asymmetry that stops the caller filtering out the entrance
		// and losing the station with it.
		expect(wg?.subtype).toBe("rail");
		expect(wg?.distanceM).toBeGreaterThan(25);
	});

	it("returns rail line names, not the road", async () => {
		expect([...(await a.linesAtPoint(LAT, LON, 300))]).toEqual(["Jubilee Line"]);
	});

	it("merges every way bucket, including aeroway points", async () => {
		const ways = await a.nearbyWays(LAT, LON, 50);
		expect(ways.map((w) => `${w.type}/${w.subtype}`)).toContain("highway/residential");
		expect(ways.map((w) => `${w.type}/${w.subtype}`)).toContain("aeroway/terminal");
	});

	it("shapes landmarks with their tag type, from BOTH points and ways", async () => {
		const marks = await a.nearbyLandmarks(LAT, LON, 100);
		expect(marks.map((m) => [m.name, m.type])).toContainEqual(["A Cafe", "amenity"]);
		// The way-mapped museum: OSM maps institutions as outlines as well as
		// nodes, and dropping the line half is otherwise invisible.
		expect(marks.map((m) => [m.name, m.type])).toContainEqual(["A Museum", "tourism"]);
	});

	it("drops railway points that are not station kinds", async () => {
		const stations = await a.nearbyStations(LAT, LON, 400);
		expect(stations.map((s) => s.name)).not.toContain("Not A Station");
	});

	it("shapes transit stops nearest-first", async () => {
		const stops = await a.nearbyTransitStops(LAT, LON, 50);
		expect(stops.map((s) => s.name)).toEqual(["Chapter Road"]);
	});

	it("applies the same default radii as the DB path when none is given", async () => {
		// A copied-and-drifted default would silently change the answer, and the
		// coverage gate could not catch it — both radii are covered. `undefined`
		// reaching the distance test would give NaN and an empty result.
		//
		// Asserting "non-empty" is NOT enough: a default shrunk to 20 m still
		// returns the 5 m entrance. The check has to name a feature that only
		// the REAL default reaches — Dollis Hill at 150 m.
		const stations = await a.nearbyStations(LAT, LON);
		expect(stations.map((s) => s.name)).toContain("Dollis Hill");
		expect([...(await a.linesAtPoint(LAT, LON))]).toEqual(["Jubilee Line"]);
		expect(await a.nearbyWays(LAT, LON)).not.toHaveLength(0);
	});
});

describe("RowSetOsmAdapter delegates what it does not own", () => {
	// `makeRowSet()` carries no `railLines`, so `stationsOnLine` delegating here
	// IS the backwards-compatibility path: a row-set captured before #414 has no
	// rail rows to compute from and must behave exactly as it always did. The
	// computed path is exercised in its own block below.
	it("passes the non-spatial and bulk readers to the inner adapter", async () => {
		const inner = new RecordingInner();
		const a = new RowSetOsmAdapter(makeRowSet(), inner);
		await a.reverseGeocode(LAT, LON);
		await a.stationsOnLine("Jubilee Line");
		await a.drivableRoads(LAT, LON, 600);
		await a.walkableRoads(LAT, LON, 600);
		await a.buildingsNear(LAT, LON, 150);
		expect(inner.calls).toEqual([
			"reverseGeocode",
			"stationsOnLine",
			"drivableRoads",
			"walkableRoads",
			"buildingsNear",
		]);
	});

	it("does not route the kernel lookups to the inner adapter", async () => {
		const inner = new RecordingInner();
		const a = new RowSetOsmAdapter(makeRowSet(), inner);
		await a.nearbyStations(LAT, LON, 400);
		await a.linesAtPoint(LAT, LON, 300);
		await a.nearbyWays(LAT, LON, 50);
		await a.nearbyLandmarks(LAT, LON, 100);
		await a.nearbyTransitStops(LAT, LON, 50);
		expect(inner.calls).toEqual([]);
	});
});

/**
 * `stationsOnLine` from pushed rail rows (#414).
 *
 * This lookup is keyed by NAME, not by bbox, so it could not ride on the
 * coverage boxes and carries its own section and its own coverage predicate.
 * The refusal matters here for a slightly different reason than it does above:
 * a short answer does not read as an error, it reads as a line that serves
 * fewer stations — and the rail-triple invariant treats "not served" as a
 * VETO, so a missing station turns into a positive assertion that a real
 * journey was impossible.
 */
describe("RowSetOsmAdapter computes stationsOnLine from pushed rail rows", () => {
	/** A north-south line with two stations on it and one 800 m off it, so the
	 *  300 m proximity filter has something to reject. */
	function railSet(): OsmRailLineSet {
		return {
			allNames: ["Jubilee Line", "Jubilee Line Northbound", "Bakerloo Line"],
			fetchedNames: ["Jubilee Line", "Jubilee Line Northbound"],
			ways: [
				{
					name: "Jubilee Line",
					coords: [
						[LAT - 0.01, LON],
						[LAT + 0.01, LON],
					],
				},
			],
			stations: [
				{ name: "On The Line", lat: LAT, lon: LON + 50 / MDEG },
				{ name: "Also On It", lat: LAT + 0.005, lon: LON - 100 / MDEG },
				{ name: "Far Away", lat: LAT, lon: LON + 800 / MDEG },
			],
		};
	}

	function withRail(rail: OsmRailLineSet): OsmRowSet {
		return { ...makeRowSet(), railLines: rail };
	}

	it("keeps the stations within 300 m and drops the rest", async () => {
		const inner = new RecordingInner();
		const a = new RowSetOsmAdapter(withRail(railSet()), inner);
		expect((await a.stationsOnLine("Jubilee Line")).map((s) => s.name)).toEqual(["On The Line", "Also On It"]);
		expect(inner.calls).toEqual([]);
	});

	it("agrees with the DB path's own filter on the same inputs", async () => {
		// The two paths must be ONE decision, not two that happen to agree. The
		// adapter reaches `filterStationsByLineProximityParsed` directly and the
		// DB reaches it through a WKT wrapper, so feeding both the same geometry
		// is what pins that they have not drifted apart.
		const rail = railSet();
		const a = new RowSetOsmAdapter(withRail(rail), new RecordingInner());
		const viaWkt = filterStationsByLineProximity(
			rail.stations,
			rail.ways.map((w) => ({ wkt: `LINESTRING(${w.coords.map(([la, lo]) => `${lo} ${la}`).join(",")})` })),
		);
		expect(await a.stationsOnLine("Jubilee Line")).toEqual(viaWkt);
	});

	it("answers a directional variant, which resolves to the same fetched names", async () => {
		// "Jubilee Line Northbound" strips to the base token "Jubilee", the same
		// as "Jubilee Line", so it expands to a set already fetched. This is why
		// candidates derived from the day's own way names cover the labels the
		// pipeline actually asks about.
		const a = new RowSetOsmAdapter(withRail(railSet()), new RecordingInner());
		expect((await a.stationsOnLine("Jubilee Line Northbound")).map((s) => s.name)).toEqual([
			"On The Line",
			"Also On It",
		]);
	});

	it("REFUSES a line whose ways were never fetched", async () => {
		const a = new RowSetOsmAdapter(withRail(railSet()), new RecordingInner());
		await expect(a.stationsOnLine("Bakerloo Line")).rejects.toThrow(/outside the pushed rail-line set/);
	});

	it("refuses rather than answering empty when the name is merely absent from `ways`", async () => {
		// "Jubilee Line Northbound" IS in `fetchedNames` but has no way rows —
		// a legitimate empty. "Bakerloo Line" is in neither, and the difference
		// between the two is exactly what `fetchedNames` exists to record: an
		// empty answer and an unfetched one are indistinguishable from `ways`.
		const rail = railSet();
		const a = new RowSetOsmAdapter(withRail(rail), new RecordingInner());
		expect(rail.ways.some((w) => w.name === "Jubilee Line Northbound")).toBe(false);
		await expect(a.stationsOnLine("Jubilee Line Northbound")).resolves.not.toHaveLength(0);
		await expect(a.stationsOnLine("Bakerloo Line")).rejects.toThrow();
	});

	it("matches way names case-INSENSITIVELY, as MariaDB's collation does", async () => {
		// The mirror really carries both "North London line" and "North London
		// Line", and `SELECT DISTINCT name` collapses them under
		// `utf8mb4_general_ci`, so only one spelling reaches `allNames` while the
		// DB's `name IN (…)` still selects the ways of BOTH. Filtering the pushed
		// ways by exact string dropped the other spelling's ways and with them two
		// real stations — 06-23, caught by the parity referee.
		const rail = railSet();
		rail.ways.push({
			name: "JUBILEE LINE",
			coords: [
				[LAT + 0.004, LON - 200 / MDEG],
				[LAT + 0.006, LON - 200 / MDEG],
			],
		});
		rail.stations.push({ name: "Only Near The Shouty Way", lat: LAT + 0.005, lon: LON - 150 / MDEG });
		const a = new RowSetOsmAdapter(withRail(rail), new RecordingInner());
		expect((await a.stationsOnLine("Jubilee Line")).map((s) => s.name)).toContain("Only Near The Shouty Way");
	});

	it("returns empty for a label that resolves to nothing at all", async () => {
		// A name whose base token matches no mirror name expands to the empty
		// set, which is vacuously covered — there is nothing missing. That is a
		// real empty answer, not a refusal.
		const a = new RowSetOsmAdapter(withRail(railSet()), new RecordingInner());
		expect(await a.stationsOnLine("Nonexistent Line")).toEqual([]);
	});
});
