/**
 * Find focus places (home, work, frequent cafes, ...) from a JSON dump of
 * PhoneTrack history. Local development tool — pure presentation around
 * src/geo/focus-places.ts.
 *
 * Usage:
 *   npx tsx src/cli/find-focus-places.ts [points.json] [topN] [tz] [--snap]
 *   npx tsx src/cli/find-focus-places.ts .local-data/points.json 20 Europe/Amsterdam
 */

import { readFileSync } from "node:fs";
import {
	CLUSTER_RADIUS_M,
	type Cluster,
	classifyCluster,
	clusterStays,
	detectStays,
	localSolarHour,
	type RawPoint,
	type Stay,
	uniqueDayCount,
} from "../geo/focus-places.js";
import { type KnownPlace, snapToPlace } from "../geo/place-snap.js";

const ACCURACY_FILTER_M = 200;

function fmtDuration(sec: number): string {
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	if (h >= 24) {
		const d = Math.floor(h / 24);
		return `${d}d ${h % 24}h`;
	}
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m`;
}

function dayOfWeekInTz(d: Date, tz: string): number {
	const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short" });
	const map: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
	return map[fmt.format(d)] ?? 0;
}

function dayOfWeekHistogram(stays: Stay[], tz: string): number[] {
	const hours = [0, 0, 0, 0, 0, 0, 0];
	const stepSec = 30 * 60;
	for (const s of stays) {
		for (let t = s.startTs; t <= s.endTs; t += stepSec) {
			hours[dayOfWeekInTz(new Date(t * 1000), tz)] += stepSec / 3600;
		}
	}
	return hours;
}

function hourOfDayHistogram(stays: Stay[], lon: number): number[] {
	const hours = new Array(24).fill(0);
	const stepSec = 30 * 60;
	for (const s of stays) {
		for (let t = s.startTs; t <= s.endTs; t += stepSec) {
			hours[localSolarHour(t, lon)] += stepSec / 3600;
		}
	}
	return hours;
}

function asciiHistogram(values: number[], labels: string[], width = 30): string {
	const max = Math.max(...values, 1);
	return values
		.map((v, i) => {
			const bar = "█".repeat(Math.round((v / max) * width));
			return `  ${labels[i].padStart(3)} ${bar.padEnd(width, " ")} ${v.toFixed(1)}h`;
		})
		.join("\n");
}

function ymdInTz(ts: number, tz: string): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date(ts * 1000));
}

// --- Main ---

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));
const inputPath = positional[0] ?? ".local-data/points.json";
const topN = Number(positional[1] ?? "20");
const tz = positional[2] ?? "Europe/Amsterdam";
const useSnap = flags.has("--snap");

const data = JSON.parse(readFileSync(inputPath, "utf-8")) as { points: RawPoint[] };
const all = data.points;
const filtered = all.filter((p) => p.accuracy === null || p.accuracy <= ACCURACY_FILTER_M);
console.log(`Input:  ${all.length} points`);
console.log(`Filter: ${filtered.length} after accuracy ≤ ${ACCURACY_FILTER_M}m`);

const t0 = Date.now();
let stays = detectStays(filtered);
let clusters = clusterStays(stays);
console.log(
	`Pass 1: ${stays.length} stays, ${clusters.length} clusters (≤${CLUSTER_RADIUS_M}m) in ${Date.now() - t0}ms`,
);

if (useSnap) {
	const anchors: KnownPlace[] = [...clusters]
		.sort((a, b) => b.totalDwellSec - a.totalDwellSec)
		.slice(0, 30)
		.map((c, i) => ({ centroidLat: c.centroidLat, centroidLon: c.centroidLon, radiusM: 25, id: c.id ?? i }));
	const t1 = Date.now();
	let snappedCount = 0;
	const snapped: RawPoint[] = filtered.map((p) => {
		const r = snapToPlace({ lat: p.lat, lon: p.lon, accuracy: p.accuracy }, anchors);
		if (r.snapped) snappedCount++;
		return { ts: p.ts, lat: r.lat, lon: r.lon, accuracy: r.accuracy };
	});
	console.log(
		`Snap:   ${snappedCount}/${filtered.length} fixes pulled to a known place (${anchors.length} anchors) in ${Date.now() - t1}ms`,
	);
	const t2 = Date.now();
	stays = detectStays(snapped);
	clusters = clusterStays(stays);
	console.log(`Pass 2: ${stays.length} stays, ${clusters.length} clusters after snap in ${Date.now() - t2}ms`);
}

console.log("");
clusters.sort((a, b) => b.totalDwellSec - a.totalDwellSec);

for (const c of clusters.slice(0, topN) as Cluster[]) {
	const days = new Set(c.stays.map((s) => ymdInTz(s.startTs, tz)));
	const sortedStays = [...c.stays].sort((a, b) => a.startTs - b.startTs);
	const sample = sortedStays.slice(0, 3).map((s) => ymdInTz(s.startTs, tz));
	const last = sortedStays.slice(-3).map((s) => ymdInTz(s.startTs, tz));
	const mapsUrl = `https://www.google.com/maps/place/${c.centroidLat.toFixed(5)},${c.centroidLon.toFixed(5)}/@${c.centroidLat.toFixed(5)},${c.centroidLon.toFixed(5)},18z`;
	const cls = classifyCluster(c);
	console.log(
		`#${c.id}  [${cls.label.toUpperCase()}]  ${c.centroidLat.toFixed(5)}, ${c.centroidLon.toFixed(5)}  ${mapsUrl}`,
	);
	console.log(`     ${cls.reason}`);
	console.log(`     dwell ${fmtDuration(c.totalDwellSec)}, ${c.stays.length} visits, ${days.size} unique days`);
	console.log(`     unique-days (solar): ${uniqueDayCount(c.stays, c.centroidLon)}`);
	console.log(`     first: ${sample.join(", ")}`);
	console.log(`     last:  ${last.join(", ")}`);
	console.log("     by day-of-week:");
	console.log(asciiHistogram(dayOfWeekHistogram(c.stays, tz), ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]));
	console.log("     by hour-of-day:");
	console.log(
		asciiHistogram(
			hourOfDayHistogram(c.stays, c.centroidLon),
			Array.from({ length: 24 }, (_, i) => i.toString()),
		),
	);
	console.log("");
}
