/**
 * CLI: the matcher-level float↔quant parity probe (the V4 matcher arc of
 * `docs/proposals/2026-07-verified-core-lean.md`).
 *
 * For every walking leg of every golden day fixture (zero DB — the
 * `score-walk-match` replay chassis): run the production
 * `matchWalkSegment` (float) and the BigInt twin `qMatchWalkSegment`
 * (`geo/match-twin.ts`) on identical inputs — the leg's spike-cleaned
 * fixes and the fixture's leg-windowed walkable ways + building
 * footprints — and compare the (path, coarsePath) decisions.
 *
 * Classes per leg:
 *   EXACT     — both null, or both non-null with bit-identical
 *               quantised vertex rows (coords and timestamps);
 *   NEAR      — same null-ness and vertex counts, coords within 30 cm
 *               (rounding drift on identical decisions);
 *   DIFF      — different null-ness or different geometry (a genuine
 *               decision flip — candidate tie, weight near-tie, …).
 *
 * This is the measurement that pins the matcher representation before
 * the Lean port; the later three-arm harness will gate quant↔Lean at
 * bit-exact, like `compare-geo`.
 *
 * Usage: node dist/cli/compare-match.js [date ...]
 */

import { readdirSync, readFileSync } from "node:fs";
import { rejectSpikes } from "../geo/episode-geometry.js";
import type { BuildingRing, RoadFix } from "../geo/map-match-core.js";
import { type QWalkMatchResult, type QWay, qMatchWalkSegment } from "../geo/match-twin.js";
import { matchWalkSegment, type WalkMatchResult } from "../geo/pedestrian-match.js";
import { type QPt, quantPt } from "../geo/quant-twin.js";
import type { OsmRoadWay } from "../geo/road-match.js";
import { computeVelocityFromInputs } from "../geo/velocity.js";
import { type CapturedDay, inputsFromFixture, parseCapturedDay } from "./fixture-day.js";

/** Geometry margin around the leg bbox (deg-lat metres) — covers the
 *  candidate radius, gap bridging and any plausible routing detour.
 *  Driver-level and identical for both arms. */
const WINDOW_MARGIN_M = 500;

function allWalkable(captured: CapturedDay): OsmRoadWay[] {
	const section = captured.inputs.osmTrace.walkableRoads;
	if (section === undefined) return [];
	const out: OsmRoadWay[] = [];
	for (const ways of Object.values(section)) out.push(...ways);
	return out;
}

function allBuildings(captured: CapturedDay): BuildingRing[] {
	const section = captured.inputs.osmTrace.buildingsNear;
	if (section === undefined) return [];
	const out: BuildingRing[] = [];
	for (const rings of Object.values(section)) out.push(...rings);
	return out;
}

interface BBox {
	minLat: number;
	maxLat: number;
	minLon: number;
	maxLon: number;
}

function legBBox(fixes: readonly RoadFix[]): BBox {
	let minLat = fixes[0].lat;
	let maxLat = fixes[0].lat;
	let minLon = fixes[0].lon;
	let maxLon = fixes[0].lon;
	for (const f of fixes) {
		if (f.lat < minLat) minLat = f.lat;
		if (f.lat > maxLat) maxLat = f.lat;
		if (f.lon < minLon) minLon = f.lon;
		if (f.lon > maxLon) maxLon = f.lon;
	}
	const dLat = WINDOW_MARGIN_M / 111_320;
	const dLon = WINDOW_MARGIN_M / (111_320 * Math.cos((minLat * Math.PI) / 180));
	return { minLat: minLat - dLat, maxLat: maxLat + dLat, minLon: minLon - dLon, maxLon: maxLon + dLon };
}

const inBox = (lat: number, lon: number, b: BBox): boolean =>
	lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon;

/** 30 cm in 1e-7° latitude units — the NEAR coordinate tolerance. */
const NEAR_UNITS = 30n;

type LegClass = "EXACT" | "NEAR" | "DIFF";

function comparePaths(float: ReadonlyArray<{ lat: number; lon: number; ts: number }>, quant: readonly QPt[]): LegClass {
	const qf = float.map((p) => quantPt(p));
	if (qf.length !== quant.length) return "DIFF";
	let cls: LegClass = "EXACT";
	for (let i = 0; i < qf.length; i++) {
		const dLa = qf[i].la - quant[i].la;
		const dLo = qf[i].lo - quant[i].lo;
		const dTs = qf[i].ts - quant[i].ts;
		if (dLa === 0n && dLo === 0n && dTs === 0n) continue;
		const abs = (x: bigint): bigint => (x < 0n ? -x : x);
		if (abs(dLa) <= NEAR_UNITS && abs(dLo) <= NEAR_UNITS && abs(dTs) <= 1n) cls = "NEAR";
		else return "DIFF";
	}
	return cls;
}

