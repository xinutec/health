/**
 * Shared core for the verified walk-matcher shadow — the per-leg
 * quant↔Lean A/B, used by BOTH the `compare-match` gate (golden days, exit 1
 * on mismatch) and the `decode-day` cron shadow (live days, observational).
 * Mirrors `src/hmm/lean-shadow-core.ts`: one place that owns the verified
 * comparison, two callers that differ only in corpus and failure posture.
 *
 * The verified claim, per real walking leg: the Lean matcher
 * (`verified_cli match`) reproduces the BigInt twin `qMatchWalkSegment`
 * bit-for-bit on the identical quantised input. `shadowWalkLeg` runs
 * float + quant + Lean on one already-cleaned leg; `extractWalkLegs` windows a
 * day's episodes into leg inputs (the same spike-cleaned fixes + leg-windowed
 * ways/buildings the gate feeds both arms); `shadowWalkDay` folds a day into an
 * agreement summary.
 *
 * `float` (the production `matchWalkSegment`) is carried through only for the
 * float↔quant decision classes the gate reports — the Lean verdict itself is
 * purely quant↔Lean and never depends on the float arm.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { rejectSpikes } from "./episode-geometry.js";
import type { BuildingRing, RoadFix } from "./map-match-core.js";
import { type QWalkMatchResult, type QWay, qMatchWalkSegment } from "./match-twin.js";
import type { OsmTrace } from "./osm-adapter-recording.js";
import { matchWalkSegment, type WalkMatchResult } from "./pedestrian-match.js";
import { type QPt, quantPt } from "./quant-twin.js";
import type { OsmRoadWay } from "./road-match.js";

/** Geometry margin around the leg bbox (deg-lat metres) — covers the candidate
 *  radius, gap bridging and any plausible routing detour. Driver-level and
 *  identical for both arms. */
export const WINDOW_MARGIN_M = 500;

export type LegClass = "EXACT" | "NEAR" | "DIFF";

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

/** Per-leg float↔quant verdict, coarse (decision layer) and path (display
 *  splice) separately — a coarse flip is a matcher decision divergence, a
 *  path-only flip is the known splice-detail near-tie class. */
