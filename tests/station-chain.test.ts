/**
 * C4.3 chained train triples (`docs/proposals/2026-07-continuity-c4.md`):
 * the post-decode station resolver that turns decoded train legs into
 * (board, alight) station pairs, scored jointly along the journey chain.
 *
 * The acceptance contract:
 *
 *   - A dark ride bracketed by fixes at two stations resolves to that
 *     station pair (board from the pre-ride fix, alight from the
 *     reacquisition fix).
 *   - Two chained legs with an unobserved interchange resolve to a
 *     SHARED interchange station — the chain constraint recovers what
 *     no per-leg anchor can see (the erased-interchange class, #351 /
 *     C4 mechanisms 2+3).
 *   - When the evidence cannot separate two candidate stations, the
 *     resolver emits null for that side rather than guessing — the
 *     scoreboard counts a wrong station as worse than a missing one.
 *   - Legs without a named line are not resolved.
 */

import { describe, expect, it } from "vitest";
import { buildRouteGraph, type RawOsmLine, type RawOsmPoint } from "../src/geo/route-graph.js";
import type { Observation } from "../src/hmm/observation.js";
import type { HmmSegment } from "../src/hmm/persist.js";
import { resolveStationChain } from "../src/hmm/station-chain.js";

const BASE_TS = 1_700_000_000;

function makeLine(over: Partial<RawOsmLine>): RawOsmLine {
	return {
		osm_id: 1n,
		osm_type: "way",
		feature_type: "railway",
		subtype: "subway",
		name: null,
		tags_json: null,
		geom: "LINESTRING(0 0, 1 1)",
		...over,
	};
}

function makeStation(osmId: bigint, name: string, p: { lat: number; lon: number }): RawOsmPoint {
	return {
		osm_id: osmId,
		osm_type: "node",
		name,
		tags_json: JSON.stringify({ railway: "station", public_transport: "station" }),
		lat: p.lat,
		lon: p.lon,
	};
}

function wkt(...pts: { lat: number; lon: number }[]): string {
	return `LINESTRING(${pts.map((p) => `${p.lon} ${p.lat}`).join(", ")})`;
}

// Same synthetic geography as the train-candidate-generator tests, plus
// EastCarfax 300 m east of Carfax for the ambiguity case.
//
//   ASHVALE ── BROOKDEN ── CARFAX ── EASTCARFAX   (Metropolitan)
//                             │
//                          FARVALE                (Jubilee only;
//                                                  Jubilee shares the
//                                                  Ashvale–Carfax track)
const ASHVALE = { lat: 51.5635, lon: -0.2796 };
const BROOKDEN = { lat: 51.5474, lon: -0.1809 };
const CARFAX = { lat: 51.5226, lon: -0.1571 };
const EASTCARFAX = { lat: 51.5226, lon: -0.15277 };
const FARVALE = { lat: 51.5067, lon: -0.1428 };

/** EastCarfax (300 m from Carfax on the same Met track) exists only in
 *  the ambiguity scenario — with it in the graph, "alight EastCarfax and
 *  walk" is genuinely indistinguishable from "alight Carfax", which is
 *  exactly what the null-not-guess case pins. */
function buildScenarioGraph(withEastCarfax = false) {
	const lines = [
		makeLine({ osm_id: 1n, name: "Metropolitan and Jubilee Lines", geom: wkt(ASHVALE, BROOKDEN) }),
		makeLine({ osm_id: 2n, name: "Metropolitan and Jubilee Lines", geom: wkt(BROOKDEN, CARFAX) }),
		makeLine({ osm_id: 4n, name: "Jubilee Line", geom: wkt(CARFAX, FARVALE) }),
	];
	const stations = [
		makeStation(101n, "Ashvale", ASHVALE),
		makeStation(102n, "Brookden", BROOKDEN),
		makeStation(103n, "Carfax", CARFAX),
		makeStation(105n, "Farvale", FARVALE),
	];
	if (withEastCarfax) {
		lines.push(makeLine({ osm_id: 3n, name: "Metropolitan Line", geom: wkt(CARFAX, EASTCARFAX) }));
		stations.push(makeStation(104n, "East Carfax", EASTCARFAX));
	}
	return buildRouteGraph(lines, stations);
}

function obsAt(minute: number, gps: { lat: number; lon: number; speedKmh: number } | null): Observation {
	return {
		ts: BASE_TS + minute * 60,
		gps,
		hr: null,
		cadence: null,
		hourLocal: 9,
		dayOfWeekLocal: 4,
		inBed: false,
		prevGpsFix: null,
		nextGpsFix: null,
	};
}

