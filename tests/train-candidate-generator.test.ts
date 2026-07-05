/**
 * Phase 1 of `docs/proposals/decoder-roadmap.md`:
 * train (board, line, alight) candidate generator.
 *
 * A `train @ L` segment is a valid candidate iff:
 *   - The user's GPS context at the segment's start is within
 *     R_station of a station node N₁ on line L.
 *   - The user's GPS context at the end is within R_station of a
 *     station node N₂ on line L.
 *   - N₁ ≠ N₂ and they are graph-connected on L's per-line edge
 *     subgraph.
 *
 * Anything else is not a candidate. The decoder doesn't score it
 * and doesn't consider it.
 *
 * These tests are the acceptance contract for the generator. The
 * synthetic cases pin the surface; the real-data fixture replay
 * pins that the generator correctly handles the 2026-05-22 Met /
 * Jubilee / Victoria rides.
 */

import { describe, expect, it } from "vitest";
import { buildRouteGraph, type RawOsmLine, type RawOsmPoint } from "../src/geo/route-graph.js";
import type { Observation } from "../src/hmm/observation.js";
import { enumerateTrainCandidates } from "../src/hmm/train-candidate-generator.js";

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

// Synthetic 4-station, 2-line scenario.
//
//      ASHVALE (Met, Jubilee shared)
//         |
//      BROOKDEN (Met, Jubilee shared)
//         |
//      CARFAX (Met, Jubilee shared) — interchange
//         |
//      FARVALE (Jubilee only)
//
// Met continues east from Carfax to KX (not used in this fixture).
// Jubilee continues south from Carfax to Farvale.
const ASHVALE = { lat: 51.5635, lon: -0.2796 };
const BROOKDEN = { lat: 51.5474, lon: -0.1809 };
const CARFAX = { lat: 51.5226, lon: -0.1571 };
const FARVALE = { lat: 51.5067, lon: -0.1428 };

