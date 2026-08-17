#!/usr/bin/env -S npx tsx
/**
 * Lean ↔ TypeScript parity for the GPS Kalman filter, on real captured tracks.
 *
 * Feeds every golden day's raw PhoneTrack fixes (the same accuracy ceiling
 * production applies) through both `src/geo/kalman.ts` and `verified_cli
 * kalman`, and demands the outputs be identical BIT-FOR-BIT — same row count,
 * same IEEE-754 pattern in every lat/lon/speed/bearing.
 *
 * Why the bar is bit-exactness and not a tolerance: nothing here is quantised.
 * The filter is a covariance recursion over raw degrees, so the two arms run
 * the same IEEE arithmetic on the same inputs and must agree exactly. The
 * transcendentals (`cos`, `atan2`) reach the emitted values only through
 * `Math.round`, which absorbs a ≤1-ULP difference except at a round boundary.
 * A divergence is therefore a finding, not noise.
 *
 * That last paragraph is the MODEL, and the corpus has already exceeded it:
 * under `LEAN_KALMAN=on` the golden gate reports a bearing gap of 17° between
 * two ROUNDED (integer) bearings — 17 whole degrees is not a round boundary
 * and not a last-bit `cos`. See #393. This referee did not catch it for two
 * reasons, both since fixed here: it measured bearing by BIT distance (the
 * #389 defect, fixed in the ledger but never propagated to this file), which
 * for a modular quantity measures nothing; and it feeds the filter RAW fixes,
 * whereas production feeds it the post-clean track, so the two arms do not even
 * see the same input. Bearing is now compared as an ANGLE, and the worst
 * instance is named rather than merely counted.
 *
 * This is the fast referee — pure, no DB, all days in seconds. The production
 * verdict is still the golden corpus under `LEAN_KALMAN=shadow`, which runs the
 * filter on the post-clean, post-snap track production actually gives it.
 *
 * Run: npx tsx lean/experiments/compare-kalman.mts [YYYY-MM-DD …]
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { filterGpsTrack } from "../../src/geo/kalman.js";
import { floatToBits, floatFromBits } from "../../src/lean/float-bits.js";
import { circularDegGap } from "../../src/lean/float-gap.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const leanBin = path.join(here, "..", ".lake", "build", "bin", "verified_cli");
const dir = path.join(repo, "tests", "golden", "days");

const want = process.argv.slice(2);
const files = readdirSync(dir)
	.filter((f) => f.endsWith(".json"))
	.filter((f) => want.length === 0 || want.some((d) => f.includes(d)))
	.sort();
if (files.length === 0) {
	console.error(`no golden day fixtures${want.length ? ` matching ${want.join(", ")}` : ""} in ${dir}`);
	process.exit(1);
}

const FIELDS = ["ts", "lat", "lon", "speed", "bearing"];
let bad = 0;
// Collected so the EXIT CODE can be judged on the header's three criteria
// rather than on bit-exactness — see the note at the bottom. `n` per day is kept
// whole rather than reduced here, because which FIELD moved is the whole
// question: `lat` never calls `cos`, so a `lat` difference is not the libm band.
const counts: Array<{ file: string; tsRows: number; leanRows: number }> = [];
const perDay: Array<{ file: string; n: Record<string, number> }> = [];

for (const file of files) {
	const fixture = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
	const pt = fixture.inputs.phonetrack;
	// Every window the day's pipeline can see, in time order, at production's
	// accuracy ceiling — the widest real track the fixture holds.
	const points = [...(pt.priorEvening ?? []), ...(pt.morning ?? []), ...(pt.today ?? [])]
		.sort((a: any, b: any) => a.ts - b.ts)
		.filter((p: any) => p.accuracy === null || p.accuracy <= 200)
		.map((p: any) => ({ ts: p.ts, lat: p.lat, lon: p.lon, accuracy: p.accuracy ?? null }));

	const ts = filterGpsTrack(points);
	const req = JSON.stringify({
		pts: points.map((p: any) => [
			p.ts,
			floatToBits(p.lat),
			floatToBits(p.lon),
			p.accuracy === null ? null : floatToBits(p.accuracy),
		]),
	});
	const run = spawnSync(leanBin, ["kalman"], { input: req, encoding: "utf8", maxBuffer: 1 << 28 });
	if (run.status !== 0) {
		console.log(`${file}  LEAN FAILED (${run.status}) ${(run.stderr || run.stdout).slice(0, 200)}`);
		bad += 1;
		continue;
	}
	const lean = JSON.parse(run.stdout).pts as Array<[number, string, string, string, string]>;

	if (lean.length !== ts.length) {
		console.log(`${file}  in=${points.length}  LENGTH ts=${ts.length} lean=${lean.length}`);
		counts.push({ file, tsRows: ts.length, leanRows: lean.length });
		bad += 1;
		continue;
	}
	// Per-field tally and the worst ULP distance. ULP because the expected
	// divergence class is a last-bit `cos`/`atan2` difference between two libms:
	// counting rows says how often, ULP says whether it is that class or
	// something structural wearing its clothes.
	const n: Record<string, number> = {};
	const worst: Record<string, number> = {};
	// The worst bearing row, named. A count plus a magnitude tells you a heading
	// disagreement exists and gives you nothing to go look at; #393 was stuck
	// exactly there. Speed rides along because the leading theory for a large
	// angular gap is a near-zero velocity, where the direction of a vector whose
	// components are both ~0 is not a quantity either runtime can be right about.
	let worstBearing = "";
	for (let i = 0; i < ts.length; i++) {
		const a = [ts[i].ts, floatToBits(ts[i].lat), floatToBits(ts[i].lon), floatToBits(ts[i].speed_kmh), floatToBits(ts[i].bearing)];
		const b = lean[i];
		for (let k = 0; k < FIELDS.length; k++) {
			if (String(a[k]) === String(b[k])) continue;
			const f = FIELDS[k];
			n[f] = (n[f] ?? 0) + 1;
			if (f === "bearing") {
				// An ANGLE, not a bit distance: 359° and 0° are one degree apart and
				// astronomically far apart as doubles. See src/lean/float-gap.ts.
				const deg = circularDegGap(String(a[k]), String(b[k]));
				if (deg > (worst[f] ?? 0)) {
					worst[f] = deg;
					worstBearing =
						`row ${i} ts=${ts[i].ts} bearing ${ts[i].bearing}→${floatFromBits(String(b[4]))} (${deg}°)` +
						` speed ts=${ts[i].speed_kmh} lean=${floatFromBits(String(b[3]))}`;
				}
				continue;
			}
			// Both patterns share a sign here (they are within a few bits), so the
			// unsigned magnitude difference IS the ULP distance.
			const d = Number(BigInt(String(a[k])) - BigInt(String(b[k])));
			worst[f] = Math.max(worst[f] ?? 0, Math.abs(d));
		}
	}
	counts.push({ file, tsRows: ts.length, leanRows: lean.length });
	perDay.push({ file, n });
	const fields = FIELDS.filter((f) => n[f] !== undefined);
	if (fields.length > 0) {
		const tally = fields
			.map((f) => `${f} ${n[f]}/${ts.length} (≤${worst[f]}${f === "bearing" ? "°" : "ulp"})`)
			.join(" ");
		console.log(`${file}  in=${points.length} out=${ts.length}  ${tally}`);
		if (worstBearing !== "") console.log(`    worst bearing: ${worstBearing}`);
		bad += 1;
	} else {
		console.log(`${file}  in=${points.length} out=${ts.length}  EXACT`);
	}
}

console.log(`\n${files.length - bad}/${files.length} days bit-exact`);

// ⚠ THE EXIT CODE FOLLOWS THE HEADER'S BAR, NOT BIT-EXACTNESS.
//
// It used to be `process.exit(bad === 0 ? 0 : 1)` — non-zero whenever any day
// was not bit-exact. That contradicted this file's own premise: nothing here is
// quantised, `metersToDegreesLon` calls `cos`, and Lean's and V8's disagree by
// 1 ULP on ~7.6% of real latitudes, so a handful of `lon` rows differing is the
// EXPECTED state. Measured 2026-08-17: 6/35 bit-exact, and that is health.
//
// A tool that exits 1 on its healthy state is one nobody can gate on, and one
// that teaches its reader to ignore the exit code. That is the likeliest reason
// nobody noticed this harness had stopped running at all (#1020).
//
// The three criteria the header actually names:
//   * row COUNTS agree — same fixes kept. A mismatch means the arms disagreed
//     about which fixes are real, not about the last bit of one.
//   * `lat` is EXACT everywhere. It is the control: it never calls `cos`, so a
//     `lat` difference cannot be the libm gap and is a genuine defect.
//   * the `lon` gap stays in SINGLE DIGITS of rows per day.
const rowMismatch = counts.filter((c) => c.tsRows !== c.leanRows);
const latDrift = perDay.filter((d) => (d.n.lat ?? 0) > 0);
// "single digits" from the header, named once so the threshold and the message
// below cannot drift apart. A red test with the bound at 1 printed "10+ rows"
// while faulting on days with 1 — the number was written twice.
const LON_ROWS_MAX = 9;
const lonWide = perDay.filter((d) => (d.n.lon ?? 0) > LON_ROWS_MAX);

const faults: string[] = [];
if (rowMismatch.length > 0) {
	faults.push(`${rowMismatch.length} day(s) kept a different NUMBER of fixes: ${rowMismatch.map((c) => c.file).join(", ")}`);
}
if (latDrift.length > 0) {
	faults.push(`${latDrift.length} day(s) differ in lat, the control field: ${latDrift.map((d) => d.file).join(", ")}`);
}
if (lonWide.length > 0) {
	faults.push(`${lonWide.length} day(s) differ in lon on more than ${LON_ROWS_MAX} rows: ${lonWide.map((d) => `${d.file} (${d.n.lon})`).join(", ")}`);
}

if (faults.length === 0) {
	console.log("within the documented libm band: row counts agree, lat exact, lon gap single-digit");
	process.exit(0);
}
for (const f of faults) console.log(`FAULT: ${f}`);
process.exit(1);
