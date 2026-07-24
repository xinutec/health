#!/usr/bin/env -S npx tsx
/**
 * Lean ↔ TypeScript assembly parity with NON-EMPTY train-generator coverage.
 *
 * The empty/populated-graph harnesses never exercise the covered code paths.
 * This day has stations (Alpha, Beta) on an underground Jubilee Line and a tube
 * blackout between them, so the generator vouches "Jubilee Line" on those
 * minutes — driving the entry boost (+3 valid / −8 invalid line), the route-rail
 * gate (covered ⇒ 0, not the +3.5 boost), the train-hop duration relaxation, and
 * the chain-context boarding gate. Coverage is taken from TS `linesAt` and fed to
 * Lean's `buildContext` (this checks Lean CONSUMES coverage correctly; the Lean
 * REBUILD via enumerateTrainCandidates is a separate check).
 *
 * Verifies both the quantised tensors (`assemble`) and the decoded path
 * (`assembledecode`). Run: npx tsx lean/experiments/compare-assemble-covered.mts
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const leanBin = path.join(here, "..", ".lake", "build", "bin", "verified_cli");

const { buildHsmmModel, KNOWN_LINES } = await import(path.join(repo, "src/hmm/decode.ts"));
const { buildTrainGeneratorPrior } = await import(path.join(repo, "src/hmm/train-generator-prior.ts"));
const { quantize, decodeTsFloat, scoreFloat } = await import(path.join(repo, "src/hmm/lean-shadow-core.ts"));
const { buildRouteGraph, nodeKey } = await import(path.join(repo, "src/geo/route-graph.ts"));
const { DEFAULT_MAX_DURATION } = await import(path.join(repo, "src/hmm/hsmm-viterbi.ts"));

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
const cc = { priorPlaceId: P1.id, priorPlaceCoord: { lat: P1.lat, lon: P1.lon }, hoursSinceLastConfirmedFix: 8, priorPosterior: 0.9 };
const inputs: any = {
	date: "2026-07-16", tz: "Europe/London", points, hr, steps, sleep: [],
	places, placeNearLine: new Set<string>(), routeGraph: graph, continuityContext: cc,
	proximityByMinute: new Map(prox), segmentEvidence: true, chainContext: true, reacquireRobustSpeed: true, imputeCadence: false,
};

const model = buildHsmmModel(inputs);
const T = model.tensor.length, S = model.states.length, maxD = DEFAULT_MAX_DURATION, st = model.states;
const tg = buildTrainGeneratorPrior({ observations: model.tensor, routeGraph: graph, knownLines: KNOWN_LINES });
const coverage = model.tensor.filter((o: any) => tg.isCovered(o.ts)).map((o: any) => [o.ts, tg.linesAt(o.ts)]);
console.log(`built model T=${T} S=${S}; covered minutes=${coverage.length} (${coverage.length ? coverage[0][1] : "-"})`);
if (coverage.length === 0) { console.error("no coverage — test would be vacuous"); process.exit(1); }

const obs = model.tensor.map((o: any) => ({
	ts: o.ts, gps: o.gps ? { lat: o.gps.lat, lon: o.gps.lon, speedKmh: o.gps.speedKmh } : null,
	hr: o.hr ?? null, cadence: o.cadence ?? null, hourLocal: o.hourLocal, dayOfWeekLocal: o.dayOfWeekLocal,
	inBed: o.inBed, roadDistM: o.roadDistM ?? null, railDistM: o.railDistM ?? null, reacquireAgeMin: o.reacquireAgeMin ?? null,
	prevGpsFix: o.prevGpsFix ? { ts: o.prevGpsFix.ts, lat: o.prevGpsFix.lat, lon: o.prevGpsFix.lon } : null,
	nextGpsFix: o.nextGpsFix ? { ts: o.nextGpsFix.ts, lat: o.nextGpsFix.lat, lon: o.nextGpsFix.lon } : null,
}));
const coveredIdx = model.tensor.flatMap((o: any, i: number) => (tg.isCovered(o.ts) ? [i] : []));
const sampleT = [...new Set([0, coveredIdx[0], coveredIdx[coveredIdx.length - 1], T - 1])];
const transProbes: [number, number, number][] = [];
for (const t of sampleT) for (let a = 0; a < S; a++) for (let b = 0; b < S; b++) transProbes.push([a, b, t]);
const durProbes: [number, number, number][] = [];
for (let s = 0; s < S; s++) for (const dd of [1, 2, 3, 5, 60, maxD]) for (const e of sampleT) durProbes.push([s, dd, e]);

const base = {
	maxD, obs, edges, places: places.map((p) => ({ id: p.id, name: p.displayName, lat: p.lat, lon: p.lon, hourProfile: p.hourProfile, dwell: p.totalDwellSec })),
	coverage, placeNearLine: [] as string[],
	continuity: { priorPlaceId: cc.priorPlaceId, priorPlaceCoord: [cc.priorPlaceCoord.lat, cc.priorPlaceCoord.lon], hoursSince: cc.hoursSinceLastConfirmedFix, priorPosterior: cc.priorPosterior },
	flags: { reacquireRobust: true, segEvidence: true, chainContext: true },
};

const run = (mode: string, extra: any) => {
	const res = spawnSync(leanBin, [mode], { input: JSON.stringify({ ...base, ...extra }), encoding: "utf8", maxBuffer: 1 << 28 });
	if (res.status !== 0) { console.error(`${mode} failed:`, res.stderr || res.stdout); process.exit(1); }
	const j = JSON.parse(res.stdout);
	if (j.error) { console.error(`${mode} error:`, j.error); process.exit(1); }
	return j;
};

// ── tensor parity ──
const lean = run("assemble", { transProbes, durProbes });
let mism = 0; const ex: string[] = [];
const note = (s: string) => { mism++; if (ex.length < 10) ex.push(s); };
const eq = (a: any, b: any) => (a === null ? b === null : b !== null && a === b);
for (let t = 0; t < T; t++) for (let s = 0; s < S; s++) {
	if (!eq(lean.emit[t][s], quantize(model.emissionLogProb(st[s], model.tensor[t])))) note(`emit[${t}][${s}] lean=${lean.emit[t][s]} ts=${quantize(model.emissionLogProb(st[s], model.tensor[t]))}`);
	if (!eq(lean.entry[t][s], quantize(model.entryLogProb(st[s], model.tensor[t])))) note(`entry[${t}][${s}] lean=${lean.entry[t][s]} ts=${quantize(model.entryLogProb(st[s], model.tensor[t]))}`);
}
for (let s = 0; s < S; s++) if (!eq(lean.init[s], quantize(model.initialLogProb(st[s])))) note(`init[${s}]`);
transProbes.forEach(([a, b, t], i) => { const w = quantize(model.transitionLogProb(st[a], st[b], model.tensor[t])); if (!eq(lean.transP[i], w)) note(`trans[${a},${b},${t}] lean=${lean.transP[i]} ts=${w}`); });
durProbes.forEach(([s, dd, e], i) => { const w = quantize(model.durationLogProb(st[s], dd, e)); if (!eq(lean.durP[i], w)) note(`dur[${s},${dd},${e}] lean=${lean.durP[i]} ts=${w}`); });
const cells = T * S * 2 + S + transProbes.length + durProbes.length;
if (mism === 0) console.log(`✅ tensors EXACT — ${cells} cells`);
else { console.log(`❌ ${mism}/${cells} tensor mismatches:`); for (const e of ex) console.log("   " + e); process.exit(1); }

// ── decode parity ──
const dec = run("assembledecode", {});
if (dec.degenerate) { console.error("lean decode degenerate"); process.exit(1); }
const leanPath: number[] = dec.path, tsPath = decodeTsFloat(model);
let agree = 0; const diffs: string[] = [];
for (let i = 0; i < T; i++) { if (leanPath[i] === tsPath[i]) agree++; else if (diffs.length < 8) diffs.push(`min ${i}: lean=${leanPath[i]} ts=${tsPath[i]}`); }
const lS = scoreFloat(model, leanPath), tS = scoreFloat(model, tsPath);
console.log(`decode agreement: ${agree}/${T} (${((100 * agree) / T).toFixed(2)}%)  scoreΔ=${(lS - tS).toFixed(6)}`);
if (agree === T) console.log("✅ decode EXACT — raw inputs → path identical with coverage");
else { console.log(`⚠️  ${T - agree} differ:`); for (const d of diffs) console.log("   " + d); }
process.exit(mism === 0 && lS >= tS - 1e-9 ? 0 : 1);
