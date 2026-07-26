/**
 * How wide must the buffered-track over-fetch be?
 *
 * `docs/proposals/2026-07-osm-into-lean.md` step 2 pushes one row-set per day
 * instead of per-query answers. The row-set is built by buffering the day's
 * fix track, so the buffer has to be wide enough that EVERY query the pipeline
 * makes is answerable from it. A query is answerable when the rows it needs —
 * everything within its own extent of its own coordinate — are all present.
 *
 * So the requirement is NOT "how far from a fix does the pipeline ask?". It is
 *
 *     buffer ≥ max over queries of (distance to nearest fix + the query's own extent)
 *
 * and the second term is the larger of the two: `walkableRoads` asks with a
 * 600 m radius and then adds a 400 m corridor margin on top, so a single query
 * reaches 1000 m from its own coordinate before the offset is counted at all.
 *
 * The extents below are read off the query builders in `src/geo/osm-local.ts`:
 * the circle methods need `radius`; the road/building methods MBR-filter an
 * axis-aligned box of `radius + margin` per axis.
 *
 * Run: nix develop /Users/pippijn/Code/health --command npx tsx lean/experiments/osm-buffer-sizing.mts
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { coverageForTrack, METHOD_FEATURE_TYPES, methodIsCovered } from "../../src/geo/osm-rowset.js";

const DAYS_DIR = path.join(process.cwd(), "tests", "golden", "days");

/** `ROAD_CORRIDOR_MARGIN_M` / `BUILDING_QUERY_MARGIN_M` in `osm-local.ts`. */
const ROAD_CORRIDOR_MARGIN_M = 400;
const BUILDING_QUERY_MARGIN_M = 100;

/** Default radius per adapter method, from the `osm.ts` signatures — a trace
 *  key records `""` for the third field when the caller passed no radius. */
const DEFAULT_RADIUS: Record<string, number> = {
	nearbyWays: 50,
	nearbyStations: 200,
	nearbyLandmarks: 100,
	linesAtPoint: 100,
	nearbyTransitStops: 50,
	drivableRoads: 600,
	walkableRoads: 600,
	buildingsNear: 150,
};

/** Extra reach the query takes beyond its nominal radius. */
const MARGIN: Record<string, number> = {
	drivableRoads: ROAD_CORRIDOR_MARGIN_M,
	walkableRoads: ROAD_CORRIDOR_MARGIN_M,
	buildingsNear: BUILDING_QUERY_MARGIN_M,
};

/** Sections that stay in the shell — not spatial, so not sized here. */
const NON_SPATIAL = new Set(["reverseGeocode", "stationsOnLine"]);

/** The methods built on the `queryPoints` / `queryLines` kernel — the scope of
 *  `docs/proposals/2026-07-osm-into-lean.md`. The other three (drivable /
 *  walkable / buildings) are separate bbox readers that bulk-load geometry for
 *  the map-matchers; they do not go through the kernel. Sized separately
 *  because their reach is an order of magnitude wider. */
const KERNEL_METHODS = new Set([
	"nearbyWays",
	"nearbyStations",
	"nearbyLandmarks",
	"linesAtPoint",
	"nearbyTransitStops",
]);

