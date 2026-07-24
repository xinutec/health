#!/usr/bin/env -S npx tsx
/**
 * Lean ↔ TypeScript HSMM *model-assembly* parity harness.
 *
 * The trellis harness (compare.mjs) checks the DECODE given quantised tensors.
 * This checks the step before it: that the Lean model builder
 * (`Verified.Hsmm.Assemble`, via `verified_cli assemble`) produces the SAME
 * quantised tensors as TS `buildHsmmModel`, cell-for-cell.
 *
 * Reference = the FLOAT model callbacks quantised directly (`quantize(model.
 * transitionLogProb(...))` etc), NOT `quantAccessors(q)`: quantizeModel's transOv
 * export uses a coarse (a,b += 11) sampler that can miss chain-context deviations
 * on a small state space — an export-fidelity concern separate from whether Lean
 * ASSEMBLED right.
 *
 * Two scenarios:
 *   - EMPTY graph: isolates the non-graph factors (base emission, geometric,
 *     entry priors, duration + segment evidence, transition + placeNearLine +
 *     chain-stay, continuity).
 *   - POPULATED graph: an underground "Jubilee Line" (two connected edges) and a
 *     tube blackout, so route-rail / line-proximity fire too.
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
const { quantize } = await import(path.join(repo, "src/hmm/lean-shadow-core.ts"));
const { DEFAULT_MAX_DURATION } = await import(path.join(repo, "src/hmm/hsmm-viterbi.ts"));
const { buildRouteGraph, nodeKey } = await import(path.join(repo, "src/geo/route-graph.ts"));

const day = "2026-07-16";
const tz = "Europe/London";
const t0 = Math.floor(Date.parse("2026-07-16T11:00:00Z") / 1000); // midday BST
const P1 = { id: 101, lat: 51.52, lon: -0.13 };
const P2 = { id: 202, lat: 51.5, lon: -0.1 };
const hourProfile = Array.from({ length: 24 }, (_, h) => (h === 11 ? 0.2 : 0.03));
const places = [
	{ id: P1.id, displayName: "Home", lat: P1.lat, lon: P1.lon, hourProfile, totalDwellSec: 3600 },
	{ id: P2.id, displayName: "Work", lat: P2.lat, lon: P2.lon, hourProfile: null, totalDwellSec: 1800 },
];
const continuityContext = {
	priorPlaceId: P1.id,
	priorPlaceCoord: { lat: P1.lat, lon: P1.lon },
	hoursSinceLastConfirmedFix: 8,
	priorPosterior: 0.9,
};
const emptyGraph = { edges: new Map(), nodes: new Map(), edgesNear: () => [] } as any;

// Populated graph: underground Jubilee Line A→M→B (two connected edges).
const A = { lat: 51.5, lon: -0.1 };
const M = { lat: 51.525, lon: -0.075 };
const B = { lat: 51.55, lon: -0.05 };
const wkt = (a: any, b: any) => `LINESTRING(${a.lon} ${a.lat}, ${b.lon} ${b.lat})`;
const rawLines = [
	{ osm_id: 1n, osm_type: "way", feature_type: "railway", subtype: "subway", name: "Jubilee Line", tags_json: '{"tunnel":"yes"}', geom: wkt(A, M) },
	{ osm_id: 2n, osm_type: "way", feature_type: "railway", subtype: "subway", name: "Jubilee Line", tags_json: '{"tunnel":"yes"}', geom: wkt(M, B) },
];
const populatedGraph = buildRouteGraph(rawLines, []); // no station points ⇒ empty coverage
const edgesJson = [...populatedGraph.edges.values()].map((e: any) => ({
	id: e.id,
	geometry: e.geometry.map((p: any) => ({ lat: p.lat, lon: p.lon })),
	lineMemberships: [...e.attrs.lineMemberships],
	underground: e.attrs.underground,
	startNode: nodeKey(e.startPoint.lat, e.startPoint.lon),
	endNode: nodeKey(e.endPoint.lat, e.endPoint.lon),
}));

/** A day: 3 min stationary at `start`, then either walking away (empty scenario)
 *  or a tube blackout A→B (populated). Returns points/hr/steps/proximity. */
