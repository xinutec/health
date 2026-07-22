/**
 * Request-path adoption of the verified walk map-matcher (the decision
 * engine, not just the geometry passes).
 *
 * This is the matcher analogue of `lean-passes.ts`: it lets production run
 * the *proved* Lean Viterbi walk-matcher (`MatchViterbi.decodeFast`, whose
 * `decodeFast_argmax` proves the returned chain is the maximum-`pathScore`
 * candidate) via the synchronous bridge (`lean-core.ts`) in place of the TS
 * `matchWalkSegment`, staged behind its OWN env flag:
 *
 *   off    (default) — pure TS, zero behaviour change. The bridge is never
 *            touched; no measurement.
 *   shadow — run BOTH, SERVE the TS output, compare, log divergence. The
 *            request-path shadow (the cron already shadows via spawnSync;
 *            this measures the SERVE path, over the persistent worker).
 *   on     — run BOTH, SERVE the verified Lean output, still compare and
 *            record. Fall back to TS on any bridge failure.
 *
 * Why a SEPARATE flag from `LEAN_PASSES` (rather than reusing it): the five
 * geometry passes are already served `on` in production, but the matcher is
 * only days into its quant↔Lean soak (`walk-shadow` in decode-day). Coupling
 * the two flags would flip an un-soaked matcher the instant anyone touched
 * the passes flag. `LEAN_MATCH` keeps the matcher flip an independent,
 * separately-gated decision — the plumbing lands now, the flip waits for the
 * soak.
 *
 * Inputs are quantised to the pinned 1e-7° integers on the way in — exactly
 * what the `compare-match` referee (173/173 quant↔Lean) sees — so that gate
 * is the judge of what `on` serves. `on` adopts quantised geometry as truth,
 * which differs from the TS floats on the corpus's known near-tie legs (the
 * route near-ties + the one building-penalty in/out flip); those are the
 * matcher's accepted-delta class, surfaced in the ledger so the flip is never
 * blind.
 */

import type { BuildingRing, RoadFix, RoadGeometry } from "../geo/map-match-core.js";
import type { WalkMatchResult } from "../geo/pedestrian-match.js";
import { type QPt, quantPt } from "../geo/quant-twin.js";
import { LeanBridgeError, type LeanMatchResp, leanMatchServe } from "./lean-core.js";
import { type LeanRunScope, leanRunScope, resetLeanRunScope } from "./run-scope.js";
import { verifiedCoreOverride } from "./runtime-mode.js";

export type LeanMatchMode = "off" | "shadow" | "on";

export function leanMatchMode(): LeanMatchMode {
	// The settings-UI master override wins over the env default when set.
	const o = verifiedCoreOverride();
	if (o !== null) return o ? "on" : "off";
	const v = process.env.LEAN_MATCH;
	return v === "on" || v === "shadow" ? v : "off";
}

interface MatchStat {
	/** Successful bridge calls (the verified matcher ran and returned). */
	calls: number;
	/** Bridge failures caught and fallen back to TS (LeanBridgeError). */
	fails: number;
	/** Calls where the Lean decision (coarse layer) differed from TS. */
	coarseDiffs: number;
	/** Calls where only the display path (splice detail) differed. */
	pathDiffs: number;
	/** Calls where one arm matched and the other returned null. */
	nullFlips: number;
}

const empty = (): MatchStat => ({ calls: 0, fails: 0, coarseDiffs: 0, pathDiffs: 0, nullFlips: 0 });

/** Tallies per run scope. Pooled into one counter, the observational
 *  `runWalkShadow` velocity run's legs were summed with the persisted decode's,
 *  so the ledger reported roughly double the served call count and could not say
 *  whether a divergence reached served output. */
const stats = new Map<LeanRunScope, MatchStat>();

function stat(): MatchStat {
	const s = stats.get(leanRunScope()) ?? empty();
	stats.set(leanRunScope(), s);
	return s;
}

/** Matcher tallies since the last reset, summed across scopes. */
export function leanMatchStats(): Readonly<MatchStat> {
	const out = empty();
	for (const s of stats.values()) {
		out.calls += s.calls;
		out.fails += s.fails;
		out.coarseDiffs += s.coarseDiffs;
		out.pathDiffs += s.pathDiffs;
		out.nullFlips += s.nullFlips;
	}
	return out;
}

/** Per-scope matcher tallies — what separates served output from measurement. */
export function leanMatchScopeTotals(): Readonly<Partial<Record<LeanRunScope, Readonly<MatchStat>>>> {
	return Object.fromEntries(stats);
}

export function resetLeanMatchStats(): void {
	stats.clear();
	resetLeanRunScope();
}

