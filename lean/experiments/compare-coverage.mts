#!/usr/bin/env -S npx tsx
/**
 * Lean ↔ TypeScript train-generator COVERAGE parity.
 *
 * `verified_cli coverage` rebuilds the coverage map in Lean
 * (`enumerateTrainCandidates` + `buildCoverage`) from the observation tensor and
 * a node-annotated station graph. This checks that rebuild matches TS
 * `buildTrainGeneratorPrior` (via `linesAt`) — the last algorithmic parity
 * question (the assemble path CONSUMES coverage; this REBUILDS it).
 *
 * The day: stations Alpha/Beta on an underground Jubilee Line, a tube blackout
 * between them ⇒ a valid Alpha→Beta candidate ⇒ "Jubilee Line" vouched.
 *
 * Run: npx tsx lean/experiments/compare-coverage.mts   (after `lake build`)
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const leanBin = path.join(here, "..", ".lake", "build", "bin", "verified_cli");

const { buildHsmmModel, KNOWN_LINES } = await import(path.join(repo, "src/hmm/decode.ts"));
const { buildTrainGeneratorPrior } = await import(path.join(repo, "src/hmm/train-generator-prior.ts"));
const { buildRouteGraph, nodeKey } = await import(path.join(repo, "src/geo/route-graph.ts"));

const t0 = Math.floor(Date.parse("2026-07-16T11:00:00Z") / 1000);
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

const model = buildHsmmModel({
	date: "2026-07-16", tz: "Europe/London", points, hr: [], steps: [], sleep: [],
	places: [], placeNearLine: new Set(), routeGraph: graph, continuityContext: null,
	segmentEvidence: true, chainContext: true, reacquireRobustSpeed: true,
} as any);

const tg = buildTrainGeneratorPrior({ observations: model.tensor, routeGraph: graph, knownLines: KNOWN_LINES });
// TS coverage: ts → sorted lines, for every covered minute.
const tsCov = new Map<number, string[]>();
for (const o of model.tensor as any[]) if (tg.isCovered(o.ts)) tsCov.set(o.ts, [...tg.linesAt(o.ts)].sort());

const obs = model.tensor.map((o: any) => ({
	ts: o.ts, gps: o.gps ? { lat: o.gps.lat, lon: o.gps.lon, speedKmh: o.gps.speedKmh } : null,
	hr: o.hr ?? null, cadence: o.cadence ?? null, hourLocal: o.hourLocal, dayOfWeekLocal: o.dayOfWeekLocal,
	inBed: o.inBed, roadDistM: o.roadDistM ?? null, railDistM: o.railDistM ?? null, reacquireAgeMin: o.reacquireAgeMin ?? null,
	prevGpsFix: o.prevGpsFix ? { ts: o.prevGpsFix.ts, lat: o.prevGpsFix.lat, lon: o.prevGpsFix.lon } : null,
	nextGpsFix: o.nextGpsFix ? { ts: o.nextGpsFix.ts, lat: o.nextGpsFix.lat, lon: o.nextGpsFix.lon } : null,
}));
const edges = [...graph.edges.values()].map((e: any) => ({
	id: e.id, geometry: e.geometry.map((p: any) => ({ lat: p.lat, lon: p.lon })),
	lineMemberships: [...e.attrs.lineMemberships], underground: e.attrs.underground,
	startNode: nodeKey(e.startPoint.lat, e.startPoint.lon), endNode: nodeKey(e.endPoint.lat, e.endPoint.lon),
}));
const nodes = [...graph.nodes.values()].map((n: any) => ({
	id: n.id, lat: n.point.lat, lon: n.point.lon, stationName: n.stationName ?? null, edgeIds: [...n.edgeIds],
}));

const res = spawnSync(leanBin, ["coverage"], { input: JSON.stringify({ obs, edges, nodes }), encoding: "utf8", maxBuffer: 1 << 28 });
if (res.status !== 0) { console.error("coverage failed:", res.stderr || res.stdout); process.exit(1); }
const lean = JSON.parse(res.stdout);
if (lean.error) { console.error("coverage error:", lean.error); process.exit(1); }
const leanCov = new Map<number, string[]>();
for (const [ts, lines] of lean.coverage) leanCov.set(ts, [...lines].sort());

console.log(`TS covered minutes=${tsCov.size}, Lean covered minutes=${leanCov.size}`);
if (tsCov.size === 0) { console.error("TS coverage empty — test vacuous"); process.exit(1); }

let mism = 0; const ex: string[] = [];
const allTs = new Set<number>([...tsCov.keys(), ...leanCov.keys()]);
const same = (a: string[] | undefined, b: string[] | undefined) =>
	a !== undefined && b !== undefined && a.length === b.length && a.every((x, i) => x === b[i]);
for (const ts of allTs) {
	if (!same(tsCov.get(ts), leanCov.get(ts))) {
		mism++;
		if (ex.length < 10) ex.push(`ts=${ts}: ts=[${tsCov.get(ts) ?? "∅"}] lean=[${leanCov.get(ts) ?? "∅"}]`);
	}
}
if (mism === 0) console.log(`✅ EXACT — Lean coverage rebuild matches TS across ${allTs.size} minute(s)`);
else { console.log(`❌ ${mism}/${allTs.size} minutes differ:`); for (const e of ex) console.log("   " + e); process.exit(1); }
