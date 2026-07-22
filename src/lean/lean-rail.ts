/**
 * Request-path adoption of the verified rail shortest path.
 *
 * The rail analogue of `lean-passes.ts` / `lean-match.ts`. Lean has had this
 * feature for a while — `Verified.Rail.dijkstraC` is proved correct
 * (`dijkstraC_correct`), complete (`dijkstra_complete`, `dijkstra_none_iff`
 * under `WFEdges`), `verified_cli rail` exposes it, and `Main.lean`'s
 * `serveLoop` already routes `"rail"` to it. What was missing was any TS
 * caller, so the proved implementation never ran on a real journey. This is
 * that caller.
 *
 *   off    (default) — pure TS, zero behaviour change. The bridge is never
 *            touched; no measurement.
 *   shadow — run BOTH, SERVE the TS path, compare, record divergence.
 *   on     — run BOTH, SERVE the verified path, still compare and record.
 *            Fall back to TS on any bridge failure.
 *
 * Its own flag, for the same reason `LEAN_MATCH` is separate from
 * `LEAN_PASSES`: each tenant's soak is its own decision.
 *
 * **What `on` actually adopts.** The output is a list of vertex INDICES into
 * the caller's graph, not geometry — so unlike the geometry passes and the
 * matcher there is no dequantisation on the way out and no sub-millimetre
 * drift class. Serving Lean's answer serves exactly the vertices TS would have
 * named. The single divergence class is that the search runs over ×2²⁰
 * quantised edge weights, so two routes whose float costs differ by less than
 * ~1e-6 of a metric unit can swap places. `compare-rail` is the judge of that,
 * and reports EXACT on every railsnap fixture in both directions.
 *
 * **Where this runs.** Not in the decode. Production's `railSnap` pass is an
 * indexed lookup into `rail_route_cache`; the Dijkstra runs when that cache is
 * FILLED — in `refresh-rail-routes` (offline cron) and in the serving path's
 * miss-driven fill for a first-seen route (`rail-route-fill.ts`, #363). So the
 * call volume is low and bursty, which is also why the ledger is printed by
 * the refresh CLI rather than per-day by `decode-day`.
 */

import { createHash } from "node:crypto";
import type { RailGraph } from "../geo/rail-snap.js";
import { LeanBridgeError, type LeanRailResp, leanRailServe } from "./lean-core.js";
import { type LeanRunScope, leanRunScope } from "./run-scope.js";
import { verifiedCoreOverride } from "./runtime-mode.js";

export type LeanRailMode = "off" | "shadow" | "on";

export function leanRailMode(): LeanRailMode {
	// The settings-UI master override wins over the env default when set.
	const o = verifiedCoreOverride();
	if (o !== null) return o ? "on" : "off";
	const v = process.env.LEAN_RAIL;
	return v === "on" || v === "shadow" ? v : "off";
}

/** ×2²⁰ — the same quantisation scale `compare-rail` and the HSMM shadow use.
 *  The gate is only the judge of what `on` serves if both send the identical
 *  integer graph, so this constant must not drift from the referee's. */
export const RAIL_Q = 1 << 20;

/** Quantised adjacency: `[to, weight]` pairs, in the TS builder's per-vertex
 *  insertion order. Order is preserved deliberately — it is what a tie-parity
 *  claim between the two searches rests on. */
export type QRailAdj = Array<Array<[number, number]>>;

export function quantiseRailAdj(adj: ReadonlyArray<ReadonlyArray<{ to: number; w: number }>>): QRailAdj {
	return adj.map((row) => row.map((e) => [e.to, Math.round(e.w * RAIL_Q)] as [number, number]));
}

/** Cost of a vertex sequence over the quantised graph, taking the cheapest
 *  parallel edge per step (mirrors the Lean `pathCost` spec, and the referee in
 *  `compare-rail`). `null` when some step has no connecting edge. */
export function railPathCostQ(qadj: QRailAdj, p: readonly number[]): number | null {
	let total = 0;
	for (let i = 1; i < p.length; i++) {
		let best: number | null = null;
		for (const [to, w] of qadj[p[i - 1]] ?? []) {
			if (to === p[i] && (best === null || w < best)) best = w;
		}
		if (best === null) return null;
		total += best;
	}
	return total;
}

/** Digest of the quantised graph and its endpoints. A rail graph is built from
 *  real journeys, so — like `legFingerprint` — the ledger names a divergence by
 *  a digest rather than printing coordinates into a log. */
export function graphFingerprint(qadj: QRailAdj, src: number, dst: number): string {
	const h = createHash("sha256");
	h.update(`${src}>${dst}|`);
	for (const row of qadj) {
		for (const [to, w] of row) h.update(`${to},${w};`);
		h.update("/");
	}
	return h.digest("hex").slice(0, 16);
}

interface RailStat {
	/** Successful bridge calls (the verified search ran and returned). */
	calls: number;
	/** Bridge failures caught and fallen back to TS (LeanBridgeError). */
	fails: number;
	/** Calls where the two arms returned different vertex sequences. */
	pathDiffs: number;
	/** Calls where one arm found a route and the other returned null. */
	nullFlips: number;
	/** Calls where Lean's own settled distance disagreed with the referee's
	 *  recomputed cost of Lean's own path — an internal inconsistency, far
	 *  louder than a mere tie swap. */
	costDiffs: number;
}

