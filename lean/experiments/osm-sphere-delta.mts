/**
 * What actually moves when the sphere changes from MariaDB's 6370986 m to the
 * kernel's 6371000 m? Measured against every captured query in the golden
 * corpus, before any re-bless.
 *
 * # Why this is exact, not a sample
 *
 * The haversine is `R · 2 · atan2(√a, √(1−a))`, and `a` depends only on the two
 * coordinates. R is a pure scale factor, so EVERY distance scales by exactly
 * `6371000 / 6370986 = 1 + 2.198e-6`. Two consequences, both decisive:
 *
 *   - **Ordering can never change.** A uniform positive scaling is
 *     order-preserving, so no `ORDER BY distance` result can be permuted and no
 *     nearest-feature pick can flip to a different feature.
 *   - **Only the radius bar can move a decision**, and only for a feature lying
 *     within `radius · 2.198e-6` of it. Under the strict `<` bar, a feature is
 *     dropped exactly when its MariaDB distance lies in `[radius/ratio, radius)`
 *     — a window 0.22 mm wide at a 100 m radius, 0.88 mm at 400 m.
 *
 * So the whole re-bless question for the POINT side reduces to: does any
 * captured feature fall in that window? This counts them.
 *
 * The residual approximation: MariaDB arranges its formula differently and
 * agrees with this haversine at 6370986 only to ~1e-9 m (measured, 18–97888
 * ULP). That gap is five orders of magnitude below the window, so it cannot
 * change the count.
 *
 * # What this does NOT cover
 *
 * The LINE side. `queryLines` never touches the sphere — its metric is planar
 * in degree space, rescaled by a fixed `min(111000, 111000·cos lat)` — so the
 * radius change is a no-op there BY CONSTRUCTION. But that means the line
 * side's risk is a different question entirely: whether MariaDB's `ST_Distance`
 * and this port's `segDistDeg` agree bit-for-bit. They are not compared here,
 * and nothing in this script speaks to them.
 *
 * Run: nix develop /Users/pippijn/Code/health --command npx tsx lean/experiments/osm-sphere-delta.mts
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_RADIUS_M } from "../../src/geo/osm.js";

const DAYS_DIR = path.join(process.cwd(), "tests", "golden", "days");

const MARIA_R = 6_370_986;
const LEAN_R = 6_371_000;
const RATIO = LEAN_R / MARIA_R;

/** Sections whose distances come from the SPHERE (`queryPoints`). The line-side
 *  sections are excluded: their metric has no R in it. */
const POINT_SECTIONS: Record<string, number> = {
	nearbyStations: DEFAULT_RADIUS_M.nearbyStations,
	nearbyTransitStops: DEFAULT_RADIUS_M.nearbyTransitStops,
};

interface AtRisk {
	date: string;
	method: string;
	radius: number;
	distanceM: number;
	marginM: number;
}

const atRisk: AtRisk[] = [];
let features = 0;
let queries = 0;
/** How close any feature got to its bar, in metres — the headroom actually
 *  observed, as opposed to the window we reason about. */
let closest = Number.POSITIVE_INFINITY;
let closestWhere = "";

for (const file of readdirSync(DAYS_DIR).filter((f) => f.endsWith(".json")).sort()) {
	const day = JSON.parse(readFileSync(path.join(DAYS_DIR, file), "utf8"));
	const date: string = day.meta.date;
	const trace = day.inputs.osmTrace ?? {};

	for (const [method, fallbackRadius] of Object.entries(POINT_SECTIONS)) {
		const section = trace[method];
		if (!section || typeof section !== "object") continue;
		for (const [key, result] of Object.entries(section as Record<string, unknown>)) {
			const radS = key.split("|")[2];
			const radius = radS === "" ? fallbackRadius : Number(radS);
			if (!Number.isFinite(radius)) continue;
			queries++;
			// A feature is dropped under the larger sphere exactly when its
			// scaled distance reaches the bar: d · RATIO >= radius.
			const bar = radius / RATIO;
			for (const f of (result ?? []) as Array<{ distanceM?: number }>) {
				if (typeof f.distanceM !== "number") continue;
				features++;
				const margin = radius - f.distanceM;
				if (margin >= 0 && margin < closest) {
					closest = margin;
					closestWhere = `${date} ${method} r=${radius} d=${f.distanceM}`;
				}
				if (f.distanceM >= bar && f.distanceM < radius) {
					atRisk.push({ date, method, radius, distanceM: f.distanceM, marginM: margin });
				}
			}
		}
	}
}

console.log(`sphere ratio: ${RATIO} (${((RATIO - 1) * 1e6).toFixed(3)} ppm)`);
console.log("windows the bar can move through:");
for (const r of [50, 100, 200, 400, 800]) {
	console.log(`  radius ${String(r).padStart(3)} m → ${((r * (RATIO - 1)) * 1000).toFixed(4)} mm`);
}

console.log(`\nscanned ${queries} point-side queries, ${features} returned features`);
console.log(`closest any feature came to its own bar: ${closest.toFixed(6)} m`);
console.log(`  (${closestWhere})`);

console.log(`\nFEATURES THAT WOULD CHANGE SIDE: ${atRisk.length}`);
for (const a of atRisk) {
	console.log(`  ${a.date} ${a.method} r=${a.radius} d=${a.distanceM} margin=${a.marginM}`);
}

console.log("\nOrdering: unchanged by construction — a uniform positive scaling cannot permute a sort.");