function buildDay(kind: "walk" | "tube") {
	const points: any[] = [], hr: any[] = [], steps: any[] = [], prox: [number, any][] = [];
	if (kind === "walk") {
		for (let m = 0; m < 5; m++) {
			points.push({ ts: t0 + m * 60, lat: P1.lat, lon: P1.lon, speed_kmh: 0.2, bearing: 0 });
			hr.push({ ts: t0 + m * 60, bpm: 68 }); steps.push({ ts: t0 + m * 60, steps: 0 });
		}
		for (let m = 5; m < 11; m++) {
			points.push({ ts: t0 + m * 60, lat: P1.lat + (m - 4) * 9e-4, lon: P1.lon + (m - 4) * 6e-4, speed_kmh: 5, bearing: 45 });
			hr.push({ ts: t0 + m * 60, bpm: 102 }); steps.push({ ts: t0 + m * 60, steps: 105 });
		}
	} else {
		// GPS at A, blackout, GPS at B — a dark underground ride.
		for (let m = 0; m < 3; m++) {
			points.push({ ts: t0 + m * 60, lat: A.lat, lon: A.lon, speed_kmh: 2, bearing: 0 });
			hr.push({ ts: t0 + m * 60, bpm: 80 }); steps.push({ ts: t0 + m * 60, steps: 0 });
			prox.push([t0 + m * 60, { railDistM: 50, roadDistM: 300 }]); // rail-nearer
		}
		// minutes 3..8: no GPS (blackout) → prevGpsFix=A, nextGpsFix=B on those rows.
		points.push({ ts: t0 + 9 * 60, lat: B.lat, lon: B.lon, speed_kmh: 2, bearing: 0 });
		hr.push({ ts: t0 + 9 * 60, bpm: 80 }); steps.push({ ts: t0 + 9 * 60, steps: 0 });
		prox.push([t0 + 9 * 60, { railDistM: 50, roadDistM: 300 }]);
	}
	return { points, hr, steps, proximityByMinute: new Map(prox) };
}

