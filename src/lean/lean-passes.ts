/**
 * Request-path adoption of the verified geometry passes.
 *
 * These wrappers let production execute the *proved* Lean pass (via the
 * synchronous bridge, `lean-core.ts`) in place of the TS implementation,
 * staged behind the `LEAN_PASSES` env flag:
 *
 *   off    (default) — pure TS, zero behaviour change. The bridge is never
 *            touched; no measurement.
 *   shadow — run BOTH, SERVE the TS output, compare byte-wise, log
 *            divergence. The lean-shadow discipline on the request path.
 *   on     — run BOTH, SERVE the verified Lean output, still compare and
 *            record. Fall back to TS on any bridge failure (swallow-over-
 *            wrong, execution edition).
 *
 * `shadow` and `on` take the SAME measurements (calls / bridge-failures /
 * divergences) — they differ only in which result is returned. So the ledger
 * is a faithful record of what the bridge did regardless of which output was
 * served, and a green `on` run PROVES the bridge actually executed (calls > 0,
 * failures == 0) rather than having silently fallen back to TS.
 *
 * Inputs are quantised to the pinned 1e-7° integers on the way in, so the
 * bridge sees exactly what the `compare-geo` referee sees — the 173/173 gate
 * is the judge of what `on` mode serves. Note that `on` adopts quantised
 * geometry as truth, which differs from the TS floats on the corpus's known
 * near-tie legs (Douglas-Peucker single-vertex flips); those wash out of the
 * final golden output (golden is 31/31 byte-identical under `on`), but the
 * ledger surfaces them so the flip is never blind.
 */

import { quantPt } from "../geo/quant-twin.js";
import { LeanBridgeError, leanGeo } from "./lean-core.js";
import { verifiedCoreOverride } from "./runtime-mode.js";

export type LeanPassMode = "off" | "shadow" | "on";

export function leanPassMode(): LeanPassMode {
	// The settings-UI master override wins over the env default when set.
	const o = verifiedCoreOverride();
	if (o !== null) return o ? "on" : "off";
	const v = process.env.LEAN_PASSES;
	return v === "on" || v === "shadow" ? v : "off";
}

interface PassStat {
	/** Successful bridge calls (the verified pass ran and returned). */
	calls: number;
	/** Bridge failures caught and fallen back to TS (LeanBridgeError). */
	fails: number;
	/** Calls where the Lean output differed from the TS output. */
	diffs: number;
}
const stats = new Map<string, PassStat>();

function stat(op: string): PassStat {
	const s = stats.get(op) ?? { calls: 0, fails: 0, diffs: 0 };
	stats.set(op, s);
	return s;
}

function recordCall(op: string, diverged: boolean): void {
	const s = stat(op);
	s.calls += 1;
	if (diverged) s.diffs += 1;
}

function recordFail(op: string): void {
	stat(op).fails += 1;
}

/** Per-op tallies (calls / failures / divergences) since the last reset. */
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

/** Structured divergences (bounded) — the flip-decision ledger. */
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
 * `tsResult` is the TS output the call site already computed. Both `shadow`
 * and `on` run the Lean pass and compare against it; `shadow` serves
 * `tsResult`, `on` serves the verified `keep` subset (a subsequence of `pts`,
 * so downstream sees the same object identities). Any bridge failure is
 * recorded and falls back to `tsResult`.
 */
export function simplifyViaLean<T extends LatLonTs>(pts: readonly T[], toleranceM: number, tsResult: T[]): T[] {
	const mode = leanPassMode();
	if (mode === "off" || pts.length <= 2) return tsResult;
	let keep: number[];
	try {
		keep = leanGeo({ op: "simplify", tol: Math.round(toleranceM * 1e6), pts: rows(pts) }).keep ?? [];
	} catch (e) {
		if (!(e instanceof LeanBridgeError)) throw e;
		recordFail("simplify");
		return tsResult;
	}
	const tsIdx = keptIndices(pts, tsResult);
	const diverged = !eqNum(tsIdx, keep);
	recordCall("simplify", diverged);
	if (diverged) {
		const note = symdiffNote(tsIdx, keep);
		recordDivergence("simplify", pts.length, note);
		if (mode === "shadow") console.warn(`[lean-passes] simplify divergence (n=${pts.length}): ${note}`);
	}
	return mode === "on" ? keep.map((i) => pts[i]) : tsResult;
}

/**
 * Dead-end spur removal through the verified core (`qRemoveSpurs`, op
 * `spurs`). Drop-only over the mutated suffix; `on` mode recovers the kept
 * original objects by subsequence match. `returnM` is the metric return
 * threshold (µm on the wire, matching the compare-geo referee), `maxSpan`
 * the excursion vertex budget.
 */
