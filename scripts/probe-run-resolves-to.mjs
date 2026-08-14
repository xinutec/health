#!/usr/bin/env node
/**
 * What does a dark run RESOLVE TO, end to end? (#445)
 *
 * #445 refuted three discriminators between a real tube ride and a false one:
 * the run's DURATION, its fix COUNT, and the DISPLACEMENT OF THE GOOD FIXES
 * THAT SURFACED INSIDE IT (probe-tunnel-displacement.mjs — 52 m for a train
 * standing at Bond Street vs 114 m for a rider standing at Baker Street, i.e.
 * GPS noise either way).
 *
 * That last one measured the wrong span. It asks how far the phone moved WHILE
 * dark; this asks how far it moved ACROSS the whole run — from the last good
 * fix before it to the first good fix after, which is exactly the pair the pass
 * itself calls `boarding`/`alighting` (underground-rail.ts, the two lines above
 * reconstructUndergroundJourney). A train ends somewhere else. A rider standing
 * on a platform, or walking a station's tunnels, ends where they started.
 *
 * Prints every candidate dark run in a day with that end-to-end figure, so the
 * three #445 cases can be read on one axis before any code moves.
 *
 * Usage: probe-run-resolves-to.mjs <fixture.json> [label]
 */

import { readFileSync } from "node:fs";

const [, , file, label = ""] = process.argv;
if (!file) {
	console.error("usage: probe-run-resolves-to.mjs <fixture.json> [label]");
	process.exit(2);
}

// Mirrors underground-rail.ts. Kept in step by hand, so a divergence here is a
// probe bug, not a finding — check the constants before believing a surprise.
const COARSE_ACCURACY_M = 100;
const MAX_INTERCHANGE_GAP_S = 1800;
const MAX_COARSE_GAP_S = 300;
const MIN_COARSE_FIXES = 2;
const UNDERGROUND_STATION_RADIUS_M = 350;
const MIN_JOURNEY_M = 800;

function meters(aLat, aLon, bLat, bLon) {
	const R = 6371008.8;
	const rad = Math.PI / 180;
	const x = (bLon - aLon) * rad * Math.cos(((aLat + bLat) / 2) * rad);
	const y = (bLat - aLat) * rad;
	return Math.hypot(x, y) * R;
}

const hm = (ts) => new Date(ts * 1000).toISOString().slice(11, 19);

const day = JSON.parse(readFileSync(file, "utf8"));
const fixes = [
	...(day.inputs.phonetrack.priorEvening ?? []),
	...(day.inputs.phonetrack.today ?? []),
	...(day.inputs.phonetrack.morning ?? []),
].sort((a, b) => a.ts - b.ts);

const isDark = (f) => f.accuracy != null && f.accuracy >= COARSE_ACCURACY_M;
const good = fixes.filter((f) => !isDark(f));

/** underground-rail.ts `heardTravelling` — did the phone, in the fixes it DID
 *  report between two dark stretches, go anywhere? */
function heardTravelling(from, to) {
	const between = good.filter((f) => f.ts > from && f.ts < to);
	return between.some(
		(f) => meters(between[0].lat, between[0].lon, f.lat, f.lon) > UNDERGROUND_STATION_RADIUS_M,
	);
}

/** underground-rail.ts `sameBlackout`. A bare time gap is NOT the rule — a GPS
 *  recovery that went somewhere ends the blackout even inside the ceiling.
 *  Getting this wrong merges a whole day into one "run". */
function sameBlackout(prev, next, ceiling) {
	const gap = next.ts - prev.ts;
	if (gap <= MAX_COARSE_GAP_S) return true;
	if (gap > ceiling) return false;
	if (heardTravelling(prev.ts, next.ts)) return false;
	return meters(prev.lat, prev.lon, next.lat, next.lon) >= MIN_JOURNEY_M;
}

// Cluster the dark fixes into candidate runs under the pass's own rule.
const dark = fixes.filter(isDark);
const runs = [];
for (const f of dark) {
	const cur = runs.at(-1);
	if (cur && sameBlackout(cur[cur.length - 1], f, MAX_INTERCHANGE_GAP_S)) cur.push(f);
	else runs.push([f]);
}

console.log(`\n=== ${file.split("/").pop()} ${label}`);
console.log(
	"  window(Z)          span   nfix   board->alight        sep_m   kmh   verdict-by-separation",
);
for (const r of runs) {
	if (r.length < MIN_COARSE_FIXES) continue;
	const t0 = r[0].ts;
	const t1 = r[r.length - 1].ts;
	const board = [...good].reverse().find((f) => f.ts <= t0);
	const alight = good.find((f) => f.ts >= t1);
	if (!board || !alight) continue;
	const sep = meters(board.lat, board.lon, alight.lat, alight.lon);
	const dt = Math.max(1, alight.ts - board.ts);
	const kmh = (sep / dt) * 3.6;
	// No threshold asserted here — the point is whether the populations separate
	// at all. A label is printed only to make the table readable.
	const verdict = sep < 300 ? "went nowhere" : "went somewhere";
	console.log(
		`  ${hm(t0)}-${hm(t1)}  ${String(t1 - t0).padStart(4)}s  ${String(r.length).padStart(4)}   ` +
			`${hm(board.ts)}->${hm(alight.ts)}  ${sep.toFixed(0).padStart(6)}  ${kmh.toFixed(1).padStart(5)}   ${verdict}`,
	);
}