function compareDay(label: string, routeGraph: any, edges: any[], kind: "walk" | "tube"): boolean {
	const d = buildDay(kind);
	const inputs: any = {
		date: day, tz, points: d.points, hr: d.hr, steps: d.steps, sleep: [],
		places, placeNearLine: new Set<string>(), routeGraph, continuityContext,
		proximityByMinute: d.proximityByMinute,
		segmentEvidence: true, chainContext: true, reacquireRobustSpeed: true, imputeCadence: false,
	};
	const model = buildHsmmModel(inputs);
	const T = model.tensor.length, S = model.states.length, maxD = DEFAULT_MAX_DURATION;

	const obs = model.tensor.map((o: any) => ({
		ts: o.ts, gps: o.gps ? { lat: o.gps.lat, lon: o.gps.lon, speedKmh: o.gps.speedKmh } : null,
		hr: o.hr ?? null, cadence: o.cadence ?? null, hourLocal: o.hourLocal, dayOfWeekLocal: o.dayOfWeekLocal,
		inBed: o.inBed, roadDistM: o.roadDistM ?? null, railDistM: o.railDistM ?? null, reacquireAgeMin: o.reacquireAgeMin ?? null,
		prevGpsFix: o.prevGpsFix ? { ts: o.prevGpsFix.ts, lat: o.prevGpsFix.lat, lon: o.prevGpsFix.lon } : null,
		nextGpsFix: o.nextGpsFix ? { ts: o.nextGpsFix.ts, lat: o.nextGpsFix.lat, lon: o.nextGpsFix.lon } : null,
	}));

	const gpsIdx = model.tensor.flatMap((o: any, i: number) => (o.gps !== null ? [i] : []));
	const blackoutIdx = model.tensor.flatMap((o: any, i: number) => (o.gps === null && o.prevGpsFix !== null && o.nextGpsFix !== null && o.prevGpsFix.ts !== o.nextGpsFix.ts ? [i] : []));
	const sampleT = [...new Set([0, ...gpsIdx, ...blackoutIdx.slice(0, 3), T - 1])];
	const transProbes: [number, number, number][] = [];
	for (const t of sampleT) for (let a = 0; a < S; a++) for (let b = 0; b < S; b++) transProbes.push([a, b, t]);
	const durProbes: [number, number, number][] = [];
	for (let s = 0; s < S; s++) for (const dd of [1, 2, 3, 5, 60, maxD]) for (const e of sampleT) durProbes.push([s, dd, e]);

	const payload = {
		maxD, obs, edges,
		places: places.map((p) => ({ id: p.id, name: p.displayName, lat: p.lat, lon: p.lon, hourProfile: p.hourProfile, dwell: p.totalDwellSec })),
		coverage: [], placeNearLine: [] as string[],
		continuity: { priorPlaceId: continuityContext.priorPlaceId, priorPlaceCoord: [continuityContext.priorPlaceCoord.lat, continuityContext.priorPlaceCoord.lon], hoursSince: continuityContext.hoursSinceLastConfirmedFix, priorPosterior: continuityContext.priorPosterior },
		flags: { reacquireRobust: true, segEvidence: true, chainContext: true },
		transProbes, durProbes,
	};

	const res = spawnSync(leanBin, ["assemble"], { input: JSON.stringify(payload), encoding: "utf8", maxBuffer: 1 << 28 });
	if (res.status !== 0) { console.error(`[${label}] assemble failed:`, res.stderr || res.stdout); return false; }
	const lean = JSON.parse(res.stdout);
	if (lean.error) { console.error(`[${label}] assemble error:`, lean.error); return false; }

	let mism = 0; const ex: string[] = [];
	const note = (s: string) => { mism++; if (ex.length < 10) ex.push(s); };
	const eq = (a: any, b: any) => (a === null ? b === null : b !== null && a === b);
	const st = model.states;
	for (let t = 0; t < T; t++) for (let s = 0; s < S; s++) {
		if (!eq(lean.emit[t][s], quantize(model.emissionLogProb(st[s], model.tensor[t])))) note(`emit[${t}][${s}] lean=${lean.emit[t][s]} ts=${quantize(model.emissionLogProb(st[s], model.tensor[t]))}`);
		if (!eq(lean.entry[t][s], quantize(model.entryLogProb(st[s], model.tensor[t])))) note(`entry[${t}][${s}] lean=${lean.entry[t][s]}`);
	}
	for (let s = 0; s < S; s++) if (!eq(lean.init[s], quantize(model.initialLogProb(st[s])))) note(`init[${s}]`);
	transProbes.forEach(([a, b, t], i) => {
		const want = quantize(model.transitionLogProb(st[a], st[b], model.tensor[t]));
		if (!eq(lean.transP[i], want)) note(`trans[${a},${b},${t}] lean=${lean.transP[i]} ts=${want}`);
	});
	durProbes.forEach(([s, dd, e], i) => {
		const want = quantize(model.durationLogProb(st[s], dd, e));
		if (!eq(lean.durP[i], want)) note(`dur[${s},${dd},${e}] lean=${lean.durP[i]} ts=${want}`);
	});

	const cells = T * S * 2 + S + transProbes.length + durProbes.length;
	if (mism === 0) { console.log(`✅ [${label}] EXACT — ${cells} cells (T=${T} S=${S}, emit+entry ${T * S * 2}, init ${S}, trans ${transProbes.length}, dur ${durProbes.length})`); return true; }
	console.log(`❌ [${label}] ${mism}/${cells} mismatches. First ${ex.length}:`);
	for (const e of ex) console.log("   " + e);
	return false;
}

const ok1 = compareDay("empty-graph", emptyGraph, [], "walk");
const ok2 = compareDay("populated-graph", populatedGraph, edgesJson, "tube");
process.exit(ok1 && ok2 ? 0 : 1);
