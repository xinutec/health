#!/usr/bin/env -S npx tsx
/**
 * How many bytes does the HSMM tenant actually ship, and how many would the
 * self-contained path ship instead? (#411)
 *
 * The tenant today marshals the whole QUANTISED TRELLIS — `emit` (T×S), `entry`
 * (T×S), `trans`, `dur`, the RLE'd `durDelta` — so Lean can decode one day and
 * hand back ~1440 integers. `verified_cli assembledecode` takes RAW INPUTS
 * instead (`Verified.Hsmm.Assemble` is the `buildHsmmModel` twin) and assembles
 * the model in-process, so the tensors never cross.
 *
 * The prediction is that raw inputs are far smaller. A prediction is not a
 * measurement, and the whole of #411 is a wire-size claim, so this counts the
 * bytes of both payloads over the golden corpus rather than reasoning about
 * them. It builds the SAME two objects the real code paths build:
 *
 *   marshalled — `decodeLean`'s payload, field for field (src/hmm/lean-shadow-core.ts)
 *   raw inputs — `compare-assemble-realday.mts`'s payload, field for field
 *
 * Byte counts are `Buffer.byteLength(JSON.stringify(...))`: what the worker
 * `postMessage` and the `spawnSync` stdin actually carry. Not an in-memory
 * size, not a compressed size — the wire, which is what #405 identified as the
 * target and what the Rust shell deletes.
 *
 * This measures TRANSPORT ONLY. It does not run either decoder and says
 * nothing about whether the two agree; `compare-assemble-realday.mts` is the
 * harness for that, and its verdict is the precondition for caring about this
 * one.
 *
 * Run: npx tsx lean/experiments/measure-hsmm-wire.mts
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildHsmmModel } from "../../src/hmm/decode.js";
import { hsmmInputsFromFixture } from "../../src/cli/hsmm-fixture.js";
import { quantizeModel, rleDurDelta } from "../../src/hmm/lean-shadow-core.js";
import { nodeKey } from "../../src/geo/route-graph.js";
import { DEFAULT_MAX_DURATION } from "../../src/hmm/hsmm-viterbi.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const dir = path.join(repo, "tests", "golden", "decoded_days");

const bytes = (o: unknown) => Buffer.byteLength(JSON.stringify(o), "utf8");
const MiB = (n: number) => n / (1024 * 1024);

const files = readdirSync(dir)
	.filter((f) => f.endsWith(".json"))
	.sort();
if (files.length === 0) {
	console.error(`no fixtures in ${dir}`);
	process.exit(1);
}

console.log(`corpus: ${files.length} fixture(s) in tests/golden/decoded_days/\n`);
console.log(`  ${"day".padEnd(12)} ${"T".padStart(5)} ${"S".padStart(4)}  ${"marshalled".padStart(11)}  ${"raw inputs".padStart(11)}  ${"ratio".padStart(7)}`);

let sumMarshalled = 0;
let sumRaw = 0;
const rows: { day: string; marshalled: number; raw: number }[] = [];
const fieldBytes: Record<string, number> = {};
const graphRows: { day: string; graphHash: string }[] = [];
const marshalledFieldBytes: Record<string, number> = {};

for (const f of files) {
	const captured = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
	const inputs: any = hsmmInputsFromFixture(captured);
	const model = buildHsmmModel(inputs);
	const T = model.tensor.length;
	const S = model.states.length;
	const graph = inputs.routeGraph;

	// ── what the tenant ships today: `decodeLean`'s payload ──
	const q = quantizeModel(model);
	const marshalled: Record<string, unknown> = {
		T: q.T,
		S: q.S,
		maxD: q.maxD,
		emit: q.emit,
		trans: q.trans,
		dur: q.dur,
		init: q.init,
		entry: q.entry,
	};
	if (q.durOverrides.length > 0) marshalled.durOverrides = q.durOverrides;
	if (q.transOv.length > 0) marshalled.transOv = q.transOv;
	if (q.durClass !== null && q.durDelta !== null) {
		marshalled.durClass = q.durClass;
		marshalled.durDelta = rleDurDelta(q.durDelta);
	}

	// ── what `assembledecode` would ship instead: raw inputs ──
	const cc = inputs.continuityContext;
	const raw = {
		maxD: DEFAULT_MAX_DURATION,
		obs: model.tensor.map((o: any) => ({
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
		})),
		edges: [...graph.edges.values()].map((e: any) => ({
			id: e.id,
			geometry: e.geometry.map((p: any) => ({ lat: p.lat, lon: p.lon })),
			lineMemberships: [...e.attrs.lineMemberships],
			underground: e.attrs.underground,
			startNode: nodeKey(e.startPoint.lat, e.startPoint.lon),
			endNode: nodeKey(e.endPoint.lat, e.endPoint.lon),
		})),
		nodes: [...graph.nodes.values()].map((n: any) => ({
			id: n.id,
			lat: n.point.lat,
			lon: n.point.lon,
			stationName: n.stationName ?? null,
			edgeIds: [...n.edgeIds],
		})),
		places: inputs.places.map((p: any) => ({
			id: p.id,
			name: p.displayName,
			lat: Number(p.lat),
			lon: Number(p.lon),
			hourProfile: p.hourProfile,
			dwell: p.totalDwellSec,
		})),
		placeNearLine: [...inputs.placeNearLine],
		continuity: cc
			? {
					priorPlaceId: cc.priorPlaceId,
					priorPlaceCoord: cc.priorPlaceCoord ? [Number(cc.priorPlaceCoord.lat), Number(cc.priorPlaceCoord.lon)] : null,
					hoursSince: cc.hoursSinceLastConfirmedFix,
					priorPosterior: cc.priorPosterior,
				}
			: null,
		flags: {
			reacquireRobust: inputs.reacquireRobustSpeed === true,
			segEvidence: inputs.segmentEvidence === true,
			chainContext: inputs.chainContext === true,
		},
	};

	const bM = bytes(marshalled);
	const bR = bytes(raw);
	sumMarshalled += bM;
	sumRaw += bR;
	rows.push({ day: f.replace(/\.json$/, ""), marshalled: bM, raw: bR });
	graphRows.push({
		day: f.replace(/\.json$/, "").replace("-pippijn", ""),
		graphHash: createHash("sha256").update(JSON.stringify({ edges: raw.edges, nodes: raw.nodes })).digest("hex"),
	});
	// Per-field, because "2.7 MiB" invites "of what?" and the answer decides
	// whether there is a second reduction to be had or the payload is already
	// the irreducible day.
	for (const k of Object.keys(raw)) {
		fieldBytes[k] = (fieldBytes[k] ?? 0) + bytes((raw as Record<string, unknown>)[k]);
	}
	for (const k of Object.keys(marshalled)) {
		marshalledFieldBytes[k] = (marshalledFieldBytes[k] ?? 0) + bytes(marshalled[k]);
	}

	console.log(
		`  ${f.replace(/\.json$/, "").padEnd(12)} ${String(T).padStart(5)} ${String(S).padStart(4)}  ` +
			`${`${MiB(bM).toFixed(2)} MiB`.padStart(11)}  ${`${MiB(bR).toFixed(3)} MiB`.padStart(11)}  ` +
			`${`${(bM / bR).toFixed(0)}×`.padStart(7)}`,
	);
}

const n = rows.length;
const worstM = rows.reduce((a, b) => (b.marshalled > a.marshalled ? b : a));
const worstR = rows.reduce((a, b) => (b.raw > a.raw ? b : a));

console.log(`\n  marshalled  ${MiB(sumMarshalled / n).toFixed(2)} MiB/day mean, worst ${MiB(worstM.marshalled).toFixed(2)} (${worstM.day})`);
console.log(`  raw inputs  ${MiB(sumRaw / n).toFixed(3)} MiB/day mean, worst ${MiB(worstR.raw).toFixed(3)} (${worstR.day})`);
console.log(`  ratio       ${(sumMarshalled / sumRaw).toFixed(0)}× smaller over the corpus`);

const breakdown = (label: string, m: Record<string, number>, total: number) => {
	console.log(`\n  ${label} — mean bytes/day by field:`);
	for (const [k, v] of Object.entries(m).sort((a, b) => b[1] - a[1])) {
		const per = v / n;
		if (per < 1024) continue;
		console.log(`    ${k.padEnd(14)} ${`${MiB(per).toFixed(3)} MiB`.padStart(11)}  ${((100 * v) / total).toFixed(1)}%`);
	}
};
breakdown("marshalled", marshalledFieldBytes, sumMarshalled);
breakdown("raw inputs", fieldBytes, sumRaw);

// Is the route graph a per-DAY input at all? It is the rail network, which does
// not change between two days in the same city — but the fixtures are captured
// per day from a bbox around that day's track, so identity is a question about
// the CAPTURE, not about London. Hash it and see, rather than assume either way:
// if the graph repeats, content-addressing it takes the payload down to `obs`,
// and if it does not, that option is closed and the 2.7 MiB is the floor.
const graphHashes = new Map<string, string[]>();
for (const { day, graphHash } of graphRows) {
	graphHashes.set(graphHash, [...(graphHashes.get(graphHash) ?? []), day]);
}
console.log(`\n  route graph (edges+nodes, ${((100 * ((fieldBytes.edges ?? 0) + (fieldBytes.nodes ?? 0))) / sumRaw).toFixed(0)}% of raw inputs): ${graphHashes.size} distinct across ${n} day(s)`);
for (const [h, days] of [...graphHashes.entries()].sort((a, b) => b[1].length - a[1].length)) {
	console.log(`    ${h.slice(0, 12)}  ${days.length} day(s): ${days.join(", ")}`);
}
console.log(`
  Transport only. Correctness of the assemble path is a separate question and a
  precondition — compare-assemble-realday.mts is what answers it.`);
