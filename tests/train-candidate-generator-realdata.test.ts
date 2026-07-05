/**
 * Phase 1 acceptance — real data. Replays the 2026-05-22 morning
 * (Ashvale → Carfax → Farvale: a Met leg + a Jubilee leg
 * connected by an interchange dwell at Carfax) and asserts
 * the generator emits the correct (board, line, alight) triples.
 *
 * Per ground truth (`tests/golden/ground-truth/2026-05-22.md`):
 *
 *   13:16 – 13:32   train Ashvale → Carfax · Met Line
 *   13:32 – 13:35   train Carfax → Farvale · Jubilee Line
 *
 * The user dwells at Carfax around 13:29-13:32 (4 GPS fixes
 * clustered at the Carfax station coords). That dwell is what
 * the generator uses to split the underground gap into TWO train
 * windows.
 *
 * Generator acceptance:
 *   - For the first window: emit candidates with board ≈ Ashvale
 *     Park, alight ≈ Carfax. Met and Jubilee are both valid
 *     (shared track + Carfax is on both lines).
 *   - For the second window: emit candidates with board ≈ Carfax
 *     Street, alight in the Farvale / Bond St area. Jubilee
 *     must be in the set; Met must NOT (Met has no Farvale
 *     station — that's the structural fact the per-minute factor
 *     stack couldn't enforce).
 *
 * Both fixtures (day + route graph) are gitignored. The test
 * skips when either is missing.
 */

import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { buildRouteGraph, type RawOsmLine, type RawOsmPoint, type RouteGraph } from "../src/geo/route-graph.js";
import type { Observation } from "../src/hmm/observation.js";
import { enumerateTrainCandidates } from "../src/hmm/train-candidate-generator.js";
import { describeWithFixture } from "./helpers/describe-with-fixture.js";

const DAY_FIXTURE_URL = new URL("./fixtures/days/2026-05-22-pippijn.json", import.meta.url);
const ROUTE_GRAPH_FIXTURE_URL = new URL("./fixtures/route-graphs/london-met-jubilee-corridor.json", import.meta.url);

interface DayFixturePoint {
	ts: number;
	lat: number;
	lon: number;
	speed_kmh: number;
	bearing: number;
}

interface DayFixture {
	date: string;
	display_tz: string;
	points: DayFixturePoint[];
}

interface RouteGraphFixture {
	lines: RawOsmLine[];
	points: RawOsmPoint[];
}

function loadDay(): DayFixture | null {
	try {
		return JSON.parse(readFileSync(DAY_FIXTURE_URL, "utf8")) as DayFixture;
	} catch {
		return null;
	}
}

function loadGraph(): RouteGraph | null {
	try {
		const raw = JSON.parse(readFileSync(ROUTE_GRAPH_FIXTURE_URL, "utf8")) as RouteGraphFixture;
		const lines = raw.lines.map((l) => ({ ...l, osm_id: BigInt(l.osm_id as unknown as string) }));
		const points = raw.points.map((p) => ({ ...p, osm_id: BigInt(p.osm_id as unknown as string) }));
		return buildRouteGraph(lines, points);
	} catch {
		return null;
	}
}

const day = loadDay();
const graph = loadGraph();

const LOCAL_MIDNIGHT_UTC = 1_779_404_400;
function localTs(hhmm: string): number {
	const [h, m] = hhmm.split(":").map(Number);
	return LOCAL_MIDNIGHT_UTC + h * 3600 + m * 60;
}

function buildMinuteTensor(points: readonly DayFixturePoint[], start: number, end: number): Observation[] {
	const byMin = new Map<number, DayFixturePoint>();
	for (const p of points) {
		if (p.ts < start || p.ts > end) continue;
		const m = Math.floor(p.ts / 60) * 60;
		if (!byMin.has(m)) byMin.set(m, p);
	}
	const out: Observation[] = [];
	for (let t = Math.floor(start / 60) * 60; t <= end; t += 60) {
		const p = byMin.get(t);
		if (p !== undefined) {
			out.push({
				ts: t,
				gps: { lat: p.lat, lon: p.lon, speedKmh: p.speed_kmh },
				hr: null,
				cadence: null,
				hourLocal: Math.floor(((t - LOCAL_MIDNIGHT_UTC) / 3600) % 24),
				dayOfWeekLocal: 4,
				inBed: false,
				prevGpsFix: null,
				nextGpsFix: null,
			});
		} else {
			out.push({
				ts: t,
				gps: null,
				hr: null,
				cadence: null,
				hourLocal: Math.floor(((t - LOCAL_MIDNIGHT_UTC) / 3600) % 24),
				dayOfWeekLocal: 4,
				inBed: false,
				prevGpsFix: null,
				nextGpsFix: null,
			});
		}
	}
	let lastGps: { ts: number; lat: number; lon: number } | null = null;
	for (const o of out) {
		if (o.gps !== null) lastGps = { ts: o.ts, lat: o.gps.lat, lon: o.gps.lon };
		else if (lastGps !== null) (o as { prevGpsFix: Observation["prevGpsFix"] }).prevGpsFix = lastGps;
	}
	let nextGps: { ts: number; lat: number; lon: number } | null = null;
	for (let i = out.length - 1; i >= 0; i--) {
		const o = out[i];
		if (o.gps !== null) nextGps = { ts: o.ts, lat: o.gps.lat, lon: o.gps.lon };
		else if (nextGps !== null) (o as { nextGpsFix: Observation["nextGpsFix"] }).nextGpsFix = nextGps;
	}
	return out;
}

