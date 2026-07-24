#!/usr/bin/env -S npx tsx
/**
 * Lean ↔ TypeScript FULL-PATH parity: raw inputs → decoded path.
 *
 * `verified_cli assembledecode` builds the HSMM model from parsed inputs in Lean
 * (`Verified.Hsmm.Assemble`), packs it into `PData` in-process (no marshalled
 * tensor payload), and decodes it with `pDecodeFast`. This checks that path
 * against the TS served decode (`decodeTsFloat` — the float trellis on the same
 * model). They decode the same model (Lean-quantised vs TS-float), so they agree
 * except on genuine quant near-ties.
 *
 * Run: npx tsx lean/experiments/compare-assemble-decode.mts   (after `lake build`)
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const leanBin = path.join(here, "..", ".lake", "build", "bin", "verified_cli");

const { buildHsmmModel } = await import(path.join(repo, "src/hmm/decode.ts"));
const { decodeTsFloat, scoreFloat } = await import(path.join(repo, "src/hmm/lean-shadow-core.ts"));
const { buildRouteGraph, nodeKey } = await import(path.join(repo, "src/geo/route-graph.ts"));
const { DEFAULT_MAX_DURATION } = await import(path.join(repo, "src/hmm/hsmm-viterbi.ts"));

const t0 = Math.floor(Date.parse("2026-07-16T11:00:00Z") / 1000);
const P1 = { id: 101, lat: 51.52, lon: -0.13 };
const P2 = { id: 202, lat: 51.5, lon: -0.1 };
const A = { lat: 51.5, lon: -0.1 }, M = { lat: 51.525, lon: -0.075 }, B = { lat: 51.55, lon: -0.05 };
const wkt = (a: any, b: any) => `LINESTRING(${a.lon} ${a.lat}, ${b.lon} ${b.lat})`;
const graph = buildRouteGraph(
	[
		{ osm_id: 1n, osm_type: "way", feature_type: "railway", subtype: "subway", name: "Jubilee Line", tags_json: '{"tunnel":"yes"}', geom: wkt(A, M) },
		{ osm_id: 2n, osm_type: "way", feature_type: "railway", subtype: "subway", name: "Jubilee Line", tags_json: '{"tunnel":"yes"}', geom: wkt(M, B) },
	],
	[],
);
const edges = [...graph.edges.values()].map((e: any) => ({
	id: e.id, geometry: e.geometry.map((p: any) => ({ lat: p.lat, lon: p.lon })),
	lineMemberships: [...e.attrs.lineMemberships], underground: e.attrs.underground,
	startNode: nodeKey(e.startPoint.lat, e.startPoint.lon), endNode: nodeKey(e.endPoint.lat, e.endPoint.lon),
}));

const points: any[] = [], hr: any[] = [], steps: any[] = [], prox: [number, any][] = [];
for (let m = 0; m < 3; m++) {
	points.push({ ts: t0 + m * 60, lat: A.lat, lon: A.lon, speed_kmh: 2, bearing: 0 });
	hr.push({ ts: t0 + m * 60, bpm: 80 }); steps.push({ ts: t0 + m * 60, steps: 0 });
	prox.push([t0 + m * 60, { railDistM: 50, roadDistM: 300 }]);
}
points.push({ ts: t0 + 9 * 60, lat: B.lat, lon: B.lon, speed_kmh: 2, bearing: 0 });
hr.push({ ts: t0 + 9 * 60, bpm: 80 }); steps.push({ ts: t0 + 9 * 60, steps: 0 });
prox.push([t0 + 9 * 60, { railDistM: 50, roadDistM: 300 }]);

const hourProfile = Array.from({ length: 24 }, (_, h) => (h === 11 ? 0.2 : 0.03));
const places = [
	{ id: P1.id, displayName: "Home", lat: P1.lat, lon: P1.lon, hourProfile, totalDwellSec: 3600 },
	{ id: P2.id, displayName: "Work", lat: P2.lat, lon: P2.lon, hourProfile: null, totalDwellSec: 1800 },
];
const continuityContext = { priorPlaceId: P1.id, priorPlaceCoord: { lat: P1.lat, lon: P1.lon }, hoursSinceLastConfirmedFix: 8, priorPosterior: 0.9 };
const inputs: any = {
	date: "2026-07-16", tz: "Europe/London", points, hr, steps, sleep: [],
	places, placeNearLine: new Set<string>(), routeGraph: graph, continuityContext,
	proximityByMinute: new Map(prox),
	segmentEvidence: true, chainContext: true, reacquireRobustSpeed: true, imputeCadence: false,
};

const model = buildHsmmModel(inputs);
const T = model.tensor.length, S = model.states.length;
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
	edges, places: places.map((p) => ({ id: p.id, name: p.displayName, lat: p.lat, lon: p.lon, hourProfile: p.hourProfile, dwell: p.totalDwellSec })),
	coverage: [], placeNearLine: [] as string[],
	continuity: { priorPlaceId: continuityContext.priorPlaceId, priorPlaceCoord: [continuityContext.priorPlaceCoord.lat, continuityContext.priorPlaceCoord.lon], hoursSince: continuityContext.hoursSinceLastConfirmedFix, priorPosterior: continuityContext.priorPosterior },
	flags: { reacquireRobust: true, segEvidence: true, chainContext: true },
};

console.log(`built model T=${T} S=${S}; decoding both sides…`);
const t0ms = performance.now();
const res = spawnSync(leanBin, ["assembledecode"], { input: JSON.stringify(payload), encoding: "utf8", maxBuffer: 1 << 28 });
const leanMs = performance.now() - t0ms;
if (res.status !== 0) { console.error("assembledecode failed:", res.stderr || res.stdout); process.exit(1); }
const lean = JSON.parse(res.stdout);
if (lean.error) { console.error("assembledecode error:", lean.error); process.exit(1); }
if (lean.degenerate) { console.error("lean decode degenerate"); process.exit(1); }
const leanPath: number[] = lean.path;

if (leanPath.length !== T) { console.error(`lean path length ${leanPath.length} != T ${T}`); process.exit(1); }
let agree = 0;
const diffs: string[] = [];
for (let i = 0; i < T; i++) {
	if (leanPath[i] === tsPath[i]) agree++;
	else if (diffs.length < 12) diffs.push(`min ${i}: lean=${leanPath[i]} ts=${tsPath[i]}`);
}
const leanScore = scoreFloat(model, leanPath);
const tsScore = scoreFloat(model, tsPath);
console.log(`agreement: ${agree}/${T} minutes (${((100 * agree) / T).toFixed(2)}%)  leanDecode=${leanMs.toFixed(0)}ms`);
console.log(`float re-score: lean=${leanScore.toFixed(4)} ts=${tsScore.toFixed(4)} Δ=${(leanScore - tsScore).toFixed(6)}`);
if (agree === T) console.log("✅ EXACT — Lean raw-inputs→path identical to TS served decode");
else {
	console.log(`⚠️  ${T - agree} minute(s) differ (quant near-tie unless Δ<0):`);
	for (const d of diffs) console.log("   " + d);
}
process.exit(leanScore >= tsScore - 1e-9 ? 0 : 1); // Lean path must not score worse
