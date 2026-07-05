/**
 * Tube-journey assembler — Phase B of
 * `docs/proposals/decoder-roadmap.md`.
 *
 * Composes the per-minute decoded state list + train-candidate
 * generator output + route graph into tube-journey segments. A
 * tube journey is a maximal contiguous run of minutes that
 * belong to the same logical tube event: train rides interleaved
 * with intra-station walks and platform waits, bracketed by
 * surface-entry / surface-exit at a tube station POI.
 *
 * Per-minute classifications are preserved verbatim — the
 * assembler doesn't relabel any minute. It produces *additional*
 * segment-level structure on top of the per-minute decode.
 */

import { describe, expect, it } from "vitest";
import { buildRouteGraph, type RawOsmLine, type RawOsmPoint, type RouteGraph } from "../src/geo/route-graph.js";
import type { Observation } from "../src/hmm/observation.js";
import type { State } from "../src/hmm/state-space.js";
import type { TrainCandidate } from "../src/hmm/train-candidate-generator.js";
import { assembleTubeJourneys } from "../src/hmm/tube-journey-assembler.js";

const ASHVALE = { lat: 51.5635, lon: -0.2796 };
const BROOKDEN = { lat: 51.5474, lon: -0.1809 };
const CARFAX = { lat: 51.5226, lon: -0.1571 };
const FARVALE = { lat: 51.5067, lon: -0.1428 };
const OUTSIDE = { lat: 51.5067, lon: -0.15 }; // ~500m from Farvale

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
		tags_json: JSON.stringify({ railway: "station", public_transport: "station", subway: "yes" }),
		lat: p.lat,
		lon: p.lon,
	};
}

function wkt(...pts: { lat: number; lon: number }[]): string {
	return `LINESTRING(${pts.map((p) => `${p.lon} ${p.lat}`).join(", ")})`;
}

function buildScenarioGraph(): RouteGraph {
	return buildRouteGraph(
		[
			makeLine({ osm_id: 1n, name: "Metropolitan and Jubilee Lines", geom: wkt(ASHVALE, BROOKDEN) }),
			makeLine({ osm_id: 2n, name: "Metropolitan and Jubilee Lines", geom: wkt(BROOKDEN, CARFAX) }),
			makeLine({ osm_id: 3n, name: "Jubilee Line", geom: wkt(CARFAX, FARVALE) }),
		],
		[
			makeStation(101n, "Ashvale", ASHVALE),
			makeStation(102n, "Brookden", BROOKDEN),
			makeStation(103n, "Carfax", CARFAX),
			makeStation(104n, "Farvale", FARVALE),
		],
	);
}

function obs(over: Partial<Observation>): Observation {
	return {
		ts: 1_700_000_000,
		gps: null,
		hr: null,
		cadence: null,
		hourLocal: 13,
		dayOfWeekLocal: 4,
		inBed: false,
		prevGpsFix: null,
		nextGpsFix: null,
		...over,
	};
}

function state(mode: State["mode"], lineName: string | null = null): State {
	return { mode, placeId: null, lineName, trainEdgeId: null };
}