const R = 6371000;
function haversineM(aLat: number, aLon: number, bLat: number, bLon: number): number {
	const toRad = (d: number) => (d * Math.PI) / 180;
	const dLat = toRad(bLat - aLat);
	const dLon = toRad(bLon - aLon);
	const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

interface Fix {
	lat: number;
	lon: number;
}

interface Worst {
	need: number;
	offset: number;
	extent: number;
	method: string;
	date: string;
}

let worstOverall: Worst | null = null;
const perMethodWorst = new Map<string, Worst>();
const perDayWorst: Worst[] = [];
const perDayWorstKernel: Worst[] = [];
const radiiSeen = new Map<string, number[]>();
const boxCounts: number[] = [];
const uncovered: string[] = [];
let kernelQueries = 0;

for (const file of readdirSync(DAYS_DIR).filter((f) => f.endsWith(".json")).sort()) {
	const day = JSON.parse(readFileSync(path.join(DAYS_DIR, file), "utf8"));
	const date: string = day.meta.date;
	const pt = day.inputs.phonetrack;
	const fixes: Fix[] = [...(pt.today ?? []), ...(pt.morning ?? []), ...(pt.priorEvening ?? [])];
	if (fixes.length === 0) continue;

	// The real check: not "is the arithmetic right" but "does the implementation
	// actually cover every query this day made". Boxes built the way the capture
	// path builds them; queries taken from what the pipeline actually asked.
	const coverage = coverageForTrack(fixes);
	boxCounts.push(Object.values(coverage).reduce((n, b) => n + b.length, 0));

	let worstDay: Worst | null = null;
	let worstDayKernel: Worst | null = null;
	for (const [method, section] of Object.entries(day.inputs.osmTrace ?? {})) {
		if (NON_SPATIAL.has(method) || section === null || typeof section !== "object") continue;
		for (const key of Object.keys(section as Record<string, unknown>)) {
			const [latS, lonS, radS] = key.split("|");
			const lat = Number(latS);
			const lon = Number(lonS);
			if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
			const radius = radS === "" ? DEFAULT_RADIUS[method] : Number(radS);
			if (!Number.isFinite(radius)) throw new Error(`no default radius for ${method}`);
			const extent = radius + (MARGIN[method] ?? 0);
			const seen = radiiSeen.get(method) ?? [];
			seen.push(radius);
			radiiSeen.set(method, seen);

			let offset = Number.POSITIVE_INFINITY;
			for (const f of fixes) {
				const d = haversineM(lat, lon, f.lat, f.lon);
				if (d < offset) offset = d;
			}
			if (KERNEL_METHODS.has(method)) {
				kernelQueries++;
				if (!methodIsCovered(method, lat, lon, radius, coverage)) {
					uncovered.push(`${date} ${method} r=${radius} at ${lat},${lon}`);
				}
			}

			const cand: Worst = { need: offset + extent, offset, extent, method, date };
			if (!worstDay || cand.need > worstDay.need) worstDay = cand;
			if (KERNEL_METHODS.has(method) && (!worstDayKernel || cand.need > worstDayKernel.need)) worstDayKernel = cand;
			const pm = perMethodWorst.get(method);
			if (!pm || cand.need > pm.need) perMethodWorst.set(method, cand);
			if (!worstOverall || cand.need > worstOverall.need) worstOverall = cand;
		}
	}
	if (worstDay) perDayWorst.push(worstDay);
	if (worstDayKernel) perDayWorstKernel.push(worstDayKernel);
}

const fmt = (w: Worst) =>
	`${w.need.toFixed(1)} m  (offset ${w.offset.toFixed(1)} + extent ${w.extent}) ${w.method} on ${w.date}`;

console.log(`days: ${perDayWorst.length}`);
console.log("\nworst required buffer per method:");
for (const [m, w] of [...perMethodWorst].sort((a, b) => b[1].need - a[1].need)) {
	console.log(`  ${m.padEnd(20)} ${fmt(w)}`);
}

const needs = perDayWorst.map((w) => w.need).sort((a, b) => a - b);
console.log("\nper-day worst, distribution:");
console.log(`  min ${needs[0].toFixed(1)}  median ${needs[Math.floor(needs.length / 2)].toFixed(1)}`);
console.log(`  max ${needs[needs.length - 1].toFixed(1)}`);

console.log(`\nOVERALL: ${worstOverall ? fmt(worstOverall) : "none"}`);

// What a candidate buffer would cost in missed days — the same check that
// caught 300 m being a 3-in-32 failure rate rather than a safe percentile.
console.log("\nall methods:");
for (const b of [500, 1000, 1200, 1500, 2000, 2700, 3000]) {
	const missed = perDayWorst.filter((w) => w.need > b);
	console.log(`  buffer ${b} m → ${missed.length}/${perDayWorst.length} days short`);
}

const kNeeds = perDayWorstKernel.map((w) => w.need).sort((a, b) => a - b);
console.log(`\nKERNEL METHODS ONLY (${[...KERNEL_METHODS].join(", ")}):`);
console.log(`  per-day worst: min ${kNeeds[0].toFixed(1)}  max ${kNeeds[kNeeds.length - 1].toFixed(1)}`);
for (const b of [500, 800, 1000, 1250, 1500, 2000]) {
	const missed = perDayWorstKernel.filter((w) => w.need > b);
	console.log(`  buffer ${b} m → ${missed.length}/${perDayWorstKernel.length} days short`);
}

boxCounts.sort((a, b) => a - b);
console.log("\ncoverage boxes per day, summed over feature types:");
console.log(`  min ${boxCounts[0]}  median ${boxCounts[Math.floor(boxCounts.length / 2)]}  max ${boxCounts[boxCounts.length - 1]}`);

console.log(`\nCOVERAGE CHECK — ${kernelQueries} kernel queries replayed through methodIsCovered():`);
if (uncovered.length === 0) {
	console.log("  all covered");
} else {
	console.log(`  ${uncovered.length} UNCOVERED:`);
	for (const u of uncovered.slice(0, 20)) console.log(`    ${u}`);
}

// One global buffer is sized by the worst method, and every feature_type pays
// for it. But `nearbyWays` asks the dense `highway` table with a 50 m radius,
// while only `railway` is ever asked at 800 m. Size per feature_type instead.
const perFeatureWorst = new Map<string, Worst>();
for (const [m, w] of perMethodWorst) {
	for (const ftype of METHOD_FEATURE_TYPES[m] ?? []) {
		const cur = perFeatureWorst.get(ftype);
		if (!cur || w.need > cur.need) perFeatureWorst.set(ftype, w);
	}
}
console.log("\nworst required buffer PER FEATURE TYPE:");
for (const [ftype, w] of [...perFeatureWorst].sort((a, b) => b[1].need - a[1].need)) {
	console.log(`  ${ftype.padEnd(14)} ${fmt(w)}`);
}

console.log("\nradius distribution per method (min / median / max, n):");
for (const [m, rs] of [...radiiSeen].sort()) {
	rs.sort((a, b) => a - b);
	console.log(
		`  ${m.padEnd(20)} ${rs[0]} / ${rs[Math.floor(rs.length / 2)]} / ${rs[rs.length - 1]}   n=${rs.length}`,
	);
}
