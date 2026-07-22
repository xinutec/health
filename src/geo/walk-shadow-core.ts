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
import type { BuildingRing, RoadFix } from "./map-match-core.js";
import { type QWalkMatchResult, type QWay, qMatchWalkSegment } from "./match-twin.js";
import { matchWalkSegment, type WalkMatchResult } from "./pedestrian-match.js";
import { type QPt, quantPt } from "./quant-twin.js";
import type { OsmRoadWay } from "./road-match.js";

/** Per-leg float↔quant verdict: identical, within the NEAR tolerance, or a
 *  genuine difference. */
export type LegClass = "EXACT" | "NEAR" | "DIFF";

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

/** One walking leg's matcher input — the spike-cleaned fixes and the
 *  leg-windowed walkable ways + building footprints, exactly as both arms
 *  and the gate consume them. */
export interface WalkLegInput {
	startTs: number;
	clean: RoadFix[];
	ways: OsmRoadWay[];
	buildings: BuildingRing[];
}

/**
 * A day's matcher legs come from `annotateWalkMatches` recording them as it
 * feeds them (`beginWalkLegCapture` / `endWalkLegCapture` in
 * `pedestrian-match-annotate.ts`), NOT from reconstructing a leg set here.
 *
 * The reconstruction this replaces rebuilt legs from HSMM episodes and a bbox
 * slice of the day's OSM trace, and disagreed with production five ways at once
 * — different iteration unit, fix source, speed cap, minimum leg size, and
 * candidate way set. Measured on 2026-07-17: 8 reconstructed legs against
 * production's 9. A gate that measures a different population than production
 * serves cannot certify what production serves, so the second definition is
 * gone rather than realigned.
 *
 * Callers wrap their own velocity run:
 *
 *     const prev = beginWalkLegCapture();
 *     await computeVelocityFromInputs(inputs, { walkMatch: true });
 *     const legs = endWalkLegCapture(prev);
 */

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
