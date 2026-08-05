#!/usr/bin/env -S npx tsx
/**
 * Lean ↔ TypeScript FULLY SELF-CONTAINED path: raw inputs (incl. the station
 * graph) → coverage REBUILT in Lean → assemble → decode, all in one process.
 *
 * Unlike compare-assemble-covered (which feeds TS's coverage map), this passes
 * only the station `nodes`; `verified_cli assembledecode` reconstructs coverage
 * via `enumerateTrainCandidates` + `buildCoverage` itself, then assembles and
 * decodes. So nothing but the post-boundary raw inputs crosses to Lean — the
 * end state of the port. Checked against the TS served decode.
 *
 * Run: npx tsx lean/experiments/compare-assemble-selfcontained.mts
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildHsmmModel } from "../../src/hmm/decode.js";
import { decodeTsFloat, scoreFloat } from "../../src/hmm/lean-shadow-core.js";
import { buildRouteGraph, nodeKey } from "../../src/geo/route-graph.js";
import { DEFAULT_MAX_DURATION } from "../../src/hmm/hsmm-viterbi.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const leanBin = path.join(here, "..", ".lake", "build", "bin", "verified_cli");

const t0 = Math.floor(Date.parse("2026-07-16T11:00:00Z") / 1000);
const P1 = { id: 101, lat: 51.52, lon: -0.13 }, P2 = { id: 202, lat: 51.5, lon: -0.1 };
const A = { lat: 51.5, lon: -0.1 }, M = { lat: 51.525, lon: -0.075 }, B = { lat: 51.55, lon: -0.05 };
const wkt = (a: any, b: any) => `LINESTRING(${a.lon} ${a.lat}, ${b.lon} ${b.lat})`;
const graph = buildRouteGraph(
	[
		{ osm_id: 1n, osm_type: "way", feature_type: "railway", subtype: "subway", name: "Jubilee Line", tags_json: '{"tunnel":"yes"}', geom: wkt(A, M) },
		{ osm_id: 2n, osm_type: "way", feature_type: "railway", subtype: "subway", name: "Jubilee Line", tags_json: '{"tunnel":"yes"}', geom: wkt(M, B) },
	],
	[
		{ osm_id: 10n, osm_type: "node", name: "Alpha", tags_json: '{"railway":"station"}', lat: A.lat, lon: A.lon },
		{ osm_id: 11n, osm_type: "node", name: "Beta", tags_json: '{"railway":"station"}', lat: B.lat, lon: B.lon },
	],
);
const points: any[] = [];
for (let m = 0; m < 3; m++) points.push({ ts: t0 + m * 60, lat: A.lat, lon: A.lon, speed_kmh: 2, bearing: 0 });
points.push({ ts: t0 + 9 * 60, lat: B.lat, lon: B.lon, speed_kmh: 2, bearing: 0 });

const hourProfile = Array.from({ length: 24 }, (_, h) => (h === 11 ? 0.2 : 0.03));
const places = [
	{ id: P1.id, displayName: "Home", lat: P1.lat, lon: P1.lon, hourProfile, totalDwellSec: 3600 },
	{ id: P2.id, displayName: "Work", lat: P2.lat, lon: P2.lon, hourProfile: null, totalDwellSec: 1800 },
];
const cc = { priorPlaceId: P1.id, priorPlaceCoord: { lat: P1.lat, lon: P1.lon }, hoursSinceLastConfirmedFix: 8, priorPosterior: 0.9 };
const model = buildHsmmModel({
	date: "2026-07-16", tz: "Europe/London", points, hr: [], steps: [], sleep: [],
	places, placeNearLine: new Set(), routeGraph: graph, continuityContext: cc,
	segmentEvidence: true, chainContext: true, reacquireRobustSpeed: true,
} as any);
const T = model.tensor.length;
const tsPath = decodeTsFloat(model);

const payload = {
	maxD: DEFAULT_MAX_DURATION,
	obs: model.tensor.map((o: any) => ({
		ts: o.ts, gps: o.gps ? { lat: o.gps.lat, lon: o.gps.lon, speedKmh: o.gps.speedKmh } : null,
		hr: o.hr ?? null, cadence: o.cadence ?? null, hourLocal: o.hourLocal, dayOfWeekLocal: o.dayOfWeekLocal,
		inBed: o.inBed, roadDistM: o.roadDistM ?? null, railDistM: o.railDistM ?? null, reacquireAgeMin: o.reacquireAgeMin ?? null,
		prevGpsFix: o.prevGpsFix ? { ts: o.prevGpsFix.ts, lat: o.prevGpsFix.lat, lon: o.prevGpsFix.lon } : null,
		nextGpsFix: o.nextGpsFix ? { ts: o.nextGpsFix.ts, lat: o.nextGpsFix.lat, lon: o.nextGpsFix.lon } : null,
	})),
	edges: [...graph.edges.values()].map((e: any) => ({
		id: e.id, geometry: e.geometry.map((p: any) => ({ lat: p.lat, lon: p.lon })),
		lineMemberships: [...e.attrs.lineMemberships], underground: e.attrs.underground,
		startNode: nodeKey(e.startPoint.lat, e.startPoint.lon), endNode: nodeKey(e.endPoint.lat, e.endPoint.lon),
	})),
	// The station graph — Lean rebuilds coverage from THIS (no coverage field).
	nodes: [...graph.nodes.values()].map((n: any) => ({
		id: n.id, lat: n.point.lat, lon: n.point.lon, stationName: n.stationName ?? null, edgeIds: [...n.edgeIds],
	})),
	places: places.map((p) => ({ id: p.id, name: p.displayName, lat: p.lat, lon: p.lon, hourProfile: p.hourProfile, dwell: p.totalDwellSec })),
	continuity: { priorPlaceId: cc.priorPlaceId, priorPlaceCoord: [cc.priorPlaceCoord.lat, cc.priorPlaceCoord.lon], hoursSince: cc.hoursSinceLastConfirmedFix, priorPosterior: cc.priorPosterior },
	flags: { reacquireRobust: true, segEvidence: true, chainContext: true },
	placeNearLine: [] as string[],
};

console.log(`built model T=${T}; Lean rebuilds coverage internally (nodes only, no coverage field)…`);
const res = spawnSync(leanBin, ["assembledecode"], { input: JSON.stringify(payload), encoding: "utf8", maxBuffer: 1 << 28 });
if (res.status !== 0) { console.error("assembledecode failed:", res.stderr || res.stdout); process.exit(1); }
const lean = JSON.parse(res.stdout);
if (lean.error) { console.error("error:", lean.error); process.exit(1); }
if (lean.degenerate) { console.error("degenerate"); process.exit(1); }
const leanPath: number[] = lean.path;

let agree = 0; const diffs: string[] = [];
for (let i = 0; i < T; i++) { if (leanPath[i] === tsPath[i]) agree++; else if (diffs.length < 8) diffs.push(`min ${i}: lean=${leanPath[i]} ts=${tsPath[i]}`); }
const lS = scoreFloat(model, leanPath), tS = scoreFloat(model, tsPath);
console.log(`decode agreement: ${agree}/${T} (${((100 * agree) / T).toFixed(2)}%)  scoreΔ=${(lS - tS).toFixed(6)}`);
if (agree === T) console.log("✅ EXACT — fully self-contained Lean path (coverage rebuilt) identical to TS decode");
else { console.log(`⚠️  ${T - agree} differ:`); for (const d of diffs) console.log("   " + d); }
process.exit(agree === T ? 0 : 1);
