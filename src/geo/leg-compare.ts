/**
 * Per-leg float↔quant comparison, shared by the `compare-match` gate and the
 * production matcher ledger (`src/lean/lean-match.ts`).
 *
 * One definition, deliberately: the gate's verdict on a leg and production's
 * verdict on the same leg have to be the same verdict, or adjudicating a
 * production divergence against the gate's manifest is theatre. Kept free of
 * matcher/OSM/child-process imports so the request path can use it.
 *
 * Structural parameter types (rather than `WalkMatchResult` / `QWalkMatchResult`)
 * keep it that way and let the Lean bridge pass its own decoded rows.
 */

import { createHash } from "node:crypto";
import { type QPt, quantPt } from "./quant-twin.js";

/** Per-leg float↔quant verdict: identical, within the NEAR tolerance, or a
 *  genuine difference. */
export type LegClass = "EXACT" | "NEAR" | "DIFF";

/** 30 cm in 1e-7° latitude units — the NEAR coordinate tolerance. */
const NEAR_UNITS = 30n;

interface FloatArm {
	coarsePath: ReadonlyArray<{ lat: number; lon: number; ts: number }>;
	path: ReadonlyArray<{ lat: number; lon: number; ts: number }>;
}
interface QuantArm {
	coarsePath: readonly QPt[];
	path: readonly QPt[];
}

function comparePaths(float: FloatArm["path"], quant: readonly QPt[]): LegClass {
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
export function legClasses(float: FloatArm | null, quant: QuantArm | null): { coarse: LegClass; path: LegClass } {
	if (float === null || quant === null) {
		const cls: LegClass = float === quant ? "EXACT" : "DIFF";
		return { coarse: cls, path: cls };
	}
	return {
		coarse: comparePaths(float.coarsePath, quant.coarsePath),
		path: comparePaths(float.path, quant.path),
	};
}

/** Canonical vertex-count fingerprint of a leg's two matcher arms — the
 *  manifest `note` for a diverging leg, stable across runs. */
export function legNote(
	float: { coarsePath: readonly unknown[]; path: readonly unknown[] } | null,
	quant: { coarsePath: readonly unknown[]; path: readonly unknown[] } | null,
): string {
	const c = (
		r: { coarsePath: readonly unknown[]; path: readonly unknown[] } | null,
		k: "coarsePath" | "path",
	): string => (r === null ? "null" : `${r[k].length}v`);
	return `coarse ${c(float, "coarsePath")} vs ${c(quant, "coarsePath")}, path ${c(float, "path")} vs ${c(quant, "path")}`;
}

/**
 * Intrinsic identity of a matcher leg: a digest of its quantised input fixes.
 *
 * The manifest was keyed by golden day + leg start `hh:mm`, which works for the
 * gate (it replays golden days) but is useless in production, which decodes
 * live days the corpus does not contain — every live divergence would miss the
 * manifest and read UNEXPLAINED. Keying on the leg's own input instead lets ONE
 * rule adjudicate both, the way `accepted-deltas.ts` already keys the geometry
 * passes on `op|n|note` with no date.
 *
 * A digest rather than a coordinate: two short legs can share a fix count and a
 * vertex signature, and a route-choice flip silently auto-accepted by collision
 * is exactly what this manifest exists to prevent. It also keeps raw positions
 * — which are the user's movements — out of a committed file.
 *
 * Computed from the SAME `quantPt` rows both arms are fed, so the gate and the
 * request path derive the same key from the same leg.
 */
export function legFingerprint(fixes: ReadonlyArray<{ lat: number; lon: number; ts: number }>): string {
	const h = createHash("sha256");
	for (const f of fixes) {
		const q = quantPt(f);
		h.update(`${q.la},${q.lo},${q.ts};`);
	}
	return h.digest("hex").slice(0, 16);
}
