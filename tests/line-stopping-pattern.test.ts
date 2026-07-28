/**
 * Which of two lines sharing a track did the train run on?
 *
 * Where two lines share a corridor, neither the endpoints nor the mid-ride
 * fixes can separate them — the trains run on the same rails. What differs is
 * where they STOP: the Metropolitan runs fast past Neasden, Dollis Hill,
 * Willesden Green and Kilburn; the Jubilee calls at all of them. So the ride's
 * own speed profile says which pattern it ran, and the tests below pin both
 * halves of that: the stop counts read out of the mirror, and the bounds the
 * fix stream puts on how many stops the train can have made.
 */

import { describe, expect, it } from "vitest";
import type { FilteredPoint } from "../src/geo/kalman.js";
import { intermediateStopCount, pickLineByStoppingPattern, stopBounds } from "../src/geo/line-stopping-pattern.js";
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

/** The fast line skips the three intermediate stations the all-stops line
 *  calls at — the Metropolitan / Jubilee shape between Wembley Park and
 *  Finchley Road, with the names kept synthetic. */
const FAST = relation("Fast Line", ["Alpha", "Epsilon"], 1);
const ALL_STOPS = relation("Stopping Line", ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"], 2);
const RELATIONS = [FAST, ALL_STOPS];
const CANDIDATES = ["Fast Line", "Stopping Line"];

const T0 = 1_750_000_000;

/** A fix stream from a speed profile: one fix every `stepS` seconds. */
function ride(speeds: number[], stepS = 15): FilteredPoint[] {
	return speeds.map((speed_kmh, i) => ({
		ts: T0 + i * stepS,
		lat: 51.5,
		lon: -0.2,
		speed_kmh,
		bearing: 0,
		accuracy: 10,
	}));
}

const ends = (points: FilteredPoint[]): [number, number] => [points[0].ts, points[points.length - 1].ts];

/** Sixty km/h held for `n` fixes. */
const running = (n: number) => Array.from({ length: n }, () => 60);
/** A station call: brake, stand, accelerate away. */
const stop = () => [20, 0, 0, 20];

describe("intermediateStopCount", () => {
	it("counts the stations a line actually calls at in between", () => {
		// The whole point: same two endpoints, wildly different stopping
		// patterns. Non-stop for the fast service, three calls for the other.
		expect(intermediateStopCount("Fast Line", "Alpha", "Epsilon", RELATIONS)).toBe(0);
		expect(intermediateStopCount("Stopping Line", "Alpha", "Epsilon", RELATIONS)).toBe(3);
	});

	it("reads the stop list in either direction — a relation is one direction of the service", () => {
		const reversed = [
			relation("Fast Line", ["Epsilon", "Alpha"], 3),
			relation("Stopping Line", ["Epsilon", "Delta", "Gamma", "Beta", "Alpha"], 4),
		];
		expect(intermediateStopCount("Fast Line", "Alpha", "Epsilon", reversed)).toBe(0);
		expect(intermediateStopCount("Stopping Line", "Alpha", "Epsilon", reversed)).toBe(3);
	});

	it("says nothing when the mirror has no relation stopping at both endpoints", () => {
		// Unknown is not evidence — the caller must stay inert without data.
		expect(intermediateStopCount("Fast Line", "Alpha", "Omega", RELATIONS)).toBeNull();
		expect(intermediateStopCount("Unmapped Line", "Alpha", "Epsilon", RELATIONS)).toBeNull();
	});
});

describe("stopBounds", () => {
	it("bounds a densely-observed non-stop ride at zero stops", () => {
		const points = ride([0, 0, ...running(20), 0, 0]);
		expect(stopBounds(points, ...ends(points))).toEqual({ atLeast: 0, atMost: 0 });
	});

	it("counts the pauses a stopping ride actually made", () => {
		const points = ride([0, 0, ...running(6), ...stop(), ...running(6), ...stop(), ...running(6), 0, 0]);
		expect(stopBounds(points, ...ends(points))?.atLeast).toBe(2);
	});

	it("does not credit the platform wait with stops it did not make", () => {
		// Six minutes of standing before the train pulls away is the boarding
		// wait, not six station calls — it precedes any observed motion.
		const points = ride([...Array(24).fill(0), ...running(20)]);
		expect(stopBounds(points, ...ends(points))).toEqual({ atLeast: 0, atMost: 0 });
	});

	it("allows for the stops that could have hidden in a long unobserved gap", () => {
		// Two dense halves either side of five unwatched minutes. Nothing
		// observed says the train stopped; nothing rules it out either.
		const first = ride(running(10));
		const second = ride(running(10)).map((p) => ({ ...p, ts: p.ts + 10 * 15 + 300 }));
		const points = [...first, ...second];
		const bounds = stopBounds(points, ...ends(points));
		expect(bounds?.atLeast).toBe(0);
		expect(bounds?.atMost).toBeGreaterThan(3);
	});

	it("says nothing about a ride never observed running", () => {
		// All coarse cell fixes at a crawl: no motion to bound stops between.
		expect(stopBounds(ride([0, 2, 1, 3, 0, 1]), T0, T0 + 75)).toBeNull();
	});
});

describe("pickLineByStoppingPattern", () => {
	const pick = (points: FilteredPoint[]) =>
		pickLineByStoppingPattern(CANDIDATES, "Alpha", "Epsilon", RELATIONS, points, ...ends(points));

	it("names the fast line when the train demonstrably ran past the stations", () => {
		expect(pick(ride([0, 0, ...running(20), 0, 0]))).toBe("Fast Line");
	});

	it("names the all-stops line when the train made the calls", () => {
		const points = ride([
			0,
			0,
			...running(5),
			...stop(),
			...running(5),
			...stop(),
			...running(5),
			...stop(),
			...running(5),
			0,
			0,
		]);
		expect(pick(points)).toBe("Stopping Line");
	});

	it("stays silent when the ride leaves both patterns possible", () => {
		// A five-minute hole is room for either service to have done what it
		// does. Silence here is the point: the caller emits a bare station pair
		// rather than a line name it cannot support.
		const first = ride(running(10));
		const second = ride(running(10)).map((p) => ({ ...p, ts: p.ts + 10 * 15 + 300 }));
		expect(pick([...first, ...second])).toBeNull();
	});

	it("stays silent when the mirror has no stop list for one of the candidates", () => {
		// The survivor would then be an artefact of missing data, not of the ride.
		const points = ride([0, 0, ...running(20), 0, 0]);
		expect(
			pickLineByStoppingPattern(["Fast Line", "Unmapped Line"], "Alpha", "Epsilon", RELATIONS, points, ...ends(points)),
		).toBeNull();
	});
});
