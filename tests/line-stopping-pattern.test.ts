/**
 * Which of two lines sharing a track did the train run on?
 *
 * Where two lines share a corridor, neither the endpoints nor the mid-ride
 * fixes can separate them — the trains run on the same rails. What differs is
 * where they STOP: the Metropolitan runs fast past Neasden, Dollis Hill,
 * Willesden Green and Kilburn; the Jubilee calls at all of them. So the same
 * Wembley Park → Finchley Road distance takes one train half as long as the
 * other, and the elapsed time says which one was ridden.
 */

import { describe, expect, it } from "vitest";
import { expectedDurationS } from "../src/geo/line-stopping-pattern.js";
import type { RailStopRelation } from "../src/geo/osm-rail-stops.js";

/** A route relation stopping at `names`, in order. Coordinates are irrelevant
 *  here — the ordered stop list is what carries the stopping pattern. */
function relation(line: string, names: string[], osmRelationId = 1): RailStopRelation {
	return {
		osmRelationId,
		routeType: "subway",
		lineRef: null,
		lineName: line,
		stops: names.map((name, seq) => ({ name, lat: 0, lon: 0, seq })),
	};
}

/** The fast line skips the four intermediate stations the all-stops line calls
 *  at — the Metropolitan / Jubilee shape between Wembley Park and Finchley
 *  Road, with the names kept synthetic. */
const FAST = relation("Fast Line", ["Alpha", "Epsilon"], 1);
const ALL_STOPS = relation("Stopping Line", ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"], 2);
const RELATIONS = [FAST, ALL_STOPS];
const CANDIDATES = ["Fast Line", "Stopping Line"];

describe("expectedDurationS — hop counting", () => {
	it("counts the stations a line actually calls at between two stops", () => {
		// The whole point: same two endpoints, wildly different stopping
		// patterns. One hop for the fast service, five for the all-stops one.
		expect(expectedDurationS("Fast Line", "Alpha", "Epsilon", RELATIONS)).toBe(120);
		expect(expectedDurationS("Stopping Line", "Alpha", "Epsilon", RELATIONS)).toBe(480);
	});

	it("reads the stop list in either direction — a relation is one direction of the service", () => {
		const reversed = [
			relation("Fast Line", ["Epsilon", "Alpha"], 3),
			relation("Stopping Line", ["Epsilon", "Delta", "Gamma", "Beta", "Alpha"], 4),
		];
		expect(expectedDurationS("Fast Line", "Alpha", "Epsilon", reversed)).toBe(120);
		expect(expectedDurationS("Stopping Line", "Alpha", "Epsilon", reversed)).toBe(480);
	});

	it("says nothing when the mirror has no relation stopping at both endpoints", () => {
		// Unknown is not evidence — the caller must stay inert without data.
		expect(expectedDurationS("Fast Line", "Alpha", "Omega", RELATIONS)).toBeNull();
		expect(expectedDurationS("Unmapped Line", "Alpha", "Epsilon", RELATIONS)).toBeNull();
	});
});
