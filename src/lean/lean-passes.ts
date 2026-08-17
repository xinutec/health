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

import { polylineDeviationM } from "../geo/leg-compare.js";
import { DETAIL_TOLERANCE_M } from "../geo/map-match-core.js";
import { quantPt } from "../geo/quant-twin.js";
import { deltaFingerprint, deltaTag, unexplainedDeltas } from "./accepted-deltas.js";
import { armPair, formatArmPair, resetArmPair, timeTsArm } from "./arm-timing.js";
import { LeanBridgeError, type LeanGeoResp, leanGeo } from "./lean-core.js";
import { type LedgerVerdict, servedNote } from "./ledger-verdict.js";
import { type LeanRunScope, leanLeg, leanRunScope, resetLeanRunScope } from "./run-scope.js";

/**
 * `solo` — the verified passes alone (#975). No TS arm, no comparison, no
 * fallback, on all SIX ops behind this one flag.
 *
 * ⚠ Every op's small-input guard is dropped under `solo`, and each was checked
 * against both implementations first (#975 audit): `simplifyPath`/`rejectSpikes`
 * /`trimOverRouteExcursions` return the input verbatim below their thresholds
 * and so do `simplifyIdx`/`rejectSpikes`/`trim` in Lean; `removeSpurs` has no
 * early return at all but its loop cannot execute under three points, matching
 * `spurGo`. Do not restore a guard here without redoing that check — the
 * `gpsquality` one looked equally harmless and was not.
 */
export type LeanPassMode = "off" | "shadow" | "on" | "solo";

export function leanPassMode(): LeanPassMode {
	// Env only; the settings-UI master override is gone (#975). See
	// `lean-head.ts` for why it had to go before `solo` meant anything.
	const v = process.env.LEAN_PASSES;
	return v === "on" || v === "shadow" || v === "solo" ? v : "off";
}

interface PassStat {
	/** Successful bridge calls (the verified pass ran and returned). */
	calls: number;
	/** Bridge failures caught and fallen back to TS (LeanBridgeError). */
	fails: number;
	/** Calls where the Lean output differed from the TS output. */
	diffs: number;
}

/** Keyed `${scope}|${op}` so one op can be tallied per run. */
const stats = new Map<string, PassStat>();

function stat(op: string): PassStat {
	const key = `${leanRunScope()}|${op}`;
	const s = stats.get(key) ?? { calls: 0, fails: 0, diffs: 0 };
	stats.set(key, s);
	return s;
}

function recordCall(op: string, diverged: boolean): void {
	const s = stat(op);
	s.calls += 1;
	if (diverged) s.diffs += 1;
}

/**
 * The `solo` body every op shares (#975): ask the bridge, count the call, and
 * hand the response to the op's own materialiser. No TS arm, no comparison, no
 * fallback — a `LeanBridgeError` propagates and the caller fails loudly.
 *
 * Factored because six ops behind ONE flag would otherwise be six copies of the
 * same four lines, and a divergence between those copies is exactly the kind of
 * thing nobody would notice. What stays per-op is only what genuinely differs:
 * the request, and how the response becomes points. Those are three distinct
 * shapes — an index list (`simplify`), a subsequence of the input
 * (`spurs`/`spikes`/`trim`/`despike`), and materialised vertices (`splice`) —
 * and collapsing them further would hide a real distinction.
 *
 * ⚠ `recordCall(op, false)` is not a claim that nothing diverged. Under `solo`
 * there is no second arm to diverge FROM, and the ledger prints SOLO rather
 * than EXACT so the zero is never read as agreement.
 */
function soloGeo<R>(op: string, req: Record<string, unknown>, take: (r: LeanGeoResp) => R): R {
	const resp = leanGeo(req);
	if (resp.error !== undefined) {
		recordFail(op);
		throw new LeanBridgeError(`lean-passes[solo] ${op}: ${resp.error}`);
	}
	recordCall(op, false);
	return take(resp);
}

function recordFail(op: string): void {
	stat(op).fails += 1;
}

