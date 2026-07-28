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
import { pickLineByStoppingPattern } from "../src/geo/line-stopping-pattern.js";
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

describe("pickLineByStoppingPattern", () => {
	it("picks the fast line when the ride was too quick to have stopped four times", () => {
		// One hop at ~120 s: only the non-stopping service fits.
		expect(pickLineByStoppingPattern(CANDIDATES, "Alpha", "Epsilon", 130, RELATIONS)).toBe("Fast Line");
	});

	it("picks the all-stops line when the ride took as long as calling everywhere", () => {
		// Five hops at ~120 s each.
		expect(pickLineByStoppingPattern(CANDIDATES, "Alpha", "Epsilon", 600, RELATIONS)).toBe("Stopping Line");
	});

	it("refuses when the elapsed time fits both candidates about equally", () => {
		// The two predictions are 120 s (one hop) and 480 s (four), so 300 s
		// misses both by the same 180 s and is evidence for neither.
		expect(pickLineByStoppingPattern(CANDIDATES, "Alpha", "Epsilon", 300, RELATIONS)).toBeNull();
	});

	it("refuses when the mirror has no stop data for a candidate — unknown is not evidence", () => {
		// Without the rival's stopping pattern there is nothing to compare
		// against, so a good fit for the one known line proves nothing.
		expect(pickLineByStoppingPattern(CANDIDATES, "Alpha", "Epsilon", 130, [FAST])).toBeNull();
	});

	it("refuses when a candidate does not stop at both endpoints", () => {
		// The endpoints are what the ride is anchored to; a line whose stop list
		// does not contain them cannot be scored on this evidence.
		expect(pickLineByStoppingPattern(CANDIDATES, "Alpha", "Omega", 130, RELATIONS)).toBeNull();
	});

	it("reads the stop list in either direction — a relation is one direction of the service", () => {
		// The Jubilee's southbound relation lists Epsilon first; the ride is the
		// same four stops whichever way round the relation was mapped.
		const reversed = [
			relation("Fast Line", ["Epsilon", "Alpha"], 3),
			relation("Stopping Line", ["Epsilon", "Delta", "Gamma", "Beta", "Alpha"], 4),
		];
		expect(pickLineByStoppingPattern(CANDIDATES, "Alpha", "Epsilon", 130, reversed)).toBe("Fast Line");
	});
});
