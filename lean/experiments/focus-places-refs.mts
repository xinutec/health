/**
 * V8 reference values for the Lean port of `src/geo/focus-places.ts`.
 *
 * Run:
 *   nix develop /Users/pippijn/Code/health --command \
 *     npx tsx /Users/pippijn/Code/health/lean/experiments/focus-places-refs.mts
 *
 * The module is wholly pure (no DB, no tz library — solar time comes from
 * longitude), so everything below is ported. Synthetic but realistic input:
 * a home, a work, and a café/residence pair close enough to be fused by
 * `clusterStays` and separated again by `splitCluster`.
 */

import {
	detectStays,
	clusterStays,
	splitCluster,
	detectFocusPlaces,
	classifyCluster,
	assignDisplayNames,
	pickWinningAmenity,
	uniqueDayCount,
	sleepHoursOf,
	sleepHoursFromFitbit,
	hourProfileOf,
	hourProfileForRange,
	serializeHourProfile,
	parseHourProfile,
	localSolarHour,
	localSolarHourFractional,
	localSolarDayOfWeek,
	type RawPoint,
	type Stay,
	type Cluster,
} from "../../src/geo/focus-places.js";

const f = (x: number): string => (Number.isFinite(x) ? x.toPrecision(17) : String(x));

/** 2026-05-11 00:00:00 UTC — a Monday. */
const DAY0 = Date.UTC(2026, 4, 11) / 1000;
const HOME_LAT = 51.5205;
const HOME_LON = -0.1275;

console.log("=== solar time ===");
for (const [ts, lon] of [
	[DAY0, 0],
	[DAY0 + 9 * 3600, 0],
	[DAY0 + 9 * 3600, -0.1275],
	[DAY0 + 9 * 3600, -122],
	[DAY0 + 9 * 3600, 139],
	[DAY0 + 23 * 3600 + 1800, 15],
	[DAY0 + 90, -0.1275],
] as [number, number][]) {
	console.log(
		`ts=+${ts - DAY0}s lon=${lon}: hour=${localSolarHour(ts, lon)} frac=${f(
			localSolarHourFractional(ts, lon),
		)} dow=${localSolarDayOfWeek(ts, lon)}`,
	);
}
for (let d = 0; d < 8; d++) {
	console.log(`day+${d}: dow=${localSolarDayOfWeek(DAY0 + d * 86400 + 12 * 3600, HOME_LON)}`);
}

// --- synthetic point stream -------------------------------------------------

/** Points every 5 min at (lat,lon) across [from, to). */
function stationaryPoints(lat: number, lon: number, from: number, to: number, accuracy: number | null = 20): RawPoint[] {
	const out: RawPoint[] = [];
	for (let t = from; t < to; t += 300) out.push({ ts: t, lat, lon, accuracy });
	return out;
}

console.log("");
console.log("=== detectStays ===");
const oneStay = stationaryPoints(HOME_LAT, HOME_LON, DAY0 + 3600, DAY0 + 3600 + 5400);
for (const s of detectStays(oneStay)) {
	console.log(
		`stay +${s.startTs - DAY0}..+${s.endTs - DAY0} n=${s.pointCount} dur=${s.durationSec} lat=${f(
			s.centroidLat,
		)} lon=${f(s.centroidLon)}`,
	);
}
console.log(`too short: ${detectStays(stationaryPoints(HOME_LAT, HOME_LON, DAY0, DAY0 + 400)).length}`);
console.log(`single point: ${detectStays([{ ts: DAY0, lat: HOME_LAT, lon: HOME_LON, accuracy: 10 }]).length}`);
console.log(`empty: ${detectStays([]).length}`);
// Two stays separated by a jump.
const twoStays = [
	...stationaryPoints(HOME_LAT, HOME_LON, DAY0 + 3600, DAY0 + 3600 + 3600),
	...stationaryPoints(HOME_LAT + 0.02, HOME_LON, DAY0 + 9000, DAY0 + 9000 + 3600),
];
console.log(`two stays: ${detectStays(twoStays).length}`);
for (const s of detectStays(twoStays)) console.log(`  +${s.startTs - DAY0} dur=${s.durationSec} lat=${f(s.centroidLat)}`);
// Accuracy filter is applied by detectFocusPlaces, not detectStays.
console.log(
	`accuracy filter: ${detectFocusPlaces(stationaryPoints(HOME_LAT, HOME_LON, DAY0, DAY0 + 5400, 500)).stays.length}`,
);

console.log("");
console.log("=== clusterStays ===");
function stay(lat: number, lon: number, startTs: number, durationSec: number): Stay {
	return { startTs, endTs: startTs + durationSec, centroidLat: lat, centroidLon: lon, pointCount: 10, durationSec };
}
const stays1 = [
	stay(HOME_LAT, HOME_LON, DAY0 + 3600, 3600),
	stay(HOME_LAT + 0.0005, HOME_LON, DAY0 + 86400, 7200), // ~55 m — same cluster
	stay(HOME_LAT + 0.02, HOME_LON, DAY0 + 2 * 86400, 3600), // ~2 km — separate
];
for (const c of clusterStays(stays1)) {
	console.log(`cluster id=${c.id} n=${c.stays.length} dwell=${c.totalDwellSec} lat=${f(c.centroidLat)} lon=${f(c.centroidLon)}`);
}
console.log(`empty: ${clusterStays([]).length}`);