/** Sum the per-`${scope}|${op}` tallies into buckets named by `bucketOf`. */
function foldStats(bucketOf: (scope: string, op: string) => string): Record<string, PassStat> {
	const out: Record<string, PassStat> = {};
	for (const [key, s] of stats) {
		const bar = key.indexOf("|");
		const bucket = bucketOf(key.slice(0, bar), key.slice(bar + 1));
		let acc = out[bucket];
		if (acc === undefined) {
			acc = { calls: 0, fails: 0, diffs: 0 };
			out[bucket] = acc;
		}
		acc.calls += s.calls;
		acc.fails += s.fails;
		acc.diffs += s.diffs;
	}
	return out;
}

/** Per-op tallies (calls / failures / divergences) since the last reset,
 *  summed across scopes — the whole-run view the flip gate adjudicates. */
export function leanPassStats(): Record<string, PassStat> {
	return foldStats((_scope, op) => op);
}

/** Totals per scope — what separates served output from measurement noise. */
export function leanPassScopeTotals(): Record<string, PassStat> {
	return foldStats((scope) => scope);
}

interface Divergence {
	op: string;
	n: number;
	note: string;
	/** The leg this pass ran on (`legFingerprint`), or `""` if it ran outside
	 *  any leg — the episode-geometry `spikes` calls, which operate on fix
	 *  windows rather than matcher legs. Unattributed divergences are never
	 *  auto-accepted; see `accepted-deltas.ts`. */
	leg: string;
	/** The flip, structurally: which indices each arm kept alone. Present only
	 *  for the index-set ops (`simplify`), whose divergence IS a set of vertex
	 *  flips; the count-only ops describe theirs in `note` and cannot be shape-
	 *  checked. Adjudication needs the numbers, not a rendering of them. */
	tsOnly?: readonly number[];
	leanOnly?: readonly number[];
	/** How far apart the two arms' drawn lines are, and the tolerance the pass
	 *  ran at — the bar a line-drawing op is judged by (`isBoundedByGeometry`).
	 *  Absent for the ops that do not produce a comparable polyline. */
	lineDevM?: number;
	toleranceM?: number;
	sameVertexCount?: boolean;
	/** Which run produced it — a `decode` divergence affects served output. */
	scope: LeanRunScope;
}
const divergences: Divergence[] = [];
const MAX_DIVERGENCES = 500;

function recordDivergence(
	op: string,
	n: number,
	note: string,
	shape?: { tsOnly: readonly number[]; leanOnly: readonly number[] },
	geometry?: { lineDevM: number; toleranceM: number; sameVertexCount: boolean },
): void {
	if (divergences.length >= MAX_DIVERGENCES) return;
	divergences.push({ op, n, note, leg: leanLeg(), ...shape, ...geometry, scope: leanRunScope() });
}

/** Structured divergences (bounded) — the flip-decision ledger. */
export function leanPassDivergences(): readonly Divergence[] {
	return divergences;
}

/** Clear stats + divergences (the ledger CLI resets between runs). Also
 *  returns the scope to `decode`, so a new day starts attributing afresh. */
