#!/usr/bin/env node
/**
 * Does the phone MOVE across the stretch a tunnel run would annex? (#445)
 *
 * `growThroughDarkness` extends a train's dark run outwards bounded only by
 * time — `MAX_COARSE_GAP_S` and `RECOVERY_SPAN_S`. Neither asks whether the
 * phone went anywhere, and the two losses in #445's grade are both a ride
 * growing backward into a stretch where it did not: a platform stay, a walk
 * through a station's tunnels.
 *
 * The proposed discriminator is displacement, and it is only usable if the
 * populations separate at a workable scale. This prints the raw fixes in a
 * window with their accuracy and their distance from the window's first fix,
 * so the three cases can be compared on the same axis before any code moves.
 *
 * Usage: probe-tunnel-displacement.mjs <fixture.json> <fromZ> <toZ> [label]
 *   e.g. ... tests/golden/days/2026-06-29-pippijn.json 09:50 10:00 "platform stay"
 */

import { readFileSync } from "node:fs";

const [, , file, fromHm, toHm, label = ""] = process.argv;
if (!file || !fromHm || !toHm) {
	console.error("usage: probe-tunnel-displacement.mjs <fixture.json> <HH:MM> <HH:MM> [label]");
	process.exit(2);
}

/** Metres between two WGS84 points — equirectangular, which is exact enough at
 *  the scale in question (hundreds of metres) and matches what the pipeline's
 *  own `equirectMeters` does. */
function meters(aLat, aLon, bLat, bLon) {
	const R = 6371008.8;
	const rad = Math.PI / 180;
	const x = (bLon - aLon) * rad * Math.cos(((aLat + bLat) / 2) * rad);
	const y = (bLat - aLat) * rad;
	return Math.hypot(x, y) * R;
}

const day = JSON.parse(readFileSync(file, "utf8"));
const fixes = [
	...(day.inputs.phonetrack.priorEvening ?? []),
	...(day.inputs.phonetrack.today ?? []),
	...(day.inputs.phonetrack.morning ?? []),
].sort((a, b) => a.ts - b.ts);

const hm = (ts) => new Date(ts * 1000).toISOString().slice(11, 16);
const hms = (ts) => new Date(ts * 1000).toISOString().slice(11, 19);
const win = fixes.filter((f) => hm(f.ts) >= fromHm && hm(f.ts) <= toHm);
if (win.length === 0) {
	console.log(`${file} ${fromHm}-${toHm}Z: no fixes`);
	process.exit(0);
}

// The pipeline's own thresholds, restated here so the print can be read against
// the same lines the code draws (underground-rail.ts).
const COARSE_ACCURACY_M = 100;

console.log(`\n=== ${file.split("/").pop()} ${fromHm}-${toHm}Z ${label}`);
console.log("     time      accuracy  dark   from-first  step");
let prev = null;
for (const f of win) {
	const d0 = meters(win[0].lat, win[0].lon, f.lat, f.lon);
	const step = prev ? meters(prev.lat, prev.lon, f.lat, f.lon) : 0;
	const dark = (f.accuracy ?? 0) >= COARSE_ACCURACY_M;
	console.log(
		`  ${hms(f.ts)}  ${String(Math.round(f.accuracy ?? -1)).padStart(6)}  ${dark ? "DARK" : "    "}  ${String(Math.round(d0)).padStart(8)} m  ${String(Math.round(step)).padStart(6)} m`,
	);
	prev = f;
}

const good = win.filter((f) => (f.accuracy ?? 0) < COARSE_ACCURACY_M);
const spread = (set) => {
	let max = 0;
	for (const a of set) for (const b of set) max = Math.max(max, meters(a.lat, a.lon, b.lat, b.lon));
	return max;
};
const net = meters(win[0].lat, win[0].lon, win[win.length - 1].lat, win[win.length - 1].lon);
console.log(
	`  -> ${win.length} fixes (${good.length} good), span ${win[win.length - 1].ts - win[0].ts} s, ` +
		`net ${Math.round(net)} m, spread ${Math.round(spread(win))} m, good-spread ${Math.round(spread(good))} m`,
);