function buildScenarioGraph() {
	return buildRouteGraph(
		[
			// Ashvale → Brookden: shared Met+Jub track.
			makeLine({ osm_id: 1n, name: "Metropolitan and Jubilee Lines", geom: wkt(ASHVALE, BROOKDEN) }),
			// Brookden → Carfax: also shared.
			makeLine({ osm_id: 2n, name: "Metropolitan and Jubilee Lines", geom: wkt(BROOKDEN, CARFAX) }),
			// Carfax → Farvale: Jubilee only.
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

describe("enumerateTrainCandidates — synthetic", () => {
	it("emits no candidates when no minute looks like a train ride", () => {
		const graph = buildScenarioGraph();
		// All walking-speed observations near Ashvale.
		const observations: Observation[] = [];
		for (let i = 0; i < 10; i++) {
			observations.push(obs({ ts: 1_700_000_000 + i * 60, gps: { lat: ASHVALE.lat, lon: ASHVALE.lon, speedKmh: 4 } }));
		}
		const result = enumerateTrainCandidates({
			observations,
			routeGraph: graph,
			knownLines: ["Metropolitan Line", "Jubilee Line"],
		});
		expect(result).toEqual([]);
	});

	it("emits the valid (Jubilee, Ashvale, Farvale) candidate for a single tube ride", () => {
		const graph = buildScenarioGraph();
		const t0 = 1_700_000_000;
		const observations: Observation[] = [];
		// 0..4 walking near Ashvale
		for (let i = 0; i < 5; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: { lat: ASHVALE.lat, lon: ASHVALE.lon, speedKmh: 4 } }));
		}
		// 5..14 underground train (GPS null), bracketed by the Ashvale fix at t=4
		// and a Farvale fix at t=15.
		const lastAshvale = { ts: observations[4].ts, lat: ASHVALE.lat, lon: ASHVALE.lon };
		const firstGreen = { ts: t0 + 15 * 60, lat: FARVALE.lat, lon: FARVALE.lon };
		for (let i = 5; i < 15; i++) {
			observations.push(
				obs({
					ts: t0 + i * 60,
					gps: null,
					prevGpsFix: lastAshvale,
					nextGpsFix: firstGreen,
				}),
			);
		}
		// 15..19 walking near Farvale
		for (let i = 15; i < 20; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: { lat: FARVALE.lat, lon: FARVALE.lon, speedKmh: 5 } }));
		}

		const result = enumerateTrainCandidates({
			observations,
			routeGraph: graph,
			knownLines: ["Metropolitan Line", "Jubilee Line"],
		});

		// Exactly one valid candidate: Jubilee from Ashvale to Farvale.
		// Met can't be a candidate — Met has no Farvale station, so the
		// (board=Ashvale, alight=Farvale, line=Met) triple fails the
		// "alight is on line" check.
		const validLines = result.map((c) => c.line);
		expect(validLines).toContain("Jubilee Line");
		expect(validLines).not.toContain("Metropolitan Line");

		const jub = result.find((c) => c.line === "Jubilee Line");
		expect(jub?.boardStationName).toBe("Ashvale");
		expect(jub?.alightStationName).toBe("Farvale");
	});

	it("emits a candidate for a single-minute one-stop hop with a genuine station-to-station displacement", () => {
		// The reacquisition signature of a one-stop underground hop: the
		// user walks at Ashvale, a single train-speed GPS fix lands near
		// the next station, then they walk again at that station. The
		// train-tagged run is ONE minute long — below the 2-minute window
		// floor — but the bracketing fixes (Ashvale → Brookden, ~1 km in
		// 2 min) show a real station-to-station displacement at train
		// speed. This must still produce the (Ashvale → Brookden) hop.
		const graph = buildScenarioGraph();
		const t0 = 1_700_000_000;
		const observations: Observation[] = [];
		// 0..4 walking at Ashvale.
		for (let i = 0; i < 5; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: { lat: ASHVALE.lat, lon: ASHVALE.lon, speedKmh: 4 } }));
		}
		// 5 a single train-speed fix at the next station (reacquisition).
		observations.push(obs({ ts: t0 + 5 * 60, gps: { lat: BROOKDEN.lat, lon: BROOKDEN.lon, speedKmh: 60 } }));
		// 6..10 walking at Brookden.
		for (let i = 6; i < 11; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: { lat: BROOKDEN.lat, lon: BROOKDEN.lon, speedKmh: 4 } }));
		}

		const result = enumerateTrainCandidates({
			observations,
			routeGraph: graph,
			knownLines: ["Metropolitan Line", "Jubilee Line"],
		});

		// Ashvale → Brookden is on the shared Met+Jub track, so both lines
		// are valid candidates for the hop.
		const hop = result.filter((c) => c.boardStationName === "Ashvale" && c.alightStationName === "Brookden");
		expect(hop.length).toBeGreaterThanOrEqual(1);
		const lines = new Set(hop.map((c) => c.line));
		expect(lines).toContain("Jubilee Line");
	});

	it("does NOT emit a candidate for a lone fast GPS fix with no net station-to-station displacement (jitter)", () => {
		// A single noisy train-speed fix while the user stays put at
		// Ashvale: the surrounding observed fixes bracket ~zero net
		// displacement, so this is GPS jitter, not a hop. No window, no
		// candidate.
		const graph = buildScenarioGraph();
		const t0 = 1_700_000_000;
		const observations: Observation[] = [];
		for (let i = 0; i < 5; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: { lat: ASHVALE.lat, lon: ASHVALE.lon, speedKmh: 4 } }));
		}
		// 5 a lone fast fix that jumps toward Brookden...
		observations.push(obs({ ts: t0 + 5 * 60, gps: { lat: BROOKDEN.lat, lon: BROOKDEN.lon, speedKmh: 60 } }));
		// ...but 6.. the user is right back at Ashvale — net displacement
		// across the bracket is zero.
		for (let i = 6; i < 11; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: { lat: ASHVALE.lat, lon: ASHVALE.lon, speedKmh: 4 } }));
		}
		const result = enumerateTrainCandidates({
			observations,
			routeGraph: graph,
			knownLines: ["Metropolitan Line", "Jubilee Line"],
		});
		expect(result).toEqual([]);
	});

	it("rejects (board, line, alight) where board and alight are the SAME station", () => {
		// Degenerate: the user 'rides' one stop but the GPS context is
		// the same station at both ends. Not a candidate.
		const graph = buildScenarioGraph();
		const t0 = 1_700_000_000;
		const observations: Observation[] = [];
		for (let i = 0; i < 5; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: { lat: CARFAX.lat, lon: CARFAX.lon, speedKmh: 4 } }));
		}
		const lastCarfax = { ts: observations[4].ts, lat: CARFAX.lat, lon: CARFAX.lon };
		const firstCarfaxAgain = { ts: t0 + 15 * 60, lat: CARFAX.lat, lon: CARFAX.lon };
		for (let i = 5; i < 15; i++) {
			observations.push(
				obs({
					ts: t0 + i * 60,
					gps: null,
					prevGpsFix: lastCarfax,
					nextGpsFix: firstCarfaxAgain,
				}),
			);
		}
		for (let i = 15; i < 20; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: { lat: CARFAX.lat, lon: CARFAX.lon, speedKmh: 4 } }));
		}
		const result = enumerateTrainCandidates({
			observations,
			routeGraph: graph,
			knownLines: ["Metropolitan Line", "Jubilee Line"],
		});
		expect(result).toEqual([]);
	});

	it("does not emit a candidate when the alight station isn't on the line (Met → Farvale is invalid)", () => {
		// Extend the scenario so a Met-only edge exists east of Carfax
		// (e.g. Marylebone). The user's GPS implies Ashvale → Farvale,
		// but Met doesn't reach Farvale. Met must NOT be a candidate.
		const MARYLEBONE = { lat: 51.5226, lon: -0.1635 };
		const graph = buildRouteGraph(
			[
				makeLine({ osm_id: 1n, name: "Metropolitan and Jubilee Lines", geom: wkt(ASHVALE, BROOKDEN) }),
				makeLine({ osm_id: 2n, name: "Metropolitan and Jubilee Lines", geom: wkt(BROOKDEN, CARFAX) }),
				makeLine({ osm_id: 3n, name: "Jubilee Line", geom: wkt(CARFAX, FARVALE) }),
				// Met-only branch east of Carfax.
				makeLine({ osm_id: 4n, name: "Metropolitan Line", geom: wkt(CARFAX, MARYLEBONE) }),
			],
			[
				makeStation(101n, "Ashvale", ASHVALE),
				makeStation(102n, "Brookden", BROOKDEN),
				makeStation(103n, "Carfax", CARFAX),
				makeStation(104n, "Farvale", FARVALE),
				makeStation(105n, "Marylebone", MARYLEBONE),
			],
		);
		const t0 = 1_700_000_000;
		const observations: Observation[] = [];
		for (let i = 0; i < 5; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: { lat: ASHVALE.lat, lon: ASHVALE.lon, speedKmh: 4 } }));
		}
		const lastAshvale = { ts: observations[4].ts, lat: ASHVALE.lat, lon: ASHVALE.lon };
		const firstGreen = { ts: t0 + 15 * 60, lat: FARVALE.lat, lon: FARVALE.lon };
		for (let i = 5; i < 15; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: null, prevGpsFix: lastAshvale, nextGpsFix: firstGreen }));
		}
		for (let i = 15; i < 20; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: { lat: FARVALE.lat, lon: FARVALE.lon, speedKmh: 5 } }));
		}
		const result = enumerateTrainCandidates({
			observations,
			routeGraph: graph,
			knownLines: ["Metropolitan Line", "Jubilee Line"],
		});
		const lines = new Set(result.map((c) => c.line));
		expect(lines).toContain("Jubilee Line");
		expect(lines).not.toContain("Metropolitan Line");
	});

	it("emits two candidates for an interchange ride (Met Ashvale→Carfax, then Jubilee Carfax→Green) — two segments", () => {
		// Same graph as above. The observation window has a dwell at
		// Carfax in the middle (~3 minutes at low speed), splitting
		// the long underground gap into two train-mode windows. The
		// generator should emit a (Met, Ashvale, Carfax) candidate for
		// the first window and a (Jubilee, Carfax, Farvale) candidate
		// for the second.
		const MARYLEBONE = { lat: 51.5226, lon: -0.1635 };
		const graph = buildRouteGraph(
			[
				makeLine({ osm_id: 1n, name: "Metropolitan and Jubilee Lines", geom: wkt(ASHVALE, BROOKDEN) }),
				makeLine({ osm_id: 2n, name: "Metropolitan and Jubilee Lines", geom: wkt(BROOKDEN, CARFAX) }),
				makeLine({ osm_id: 3n, name: "Jubilee Line", geom: wkt(CARFAX, FARVALE) }),
				makeLine({ osm_id: 4n, name: "Metropolitan Line", geom: wkt(CARFAX, MARYLEBONE) }),
			],
			[
				makeStation(101n, "Ashvale", ASHVALE),
				makeStation(102n, "Brookden", BROOKDEN),
				makeStation(103n, "Carfax", CARFAX),
				makeStation(104n, "Farvale", FARVALE),
				makeStation(105n, "Marylebone", MARYLEBONE),
			],
		);
		const t0 = 1_700_000_000;
		const observations: Observation[] = [];
		for (let i = 0; i < 5; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: { lat: ASHVALE.lat, lon: ASHVALE.lon, speedKmh: 4 } }));
		}
		// Tube Ashvale → Carfax (5..10)
		const lastAshvale = { ts: observations[4].ts, lat: ASHVALE.lat, lon: ASHVALE.lon };
		const bakerFix = { ts: t0 + 11 * 60, lat: CARFAX.lat, lon: CARFAX.lon };
		for (let i = 5; i < 11; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: null, prevGpsFix: lastAshvale, nextGpsFix: bakerFix }));
		}
		// Dwell at Carfax (11..13) — 3 minutes at low speed, observed GPS.
		for (let i = 11; i < 14; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: { lat: CARFAX.lat, lon: CARFAX.lon, speedKmh: 2 } }));
		}
		// Tube Carfax → Green (14..18)
		const lastCarfax = { ts: observations[13].ts, lat: CARFAX.lat, lon: CARFAX.lon };
		const greenFix = { ts: t0 + 19 * 60, lat: FARVALE.lat, lon: FARVALE.lon };
		for (let i = 14; i < 19; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: null, prevGpsFix: lastCarfax, nextGpsFix: greenFix }));
		}
		for (let i = 19; i < 24; i++) {
			observations.push(obs({ ts: t0 + i * 60, gps: { lat: FARVALE.lat, lon: FARVALE.lon, speedKmh: 5 } }));
		}

		const result = enumerateTrainCandidates({
			observations,
			routeGraph: graph,
			knownLines: ["Metropolitan Line", "Jubilee Line"],
		});

		if (process.env.GEN_DUMP === "1") {
			console.error("GRAPH NODES:");
			for (const n of graph.nodes.values()) {
				console.error(`  ${n.id}  name=${n.stationName ?? "-"}`);
			}
			console.error("CANDIDATES:");
			for (const c of result) {
				console.error(
					`  [${c.startMin}-${c.endMin}] ${c.line}  ${c.boardStationName ?? "?"} → ${c.alightStationName ?? "?"}`,
				);
			}
		}

		// First window: Ashvale → Carfax. Both Met and Jubilee are valid
		// here (shared track + Carfax is on both lines). Two candidates.
		// Second window: Carfax → Green. Only Jubilee is valid. One
		// candidate.
		const firstWindow = result.filter((c) => c.boardStationName === "Ashvale");
		const secondWindow = result.filter((c) => c.boardStationName === "Carfax");

		expect(firstWindow.length).toBeGreaterThanOrEqual(2);
		const firstLines = new Set(firstWindow.map((c) => c.line));
		expect(firstLines).toContain("Metropolitan Line");
		expect(firstLines).toContain("Jubilee Line");

		expect(secondWindow.length).toBe(1);
		expect(secondWindow[0].line).toBe("Jubilee Line");
		expect(secondWindow[0].alightStationName).toBe("Farvale");
	});
});