describe("assembleTubeJourneys", () => {
	it("returns no journeys when there are no train minutes", () => {
		const observations: Observation[] = [];
		const states: State[] = [];
		for (let i = 0; i < 10; i++) {
			observations.push(
				obs({ ts: 1_700_000_000 + i * 60, gps: { lat: OUTSIDE.lat, lon: OUTSIDE.lon, speedKmh: 5 }, cadence: 100 }),
			);
			states.push(state("walking"));
		}
		const journeys = assembleTubeJourneys({
			observations,
			states,
			routeGraph: buildScenarioGraph(),
			trainCandidates: [],
		});
		expect(journeys).toEqual([]);
	});

	it("wraps a single train ride into one tube journey with one leg", () => {
		const graph = buildScenarioGraph();
		const t0 = 1_700_000_000;
		const observations: Observation[] = [];
		const states: State[] = [];
		// 0-2: walking outside Ashvale
		for (let i = 0; i < 3; i++) {
			observations.push(
				obs({ ts: t0 + i * 60, gps: { lat: OUTSIDE.lat, lon: OUTSIDE.lon, speedKmh: 5 }, cadence: 100 }),
			);
			states.push(state("walking"));
		}
		// 3-4: walking near Ashvale station entrance
		for (let i = 3; i < 5; i++) {
			observations.push(
				obs({ ts: t0 + i * 60, gps: { lat: ASHVALE.lat, lon: ASHVALE.lon, speedKmh: 3 }, cadence: 80 }),
			);
			states.push(state("walking"));
		}
		// 5-14: train Ashvale → Farvale (Jubilee)
		for (let i = 5; i < 15; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: null }));
			states.push(state("train", "Jubilee Line"));
		}
		// 15-17: walking near Farvale
		for (let i = 15; i < 18; i++) {
			observations.push(
				obs({ ts: t0 + i * 60, gps: { lat: FARVALE.lat, lon: FARVALE.lon, speedKmh: 4 }, cadence: 90 }),
			);
			states.push(state("walking"));
		}
		// 18-20: walking outside Farvale (exit)
		for (let i = 18; i < 21; i++) {
			observations.push(
				obs({ ts: t0 + i * 60, gps: { lat: OUTSIDE.lat, lon: OUTSIDE.lon, speedKmh: 5 }, cadence: 100 }),
			);
			states.push(state("walking"));
		}
		const trainCandidates: TrainCandidate[] = [
			{
				startMin: 5,
				endMin: 14,
				line: "Jubilee Line",
				boardStationId: "ashvale",
				alightStationId: "green",
				boardStationName: "Ashvale",
				alightStationName: "Farvale",
			},
		];
		const journeys = assembleTubeJourneys({ observations, states, routeGraph: graph, trainCandidates });
		expect(journeys).toHaveLength(1);
		const j = journeys[0];
		expect(j.boardStationName).toBe("Ashvale");
		expect(j.alightStationName).toBe("Farvale");
		expect(j.lines).toEqual(["Jubilee Line"]);
		expect(j.legs).toHaveLength(1);
		expect(j.legs[0]).toMatchObject({
			kind: "train",
			line: "Jubilee Line",
			boardStationName: "Ashvale",
			alightStationName: "Farvale",
		});
	});

	it("wraps two trains with an intra-station walk into one tube journey with three legs (train + walk + train)", () => {
		const graph = buildScenarioGraph();
		const t0 = 1_700_000_000;
		const observations: Observation[] = [];
		const states: State[] = [];
		// 0-2: walking outside Ashvale
		for (let i = 0; i < 3; i++) {
			observations.push(
				obs({ ts: t0 + i * 60, gps: { lat: OUTSIDE.lat, lon: OUTSIDE.lon, speedKmh: 5 }, cadence: 100 }),
			);
			states.push(state("walking"));
		}
		// 3-12: train Ashvale → Carfax (Met)
		for (let i = 3; i < 13; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: null }));
			states.push(state("train", "Metropolitan Line"));
		}
		// 13-15: walking AT Carfax station (cadence > 0, GPS at station)
		for (let i = 13; i < 16; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: { lat: CARFAX.lat, lon: CARFAX.lon, speedKmh: 3 }, cadence: 80 }));
			states.push(state("walking"));
		}
		// 16-22: train Carfax → Green (Jubilee)
		for (let i = 16; i < 23; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: null }));
			states.push(state("train", "Jubilee Line"));
		}
		// 23-25: walking outside Farvale
		for (let i = 23; i < 26; i++) {
			observations.push(
				obs({ ts: t0 + i * 60, gps: { lat: OUTSIDE.lat, lon: OUTSIDE.lon, speedKmh: 5 }, cadence: 100 }),
			);
			states.push(state("walking"));
		}
		const trainCandidates: TrainCandidate[] = [
			{
				startMin: 3,
				endMin: 12,
				line: "Metropolitan Line",
				boardStationId: "ashvale",
				alightStationId: "carfax",
				boardStationName: "Ashvale",
				alightStationName: "Carfax",
			},
			{
				startMin: 16,
				endMin: 22,
				line: "Jubilee Line",
				boardStationId: "carfax",
				alightStationId: "green",
				boardStationName: "Carfax",
				alightStationName: "Farvale",
			},
		];
		const journeys = assembleTubeJourneys({ observations, states, routeGraph: graph, trainCandidates });
		expect(journeys).toHaveLength(1);
		const j = journeys[0];
		expect(j.boardStationName).toBe("Ashvale");
		expect(j.alightStationName).toBe("Farvale");
		expect(j.lines).toEqual(["Metropolitan Line", "Jubilee Line"]);
		// Three legs: train, interchange walk, train.
		expect(j.legs).toHaveLength(3);
		expect(j.legs[0].kind).toBe("train");
		expect((j.legs[0] as { line: string }).line).toBe("Metropolitan Line");
		expect(j.legs[1].kind).toBe("interchangeWalk");
		expect((j.legs[1] as { stationName?: string }).stationName).toBe("Carfax");
		expect(j.legs[2].kind).toBe("train");
		expect((j.legs[2] as { line: string }).line).toBe("Jubilee Line");
	});

	it("does NOT merge two trains separated by surface walking (outside-station, > 2 minutes)", () => {
		const graph = buildScenarioGraph();
		const t0 = 1_700_000_000;
		const observations: Observation[] = [];
		const states: State[] = [];
		// 0-2: outside
		for (let i = 0; i < 3; i++) {
			observations.push(
				obs({ ts: t0 + i * 60, gps: { lat: OUTSIDE.lat, lon: OUTSIDE.lon, speedKmh: 5 }, cadence: 100 }),
			);
			states.push(state("walking"));
		}
		// 3-12: train ride
		for (let i = 3; i < 13; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: null }));
			states.push(state("train", "Jubilee Line"));
		}
		// 13-25: surface walking (outside any station) — much more than 5 minutes
		for (let i = 13; i < 26; i++) {
			observations.push(
				obs({ ts: t0 + i * 60, gps: { lat: OUTSIDE.lat, lon: OUTSIDE.lon, speedKmh: 5 }, cadence: 100 }),
			);
			states.push(state("walking"));
		}
		// 26-35: another train ride
		for (let i = 26; i < 36; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: null }));
			states.push(state("train", "Jubilee Line"));
		}
		const trainCandidates: TrainCandidate[] = [
			{
				startMin: 3,
				endMin: 12,
				line: "Jubilee Line",
				boardStationId: "ashvale",
				alightStationId: "carfax",
				boardStationName: "Ashvale",
				alightStationName: "Carfax",
			},
			{
				startMin: 26,
				endMin: 35,
				line: "Jubilee Line",
				boardStationId: "carfax",
				alightStationId: "green",
				boardStationName: "Carfax",
				alightStationName: "Farvale",
			},
		];
		const journeys = assembleTubeJourneys({ observations, states, routeGraph: graph, trainCandidates });
		expect(journeys).toHaveLength(2);
	});

	it("counts intra-station walking steps separately from train minutes", () => {
		const graph = buildScenarioGraph();
		const t0 = 1_700_000_000;
		const observations: Observation[] = [];
		const states: State[] = [];
		// 0-9: train ride
		for (let i = 0; i < 10; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: null }));
			states.push(state("train", "Metropolitan Line"));
		}
		// 10-12: walking AT station (3 minutes, cadence 80 spm = 240 steps)
		for (let i = 10; i < 13; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: { lat: CARFAX.lat, lon: CARFAX.lon, speedKmh: 3 }, cadence: 80 }));
			states.push(state("walking"));
		}
		// 13-19: another train ride
		for (let i = 13; i < 20; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: null }));
			states.push(state("train", "Jubilee Line"));
		}
		const trainCandidates: TrainCandidate[] = [
			{
				startMin: 0,
				endMin: 9,
				line: "Metropolitan Line",
				boardStationId: "ashvale",
				alightStationId: "carfax",
				boardStationName: "Ashvale",
				alightStationName: "Carfax",
			},
			{
				startMin: 13,
				endMin: 19,
				line: "Jubilee Line",
				boardStationId: "carfax",
				alightStationId: "green",
				boardStationName: "Carfax",
				alightStationName: "Farvale",
			},
		];
		const journeys = assembleTubeJourneys({ observations, states, routeGraph: graph, trainCandidates });
		expect(journeys).toHaveLength(1);
		// 3 walking minutes inside the station × 80 spm = 240 intra steps.
		expect(journeys[0].intraStepCount).toBe(240);
	});
});
