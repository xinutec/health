#!/usr/bin/env -S npx tsx
/**
 * Lean ↔ TypeScript HSMM *model-assembly* parity harness.
 *
 * The trellis harness (compare.mjs) checks the DECODE given quantised tensors.
 * This checks the step before it: that the Lean model builder
 * (`Verified.Hsmm.Assemble`, via `verified_cli assemble`) produces the SAME
 * quantised tensors as TS `buildHsmmModel` + `quantizeModel`, cell-for-cell.
 *
 * A synthetic-but-complete day drives every non-graph factor (base emission,
 * geometric feasibility, entry priors, duration + segment evidence, transition
 * + chain-context stay term, continuity). The route graph is EMPTY, so the
 * graph-dependent route-rail / line-proximity / boarding terms are 0 on both
 * sides (they are unit-pinned in RouteModel's own guards); a follow-up adds a
 * populated graph.
 *
 * Run: npx tsx lean/experiments/compare-assemble.mts   (after `lake build`)
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const leanBin = path.join(here, "..", ".lake", "build", "bin", "verified_cli");

const { buildHsmmModel } = await import(path.join(repo, "src/hmm/decode.ts"));
const { quantizeModel, quantAccessors, quantize } = await import(path.join(repo, "src/hmm/lean-shadow-core.ts"));
const { DEFAULT_MAX_DURATION } = await import(path.join(repo, "src/hmm/hsmm-viterbi.ts"));

// ── synthetic day ──────────────────────────────────────────────────────────
const day = "2026-07-16";
const tz = "Europe/London";
const t0 = Math.floor(Date.parse("2026-07-16T11:00:00Z") / 1000); // midday BST
const P1 = { id: 101, lat: 51.52, lon: -0.13 };
const P2 = { id: 202, lat: 51.5, lon: -0.1 };

// 5 min stationary at P1, then 6 min walking away from it.
const points: any[] = [];
const hr: any[] = [];
const steps: any[] = [];
for (let m = 0; m < 5; m++) {
	points.push({ ts: t0 + m * 60, lat: P1.lat, lon: P1.lon, speed_kmh: 0.2, bearing: 0 });
	hr.push({ ts: t0 + m * 60, bpm: 68 });
	steps.push({ ts: t0 + m * 60, steps: 0 });
}
for (let m = 5; m < 11; m++) {
	points.push({ ts: t0 + m * 60, lat: P1.lat + (m - 4) * 0.0009, lon: P1.lon + (m - 4) * 0.0006, speed_kmh: 5, bearing: 45 });
	hr.push({ ts: t0 + m * 60, bpm: 102 });
	steps.push({ ts: t0 + m * 60, steps: 105 });
}

const hourProfile = Array.from({ length: 24 }, (_, h) => (h === 11 ? 0.2 : 0.03));
const places = [
	{ id: P1.id, displayName: "Home", lat: P1.lat, lon: P1.lon, hourProfile, totalDwellSec: 3600 },
	{ id: P2.id, displayName: "Work", lat: P2.lat, lon: P2.lon, hourProfile: null, totalDwellSec: 1800 },
];
const emptyGraph = { edges: new Map(), nodes: new Map(), edgesNear: () => [] } as any;
const continuityContext = {
	priorPlaceId: P1.id,
	priorPlaceCoord: { lat: P1.lat, lon: P1.lon },
	hoursSinceLastConfirmedFix: 8,
	priorPosterior: 0.9,
};

const inputs: any = {
	date: day, tz, points, hr, steps, sleep: [],
	places, placeNearLine: new Set<string>(), routeGraph: emptyGraph,
	continuityContext,
	segmentEvidence: true, chainContext: true, reacquireRobustSpeed: true, imputeCadence: false,
};

const model = buildHsmmModel(inputs);
const q = quantizeModel(model);
const T = model.tensor.length;
const S = model.states.length;
const maxD = DEFAULT_MAX_DURATION;
const acc = quantAccessors(q);
console.log(`built model: T=${T} S=${S} maxD=${maxD} (states=${S})`);

// ── payload for Lean ───────────────────────────────────────────────────────
const obs = model.tensor.map((o: any) => ({
	ts: o.ts,
	gps: o.gps ? { lat: o.gps.lat, lon: o.gps.lon, speedKmh: o.gps.speedKmh } : null,
	hr: o.hr ?? null,
	cadence: o.cadence ?? null,
	hourLocal: o.hourLocal,
	dayOfWeekLocal: o.dayOfWeekLocal,
	inBed: o.inBed,
	roadDistM: o.roadDistM ?? null,
	railDistM: o.railDistM ?? null,
	reacquireAgeMin: o.reacquireAgeMin ?? null,
	prevGpsFix: o.prevGpsFix ? { ts: o.prevGpsFix.ts, lat: o.prevGpsFix.lat, lon: o.prevGpsFix.lon } : null,
	nextGpsFix: o.nextGpsFix ? { ts: o.nextGpsFix.ts, lat: o.nextGpsFix.lat, lon: o.nextGpsFix.lon } : null,
}));

const activeIdx = model.tensor.findIndex((o: any) => o.gps !== null);
const walkIdx = model.tensor.findIndex((o: any, i: number) => o.gps !== null && i > activeIdx + 5);
const tProbeT = [0, activeIdx, walkIdx > 0 ? walkIdx : activeIdx, T - 1];
const transProbes: [number, number, number][] = [];
for (const t of tProbeT) for (let a = 0; a < S; a++) for (let b = 0; b < S; b++) transProbes.push([a, b, t]);
const durProbes: [number, number, number][] = [];
for (let s = 0; s < S; s++) for (const d of [1, 2, 3, 5, 60, maxD]) for (const e of [0, activeIdx, T - 1]) durProbes.push([s, d, e]);

const payload = {
	maxD, obs, edges: [], places: places.map((p) => ({ id: p.id, name: p.displayName, lat: p.lat, lon: p.lon, hourProfile: p.hourProfile, dwell: p.totalDwellSec })),
	coverage: [],
	placeNearLine: [] as string[], // empty ⇒ every place↔train transition hard-zeroed
	continuity: { priorPlaceId: continuityContext.priorPlaceId, priorPlaceCoord: [continuityContext.priorPlaceCoord.lat, continuityContext.priorPlaceCoord.lon], hoursSince: continuityContext.hoursSinceLastConfirmedFix, priorPosterior: continuityContext.priorPosterior },
	flags: { reacquireRobust: true, segEvidence: true, chainContext: true },
	transProbes, durProbes,
};

const res = spawnSync(leanBin, ["assemble"], { input: JSON.stringify(payload), encoding: "utf8", maxBuffer: 1 << 28 });
if (res.status !== 0) {
	console.error("verified_cli assemble failed:", res.stderr || res.stdout);
	process.exit(1);
}
const lean = JSON.parse(res.stdout);
if (lean.error) {
	console.error("assemble error:", lean.error);
	process.exit(1);
}

// ── compare ────────────────────────────────────────────────────────────────
let mism = 0;
const ex: string[] = [];
const note = (s: string) => {
	mism++;
	if (ex.length < 12) ex.push(s);
};
const eq = (a: any, b: any) => (a === null ? b === null : b !== null && a === b);

if (lean.T !== T || lean.S !== S) note(`dims: lean T=${lean.T} S=${lean.S} vs ${T}/${S}`);
for (let t = 0; t < T; t++)
	for (let s = 0; s < S; s++) {
		if (!eq(lean.emit[t][s], q.emit[t][s])) note(`emit[${t}][${s}] lean=${lean.emit[t][s]} ts=${q.emit[t][s]}`);
		if (!eq(lean.entry[t][s], q.entry[t][s])) note(`entry[${t}][${s}] lean=${lean.entry[t][s]} ts=${q.entry[t][s]}`);
	}
for (let s = 0; s < S; s++) if (!eq(lean.init[s], q.init[s])) note(`init[${s}] lean=${lean.init[s]} ts=${q.init[s]}`);
// Reference = the FLOAT model callbacks quantised directly (ground truth per
// cell). NOT quantAccessors(q): quantizeModel's transOv export uses a coarse
// (a,b += 11) sampler that can miss chain-context deviations on a small state
// space — an export-fidelity concern separate from whether Lean ASSEMBLED right.
const st = model.states;
transProbes.forEach(([a, b, t], i) => {
	const want = quantize(model.transitionLogProb(st[a], st[b], model.tensor[t]));
	if (!eq(lean.transP[i], want)) note(`trans[${a},${b},${t}] lean=${lean.transP[i]} ts=${want}`);
});
durProbes.forEach(([s, d, e], i) => {
	const want = quantize(model.durationLogProb(st[s], d, e));
	if (!eq(lean.durP[i], want)) note(`dur[${s},${d},${e}] lean=${lean.durP[i]} ts=${want}`);
});

const cells = T * S * 2 + S + transProbes.length + durProbes.length;
if (mism === 0) console.log(`✅ EXACT — all ${cells} compared cells agree (emit+entry ${T * S * 2}, init ${S}, trans ${transProbes.length}, dur ${durProbes.length})`);
else {
	console.log(`❌ ${mism} mismatches of ${cells} cells. First ${ex.length}:`);
	for (const e of ex) console.log("   " + e);
	process.exit(1);
}