const row = (p: QPt): number[] => [Number(p.la), Number(p.lo), Number(p.ts)];
const coord = (p: QPt): number[] => [Number(p.la), Number(p.lo)];

/** Quantise a leg's matcher input exactly as `compare-match` / the shadow do
 *  (`walk-shadow-core.shadowWalkLeg`): fixes with ts, ways as lat/lon coord
 *  pairs + name, buildings as coord rings — all pinned 1e-7° integers. */
function quantReq(fixes: readonly RoadFix[], geo: RoadGeometry): Record<string, unknown> {
	const buildings: readonly BuildingRing[] = geo.buildings ?? [];
	return {
		fixes: fixes.map((f) => row(quantPt(f))),
		ways: geo.ways.map((w) => ({
			coords: w.coords.map(([lat, lon]) => coord(quantPt({ lat, lon }))),
			name: w.name ?? null,
		})),
		buildings: buildings.map((r) => r.map((p) => coord(quantPt(p)))),
	};
}

const eqNum = (a: readonly number[], b: readonly number[]): boolean =>
	a.length === b.length && a.every((x, i) => x === b[i]);
const eqRows = (a: readonly number[][], b: readonly number[][]): boolean =>
	a.length === b.length && a.every((r, i) => eqNum(r, b[i]));

/** Quantise a TS matched line to comparison rows (ts carried — matched points
 *  always have an interpolated timestamp). */
const qRows = (pts: readonly { lat: number; lon: number; ts: number }[]): number[][] => pts.map((p) => row(quantPt(p)));

/** Dequantise a verified `match` response back to a `WalkMatchResult`.
 *  `on` mode serves this: the 1e-7° integers become floats (a ≤ 5e-8° /
 *  ~5 mm shift — the "quantised geometry as truth" the doc note describes). */
const deq = (r: readonly number[]): { lat: number; lon: number; ts: number } => ({
	lat: r[0] / 1e7,
	lon: r[1] / 1e7,
	ts: r[2],
});

function leanToResult(lean: LeanMatchResp): WalkMatchResult | null {
	if (lean.none === true || lean.path === undefined || lean.coarse === undefined) return null;
	return { path: lean.path.map(deq), coarsePath: lean.coarse.map(deq) };
}

/**
 * Map-match a walking leg through the verified core, staged behind
 * `LEAN_MATCH`. `tsResult` is the TS output the call site already computed
 * (`matchWalkSegment(...)`). Both `shadow` and `on` run the Lean matcher and
 * compare against it; `shadow` serves `tsResult`, `on` serves the dequantised
 * verified result. Any bridge failure is recorded and falls back to
 * `tsResult` (swallow-over-wrong, execution edition).
 */
export function matchWalkSegmentViaLean(
	fixes: readonly RoadFix[],
	geo: RoadGeometry,
	tsResult: WalkMatchResult | null,
): WalkMatchResult | null {
	const mode = leanMatchMode();
	if (mode === "off" || fixes.length < 3) return tsResult;
	let lean: LeanMatchResp;
	try {
		lean = leanMatchServe(quantReq(fixes, geo));
	} catch (e) {
		if (!(e instanceof LeanBridgeError)) throw e;
		stat().fails += 1;
		return tsResult;
	}
	stat().calls += 1;

	// Compare quantised-TS against the verified rows, splitting the DECISION
	// layer (coarse) from the display splice (path): a coarse flip is a real
	// matcher-decision divergence; a path-only flip is the known splice near-tie
	// class. A null-vs-matched flip is its own (loudest) bucket.
	const leanResult = leanToResult(lean);
	if ((tsResult === null) !== (leanResult === null)) {
		stat().nullFlips += 1;
		if (mode === "shadow") {
			console.warn(`[lean-match] null-flip (ts=${tsResult === null ? "null" : "match"} n=${fixes.length})`);
		}
	} else if (tsResult !== null && leanResult !== null) {
		const coarseDiff = !eqRows(qRows(tsResult.coarsePath), lean.coarse ?? []);
		const pathDiff = !eqRows(qRows(tsResult.path), lean.path ?? []);
		if (coarseDiff) stat().coarseDiffs += 1;
		else if (pathDiff) stat().pathDiffs += 1;
		if ((coarseDiff || pathDiff) && mode === "shadow") {
			console.warn(
				`[lean-match] divergence (n=${fixes.length}) coarse=${coarseDiff} path=${pathDiff} ` +
					`ts=${tsResult.coarsePath.length} lean=${(lean.coarse ?? []).length}`,
			);
		}
	}

	return mode === "on" ? leanResult : tsResult;
}