console.log("");
console.log("=== uniqueDayCount / sleepHours ===");
const nightStays = [
	stay(HOME_LAT, HOME_LON, DAY0 + 22 * 3600, 8 * 3600), // 22:00 -> 06:00
	stay(HOME_LAT, HOME_LON, DAY0 + 86400 + 22 * 3600, 8 * 3600),
	stay(HOME_LAT, HOME_LON, DAY0 + 2 * 86400 + 13 * 3600, 5 * 3600), // afternoon
];
console.log(`uniqueDayCount = ${uniqueDayCount(nightStays, HOME_LON)}`);
console.log(`uniqueDayCount(lon=139) = ${uniqueDayCount(nightStays, 139)}`);
const nightCluster: Cluster = {
	id: 1,
	centroidLat: HOME_LAT,
	centroidLon: HOME_LON,
	stays: nightStays,
	totalDwellSec: nightStays.reduce((s, x) => s + x.durationSec, 0),
};
console.log(`sleepHoursOf = ${f(sleepHoursOf(nightCluster))}`);
console.log(
	`sleepHoursFromFitbit = ${f(
		sleepHoursFromFitbit(nightStays, [
			{ startTs: DAY0 + 23 * 3600, endTs: DAY0 + 30 * 3600 },
			{ startTs: DAY0 + 86400 + 23 * 3600, endTs: DAY0 + 86400 + 29 * 3600 },
		]),
	)}`,
);
console.log(`sleepHoursFromFitbit(no windows) = ${f(sleepHoursFromFitbit(nightStays, []))}`);

console.log("");
console.log("=== hour profile ===");
const prof = hourProfileForRange(DAY0 + 9 * 3600, DAY0 + 12 * 3600, HOME_LON);
console.log(`range 9-12: [${prof.map((x) => f(x)).join(",")}]`);
console.log(`serialize: ${serializeHourProfile(prof)}`);
console.log(`clusterProfile: ${serializeHourProfile(hourProfileOf(nightCluster))}`);
console.log(`empty range: ${serializeHourProfile(hourProfileForRange(DAY0, DAY0, HOME_LON))}`);
console.log(`parse round-trip: ${JSON.stringify(parseHourProfile(serializeHourProfile(prof)))}`);
console.log(`parse null: ${parseHourProfile(null)}`);
console.log(`parse "": ${parseHourProfile("")}`);
console.log(`parse short: ${parseHourProfile("1,2,3")}`);
console.log(`parse junk: ${parseHourProfile(new Array(24).fill("x").join(","))}`);
console.log(`parse blanks: ${JSON.stringify(parseHourProfile(new Array(24).fill("").join(",")))}`);

console.log("");
console.log("=== classifyCluster ===");
function mkCluster(id: number, lat: number, lon: number, stays: Stay[]): Cluster {
	return { id, centroidLat: lat, centroidLon: lon, stays, totalDwellSec: stays.reduce((s, x) => s + x.durationSec, 0) };
}
/** n nightly 22:00->06:00 stays on consecutive days. */
function nightly(n: number, lat = HOME_LAT, lon = HOME_LON, startDay = 0): Stay[] {
	return Array.from({ length: n }, (_, i) => stay(lat, lon, DAY0 + (startDay + i) * 86400 + 22 * 3600, 8 * 3600));
}
/** n weekday 09:00->17:00 stays (skipping weekends). */
function workdays(n: number, lat: number, lon: number): Stay[] {
	const out: Stay[] = [];
	let d = 0;
	while (out.length < n) {
		const dow = localSolarDayOfWeek(DAY0 + d * 86400 + 12 * 3600, lon);
		if (dow <= 4) out.push(stay(lat, lon, DAY0 + d * 86400 + 9 * 3600, 8 * 3600));
		d++;
	}
	return out;
}
const homeC = mkCluster(1, HOME_LAT, HOME_LON, nightly(40));
const workC = mkCluster(2, 51.53, -0.13, workdays(25, 51.53, -0.13));
console.log(`home: ${JSON.stringify(classifyCluster(homeC))}`);
console.log(`work: ${JSON.stringify(classifyCluster(workC))}`);
console.log(`hotel: ${JSON.stringify(classifyCluster(mkCluster(3, 40.7, -74, nightly(6, 40.7, -74))))}`);
console.log(`one-off: ${JSON.stringify(classifyCluster(mkCluster(4, 48.8, 2.3, [stay(48.8, 2.3, DAY0 + 13 * 3600, 7200)])))}`);
const freq = Array.from({ length: 8 }, (_, i) => stay(51.51, -0.12, DAY0 + i * 5 * 86400 + 13 * 3600, 5400));
console.log(`frequent: ${JSON.stringify(classifyCluster(mkCluster(5, 51.51, -0.12, freq)))}`);
const other = Array.from({ length: 4 }, (_, i) => stay(51.51, -0.12, DAY0 + i * 2 * 86400 + 13 * 3600, 5400));
console.log(`other: ${JSON.stringify(classifyCluster(mkCluster(6, 51.51, -0.12, other)))}`);

