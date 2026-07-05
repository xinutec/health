/**
 * `stationsOnLine` — given a named rail line, return the set of
 * stations that line serves.
 *
 * The HMM hard-zero transition rule "line L cannot serve focus place
 * P" depends on this lookup. Today's `linesAtPoint` answers the
 * inverse (which lines run near a given point); the membership
 * direction requires either ingesting OSM relation members (not
 * currently mirrored) or inferring from spatial proximity between
 * station points and the line's way geometry.
 *
 * This module uses the spatial-proximity inference because the local
 * OSM mirror already has both osm_lines (rail-line ways with name)
 * and osm_points (stations with railway tag). Tests pin the pure
 * `filterStationsByLineProximity` helper; the DB-backed `stationsOnLine`
 * is exercised via the helper.
 */

import { describe, expect, it } from "vitest";
import { filterStationsByLineProximity, type StationCandidate, type WayGeometry } from "../src/geo/line-stations.js";

function lineToWkt(coords: Array<[number, number]>): string {
	// coords are [lat, lon] pairs; WKT wants lon lat space-separated.
	const pairs = coords.map(([lat, lon]) => `${lon} ${lat}`).join(",");
	return `LINESTRING(${pairs})`;
}

function station(name: string, lat: number, lon: number): StationCandidate {
	return { name, lat, lon };
}

function way(coords: Array<[number, number]>): WayGeometry {
	return { wkt: lineToWkt(coords) };
}

describe("filterStationsByLineProximity", () => {
	it("returns empty when there are no ways", () => {
		const result = filterStationsByLineProximity([station("Foo", 51.5, -0.1)], []);
		expect(result).toEqual([]);
	});

	it("returns empty when there are no station candidates", () => {
		const result = filterStationsByLineProximity(
			[],
			[
				way([
					[51.5, -0.1],
					[51.5, -0.09],
				]),
			],
		);
		expect(result).toEqual([]);
	});

	it("keeps a station within MAX_DIST_M of any way of the line", () => {
		// Way runs along latitude 51.5 from lon -0.1 to lon -0.09.
		// Station at (51.5001, -0.095) — ~11m perpendicular to the way.
		const stations = [station("Close", 51.5001, -0.095)];
		const ways = [
			way([
				[51.5, -0.1],
				[51.5, -0.09],
			]),
		];
		const result = filterStationsByLineProximity(stations, ways);
		expect(result.map((s) => s.name)).toEqual(["Close"]);
	});

	it("rejects a station further than MAX_DIST_M from all ways", () => {
		// Way as above; station 500m north.
		const stations = [station("Far", 51.505, -0.095)];
		const ways = [
			way([
				[51.5, -0.1],
				[51.5, -0.09],
			]),
		];
		const result = filterStationsByLineProximity(stations, ways);
		expect(result).toEqual([]);
	});

	it("dedupes by station name across multiple matching ways", () => {
		// Two way segments meet at (51.5, -0.095). Station is at that
		// junction — close to both ways.
		const stations = [station("Junction", 51.5, -0.095)];
		const ways = [
			way([
				[51.5, -0.1],
				[51.5, -0.095],
			]),
			way([
				[51.5, -0.095],
				[51.5, -0.09],
			]),
		];
		const result = filterStationsByLineProximity(stations, ways);
		expect(result).toEqual([{ name: "Junction", lat: 51.5, lon: -0.095 }]);
	});

	it("returns stations in input order (no shuffling)", () => {
		const stations = [
			station("Alpha", 51.5001, -0.099),
			station("Bravo", 51.5001, -0.095),
			station("Charlie", 51.5001, -0.091),
		];
		const ways = [
			way([
				[51.5, -0.1],
				[51.5, -0.09],
			]),
		];
		const result = filterStationsByLineProximity(stations, ways);
		expect(result.map((s) => s.name)).toEqual(["Alpha", "Bravo", "Charlie"]);
	});
});