export function removeSpursViaLean<T extends LatLonTs>(
	pts: readonly T[],
	returnM: number,
	maxSpan: number,
	tsResult: T[],
): T[] {
	const mode = leanPassMode();
	if (mode === "off" || pts.length < 3) return tsResult;
	let leanRows: number[][];
	try {
		leanRows = leanGeo({ op: "spurs", ret: Math.round(returnM * 1e6), span: maxSpan, pts: rows(pts) }).pts ?? [];
	} catch (e) {
		if (!(e instanceof LeanBridgeError)) throw e;
		recordFail("spurs");
		return tsResult;
	}
	const diverged = !eqRows(rows(tsResult), leanRows);
	recordCall("spurs", diverged);
	if (diverged) {
		const note = `ts=${tsResult.length} lean=${leanRows.length} kept`;
		recordDivergence("spurs", pts.length, note);
		if (mode === "shadow") console.warn(`[lean-passes] spurs divergence (n=${pts.length}): ${note}`);
	}
	return mode === "on" ? subsequenceKept(pts, leanRows) : tsResult;
}

/**
 * Geometric spike rejection through the verified core (`qRejectSpikes`).
 * The `spikes` op returns quantised rows; `on` mode recovers the kept
 * original objects by subsequence match. Both modes compare the quantised TS
 * keep-set to the Lean keep-set. (compare-geo measures zero float↔quant flips
 * for this pass, so the ledger should stay clean.)
 */
export function rejectSpikesViaLean<T extends LatLonTs>(pts: readonly T[], tsResult: T[]): T[] {
	const mode = leanPassMode();
	if (mode === "off" || pts.length < 3) return tsResult;
	let leanRows: number[][];
	try {
		leanRows = leanGeo({ op: "spikes", pts: rows(pts) }).pts ?? [];
	} catch (e) {
		if (!(e instanceof LeanBridgeError)) throw e;
		recordFail("spikes");
		return tsResult;
	}
	const diverged = !eqRows(rows(tsResult), leanRows);
	recordCall("spikes", diverged);
	if (diverged) {
		const note = `ts=${tsResult.length} lean=${leanRows.length} kept`;
		recordDivergence("spikes", pts.length, note);
		if (mode === "shadow") console.warn(`[lean-passes] spikes divergence (n=${pts.length}): ${note}`);
	}
	return mode === "on" ? subsequenceKept(pts, leanRows) : tsResult;
}

/**
 * Over-route excursion trim through the verified core (`qTrim`, op `trim`).
 * Drop-only over the drawn `path`, judged against the raw `fixes`; `on` mode
 * recovers the kept path objects by subsequence match.
 */
export function trimViaLean<P extends LatLonTs, F extends LatLonTs>(
	path: readonly P[],
	fixes: readonly F[],
	tsResult: P[],
): P[] {
	const mode = leanPassMode();
	if (mode === "off" || path.length < 3) return tsResult;
	let leanRows: number[][];
	try {
		leanRows = leanGeo({ op: "trim", path: rows(path), fixes: rows(fixes) }).pts ?? [];
	} catch (e) {
		if (!(e instanceof LeanBridgeError)) throw e;
		recordFail("trim");
		return tsResult;
	}
	const diverged = !eqRows(rows(tsResult), leanRows);
	recordCall("trim", diverged);
	if (diverged) {
		const note = `ts=${tsResult.length} lean=${leanRows.length} kept`;
		recordDivergence("trim", path.length, note);
		if (mode === "shadow") console.warn(`[lean-passes] trim divergence (n=${path.length}): ${note}`);
	}
	return mode === "on" ? subsequenceKept(path, leanRows) : tsResult;
}

/**
 * Unsupported-apex despike through the verified core (`qDespike`, op
 * `despike`). Drop-only over `path`, judged against the raw `fixes`. The turn
 * threshold (140°) is baked into the verified twin; only the apex/excess
 * metric thresholds cross the wire (µm), matching the compare-geo referee.
 */
export function despikeViaLean<P extends LatLonTs, F extends LatLonTs>(
	path: readonly P[],
	fixes: readonly F[],
	tsResult: P[],
	minApexM = 15,
	excessM = 12,
): P[] {
	const mode = leanPassMode();
	if (mode === "off" || path.length < 3) return tsResult;
	let leanRows: number[][];
	try {
		leanRows =
			leanGeo({
				op: "despike",
				apex: Math.round(minApexM * 1e6),
				excess: Math.round(excessM * 1e6),
				pts: rows(path),
				raw: rows(fixes),
			}).pts ?? [];
	} catch (e) {
		if (!(e instanceof LeanBridgeError)) throw e;
		recordFail("despike");
		return tsResult;
	}
	const diverged = !eqRows(rows(tsResult), leanRows);
	recordCall("despike", diverged);
	if (diverged) {
		const note = `ts=${tsResult.length} lean=${leanRows.length} kept`;
		recordDivergence("despike", path.length, note);
		if (mode === "shadow") console.warn(`[lean-passes] despike divergence (n=${path.length}): ${note}`);
	}
	return mode === "on" ? subsequenceKept(path, leanRows) : tsResult;
}