console.log("");
console.log("=== assignDisplayNames ===");
const stayC = mkCluster(7, 52.1, 4.3, nightly(3, 52.1, 4.3, 5));
for (const [id, name] of assignDisplayNames([homeC, workC, stayC])) console.log(`  id=${id} => ${name}`);
console.log("-- home alone");
for (const [id, name] of assignDisplayNames([homeC])) console.log(`  id=${id} => ${name}`);
console.log("-- nothing qualifies");
for (const [id, name] of assignDisplayNames([mkCluster(9, 51.51, -0.12, other)])) console.log(`  id=${id} => ${name}`);

console.log("");
console.log("=== pickWinningAmenity ===");
function pick(m: [string, number][], minWeight: number, minFraction: number): void {
	console.log(
		`${JSON.stringify(m)} w>=${minWeight} f>=${minFraction} => ${pickWinningAmenity(new Map(m), { minWeight, minFraction })}`,
	);
}
pick([], 100, 0.5);
pick([["Cafe A", 900]], 100, 0.5);
pick([["Cafe A", 90]], 100, 0.5);
pick([["Cafe A", 520], ["Cafe B", 480]], 100, 0.6);
pick([["Cafe A", 520], ["Cafe B", 480]], 100, 0.5);
pick([["Cafe A", 300], ["Cafe B", 700]], 100, 0.5);
pick([["A", 500], ["B", 500]], 100, 0.5);

console.log("");
console.log("=== splitCluster ===");
/** A café visited at ~13:00 and a residence at ~21:00, 45 m apart. */
function cafeResidence(): Cluster {
	const stays: Stay[] = [];
	for (let d = 0; d < 4; d++) {
		stays.push(stay(HOME_LAT, HOME_LON, DAY0 + d * 86400 + 13 * 3600, 3600));
		stays.push(stay(HOME_LAT + 0.0004, HOME_LON, DAY0 + d * 86400 + 21 * 3600, 7200));
	}
	return mkCluster(1, HOME_LAT + 0.0002, HOME_LON, stays);
}
const cr = splitCluster(cafeResidence());
console.log(`cafe+residence => ${cr.length} lobes`);
for (const c of cr) console.log(`  lat=${f(c.centroidLat)} dwell=${c.totalDwellSec} n=${c.stays.length}`);
// A single home visited evening AND morning: temporally bimodal, but one place.
function homeBimodal(): Cluster {
	const stays: Stay[] = [];
	for (let d = 0; d < 4; d++) {
		stays.push(stay(HOME_LAT, HOME_LON, DAY0 + d * 86400 + 21 * 3600, 3600));
		stays.push(stay(HOME_LAT + 0.00002, HOME_LON, DAY0 + d * 86400 + 7 * 3600, 3600));
	}
	return mkCluster(1, HOME_LAT, HOME_LON, stays);
}
console.log(`home bimodal (2m apart) => ${splitCluster(homeBimodal()).length} lobes`);
// Too few days to form two lobes.
console.log(`too few days => ${splitCluster(mkCluster(1, HOME_LAT, HOME_LON, nightly(3))).length} lobes`);
// A continuous spread of visit times: k-means cuts it but the halves touch.
function continuousSpread(): Cluster {
	const stays: Stay[] = [];
	for (let d = 0; d < 6; d++) stays.push(stay(HOME_LAT, HOME_LON, DAY0 + d * 86400 + (10 + d) * 3600, 3600));
	return mkCluster(1, HOME_LAT, HOME_LON, stays);
}
console.log(`continuous spread => ${splitCluster(continuousSpread()).length} lobes`);

console.log("");
console.log("=== detectFocusPlaces ===");
const dayPoints: RawPoint[] = [];
for (let d = 0; d < 3; d++) {
	dayPoints.push(...stationaryPoints(HOME_LAT, HOME_LON, DAY0 + d * 86400 + 0, DAY0 + d * 86400 + 6 * 3600));
	dayPoints.push(...stationaryPoints(51.53, -0.13, DAY0 + d * 86400 + 9 * 3600, DAY0 + d * 86400 + 17 * 3600));
}
const res = detectFocusPlaces(dayPoints);
console.log(`stays=${res.stays.length} clusters=${res.clusters.length}`);
for (const c of res.clusters) {
	console.log(`  id=${c.id} lat=${f(c.centroidLat)} lon=${f(c.centroidLon)} dwell=${c.totalDwellSec} n=${c.stays.length}`);
}
