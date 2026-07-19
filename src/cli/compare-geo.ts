/**
 * CLI: the geometry-substrate TS↔Lean parity harness (V4 of
 * `docs/proposals/2026-07-verified-core-lean.md`).
 *
 * For every walking leg of every golden day fixture (zero DB — the
 * `score-walk-match` replay chassis): quantise the raw fixes to the
 * pinned 1e-7° representation and run the display passes three ways —
 *
 *   float — the production functions (`simplifyPath`,
 *           `holdImplausibleSpeed`, `rejectSpikes`);
 *   quant — the BigInt twin (`geo/quant-twin.ts`);
 *   lean  — `verified_cli geo` on identical input.
 *
 * quant↔lean must be bit-identical (the gate; exit 1 on any mismatch).
 * float↔quant keep-set flips are reported as the fidelity metric — the
 * corpus probe measured zero everywhere except one near-threshold tie
 * on the 1.5 m detail tolerance, and that class is expected, not a
 * failure.
 *
 * Usage: node dist/cli/compare-geo.js [date ...]
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { holdImplausibleSpeed, rejectSpikes } from "../geo/episode-geometry.js";
import {
	dedupeConsecutive,
	despikeUnsupportedApexes,
	removeSpurs,
	simplifyPath,
	trimOverRouteExcursions,
} from "../geo/map-match-core.js";
import {
	type QPt,
	qDedupeKeep,
	qDespikeKeep,
	qHoldSpeedKeep,
	qRejectSpikesKeep,
	qRemoveSpurs,
	qSimplifyKeep,
	qTrim,
	quantPt,
} from "../geo/quant-twin.js";
import { computeVelocityFromInputs } from "../geo/velocity.js";
import { inputsFromFixture, parseCapturedDay } from "./fixture-day.js";

const LEAN_BIN = process.env.LEAN_CLI ?? path.join(process.cwd(), "lean", ".lake", "build", "bin", "verified_cli");
const WALK_CAP_KMH = 12;

interface LeanGeoResp {
	keep?: number[];
	pts?: number[][];
	error?: string;
}

function leanGeo(req: object): LeanGeoResp {
	const res = spawnSync(LEAN_BIN, ["geo"], {
		input: JSON.stringify(req),
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	if (res.status !== 0) throw new Error(`verified_cli geo failed: ${res.stderr || res.stdout}`);
	const parsed = JSON.parse(res.stdout) as LeanGeoResp;
	if (parsed.error) throw new Error(`verified_cli geo: ${parsed.error}`);
	return parsed;
}

const ptRow = (p: QPt): number[] => [Number(p.la), Number(p.lo), Number(p.ts)];
const eqNums = (a: readonly number[], b: readonly number[]): boolean =>
	a.length === b.length && a.every((x, i) => x === b[i]);
const eqRows = (a: readonly number[][], b: readonly number[][]): boolean =>
	a.length === b.length && a.every((x, i) => eqNums(x, b[i]));

/** Indices of `kept` within `all`, by object identity (the float passes
 *  return the input objects). */
function keptIdx<T>(all: readonly T[], kept: readonly T[]): number[] {
	const set = new Set(kept);
	const out: number[] = [];
	for (let i = 0; i < all.length; i++) if (set.has(all[i])) out.push(i);
	return out;
}

const argDates = process.argv.slice(2);
const files = readdirSync("tests/golden/days")
	.filter((f) => f.endsWith(".json"))
	.filter((f) => argDates.length === 0 || argDates.some((d) => f.startsWith(d)))
	.sort();

let legs = 0;
let mismatches = 0;
const flips = { simp15: 0, simp50: 0, hold: 0, spikes: 0, dedupe: 0, spurs: 0, despike: 0, trim: 0 };

