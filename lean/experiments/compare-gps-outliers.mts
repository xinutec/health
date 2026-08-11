#!/usr/bin/env -S npx tsx
/**
 * Lean ↔ TypeScript parity for the HSMM GPS outlier filter, on real tracks.
 *
 * Feeds every captured HSMM day's points through both `src/hmm/gps-outliers.ts`
 * and `verified_cli gpsoutliers`, and compares the KEPT-SETS by input index.
 *
 * # Why the HSMM fixtures and not the golden days
 *
 * This pass runs inside `buildHsmmModel`, on `inputs.points` — the smoothed
 * stream, after Kalman. `tests/golden/decoded_days/<date>.json` stores exactly
 * that array, so replaying it here feeds the twin the same bytes production
 * feeds the original. Deriving the same points from a golden day fixture would
 * mean re-running the velocity pipeline to get them, which puts two more passes
 * between the fixture and the thing under test.
 *
 * # The bar is exactness, and it is reachable
 *
 * The filter is drop-only: every emitted fix is a copy of an input fix, so
 * nothing computed crosses the wire and there is no ULP class. `cos` (via
 * `approxDistanceMeters`) reaches only the deviation compared against the 2 km
 * threshold, so the sole way the arms can disagree is a 1-ULP difference landing
 * exactly on that boundary — which no real fix does, since the population is
 * either metres from its cluster median or tens of kilometres from it. A
 * divergence is a decision flip to adjudicate, not noise to tolerate.
 *
 * # What this was for (#695)
 *
 * `Verified.Hsmm.GpsOutliers` had no verb: `Verified.Hsmm.Factors` was its only
 * importer, so nothing in `verified_cli` reached it and no comparator could
 * enter it — a real port of a live pass, pinned by two `#guard`s and nothing
 * else. The recorded reason for that was a capture-side one, and it was WRONG:
 * `capture-hsmm-day.ts:191` applies the drop to `computeMinuteProximity`'s
 * argument, not to the stored points, which are `velResult.points` raw. Measured
 * here on every run — the fixtures carry ~11% outliers, on all 11 days — so the
 * data was never the problem and the harness always was.
 *
 * Run: npx tsx lean/experiments/compare-gps-outliers.mts [YYYY-MM-DD …]
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FilteredPoint } from "../../src/geo/kalman.js";
import { dropGpsOutliers } from "../../src/hmm/gps-outliers.js";
import { floatToBits } from "../../src/lean/float-bits.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const leanBin = path.join(here, "..", ".lake", "build", "bin", "verified_cli");
const dir = path.join(repo, "tests", "golden", "decoded_days");

const want = process.argv.slice(2);
const files = readdirSync(dir)
	.filter((f) => f.endsWith(".json"))
	.filter((f) => want.length === 0 || want.some((d) => f.includes(d)))
	.sort();
if (files.length === 0) {
	console.error(`no HSMM day fixtures${want.length ? ` matching ${want.join(", ")}` : ""} in ${dir}`);
	process.exit(1);
}

/** Identity of a row on the wire — all four fields the Lean `GpsPoint` has,
 *  since the response is a copy and a coordinate that changed crossing it is as
 *  much a divergence as a fix that should not have survived. `bearing` is the
 *  one `FilteredPoint` field with no counterpart in the twin: the pass never
 *  reads it, so carrying it would prove nothing about the decision. */
const key = (p: FilteredPoint): string =>
	`${p.ts}|${floatToBits(p.lat)}|${floatToBits(p.lon)}|${floatToBits(p.speed_kmh)}`;

/** Indices of a drop-only subsequence within the input, by lock-step walk. */
function idxOf(points: readonly FilteredPoint[], keys: readonly string[]): number[] {
	const out: number[] = [];
	let j = 0;
	for (let i = 0; i < points.length && j < keys.length; i++) {
		if (key(points[i]) === keys[j]) {
			out.push(i);
			j += 1;
		}
	}
	return out;
}

let bad = 0;
let totalIn = 0;
let totalDropped = 0;
for (const file of files) {
	const fixture = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
	// The fixture stores `FilteredPoint` verbatim, which is what the TS arm
	// takes, so neither arm is fed a reshaped copy of the other's input.
	const points = fixture.inputs.points as FilteredPoint[];

	const kept = dropGpsOutliers(points);
	const req = JSON.stringify({
		pts: points.map((p) => [p.ts, floatToBits(p.lat), floatToBits(p.lon), floatToBits(p.speed_kmh)]),
	});
	const run = spawnSync(leanBin, ["gpsoutliers"], { input: req, encoding: "utf8", maxBuffer: 1 << 28 });
	if (run.status !== 0) {
		console.log(`${file}  LEAN FAILED (${run.status}) ${(run.stderr || run.stdout).slice(0, 200)}`);
		bad += 1;
		continue;
	}
	const parsed = JSON.parse(run.stdout);
	if (parsed.error !== undefined) {
		console.log(`${file}  LEAN ERROR ${parsed.error}`);
		bad += 1;
		continue;
	}
	const leanRows = parsed.pts as Array<[number, string, string, string]>;
	const leanIdx = idxOf(
		points,
		leanRows.map((r) => `${r[0]}|${r[1]}|${r[2]}|${r[3]}`),
	);
	const tsIdx = idxOf(points, kept.map(key));

	// A short lock-step walk means a row came back that is NOT a copy of the
	// input row it claims to be, which set comparison alone would report as a
	// mere count difference. Catch it as what it is.
	if (leanIdx.length !== leanRows.length) {
		console.log(`${file}  LEAN returned ${leanRows.length} rows, only ${leanIdx.length} of them input copies`);
		bad += 1;
		continue;
	}

	const tsSet = new Set(tsIdx);
	const leanSet = new Set(leanIdx);
	const tsOnly = tsIdx.filter((i) => !leanSet.has(i));
	const leanOnly = leanIdx.filter((i) => !tsSet.has(i));
	const dropped = points.length - tsIdx.length;
	totalIn += points.length;
	totalDropped += dropped;
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

// The drop count is part of the verdict, not decoration: a run where both arms
// agreed because neither dropped anything would print the same EXACT lines
// while measuring nothing, and this is the number that says otherwise.
console.log(
	`\n${files.length - bad}/${files.length} days agree exactly on the kept set` +
		` — ${totalDropped} of ${totalIn} fixes dropped across the corpus`,
);
if (totalDropped === 0) {
	console.log("NO OUTLIERS IN THE CORPUS — the arms agree on a decision neither of them took");
	process.exit(1);
}
process.exit(bad === 0 ? 0 : 1);