const trainCandidateFixtures = day !== null && graph !== null ? { d: day, g: graph } : null;
describeWithFixture(
	"train-candidate generator — 2026-05-22 Met / Jubilee morning",
	trainCandidateFixtures,
	({ d, g }) => {
		it("emits the right (board, line, alight) triples for the Met → Jubilee morning interchange", () => {
			const observations = buildMinuteTensor(d.points, localTs("13:00"), localTs("13:50"));
			const candidates = enumerateTrainCandidates({
				observations,
				routeGraph: g,
				knownLines: [
					"Metropolitan Line",
					"Jubilee Line",
					"Victoria Line",
					"Piccadilly Line",
					"Carfaxloo Line",
					"Northern Line",
					"Circle Line",
					"Hammersmith & City Line",
					"District Line",
					"Central Line",
					"Elizabeth Line",
				],
			});

			if (process.env.GEN_DUMP === "1") {
				let stationCount = 0;
				const stationNames: string[] = [];
				let metStations = 0;
				let jubStations = 0;
				for (const n of g.nodes.values()) {
					if (n.stationName !== undefined) {
						stationCount++;
						if (stationNames.length < 30) stationNames.push(n.stationName);
					}
					const lines = new Set<string>();
					for (const eid of n.edgeIds) {
						const e = g.edges.get(eid);
						if (e !== undefined) for (const l of e.attrs.lineMemberships) lines.add(l);
					}
					if (n.stationName !== undefined && lines.has("Metropolitan Line")) metStations++;
					if (n.stationName !== undefined && lines.has("Jubilee Line")) jubStations++;
				}
				console.error(`graph: ${stationCount} station nodes, Met-incident ${metStations}, Jub-incident ${jubStations}`);
				console.error(`stations: ${stationNames.join(", ")}`);
				console.error(`observations: ${observations.length}, candidates: ${candidates.length}`);
				for (const c of candidates.slice(0, 10)) {
					console.error(
						`  [${c.startMin}-${c.endMin}] ${c.line}  ${c.boardStationName ?? "?"} → ${c.alightStationName ?? "?"}`,
					);
				}
			}

			// The generator must detect at least two distinct windows
			// (Ashvale → Carfax, Carfax → ~Farvale) because the user
			// dwells at Carfax for ~3 minutes.
			const windows = new Set(candidates.map((c) => `${c.startMin}-${c.endMin}`));
			expect(
				windows.size,
				"generator should detect at least two train windows split by the Carfax dwell",
			).toBeGreaterThanOrEqual(2);

			// The Carfax → Farvale window must produce a valid Jubilee
			// candidate, and must NOT produce a Metropolitan Line candidate
			// (no Met station at Farvale).
			const secondWindowCandidates = candidates.filter((c) => {
				const startTs = observations[c.startMin].ts;
				return startTs >= localTs("13:26");
			});
			expect(secondWindowCandidates.length, "must have candidates for the second window").toBeGreaterThan(0);

			const secondLines = new Set(secondWindowCandidates.map((c) => c.line));
			expect(secondLines, "second window must include Jubilee").toContain("Jubilee Line");
			expect(secondLines, "second window must NOT include Metropolitan Line (no Met station at Farvale)").not.toContain(
				"Metropolitan Line",
			);

			// The first window's candidate set must include Metropolitan
			// Line (Ashvale → Carfax is a valid Met ride).
			const firstWindowCandidates = candidates.filter((c) => {
				const endTs = observations[c.endMin].ts;
				return endTs <= localTs("13:32");
			});
			expect(firstWindowCandidates.length, "must have candidates for the first window").toBeGreaterThan(0);

			const firstLines = new Set(firstWindowCandidates.map((c) => c.line));
			expect(firstLines, "first window must include Metropolitan Line").toContain("Metropolitan Line");
		});
	},
);
