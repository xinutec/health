import { describe, expect, it } from "vitest";
import type { RailStopRelation } from "../src/geo/osm-rail-stops.js";
import {
	parseRailStopsRow,
	railRelationsForLine,
	serializeRailStopRelation,
	servedStationNames,
} from "../src/geo/rail-stops-cache.js";

/**
 * `rail_stops_cache` (de)serialization + the line-matching read helpers.
 * Pins: row ⇄ relation round-trip, corrupt rows degrade to null (never a
 * throw on a read path), and `railRelationsForLine` matches a pipeline
 * line label ("Metropolitan Line") against relation ref/name via the same
 * base-token normalization `stationsOnLine` uses — inert (empty) when
 * nothing matches.
 */

function rel(over: Partial<RailStopRelation>): RailStopRelation {
	return {
		osmRelationId: 1,
		routeType: "subway",
		lineRef: null,
		lineName: null,
		stops: [
			{ name: "A", lat: 51.5, lon: -0.2, seq: 0 },
			{ name: "B", lat: 51.5, lon: -0.1, seq: 1 },
		],
		...over,
	};
}

describe("serialize/parse round-trip", () => {
	it("round-trips a relation through its cache row", () => {
		const r = rel({ osmRelationId: 42, routeType: "train", lineRef: "TL", lineName: "Thameslink: Bedford → Brighton" });
		const parsed = parseRailStopsRow(serializeRailStopRelation(r));
		expect(parsed).toEqual(r);
	});

	it("narrows a bigint relation id from the DB driver", () => {
		const row = serializeRailStopRelation(rel({ osmRelationId: 7 }));
		const parsed = parseRailStopsRow({ ...row, osm_relation_id: 7n });
		expect(parsed?.osmRelationId).toBe(7);
	});

	it("returns null on malformed stops_json", () => {
		const row = { ...serializeRailStopRelation(rel({})), stops_json: "{not json" };
		expect(parseRailStopsRow(row)).toBeNull();
	});

	it("returns null on a row left with fewer than two stops", () => {
		const row = {
			...serializeRailStopRelation(rel({})),
			stops_json: JSON.stringify([{ name: "A", lat: 51.5, lon: -0.2, seq: 0 }]),
		};
		expect(parseRailStopsRow(row)).toBeNull();
	});
});

describe("railRelationsForLine", () => {
	const relations = [
		rel({ osmRelationId: 1, lineName: "Metropolitan line: Aldgate → Uxbridge" }),
		rel({ osmRelationId: 2, lineName: "Metropolitan line: Uxbridge → Aldgate" }),
		rel({ osmRelationId: 3, lineName: "Jubilee line: Stanmore → Stratford" }),
		rel({ osmRelationId: 4, routeType: "train", lineRef: "TL", lineName: null }),
	];

	it("matches a pipeline line label against relation names via the base token", () => {
		const hits = railRelationsForLine(relations, "Metropolitan Line");
		expect(hits.map((r) => r.osmRelationId)).toEqual([1, 2]);
	});

	it("matches against the ref when the relation has no name", () => {
		const hits = railRelationsForLine(relations, "TL");
		expect(hits.map((r) => r.osmRelationId)).toEqual([4]);
	});

	it("is case-insensitive", () => {
		expect(railRelationsForLine(relations, "jubilee")).toHaveLength(1);
	});

	it("returns empty when nothing matches (consumers must stay inert)", () => {
		expect(railRelationsForLine(relations, "Elizabeth Line")).toEqual([]);
	});

	it("returns empty for a label that strips to an empty base token", () => {
		expect(railRelationsForLine(relations, " lines to nowhere")).toEqual([]);
	});
});

describe("servedStationNames", () => {
	it("unions named stops across relations, skipping unnamed stop nodes", () => {
		const a = rel({
			osmRelationId: 1,
			stops: [
				{ name: "Wembley Park", lat: 51.56, lon: -0.28, seq: 0 },
				{ name: null, lat: 51.55, lon: -0.25, seq: 1 },
				{ name: "Baker Street", lat: 51.52, lon: -0.16, seq: 2 },
			],
		});
		const b = rel({
			osmRelationId: 2,
			stops: [
				{ name: "Baker Street", lat: 51.52, lon: -0.16, seq: 0 },
				{ name: "Wembley Park", lat: 51.56, lon: -0.28, seq: 1 },
			],
		});
		expect([...servedStationNames([a, b])].sort()).toEqual(["Baker Street", "Wembley Park"]);
	});
});