export function resetLeanPassStats(): void {
	stats.clear();
	divergences.length = 0;
	resetLeanRunScope();
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

/** How two keep-index sets differ: the indices each arm kept alone. */
function symdiff(ts: readonly number[], lean: readonly number[]): { tsOnly: number[]; leanOnly: number[] } {
	const tsSet = new Set(ts);
	const leanSet = new Set(lean);
	return { tsOnly: ts.filter((i) => !leanSet.has(i)), leanOnly: lean.filter((i) => !tsSet.has(i)) };
}

/** The same, rendered for the ledger line. */
function symdiffNote(d: { tsOnly: readonly number[]; leanOnly: readonly number[] }): string {
	return `ts-only=[${d.tsOnly}] lean-only=[${d.leanOnly}]`;
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
 * `ts` computes the TS output. Both `shadow` and `on` run the Lean pass and
 * compare against it; `shadow` serves the TS result, `on` serves the verified
 * `keep` subset (a subsequence of `pts`, so downstream sees the same object
 * identities). Any bridge failure is recorded and falls back to TS.
 *
 * A THUNK rather than a value so the TS arm can be timed against the Lean arm
 * (`arm-timing.ts`) — the ratio, not the Lean cost, is what a flip decision
 * turns on. It is invoked on every path, including `off`: `shadow` and `on`
 * both compare against it, so nothing is skipped by deferring it.
 */
export function simplifyViaLean<T extends LatLonTs>(pts: readonly T[], toleranceM: number, ts: () => T[]): T[] {
	const mode = leanPassMode();
	if (mode === "solo") {
		return soloGeo("simplify", { op: "simplify", tol: Math.round(toleranceM * 1e6), pts: rows(pts) }, (r) =>
			(r.keep ?? []).map((i) => pts[i]),
		);
	}
	if (mode === "off" || pts.length <= 2) return ts();
	const tsResult = timeTsArm("geo", ts);
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
		const shape = symdiff(tsIdx, keep);
		// The two arms' OUTPUT LINES, which is what a display-geometry pass is
		// actually responsible for. An index-set difference where both lines
		// agree to the pass's own tolerance is a vertex sliding along one line,
		// not a disagreement about where the line goes (#766).
		const lineDevM = polylineDeviationM(
			tsIdx.map((i) => pts[i]),
			keep.map((i) => pts[i]),
		);
		const geometry = { lineDevM, toleranceM, sameVertexCount: tsIdx.length === keep.length };
		const note = `${symdiffNote(shape)} line=${lineDevM.toFixed(2)} m/tol ${toleranceM} m`;
		recordDivergence("simplify", pts.length, note, shape, geometry);
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
	ts: () => T[],
): T[] {
	const mode = leanPassMode();
	const req = { op: "spurs", ret: Math.round(returnM * 1e6), span: maxSpan, pts: rows(pts) };
	if (mode === "solo") return soloGeo("spurs", req, (r) => subsequenceKept(pts, r.pts ?? []));
	if (mode === "off" || pts.length < 3) return ts();
	const tsResult = timeTsArm("geo", ts);
	let leanRows: number[][];
	try {
		leanRows = leanGeo(req).pts ?? [];
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
export function rejectSpikesViaLean<T extends LatLonTs>(pts: readonly T[], ts: () => T[]): T[] {
	const mode = leanPassMode();
	const req = { op: "spikes", pts: rows(pts) };
	if (mode === "solo") return soloGeo("spikes", req, (r) => subsequenceKept(pts, r.pts ?? []));
	if (mode === "off" || pts.length < 3) return ts();
	const tsResult = timeTsArm("geo", ts);
	let leanRows: number[][];
	try {
		leanRows = leanGeo(req).pts ?? [];
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
	ts: () => P[],
): P[] {
	const mode = leanPassMode();
	const req = { op: "trim", path: rows(path), fixes: rows(fixes) };
	if (mode === "solo") return soloGeo("trim", req, (r) => subsequenceKept(path, r.pts ?? []));
	if (mode === "off" || path.length < 3) return ts();
	const tsResult = timeTsArm("geo", ts);
	let leanRows: number[][];
	try {
		leanRows = leanGeo(req).pts ?? [];
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
	ts: () => P[],
	minApexM = 15,
	excessM = 12,
): P[] {
	const mode = leanPassMode();
	const req = {
		op: "despike",
		apex: Math.round(minApexM * 1e6),
		excess: Math.round(excessM * 1e6),
		pts: rows(path),
		raw: rows(fixes),
	};
	if (mode === "solo") return soloGeo("despike", req, (r) => subsequenceKept(path, r.pts ?? []));
	if (mode === "off" || path.length < 3) return ts();
	const tsResult = timeTsArm("geo", ts);
	let leanRows: number[][];
	try {
		leanRows = leanGeo(req).pts ?? [];
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

/**
 * Request-path pass ledger (docs/proposals/2026-07-verified-core-lean.md):
 * when `LEAN_PASSES` is `shadow` or `on`, the wired geometry passes execute
 * the verified Lean implementation via the in-process bridge during the day's
 * velocity runs (`shadow` serves TS, `on` serves Lean). Log the accumulated
 * per-op ledger (calls/failures/divergences) and reset. No-op with the flag
 * off. In `on` mode this keeps the soak visible while production serves Lean —
 * the same measurement, so a run of clean `EXACT` days is the continuous
 * evidence the flip stays honest.
 *
 * Divergences are adjudicated against `accepted-deltas.ts`, the same manifest
 * the `shadow-passes` gate uses, so the line states whether the flip's premise
 * ("every divergence is a signed-off near-tie") still holds on days the corpus
 * does not cover.
 *
 * The day makes several velocity runs — the decode itself, plus the extra one
 * `runWalkShadow` does purely to extract legs — so the line breaks the tally
 * down by scope and calls out divergences that came from the decode rather than
 * from throwaway measurement. Summing them hid that distinction, which is the
 * one the reader actually needs.
 *
 * That call-out is worded by {@link servedNote}, which takes the MODE too:
 * being on the persisted run is not the same as having been served, and under
 * `shadow` it is TS that was served (#399).
 *
 * Lives here rather than in `decode-day` (where it was until #392) for two
 * reasons: it belongs beside the tenant it measures, like the other six, and
 * a private function inside one CLI cannot be called by the corpus gate.
 */
export function logLeanPassLedger(label: string): LedgerVerdict | null {
	// `leanPassMode()`, not a bare read of `process.env.LEAN_PASSES` as this did
	// in `decode-day`. The original reason was the settings-UI master override,
	// which could put this tenant into `on` without the env var and left the old
	// read SILENT through exactly that case — serving Lean with no ledger at
	// all. That override is gone (#975), so the two now agree; the call stays
	// because one accessor is where the mode is decided.
	const mode = leanPassMode();
	if (mode === "off") return null;
	const stats = leanPassStats();
	const tally = Object.entries(stats)
		.map(([op, s]) => `${op} ${s.calls}/${s.fails}f/${s.diffs}d`)
		.join(" ");
	// Adjudicate against the same manifest the flip gate uses. The gate only
	// replays the golden corpus, so production is the only place a divergence
	// on an uncaptured day can surface — logging one without saying whether it
	// is signed off makes an accepted near-tie and a genuine behaviour change
	// read identically.
	const scopes = leanPassScopeTotals();
	const byScope = Object.entries(scopes)
		.map(([sc, s]) => `${sc} ${s.calls}/${s.fails}f/${s.diffs}d`)
		.join(" · ");
	const divs = leanPassDivergences();
	const unexplained = unexplainedDeltas(divs);
	const served = divs.filter((d) => d.scope === "decode");
	// This tenant fans out over several ops, so its call count is their sum.
	const calls = Object.values(stats).reduce((n, s) => n + s.calls, 0);
	const fails = Object.values(stats).reduce((n, s) => n + s.fails, 0);
	// Zero calls is not a pass — see the note in lean-kalman.ts (#392). Until
	// then this printed `(no calls) EXACT`: the marker was already there and the
	// verdict contradicted it, which is the worst of both.
	//
	// ⚠ `solo` prints neither EXACT nor `all accepted`. Both are vacuous with no
	// TS arm, and `all accepted` is the worse of the two — it asserts every
	// divergence was adjudicated against the accepted-delta manifest, which was
	// never opened because nothing was measured.
	//
	// The per-op `n/Nf/Nd` counts stay meaningful and keep printing: the `d`
	// column is structurally zero, but `n` and `f` still say which of the six ops
	// actually ran, which is the only way to catch an op that quietly stopped
	// being reached.
	const verdict =
		calls === 0
			? "NOT EXERCISED"
			: mode === "solo"
				? `SOLO (no TS arm; ${calls} call(s) across ${Object.keys(stats).length} op(s))`
				: divs.length === 0
					? "EXACT"
					: unexplained.length === 0
						? "all accepted"
						: `${unexplained.length} UNEXPLAINED`;
	const servedTag = servedNote(mode, served.length);
	const detail =
		divs.length === 0
			? ""
			: ` — ${divs
					.map(
						(d) =>
							`[${deltaTag(d)}][${d.scope}] ${d.op} leg=${d.leg === "" ? "UNATTRIBUTED" : d.leg} ` +
							`n=${d.n} ${d.note}`,
					)
					.join("; ")}`;
	// Both arms' wall cost this run — read before the reset below.
	const armMs = formatArmPair(armPair("geo"));
	console.log(
		`lean-passes[${mode}] ${label} ${tally === "" ? "(no calls)" : tally}` +
			`${byScope === "" ? "" : ` [all ops by run: ${byScope}]`} ${verdict}${servedTag}${detail}${armMs}`,
	);
	// An ACCEPTED divergence is `accepted`, not `exact`: it passes, on a manifest
	// somebody signed. Collapsing it into `exact` would let the gate stop
	// distinguishing "agreed" from "disagreed in a way we decided to allow".
	const out: LedgerVerdict = {
		tenant: "passes",
		mode,
		calls,
		fails,
		// The same fields `AcceptedDelta` adjudicates on, so a ceiling entry and a
		// manifest entry name the same thing and promoting one to the other is a
		// move between files, not a re-derivation. Leg-and-shape, NOT `n` and the
		// literal indices: a ceiling keyed on those went stale the moment anything
		// upstream added a vertex, silently turning standing debt back into a fresh
		// failure (#409).
		unexplained: unexplained.map(deltaFingerprint).sort(),
		klass:
			calls === 0 ? "not-exercised" : divs.length === 0 ? "exact" : unexplained.length === 0 ? "accepted" : "diverged",
	};
	resetLeanPassStats();
	resetArmPair("geo");
	return out;
}

/**
 * Route-detail splice through the verified core (`qSplice`, op `splice`).
 *
 * ⚠ **This op had NO A/B until 2026-08-16.** It was added while chasing #749's
 * 2.55 m out-and-back spur on 2026-08-11, on the hypothesis that `qSplice`
 * re-injected an excursion `removeSpurs` had already excised.
 *
 * **That hypothesis is REFUTED, and this comment said otherwise for one
 * commit.** With the A/B in place, `splice` reads `n/0f/0d` on every live day:
 * given the same inputs, `qSplice` and `spliceRouteDetail` agree. Splice is not
 * the cause of the spur and nothing here should be read as implicating it.
 *
 * The function stays because the COVERAGE GAP was real independent of that
 * bug — splice was the one geometry op nothing compared, and an uncompared op
 * is a place a divergence can reach a live day unseen. Keeping it is the
 * argument; the bug it was built to catch turned out to be elsewhere.
 *
 * ⚠ **Not drop-only, unlike every other pass here.** Splice ADDS vertices
 * carried back from the route, so the result is not a subsequence of the input
 * and `subsequenceKept` cannot recover it. `on` mode therefore materialises the
 * Lean rows directly — which is faithful, because the TS splice also emits
 * fresh `{lat, lon, ts}` objects rather than the input ones.
 *
 * `tol` is the per-chord depth FLOOR and `drop` the ceiling, both micro-metres
 * on the wire, matching the two numbers `qMatchWalkSegment` passes.
 */
export function spliceViaLean<P extends LatLonTs>(
	coarse: readonly P[],
	route: readonly P[],
	dropM: number,
	ts: () => P[],
): P[] {
	const mode = leanPassMode();
	const req = {
		op: "splice",
		coarse: rows(coarse),
		route: rows(route),
		tol: Math.round(DETAIL_TOLERANCE_M * 1e6),
		drop: Math.round(dropM * 1e6),
	};
	// ⚠ The one op whose result is NOT a subsequence of its input: splice weaves
	// detail from `route` into `coarse`, so the output contains vertices that
	// appear in neither list verbatim and must be materialised from the wire.
	if (mode === "solo") {
		return soloGeo("splice", req, (r) =>
			(r.pts ?? []).map((row) => ({ lat: row[0] / 1e7, lon: row[1] / 1e7, ts: row[2] }) as unknown as P),
		);
	}
	if (mode === "off" || coarse.length < 2 || route.length < 2) return ts();
	const tsResult = timeTsArm("geo", ts);
	let leanRows: number[][];
	try {
		leanRows = leanGeo(req).pts ?? [];
	} catch (e) {
		if (!(e instanceof LeanBridgeError)) throw e;
		recordFail("splice");
		return tsResult;
	}
	const diverged = !eqRows(rows(tsResult), leanRows);
	recordCall("splice", diverged);
	if (diverged) {
		const note = `ts=${tsResult.length} lean=${leanRows.length} verts`;
		recordDivergence("splice", coarse.length, note);
		if (mode === "shadow") console.warn(`[lean-passes] splice divergence (n=${coarse.length}): ${note}`);
	}
	if (mode !== "on") return tsResult;
	return leanRows.map((r) => ({ lat: r[0] / 1e7, lon: r[1] / 1e7, ts: r[2] }) as unknown as P);
}
