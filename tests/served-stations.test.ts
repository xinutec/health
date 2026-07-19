import { describe, expect, it } from "vitest";
import type { RailStopRelation } from "../src/geo/osm-rail-stops.js";
import { normalizeStationName, servedStationSet, stationNameServed } from "../src/hmm/served-stations.js";

/**
 * Served-station membership matching (#364 phase 2). Pins the matching
 * rules measured against the live mirror: punctuation-insensitive
 * normalization, guarded containment ("London St Pancras" matches the
 * POI "London St Pancras International"; "Euston" must NOT match "Euston
 * Square" — a different station), the minimum-stops trust gate, and the
 * no-data-means-null contract.
 */

function rel(id: number, line: string, stopNames: readonly (string | null)[]): RailStopRelation {
	return {
		osmRelationId: id,
		routeType: "subway",
		lineRef: line,
		lineName: `${line} line: A → B`,
		stops: stopNames.map((name, i) => ({ name, lat: 51.5 + i * 0.01, lon: -0.1, seq: i })),
	};
}

const MET = rel(1, "Metropolitan", [
	"Aldgate",
	"King's Cross St Pancras",
	"Baker Street",
	"Finchley Road",
	"Wembley Park",
	"Harrow-on-the-Hill",
]);
const JUBILEE = rel(2, "Jubilee", [
	"Baker Street",
	"St John's Wood",
	"West Hampstead",
	"Kilburn",
	"Dollis Hill",
	"Wembley Park",
]);

describe("normalizeStationName", () => {
	it("is punctuation- and case-insensitive", () => {
		expect(normalizeStationName("King's Cross St. Pancras")).toBe(normalizeStationName("king's cross st pancras"));
	});
});

describe("servedStationSet", () => {
	it("unions named stops across a line's relations", () => {
		const served = servedStationSet([MET, JUBILEE], "Metropolitan");
		expect(served).not.toBeNull();
		expect(served?.has(normalizeStationName("Wembley Park"))).toBe(true);
		expect(served?.has(normalizeStationName("Dollis Hill"))).toBe(false);
	});

	it("returns null for a line with no matching relations (no data, not 'serves nothing')", () => {
		expect(servedStationSet([MET, JUBILEE], "Elizabeth")).toBeNull();
	});

	it("returns null when the matched relations union to too few stops to trust", () => {
		const stub = rel(9, "Waterloo & City", ["Bank", "Waterloo"]);
		expect(servedStationSet([stub], "Waterloo & City")).toBeNull();
	});
});

describe("stationNameServed", () => {
	const met = servedStationSet([MET, JUBILEE], "Metropolitan");
	if (met === null) throw new Error("test setup: Met served set missing");

	it("matches punctuation variants exactly", () => {
		expect(stationNameServed(met, "King's Cross St. Pancras")).toBe(true);
	});

	it("rejects a station the line passes but does not stop at", () => {
		expect(stationNameServed(met, "Dollis Hill")).toBe(false);
	});

	it("rejects the co-located NR names at a complex the tube line calls at", () => {
		expect(stationNameServed(met, "London King's Cross")).toBe(false);
		expect(stationNameServed(met, "London St Pancras International")).toBe(false);
	});

	it("accepts a long-name suffix variant via guarded containment", () => {
		const nr = servedStationSet(
			[
				rel(3, "Thameslink", [
					"London St Pancras",
					"Farringdon",
					"City Thameslink",
					"London Blackfriars",
					"East Croydon",
				]),
			],
			"Thameslink",
		);
		if (nr === null) throw new Error("test setup: Thameslink served set missing");
		expect(stationNameServed(nr, "London St Pancras International")).toBe(true);
	});

	it("refuses short-name containment: Euston is not Euston Square", () => {
		const victoria = servedStationSet(
			[rel(4, "Victoria", ["Brixton", "Vauxhall", "Victoria", "Euston", "King's Cross St Pancras"])],
			"Victoria",
		);
		if (victoria === null) throw new Error("test setup: Victoria served set missing");
		expect(stationNameServed(victoria, "Euston Square")).toBe(false);
		expect(stationNameServed(victoria, "Euston")).toBe(true);
	});
});
