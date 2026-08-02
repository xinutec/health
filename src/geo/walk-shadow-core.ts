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

import { writeFileSync } from "node:fs";
import path from "node:path";
import { leanMatchServe } from "../lean/lean-core.js";
import { type LegClass, legClasses } from "./leg-compare.js";
import type { BuildingRing, RoadFix } from "./map-match-core.js";
import { type QWalkMatchResult, type QWay, qMatchWalkSegment } from "./match-twin.js";
import { matchWalkSegment, type WalkMatchResult } from "./pedestrian-match.js";
import { type QPt, quantPt } from "./quant-twin.js";
import type { OsmRoadWay } from "./road-match.js";

interface LeanMatchResp {
	path?: number[][];
	coarse?: number[][];
	none?: boolean;
	error?: string;
}

/**
 * The Lean arm: one verified match over the PERSISTENT core worker.
 *
 * This used to `spawnSync(leanBin, ["match"])` once per leg, and that path
 * could WEDGE (#402): on 2026-07-31 a `compare-match --gate` run sat 31 minutes
 * having done 3 of 6 days, parent and child both at 0% CPU, the child holding
 * 0.04 s of CPU and an incomplete request. A gate that hangs is strictly worse
 * than one that fails — a red gate tells you something, a hang is
 * indistinguishable from slow work, which is exactly how it burned half an hour
 * before anyone read the CPU column.
 *
 * `leanMatchServe` is a drop-in for the same request object, but over
 * `lean-core`'s long-lived `verified_cli serve` worker: the pipe I/O is done
 * asynchronously inside the worker thread, and every call is bounded by
 * `LEAN_CALL_TIMEOUT_MS`, so the failure mode is a thrown `LeanBridgeError`
 * rather than an indefinite park. That worker is also the substrate the request
 * path already uses for every `LEAN_MATCH=on` leg — 191 calls per golden run,
 * repeatedly, without wedging — so this moves the gate onto the path with the
 * evidence behind it and deletes the second, older mechanism.
 *
 * The binary is unchanged: `lean-core`'s `defaultBin()` resolves `LEAN_CLI` ??
 * `lean/.lake/build/bin/verified_cli`, which is exactly what both callers were
 * passing. They keep their own existence check to decide whether to run at all.
 */
let dumpSeq = 0;

function leanMatch(req: object): LeanMatchResp {
	// Profiling aid: `LEAN_MATCH_DUMP=<dir>` keeps every request body on disk so a
	// single leg can be replayed under a profiler without re-running the pipeline.
	if (process.env.LEAN_MATCH_DUMP) {
		const n = (req as { fixes?: unknown[] }).fixes?.length ?? 0;
		writeFileSync(path.join(process.env.LEAN_MATCH_DUMP, `leg-${n}-${dumpSeq++}.json`), JSON.stringify(req));
	}
	const parsed = leanMatchServe(req as Record<string, unknown>);
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
export function shadowWalkLeg(leg: WalkLegInput): WalkShadowLeg {
	const float = matchWalkSegment(leg.clean, { ways: leg.ways, buildings: leg.buildings });
	const qFixes = leg.clean.map((p) => quantPt(p));
	const qWays: QWay[] = leg.ways.map((w) => ({
		coords: w.coords.map(([lat, lon]) => quantPt({ lat, lon })),
		name: w.name,
	}));
	const qBuildings = leg.buildings.map((r) => r.map((p) => quantPt(p)));
	const quant = qMatchWalkSegment(qFixes, qWays, qBuildings);
	const lean = leanMatch({
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
export function shadowWalkDay(legs: readonly WalkLegInput[]): WalkShadowSummary {
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
		const r = shadowWalkLeg(leg);
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
