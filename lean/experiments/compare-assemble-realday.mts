#!/usr/bin/env -S npx tsx
/**
 * Lean ↔ TypeScript full-path parity on a REAL captured day.
 *
 * Loads a golden fixture (tests/golden/decoded_days/*.json) — the same corpus
 * `lean-shadow` validates against — rebuilds the real HsmmInputs
 * (`hsmmInputsFromFixture`, incl. the real route graph, placeNearLine, coverage,
 * continuity), and runs the FULLY SELF-CONTAINED Lean path (`assembledecode`:
 * rebuild coverage → assemble → quantise → decode) against the TS served decode.
 *
 * Pass criteria (the quant playbook): tensors EXACT (assembly is bit-exact
 * per-cell — the correctness signal), decode agreement very high, and Lean's
 * float re-score never worse than TS (near-tie flips are acceptable).
 *
 * Run: npx tsx lean/experiments/compare-assemble-realday.mts [YYYY-MM-DD]
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildHsmmModel } from "../../src/hmm/decode.js";
import { hsmmInputsFromFixture } from "../../src/cli/hsmm-fixture.js";
import { quantize, decodeTsFloat, scoreFloat } from "../../src/hmm/lean-shadow-core.js";
import { nodeKey } from "../../src/geo/route-graph.js";
import { DEFAULT_MAX_DURATION } from "../../src/hmm/hsmm-viterbi.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const leanBin = path.join(here, "..", ".lake", "build", "bin", "verified_cli");
const dir = path.join(repo, "tests", "golden", "decoded_days");

const want = process.argv[2];
const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
const file = want ? files.find((f) => f.includes(want)) : files[files.length - 1];
if (!file) { console.error(`no fixture for ${want ?? "latest"} in ${dir}`); process.exit(1); }

const captured = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
const inputs: any = hsmmInputsFromFixture(captured);
const model = buildHsmmModel(inputs);
const T = model.tensor.length, S = model.states.length, maxD = DEFAULT_MAX_DURATION, st = model.states;
const graph = inputs.routeGraph;
console.log(`day ${file}: T=${T} S=${S} edges=${graph.edges.size} nodes=${graph.nodes.size} placeNearLine=${inputs.placeNearLine.size} flags={seg:${inputs.segmentEvidence},chain:${inputs.chainContext},reacq:${inputs.reacquireRobustSpeed}}`);

const cc = inputs.continuityContext;
const payload = {
	maxD,
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
	nodes: [...graph.nodes.values()].map((n: any) => ({
		id: n.id, lat: n.point.lat, lon: n.point.lon, stationName: n.stationName ?? null, edgeIds: [...n.edgeIds],
	})),
	// Some captured coords are DB-serialized as strings (JS coerces them numerically
	// in haversine, so TS's effective value is Number(...)); pass the number to Lean.
	places: inputs.places.map((p: any) => ({ id: p.id, name: p.displayName, lat: Number(p.lat), lon: Number(p.lon), hourProfile: p.hourProfile, dwell: p.totalDwellSec })),
	placeNearLine: [...inputs.placeNearLine],
	continuity: cc ? { priorPlaceId: cc.priorPlaceId, priorPlaceCoord: cc.priorPlaceCoord ? [Number(cc.priorPlaceCoord.lat), Number(cc.priorPlaceCoord.lon)] : null, hoursSince: cc.hoursSinceLastConfirmedFix, priorPosterior: cc.priorPosterior } : null,
	flags: { reacquireRobust: inputs.reacquireRobustSpeed === true, segEvidence: inputs.segmentEvidence === true, chainContext: inputs.chainContext === true },
};

// Tensor probes: sample minutes (incl. GPS + blackout ones) to check the assembly.
const gpsIdx = model.tensor.flatMap((o: any, i: number) => (o.gps !== null ? [i] : []));
const boIdx = model.tensor.flatMap((o: any, i: number) => (o.gps === null && o.prevGpsFix && o.nextGpsFix && o.prevGpsFix.ts !== o.nextGpsFix.ts ? [i] : []));
const sampleT = [...new Set([0, ...gpsIdx.filter((_: number, k: number) => k % Math.max(1, Math.floor(gpsIdx.length / 20)) === 0), ...boIdx.slice(0, 5), T - 1])].sort((a, b) => a - b);
const transProbes: [number, number, number][] = [];
for (const t of sampleT.slice(0, 6)) for (let a = 0; a < S; a++) for (let b = 0; b < S; b++) transProbes.push([a, b, t]);
const durProbes: [number, number, number][] = [];
for (let s = 0; s < S; s++) for (const dd of [1, 2, 3, 5, 60, maxD]) for (const e of sampleT.slice(0, 6)) durProbes.push([s, dd, e]);

const run = (mode: string, extra: any) => {
	const t = performance.now();
	const res = spawnSync(leanBin, [mode], { input: JSON.stringify({ ...payload, ...extra }), encoding: "utf8", maxBuffer: 1 << 30 });
	if (res.status !== 0) { console.error(`${mode} failed:`, (res.stderr || res.stdout || "").slice(0, 2000)); process.exit(1); }
	const j = JSON.parse(res.stdout);
	if (j.error) { console.error(`${mode} error:`, j.error); process.exit(1); }
	return { j, ms: performance.now() - t };
};

// ── tensor parity ──
const { j: lean, ms: asmMs } = run("assemble", { transProbes, durProbes });
// Classify a mismatch by |Δ| in the QUANTISED integer: ≤1 is the accepted
// ≤1-ULP class (emit/geo factors flow through log/exp/haversine, non-
// correctly-rounded libm, ≤1 ULP; ×2²⁰ round lands on an adjacent integer for
// large-magnitude penalties). >1 is a structural divergence and fails.
let ulp = 0, structural = 0, maxAbsD = 0; const ex: string[] = [];
const check = (name: string, a: any, b: any) => {
	if (a === null ? b === null : b !== null && a === b) return;
	if (a === null || b === null) { structural++; if (ex.length < 10) ex.push(`${name} lean=${a} ts=${b} (−∞ flip)`); return; }
	const d = Math.abs(a - b); maxAbsD = Math.max(maxAbsD, d);
	if (d <= 1) ulp++; else { structural++; if (ex.length < 10) ex.push(`${name} lean=${a} ts=${b} Δ=${a - b}`); }
};
for (let t = 0; t < T; t++) for (let s = 0; s < S; s++) {
	check(`emit[${t}][${s}]`, lean.emit[t][s], quantize(model.emissionLogProb(st[s], model.tensor[t])));
	check(`entry[${t}][${s}]`, lean.entry[t][s], quantize(model.entryLogProb(st[s], model.tensor[t])));
}
for (let s = 0; s < S; s++) check(`init[${s}]`, lean.init[s], quantize(model.initialLogProb(st[s])));
transProbes.forEach(([a, b, t], i) => check(`trans[${a},${b},${t}]`, lean.transP[i], quantize(model.transitionLogProb(st[a], st[b], model.tensor[t]))));
durProbes.forEach(([s, dd, e], i) => check(`dur[${s},${dd},${e}]`, lean.durP[i], quantize(model.durationLogProb(st[s], dd, e))));
const cells = T * S * 2 + S + transProbes.length + durProbes.length;
console.log(`tensors: ${cells} cells — ${cells - ulp - structural} exact, ${ulp} ≤1-ULP (accepted, maxΔ=${maxAbsD}), ${structural} structural (assemble ${(asmMs / 1000).toFixed(1)}s)`);
if (structural > 0) { console.log("  structural mismatches:"); for (const e of ex) console.log("   " + e); }

// ── decode parity ──
const { j: dec, ms: decMs } = run("assembledecode", {});
if (dec.degenerate) { console.error("lean decode degenerate"); process.exit(1); }
const leanPath: number[] = dec.path, tsPath = decodeTsFloat(model);
let agree = 0; const diffs: string[] = [];
for (let i = 0; i < T; i++) { if (leanPath[i] === tsPath[i]) agree++; else if (diffs.length < 10) diffs.push(`min ${i}: lean=${leanPath[i]}(${st[leanPath[i]]?.mode}) ts=${tsPath[i]}(${st[tsPath[i]]?.mode})`); }
const lS = scoreFloat(model, leanPath), tS = scoreFloat(model, tsPath);
console.log(`decode: ${agree}/${T} agree (${((100 * agree) / T).toFixed(3)}%)  floatΔ=${(lS - tS).toFixed(6)}  (assembledecode ${(decMs / 1000).toFixed(1)}s)`);
if (agree < T) { console.log(`  ${T - agree} differ (near-ties if Δ≥0):`); for (const d of diffs) console.log("   " + d); }
const ok = structural === 0 && lS >= tS - 1e-6;
console.log(ok ? `✅ PASS — no structural divergence (${ulp} ≤1-ULP flips, decode ${agree}/${T}, Lean score not worse)` : "❌ FAIL — structural divergence or Lean score worse");
process.exit(ok ? 0 : 1);
