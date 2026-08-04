/**
 * V8 reference values for `Verified.Geo.StayEnrich`'s local-solar arithmetic.
 *
 * The guards in that module pin `localSolarHour` and `hourProfileForRange`, and
 * a guard derived by hand pins what the porter believed rather than what V8
 * does. This runs the real TS and prints the values, so the guards are checked
 * against their subject instead of against an argument about it.
 *
 * What each case is for:
 *
 *   ts=59      seconds are dropped BEFORE the longitude offset, not after —
 *              `getUTCHours()*60 + getUTCMinutes()` is whole minutes
 *   lon=±15    one hour per 15°, in both directions
 *   lon=-30    the westward wrap BACKWARDS across midnight, which is the whole
 *              reason the TS does `((x % 1440) + 1440) % 1440` rather than one
 *              modulo
 *   lon=-0.1   London: a fraction of an hour, which floors away — the case a
 *              port that rounded instead of flooring would pass every other test
 *
 * The profile cases separate three things one case each would confuse: the
 * half-hour step, the INCLUSIVE upper bound, and the all-zero denominator.
 *
 * Run: TMPDIR=/tmp npx tsx lean/experiments/stay-enrich-refs.mts
 */

import { hourProfileForRange, localSolarHour } from "../../src/geo/focus-places.js";

const HOURS: [number, number][] = [
	[0, 0],
	[3600, 0],
	[86340, 0],
	[59, 0],
	[0, 15],
	[0, -15],
	[3600, -30],
	[0, -0.1],
	[3600, -0.1],
];

console.log("-- localSolarHour --");
for (const [ts, lon] of HOURS) {
	console.log(`#guard localSolarHour ${ts} ${lon === 0 ? "0" : `(${lon})`} == ${localSolarHour(ts, lon)}`);
}

console.log("\n-- hourProfileForRange --");
for (const [from, to] of [
	[0, 1500],
	[0, 3600],
	[0, 0],
] as [number, number][]) {
	const p = hourProfileForRange(from, to, 0);
	console.log(`${from}..${to}  len=${p.length} [0]=${p[0]} [1]=${p[1]}`);
}