export function legClasses(
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

interface LeanMatchResp {
	path?: number[][];
	coarse?: number[][];
	none?: boolean;
	error?: string;
}

/** The Lean arm: `verified_cli match` on the same quantised input. `leanBin`
 *  is the compiled `verified_cli` path (env `LEAN_CLI` in the cron image,
 *  the built binary under `lean/.lake` for the gate). */
let dumpSeq = 0;

function leanMatch(leanBin: string, req: object): LeanMatchResp {
	const body = JSON.stringify(req);
	// Profiling aid: `LEAN_MATCH_DUMP=<dir>` keeps every request body on disk so a
	// single leg can be replayed under a profiler without re-running the pipeline.
	if (process.env.LEAN_MATCH_DUMP) {
		const n = (req as { fixes?: unknown[] }).fixes?.length ?? 0;
		writeFileSync(path.join(process.env.LEAN_MATCH_DUMP, `leg-${n}-${dumpSeq++}.json`), body);
	}
	const res = spawnSync(leanBin, ["match"], {
		input: body,
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
	});
	if (res.status !== 0) throw new Error(`verified_cli match failed: ${res.stderr || res.stdout}`);
	const parsed = JSON.parse(res.stdout) as LeanMatchResp;
	if (parsed.error) throw new Error(`verified_cli match: ${parsed.error}`);
	return parsed;
}

const ptRow = (p: QPt): number[] => [Number(p.la), Number(p.lo), Number(p.ts)];
const eqNums = (a: readonly number[], b: readonly number[]): boolean =>
	a.length === b.length && a.every((x, i) => x === b[i]);
const eqRows = (a: readonly number[][], b: readonly number[][]): boolean =>
	a.length === b.length && a.every((x, i) => eqNums(x, b[i]));

/** The verified check: quant and Lean agree bit-for-bit (both null, or
 *  identical path AND coarse vertex rows). */
function quantLeanExact(quant: QWalkMatchResult | null, lean: LeanMatchResp): boolean {
	if (quant === null) return lean.none === true;
	if (lean.none === true || lean.path === undefined || lean.coarse === undefined) return false;
	return eqRows(quant.path.map(ptRow), lean.path) && eqRows(quant.coarsePath.map(ptRow), lean.coarse);
}

/** A single walking episode, minimally typed against `computeVelocityFromInputs`'s
 *  result so this module needn't import the whole velocity surface. */
export interface WalkEpisode {
	mode: string;
	startTs: number;
	endTs: number;
	points: ReadonlyArray<{ lat: number; lon: number }>;
}

/** One walking leg's matcher input — the spike-cleaned fixes and the
 *  leg-windowed walkable ways + building footprints, exactly as both arms
 *  and the gate consume them. */
export interface WalkLegInput {
	startTs: number;
	clean: RoadFix[];
	ways: OsmRoadWay[];
	buildings: BuildingRing[];
}

/** Every walkable way anywhere in a day's OSM trace, flattened across query
 *  keys — the universe a drawn line is scored/matched against. Mirrors the
 *  gate's `allWalkable`; `undefined` section (fixture predates the field) → []. */
export function flattenWalkable(osmTrace: OsmTrace): OsmRoadWay[] {
	const section = osmTrace.walkableRoads;
	if (section === undefined) return [];
	const out: OsmRoadWay[] = [];
	for (const ways of Object.values(section)) out.push(...ways);
	return out;
}

/** Every building footprint anywhere in a day's OSM trace, flattened. */
export function flattenBuildings(osmTrace: OsmTrace): BuildingRing[] {
	const section = osmTrace.buildingsNear;
	if (section === undefined) return [];
	const out: BuildingRing[] = [];
	for (const rings of Object.values(section)) out.push(...rings);
	return out;
}

/** Window a day's walking episodes into per-leg matcher inputs: fixes clipped
 *  to each leg's span, spike-cleaned, with ways/buildings filtered to the
 *  leg bbox. Legs with < 3 clean fixes are dropped (matcher needs ≥ 3). */
export function extractWalkLegs(
	episodes: readonly WalkEpisode[],
	fixes: readonly RoadFix[],
	dayWays: readonly OsmRoadWay[],
	dayBuildings: readonly BuildingRing[],
): WalkLegInput[] {
	const out: WalkLegInput[] = [];
	for (const ep of episodes) {
		if (ep.mode !== "walking" || ep.points.length < 2) continue;
		const legFixes = fixes.filter((f) => f.ts >= ep.startTs && f.ts <= ep.endTs);
		if (legFixes.length < 3) continue;
		const clean = rejectSpikes(legFixes).map((p) => ({ lat: p.lat, lon: p.lon, ts: p.ts }));
		if (clean.length < 3) continue;
		const box = legBBox(clean);
		const ways = dayWays.filter((w) => w.coords.some(([lat, lon]) => inBox(lat, lon, box)));
		const buildings = dayBuildings.filter((r) => r.some((p) => inBox(p.lat, p.lon, box)));
		out.push({ startTs: ep.startTs, clean, ways, buildings });
	}
	return out;
}

/** One leg's A/B outcome. `float`/`quant` are the raw matcher results, carried
 *  for callers (the gate) that report richer per-leg detail; the shadow reads
 *  only `exact` and the decision classes. */
export interface WalkShadowLeg {
	startTs: number;
	coarse: LegClass;
	path: LegClass;
	exact: boolean;
	float: WalkMatchResult | null;
	quant: QWalkMatchResult | null;
}

/** Run float + quant + Lean on one already-windowed leg, returning the
 *  float↔quant decision classes and the quant↔Lean verified verdict. */
export function shadowWalkLeg(leg: WalkLegInput, leanBin: string): WalkShadowLeg {
	const float = matchWalkSegment(leg.clean, { ways: leg.ways, buildings: leg.buildings });
	const qFixes = leg.clean.map((p) => quantPt(p));
	const qWays: QWay[] = leg.ways.map((w) => ({
		coords: w.coords.map(([lat, lon]) => quantPt({ lat, lon })),
		name: w.name,
	}));
	const qBuildings = leg.buildings.map((r) => r.map((p) => quantPt(p)));
	const quant = qMatchWalkSegment(qFixes, qWays, qBuildings);
	const lean = leanMatch(leanBin, {
		fixes: qFixes.map((p) => [Number(p.la), Number(p.lo), Number(p.ts)]),
		ways: qWays.map((w) => ({ coords: w.coords.map((c) => [Number(c.la), Number(c.lo)]), name: w.name ?? null })),
		buildings: qBuildings.map((r) => r.map((p) => [Number(p.la), Number(p.lo)])),
	});
	const cls = legClasses(float, quant);
	return {
		startTs: leg.startTs,
		coarse: cls.coarse,
		path: cls.path,
		exact: quantLeanExact(quant, lean),
		float,
		quant,
	};
}

/** Per-day agreement summary. */
export interface WalkShadowSummary {
	legs: number;
	exact: number;
	/** hh:mm (UTC) of each leg whose Lean verdict disagreed with the twin. */
	mismatches: string[];
	coarse: Record<LegClass, number>;
	path: Record<LegClass, number>;
	nullBoth: number;
	nullFlips: number;
}

const hhmm = (ts: number): string => new Date(ts * 1000).toISOString().slice(11, 16);

/** Shadow a whole day: extract legs, run each through the A/B, fold. */
export function shadowWalkDay(legs: readonly WalkLegInput[], leanBin: string): WalkShadowSummary {
	const s: WalkShadowSummary = {
		legs: 0,
		exact: 0,
		mismatches: [],
		coarse: { EXACT: 0, NEAR: 0, DIFF: 0 },
		path: { EXACT: 0, NEAR: 0, DIFF: 0 },
		nullBoth: 0,
		nullFlips: 0,
	};
	for (const leg of legs) {
		const r = shadowWalkLeg(leg, leanBin);
		s.legs++;
		if (r.exact) s.exact++;
		else s.mismatches.push(hhmm(r.startTs));
		s.coarse[r.coarse]++;
		s.path[r.path]++;
		if (r.float === null && r.quant === null) s.nullBoth++;
		if ((r.float === null) !== (r.quant === null)) s.nullFlips++;
	}
	return s;
}
