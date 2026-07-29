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

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const leanBin = path.join(here, "..", ".lake", "build", "bin", "verified_cli");
const dir = path.join(repo, "tests", "golden", "days");

const { filterGpsTrack } = await import(path.join(repo, "src/geo/kalman.ts"));
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

const FIELDS = ["ts", "lat", "lon", "speed", "bearing"];
let bad = 0;

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
		bad += 1;
		continue;
	}
	// Per-field tally and the worst ULP distance. ULP because the expected
	// divergence class is a last-bit `cos`/`atan2` difference between two libms:
	// counting rows says how often, ULP says whether it is that class or
	// something structural wearing its clothes.
	const n: Record<string, number> = {};
	const worst: Record<string, number> = {};
	for (let i = 0; i < ts.length; i++) {
		const a = [ts[i].ts, floatToBits(ts[i].lat), floatToBits(ts[i].lon), floatToBits(ts[i].speed_kmh), floatToBits(ts[i].bearing)];
		const b = lean[i];
		for (let k = 0; k < FIELDS.length; k++) {
			if (String(a[k]) === String(b[k])) continue;
			const f = FIELDS[k];
			n[f] = (n[f] ?? 0) + 1;
			// Both patterns share a sign here (they are within a few bits), so the
			// unsigned magnitude difference IS the ULP distance.
			const d = Number(BigInt(String(a[k])) - BigInt(String(b[k])));
			worst[f] = Math.max(worst[f] ?? 0, Math.abs(d));
		}
	}
	const fields = FIELDS.filter((f) => n[f] !== undefined);
	if (fields.length > 0) {
		const tally = fields.map((f) => `${f} ${n[f]}/${ts.length} (≤${worst[f]}ulp)`).join(" ");
		console.log(`${file}  in=${points.length} out=${ts.length}  ${tally}`);
		bad += 1;
	} else {
		console.log(`${file}  in=${points.length} out=${ts.length}  EXACT`);
	}
}

console.log(`\n${files.length - bad}/${files.length} days bit-exact`);
process.exit(bad === 0 ? 0 : 1);