const empty = (): RailStat => ({ calls: 0, fails: 0, pathDiffs: 0, nullFlips: 0, costDiffs: 0 });

let stats: RailStat = empty();

export function leanRailStats(): Readonly<RailStat> {
	return stats;
}

export interface RailDivergence {
	/** Digest of the quantised graph + endpoints. */
	graph: string;
	/** Vertex counts of each arm's path, or -1 for a null result. */
	tsLen: number;
	leanLen: number;
	/** Quantised cost of each arm's path over the SAME quantised graph — the
	 *  number that says whether a divergence is a tie or a real defect. */
	tsCost: number | null;
	leanCost: number | null;
	scope: LeanRunScope;
}

/** Bound the record so a pathological run cannot grow it without limit; the
 *  counters above stay exact regardless. */
const MAX_DIVERGENCES = 50;
let divergences: RailDivergence[] = [];

export function leanRailDivergences(): readonly RailDivergence[] {
	return divergences;
}

export function resetLeanRailStats(): void {
	stats = empty();
	divergences = [];
}

const eqPath = (a: readonly number[], b: readonly number[]): boolean =>
	a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Shortest path over a rail graph through the verified core, staged behind
 * `LEAN_RAIL`. `tsPath` is the output the call site already computed with
 * `shortestPath(graph, from, to)`. Both `shadow` and `on` run the verified
 * search and compare; `shadow` serves `tsPath`, `on` serves the verified
 * sequence. Any bridge failure is recorded and falls back to `tsPath`
 * (swallow-over-wrong, execution edition).
 */
export function shortestPathViaLean(
	graph: RailGraph,
	from: number,
	to: number,
	tsPath: number[] | null,
): number[] | null {
	const mode = leanRailMode();
	if (mode === "off") return tsPath;

	const qadj = quantiseRailAdj(graph.adj);
	let lean: LeanRailResp;
	try {
		lean = leanRailServe({ adj: qadj, src: from, dst: to });
	} catch (e) {
		if (!(e instanceof LeanBridgeError)) throw e;
		stats.fails += 1;
		return tsPath;
	}
	if (lean.error !== undefined) {
		stats.fails += 1;
		return tsPath;
	}
	stats.calls += 1;

	const leanPath = lean.none === true || lean.path === undefined ? null : lean.path;

	// Lean's settled distance must equal the referee's recomputed cost of
	// Lean's OWN path. This is not a TS-vs-Lean question — it is the verified
	// arm checked against the spec the proof is about, so a mismatch means the
	// bridge or the quantisation is wrong, not that the two searches disagree.
	let leanCost: number | null = null;
	if (leanPath !== null) {
		leanCost = railPathCostQ(qadj, leanPath);
		if (lean.dist !== undefined && leanCost !== lean.dist) stats.costDiffs += 1;
	}

	const record = (): void => {
		if (divergences.length >= MAX_DIVERGENCES) return;
		divergences.push({
			graph: graphFingerprint(qadj, from, to),
			tsLen: tsPath === null ? -1 : tsPath.length,
			leanLen: leanPath === null ? -1 : leanPath.length,
			tsCost: tsPath === null ? null : railPathCostQ(qadj, tsPath),
			leanCost,
			scope: leanRunScope(),
		});
	};

	if ((tsPath === null) !== (leanPath === null)) {
		stats.nullFlips += 1;
		record();
		if (mode === "shadow") {
			console.warn(`[lean-rail] null-flip (ts=${tsPath === null ? "null" : "path"} n=${graph.vertices.length})`);
		}
	} else if (tsPath !== null && leanPath !== null && !eqPath(tsPath, leanPath)) {
		stats.pathDiffs += 1;
		record();
		if (mode === "shadow") {
			console.warn(`[lean-rail] path divergence ts=${tsPath.length}v lean=${leanPath.length}v`);
		}
	}

	return mode === "on" ? leanPath : tsPath;
}

/**
 * Print the rail ledger and reset it. Mirrors `logLeanPassLedger` /
 * `logLeanMatchLedger` in `decode-day`, but lives here because the rail search
 * runs from the route-cache fill rather than from the decode.
 *
 * A divergence has no accepted-delta manifest yet, deliberately: `compare-rail`
 * is EXACT on every fixture in both directions, so there is nothing to accept.
 * The first real one should read loud and be adjudicated, not pre-blessed.
 */
export function logLeanRailLedger(label: string): void {
	const mode = leanRailMode();
	if (mode === "off") return;
	const s = stats;
	const clean = s.pathDiffs === 0 && s.nullFlips === 0 && s.costDiffs === 0;
	const verdict = clean ? "EXACT" : `${s.pathDiffs + s.nullFlips + s.costDiffs} DIVERGED`;
	const detail = clean ? "" : ` — path=${s.pathDiffs} null=${s.nullFlips} cost=${s.costDiffs}`;
	const legs =
		divergences.length === 0
			? ""
			: ` — ${divergences
					.map((d) => `[${d.scope}] graph=${d.graph} ts=${d.tsLen}v/${d.tsCost} lean=${d.leanLen}v/${d.leanCost}`)
					.join("; ")}`;
	console.log(
		`lean-rail[${mode}] ${label} ${s.calls}/${s.fails}f${s.calls === 0 ? " (no calls)" : ""}${detail} ${verdict}${legs}`,
	);
	resetLeanRailStats();
}
