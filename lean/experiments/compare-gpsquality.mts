#!/usr/bin/env -S npx tsx
/**
 * Lean ↔ TypeScript parity for the GPS quality pre-filter, on real tracks.
 *
 * Feeds every golden day's raw PhoneTrack fixes through both
 * `src/geo/gps-quality.ts` and `verified_cli gpsquality`, and compares the
 * KEEP-SETS by input index.
 *
 * Unlike `compare-kalman`, the bar here IS exactness, and it is reachable.
 * The filter is drop-only: every emitted fix is a copy of an input fix, so
 * there are no computed values on the wire and no ULP class. `cos` (via
 * `distanceM`) reaches only the threshold comparisons, so the sole way the two
 * arms can disagree is a 1-ULP difference landing exactly on a boundary
 * (150 km/h, 80 m, 15 km/h, 800 m). Any divergence is a decision flip worth
 * adjudicating, not noise to tolerate.
 *
 * Run: npx tsx lean/experiments/compare-gpsquality.mts [YYYY-MM-DD …]
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const leanBin = path.join(here, "..", ".lake", "build", "bin", "verified_cli");
const dir = path.join(repo, "tests", "golden", "days");

const { qualityFilterGps } = await import(path.join(repo, "src/geo/gps-quality.ts"));
const { floatToBits } = await import(path.join(repo, "src/lean/float-bits.ts"));

const want = process.argv.slice(2);
const files = readdirSync(dir)
	.filter((f) => f.endsWith(".json"))
	.filter((f) => want.length === 0 || want.some((d) => f.includes(d)))
	.sort();
if (files.length === 0) {
	console.error(`no golden day fixtures${want.length ? ` matching ${want.join(", ")}` : ""} in ${dir}`);
	process.exit(1);
}

const key = (p: any): string =>
	`${p.ts}|${floatToBits(p.lat)}|${floatToBits(p.lon)}|${p.accuracy === null ? "n" : floatToBits(p.accuracy)}`;

/** Indices of a drop-only subsequence within the input, by lock-step walk. */
function idxOf(points: any[], keys: string[]): number[] {
	const out: number[] = [];
	let j = 0;
	for (let i = 0; i < points.length && j < keys.length; i++) {
		if (key(points[i]) === keys[j]) { out.push(i); j += 1; }
	}
	return out;
}

let bad = 0;
for (const file of files) {
	const fixture = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
	const pt = fixture.inputs.phonetrack;
	const points = [...(pt.priorEvening ?? []), ...(pt.morning ?? []), ...(pt.today ?? [])]
		.sort((a: any, b: any) => a.ts - b.ts)
		.map((p: any) => ({ ts: p.ts, lat: p.lat, lon: p.lon, accuracy: p.accuracy ?? null }));

	const ts = qualityFilterGps(points);
	const req = JSON.stringify({
		pts: points.map((p: any) => [
			p.ts, floatToBits(p.lat), floatToBits(p.lon), p.accuracy === null ? null : floatToBits(p.accuracy),
		]),
	});
	const run = spawnSync(leanBin, ["gpsquality"], { input: req, encoding: "utf8", maxBuffer: 1 << 28 });
	if (run.status !== 0) {
		console.log(`${file}  LEAN FAILED (${run.status}) ${(run.stderr || run.stdout).slice(0, 200)}`);
		bad += 1;
		continue;
	}
	const leanRows = JSON.parse(run.stdout).pts as Array<[number, string, string, string | null]>;
	const leanIdx = idxOf(points, leanRows.map((r) => `${r[0]}|${r[1]}|${r[2]}|${r[3] === null ? "n" : r[3]}`));
	const tsIdx = idxOf(points, ts.map(key));

	const tsSet = new Set(tsIdx);
	const leanSet = new Set(leanIdx);
	const tsOnly = tsIdx.filter((i) => !leanSet.has(i));
	const leanOnly = leanIdx.filter((i) => !tsSet.has(i));
	const dropped = points.length - tsIdx.length;
	if (tsOnly.length === 0 && leanOnly.length === 0) {
		console.log(`${file}  in=${points.length} kept=${tsIdx.length} (dropped ${dropped})  EXACT`);
	} else {
		console.log(
			`${file}  in=${points.length} ts=${tsIdx.length} lean=${leanIdx.length}  ` +
			`DIVERGED ts-only=[${tsOnly.slice(0, 8)}] lean-only=[${leanOnly.slice(0, 8)}]`,
		);
		bad += 1;
	}
}

console.log(`\n${files.length - bad}/${files.length} days agree exactly on the keep-set`);
process.exit(bad === 0 ? 0 : 1);
