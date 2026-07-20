/**
 * Request-path adoption of the verified geometry passes.
 *
 * These wrappers let production execute the *proved* Lean pass (via the
 * synchronous bridge, `lean-core.ts`) in place of the TS implementation,
 * staged behind the `LEAN_PASSES` env flag:
 *
 *   off    (default) — pure TS, zero behaviour change.
 *   shadow — run both, SERVE the TS output, compare byte-wise, log
 *            divergence. The lean-shadow discipline on the request path.
 *   on     — SERVE the verified Lean output; fall back to TS on any bridge
 *            failure (swallow-over-wrong, execution edition).
 *
 * Inputs are quantised to the pinned 1e-7° integers on the way in, so the
 * bridge sees exactly what the `compare-geo` referee sees — the 173/173 gate
 * is the judge of what `on` mode serves. Note that `on` adopts quantised
 * geometry as truth, which differs from the TS floats on the corpus's known
 * near-tie legs (1 simplify, 2 trim); `shadow` surfaces exactly those before
 * any flip.
 */

import { quantPt } from "../geo/quant-twin.js";
import { LeanBridgeError, leanGeo } from "./lean-core.js";

export type LeanPassMode = "off" | "shadow" | "on";

export function leanPassMode(): LeanPassMode {
	const v = process.env.LEAN_PASSES;
	return v === "on" || v === "shadow" ? v : "off";
}

interface PassStat {
	calls: number;
	diffs: number;
}
const stats = new Map<string, PassStat>();

function record(op: string, diverged: boolean): void {
	const s = stats.get(op) ?? { calls: 0, diffs: 0 };
	s.calls += 1;
	if (diverged) s.diffs += 1;
	stats.set(op, s);
}

/** Per-op shadow tallies (calls / divergences) since process start. */
export function leanPassStats(): Record<string, PassStat> {
	return Object.fromEntries(stats);
}

interface Divergence {
	op: string;
	n: number;
	note: string;
}
const divergences: Divergence[] = [];
const MAX_DIVERGENCES = 500;

function recordDivergence(op: string, n: number, note: string): void {
	if (divergences.length < MAX_DIVERGENCES) divergences.push({ op, n, note });
}

/** Structured shadow divergences (bounded) — the flip-decision ledger. */
export function leanPassDivergences(): readonly Divergence[] {
	return divergences;
}

/** Clear stats + divergences (the ledger CLI resets between runs). */
export function resetLeanPassStats(): void {
	stats.clear();
	divergences.length = 0;
}

type LatLonTs = { lat: number; lon: number; ts?: number };

function rows(pts: readonly LatLonTs[]): number[][] {
	return pts.map((p, i) => {
		const q = quantPt({ lat: p.lat, lon: p.lon, ts: p.ts ?? i });
		return [Number(q.la), Number(q.lo), Number(q.ts)];
	});
}

/** Indices of `kept` within `all`, by object identity (the TS passes return
 *  the input objects). */
function keptIndices<T>(all: readonly T[], kept: readonly T[]): number[] {
	const set = new Set<T>(kept);
	const out: number[] = [];
	for (let i = 0; i < all.length; i++) if (set.has(all[i])) out.push(i);
	return out;
}

const eqNum = (a: readonly number[], b: readonly number[]): boolean =>
	a.length === b.length && a.every((x, i) => x === b[i]);

const eqRows = (a: readonly number[][], b: readonly number[][]): boolean =>
	a.length === b.length && a.every((r, i) => eqNum(r, b[i]));

/** Compact description of how two keep-index sets differ (for the ledger). */
function symdiffNote(ts: readonly number[], lean: readonly number[]): string {
	const tsSet = new Set(ts);
	const leanSet = new Set(lean);
	const tsOnly = ts.filter((i) => !leanSet.has(i));
	const leanOnly = lean.filter((i) => !tsSet.has(i));
	return `ts-only=[${tsOnly}] lean-only=[${leanOnly}]`;
}

/** Recover the kept ORIGINAL objects from a drop-only, order-preserving
 *  pass that returned quantised rows: walk both in lock-step. */
function subsequenceKept<T extends LatLonTs>(pts: readonly T[], leanRows: number[][]): T[] {
	const inRows = rows(pts);
	const out: T[] = [];
	let j = 0;
	for (let i = 0; i < inRows.length && j < leanRows.length; i++) {
		if (eqNum(inRows[i], leanRows[j])) {
			out.push(pts[i]);
			j += 1;
		}
	}
	return out;
}

/**
 * Douglas–Peucker path simplify through the verified core.
 *
 * `tsResult` is the TS output the call site already computed — served in
 * `off`/`shadow`, and the fallback when the bridge is unavailable. In `on`
 * mode the returned subset is the verified `keep` set (a subsequence of
 * `pts`, so downstream sees the same object identities).
 */
export function simplifyViaLean<T extends LatLonTs>(pts: readonly T[], toleranceM: number, tsResult: T[]): T[] {
	const mode = leanPassMode();
	if (mode === "off" || pts.length <= 2) return tsResult;
	try {
		const keep = leanGeo({ op: "simplify", tol: Math.round(toleranceM * 1e6), pts: rows(pts) }).keep ?? [];
		if (mode === "shadow") {
			const tsIdx = keptIndices(pts, tsResult);
			const diverged = !eqNum(tsIdx, keep);
			record("simplify", diverged);
			if (diverged) {
				const note = symdiffNote(tsIdx, keep);
				recordDivergence("simplify", pts.length, note);
				console.warn(`[lean-passes] simplify divergence (n=${pts.length}): ${note}`);
			}
			return tsResult;
		}
		return keep.map((i) => pts[i]);
	} catch (e) {
		if (!(e instanceof LeanBridgeError)) throw e;
		return tsResult;
	}
}

/**
 * Geometric spike rejection through the verified core (`qRejectSpikes`).
 * The `spikes` op returns quantised rows; `on` mode recovers the kept
 * original objects by subsequence match. Shadow-compares the quantised TS
 * keep-set to the Lean keep-set. (compare-geo measures zero float↔quant
 * flips for this pass, so shadow should stay clean.)
 */
export function rejectSpikesViaLean<T extends LatLonTs>(pts: readonly T[], tsResult: T[]): T[] {
	const mode = leanPassMode();
	if (mode === "off" || pts.length < 3) return tsResult;
	try {
		const leanRows = leanGeo({ op: "spikes", pts: rows(pts) }).pts ?? [];
		if (mode === "shadow") {
			const diverged = !eqRows(rows(tsResult), leanRows);
			record("spikes", diverged);
			if (diverged) {
				const note = `ts=${tsResult.length} lean=${leanRows.length} kept`;
				recordDivergence("spikes", pts.length, note);
				console.warn(`[lean-passes] spikes divergence (n=${pts.length}): ${note}`);
			}
			return tsResult;
		}
		return subsequenceKept(pts, leanRows);
	} catch (e) {
		if (!(e instanceof LeanBridgeError)) throw e;
		return tsResult;
	}
}