/** Minutes [from, to) share one shape; gaps stay GPS-null. */
function buildObservations(
	totalMinutes: number,
	fixes: { from: number; to: number; at: { lat: number; lon: number }; speedKmh?: number }[],
): Observation[] {
	const out: Observation[] = [];
	for (let m = 0; m < totalMinutes; m++) {
		const span = fixes.find((f) => m >= f.from && m < f.to);
		out.push(
			obsAt(m, span === undefined ? null : { lat: span.at.lat, lon: span.at.lon, speedKmh: span.speedKmh ?? 3 }),
		);
	}
	// Fill prev/next fix bookends the way the tensor builder does.
	let prev: { ts: number; lat: number; lon: number } | null = null;
	for (const o of out) {
		if (o.gps !== null) prev = { ts: o.ts, lat: o.gps.lat, lon: o.gps.lon };
		o.prevGpsFix = prev;
	}
	let next: { ts: number; lat: number; lon: number } | null = null;
	for (let i = out.length - 1; i >= 0; i--) {
		const o = out[i];
		if (o.gps !== null) next = { ts: o.ts, lat: o.gps.lat, lon: o.gps.lon };
		o.nextGpsFix = next;
	}
	return out;
}

function seg(fromMin: number, toMin: number, mode: HmmSegment["mode"], lineName: string | null = null): HmmSegment {
	return {
		startTs: BASE_TS + fromMin * 60,
		endTs: BASE_TS + toMin * 60,
		mode,
		placeId: null,
		lineName,
	};
}

describe("resolveStationChain", () => {
	it("resolves a dark ride's board and alight from the bracketing fixes", () => {
		const graph = buildScenarioGraph();
		const observations = buildObservations(27, [
			{ from: 0, to: 5, at: ASHVALE, speedKmh: 2 },
			{ from: 23, to: 27, at: CARFAX, speedKmh: 4 },
		]);
		const segments = [seg(0, 5, "stationary"), seg(5, 23, "train", "Metropolitan Line"), seg(23, 27, "walking")];
		const resolved = resolveStationChain({ segments, observations, routeGraph: graph });
		expect(resolved.get(1)).toEqual({ board: "Ashvale", alight: "Carfax" });
	});

	it("recovers an unobserved interchange: chained legs meet at the shared station", () => {
		const graph = buildScenarioGraph();
		// Fixes only at the journey's ends: Ashvale before, Farvale after.
		// The Met leg (20 min ≈ Ashvale→Carfax) chains into the Jubilee leg
		// (4 min ≈ Carfax→Farvale) across a dark 3-minute interchange walk.
		const observations = buildObservations(36, [
			{ from: 0, to: 5, at: ASHVALE, speedKmh: 2 },
			{ from: 32, to: 36, at: FARVALE, speedKmh: 3 },
		]);
		const segments = [
			seg(0, 5, "stationary"),
			seg(5, 25, "train", "Metropolitan Line"),
			seg(25, 28, "walking"),
			seg(28, 32, "train", "Jubilee Line"),
			seg(32, 36, "walking"),
		];
		const resolved = resolveStationChain({ segments, observations, routeGraph: graph });
		expect(resolved.get(1)).toEqual({ board: "Ashvale", alight: "Carfax" });
		expect(resolved.get(3)).toEqual({ board: "Carfax", alight: "Farvale" });
	});

	it("emits null instead of guessing between two indistinguishable alights", () => {
		const graph = buildScenarioGraph(true);
		// Reacquisition fix midway between Carfax and East Carfax (~150 m
		// from each); ride duration can't separate a 300 m path difference.
		const midpoint = { lat: 51.5226, lon: (CARFAX.lon + EASTCARFAX.lon) / 2 };
		const observations = buildObservations(27, [
			{ from: 0, to: 5, at: ASHVALE, speedKmh: 2 },
			{ from: 23, to: 27, at: midpoint, speedKmh: 3 },
		]);
		const segments = [seg(0, 5, "stationary"), seg(5, 23, "train", "Metropolitan Line"), seg(23, 27, "walking")];
		const resolved = resolveStationChain({ segments, observations, routeGraph: graph });
		expect(resolved.get(1)?.board).toBe("Ashvale");
		expect(resolved.get(1)?.alight).toBeNull();
	});

	it("does not resolve legs without a named line", () => {
		const graph = buildScenarioGraph();
		const observations = buildObservations(27, [
			{ from: 0, to: 5, at: ASHVALE, speedKmh: 2 },
			{ from: 23, to: 27, at: CARFAX, speedKmh: 4 },
		]);
		const segments = [seg(0, 5, "stationary"), seg(5, 23, "train", "unknown_rail"), seg(23, 27, "walking")];
		const resolved = resolveStationChain({ segments, observations, routeGraph: graph });
		expect(resolved.size).toBe(0);
	});

	it("resolves nothing when no station is near a fresh anchor", () => {
		const graph = buildScenarioGraph();
		// Fresh fixes 2+ km from any station on both sides.
		const nowhereA = { lat: 51.58, lon: -0.05 };
		const nowhereB = { lat: 51.6, lon: -0.02 };
		const observations = buildObservations(20, [
			{ from: 0, to: 5, at: nowhereA, speedKmh: 2 },
			{ from: 15, to: 20, at: nowhereB, speedKmh: 4 },
		]);
		const segments = [seg(0, 5, "stationary"), seg(5, 15, "train", "Metropolitan Line"), seg(15, 20, "walking")];
		const resolved = resolveStationChain({ segments, observations, routeGraph: graph });
		expect(resolved.size).toBe(0);
	});
});