/** Per-leg verdict, coarse (decision layer) and path (display splice)
 *  separately — a coarse flip is a matcher decision divergence, a
 *  path-only flip is the known splice detail near-tie class. */
function legClasses(
	float: WalkMatchResult | null,
	quant: QWalkMatchResult | null,
): { coarse: LegClass; path: LegClass } {
	if (float === null || quant === null) {
		const cls: LegClass = float === quant ? "EXACT" : "DIFF";
		return { coarse: cls, path: cls };
	}
	return {
		coarse: comparePaths(float.coarsePath, quant.coarsePath),
		path: comparePaths(float.path, quant.path),
	};
}

const argDates = process.argv.slice(2);
const files = readdirSync("tests/golden/days")
	.filter((f) => f.endsWith(".json"))
	.filter((f) => argDates.length === 0 || argDates.some((d) => f.startsWith(d)))
	.sort();

let legs = 0;
const coarseTotals = { EXACT: 0, NEAR: 0, DIFF: 0 };
const pathTotals = { EXACT: 0, NEAR: 0, DIFF: 0 };
let nullBoth = 0;
let nullFlips = 0;

for (const file of files) {
	const captured = parseCapturedDay(readFileSync(`tests/golden/days/${file}`, "utf8"));
	const inputs = inputsFromFixture(captured);
	const run = await computeVelocityFromInputs(inputs, { walkMatch: true });
	const walks = run.episodes.filter((e) => e.mode === "walking" && e.points.length >= 2);
	const fixes = inputs.phonetrack.today;
	const dayWays = allWalkable(captured);
	const dayBuildings = allBuildings(captured);
	const perDay: string[] = [];
	for (const ep of walks) {
		const legFixes = fixes.filter((f) => f.ts >= ep.startTs && f.ts <= ep.endTs);
		if (legFixes.length < 3) continue;
		const clean = rejectSpikes(legFixes).map((p) => ({ lat: p.lat, lon: p.lon, ts: p.ts }));
		if (clean.length < 3) continue;
		const box = legBBox(clean);
		const ways = dayWays.filter((w) => w.coords.some(([lat, lon]) => inBox(lat, lon, box)));
		const buildings = dayBuildings.filter((r) => r.some((p) => inBox(p.lat, p.lon, box)));
		legs++;

		const float = matchWalkSegment(clean, { ways, buildings });
		const qFixes = clean.map((p) => quantPt(p));
		const qWays: QWay[] = ways.map((w) => ({
			coords: w.coords.map(([lat, lon]) => quantPt({ lat, lon })),
			name: w.name,
		}));
		const qBuildings = buildings.map((r) => r.map((p) => quantPt(p)));
		const quant = qMatchWalkSegment(qFixes, qWays, qBuildings);

		const cls = legClasses(float, quant);
		coarseTotals[cls.coarse]++;
		pathTotals[cls.path]++;
		if (float === null && quant === null) nullBoth++;
		if ((float === null) !== (quant === null)) nullFlips++;
		const hhmm = new Date(ep.startTs * 1000).toISOString().slice(11, 16);
		perDay.push(
			`${hhmm} coarse=${cls.coarse}/path=${cls.path}` +
				`${float === null ? " float=null" : ""}${quant === null ? " quant=null" : ""}` +
				((cls.coarse === "DIFF" || cls.path === "DIFF") && float !== null && quant !== null
					? ` (coarse ${float.coarsePath.length}v vs ${quant.coarsePath.length}v, path ${float.path.length}v vs ${quant.path.length}v)`
					: ""),
		);
	}
	console.log(`${file.slice(0, 10)}: ${perDay.length} leg(s) — ${perDay.join(", ") || "none"}`);
}

console.log(
	`\ncompare-match: ${legs} legs — coarse EXACT=${coarseTotals.EXACT} NEAR=${coarseTotals.NEAR} ` +
		`DIFF=${coarseTotals.DIFF}; path EXACT=${pathTotals.EXACT} NEAR=${pathTotals.NEAR} ` +
		`DIFF=${pathTotals.DIFF} (both-null ${nullBoth}, null-flips ${nullFlips})`,
);
process.exit(0);