for (const file of files) {
	const captured = parseCapturedDay(readFileSync(`tests/golden/days/${file}`, "utf8"));
	const inputs = inputsFromFixture(captured);
	const run = await computeVelocityFromInputs(inputs, { walkMatch: true });
	const walks = run.episodes.filter((e) => e.mode === "walking" && e.points.length >= 2);
	const fixes = inputs.phonetrack.today;
	let dayLegs = 0;
	for (const ep of walks) {
		const legFixes = fixes.filter((f) => f.ts >= ep.startTs && f.ts <= ep.endTs);
		if (legFixes.length < 3) continue;
		legs++;
		dayLegs++;
		const q = legFixes.map((p) => quantPt(p));
		const ptsIn = q.map(ptRow);

		for (const [label, tolUm, tolM] of [
			["simp15", 1500000n, 1.5],
			["simp50", 5000000n, 5],
		] as const) {
			const twin = qSimplifyKeep(q, tolUm);
			const lean = leanGeo({ op: "simplify", tol: Number(tolUm), pts: ptsIn }).keep ?? [];
			if (!eqNums(twin, lean)) {
				mismatches++;
				console.log(`MISMATCH ${file.slice(0, 10)} ${label}: twin=[${twin}] lean=[${lean}]`);
			}
			const float = keptIdx(legFixes, simplifyPath(legFixes, tolM));
			if (!eqNums(float, twin)) flips[label === "simp15" ? "simp15" : "simp50"]++;
		}

		{
			const twin = qHoldSpeedKeep(q, BigInt(WALK_CAP_KMH));
			const lean = leanGeo({ op: "hold", cap: WALK_CAP_KMH, pts: ptsIn }).pts ?? [];
			if (
				!eqRows(
					twin.map((i) => ptRow(q[i])),
					lean,
				)
			) {
				mismatches++;
				console.log(`MISMATCH ${file.slice(0, 10)} hold: twin=[${twin}]`);
			}
			const float = keptIdx(legFixes, holdImplausibleSpeed(legFixes, WALK_CAP_KMH));
			if (!eqNums(float, twin)) flips.hold++;
		}

		{
			const twin = qRejectSpikesKeep(q);
			const lean = leanGeo({ op: "spikes", pts: ptsIn }).pts ?? [];
			if (
				!eqRows(
					twin.map((i) => ptRow(q[i])),
					lean,
				)
			) {
				mismatches++;
				console.log(`MISMATCH ${file.slice(0, 10)} spikes: twin=[${twin}]`);
			}
			const float = keptIdx(legFixes, rejectSpikes(legFixes));
			if (!eqNums(float, twin)) flips.spikes++;
		}

		{
			const twin = qDedupeKeep(q);
			const lean = leanGeo({ op: "dedupe", pts: ptsIn }).pts ?? [];
			if (
				!eqRows(
					twin.map((i) => ptRow(q[i])),
					lean,
				)
			) {
				mismatches++;
				console.log(`MISMATCH ${file.slice(0, 10)} dedupe`);
			}
			const float = keptIdx(legFixes, dedupeConsecutive(legFixes));
			if (!eqNums(float, twin)) flips.dedupe++;
		}

		{
			// Walk-profile spur parameters: 25 m return, 4-vertex span.
			const twin = qRemoveSpurs(q, 25000000n, 4);
			const lean = leanGeo({ op: "spurs", ret: 25000000, span: 4, pts: ptsIn }).pts ?? [];
			if (!eqRows(twin.map(ptRow), lean)) {
				mismatches++;
				console.log(`MISMATCH ${file.slice(0, 10)} spurs`);
			}
			const float = removeSpurs(legFixes, 25, 4).map((p) => [p.lat, p.lon]);
			const twinDeg = twin.map((p) => [Number(p.la) / 1e7, Number(p.lo) / 1e7]);
			if (float.length !== twinDeg.length) flips.spurs++;
		}

		{
			// Raw window = the even-indexed fixes, so the apex-excess test
			// sees genuine (decimated) jitter.
			const raw = legFixes.filter((_, i) => i % 2 === 0);
			const qraw = raw.map((p) => quantPt(p));
			const twin = qDespikeKeep(q, qraw, 15000000n, 12000000n);
			const lean =
				leanGeo({ op: "despike", apex: 15000000, excess: 12000000, pts: ptsIn, raw: qraw.map(ptRow) }).pts ?? [];
			if (
				!eqRows(
					twin.map((i) => ptRow(q[i])),
					lean,
				)
			) {
				mismatches++;
				console.log(`MISMATCH ${file.slice(0, 10)} despike`);
			}
			const float = keptIdx(legFixes, despikeUnsupportedApexes(legFixes, raw));
			if (!eqNums(float, twin)) flips.despike++;
		}

		{
			// Trim the drawn line against its own GPS corridor.
			const drawn = ep.points.map((p, i) => ({ lat: p.lat, lon: p.lon, ts: p.ts ?? i }));
			const qd = drawn.map((p) => quantPt(p));
			const twin = qTrim(q, qd);
			const lean = leanGeo({ op: "trim", path: qd.map(ptRow), fixes: ptsIn }).pts ?? [];
			if (!eqRows(twin.map(ptRow), lean)) {
				mismatches++;
				console.log(`MISMATCH ${file.slice(0, 10)} trim`);
			}
			const float = trimOverRouteExcursions(legFixes, drawn);
			if (float.length !== twin.length) flips.trim++;
		}
	}
	console.log(`${file.slice(0, 10)}: ${dayLegs} leg(s) ${mismatches === 0 ? "EXACT" : "MISMATCHED"}`);
}

console.log(
	`\ncompare-geo: ${legs} legs, quant↔lean ${mismatches === 0 ? "EXACT" : `${mismatches} MISMATCH(ES)`}; ` +
		`float↔quant flips: simplify1.5=${flips.simp15} simplify5=${flips.simp50} hold=${flips.hold} ` +
		`spikes=${flips.spikes} dedupe=${flips.dedupe} spurs=${flips.spurs} despike=${flips.despike} trim=${flips.trim}`,
);
process.exit(mismatches === 0 ? 0 : 1);
