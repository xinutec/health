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

/**
 * Per-leg float↔quant verdict: identical, within the NEAR tolerance, or a
 * genuine difference.
 *
 * `NEAR` means the two arms drew the SAME LINE — every point of each within
 * ~33 cm of the other — whether or not they sampled it with the same number of
 * vertices. `DIFF` means the line moved. The vertex count is not itself the
 * question (#396); it was until 2026-07-31, and that put a redundant collinear
 * vertex in the same class as a 120 m reroute.
 */
export type LegClass = "EXACT" | "NEAR" | "DIFF";

/** 30 cm in 1e-7° latitude units — the NEAR coordinate tolerance. */
const NEAR_UNITS = 30n;

/** Metres per degree of latitude. Good to ~0.2% anywhere; the bar it scales is
 *  a third of a metre, so the ellipsoid correction is far below the noise. */
const M_PER_DEG = 111_320;

/** The same NEAR bar as a distance, for the polyline comparison below. Derived
 *  from `NEAR_UNITS` rather than written twice — a leg must not be able to pass
 *  one form of the tolerance and fail the other. ~0.33 m. */
const NEAR_DEVIATION_M = Number(NEAR_UNITS) * 1e-7 * M_PER_DEG;

interface LL {
	lat: number;
	lon: number;
}

/** Metres between two points, equirectangular — exact enough over a walk leg. */
function metres(a: LL, b: LL): number {
	const dLat = (b.lat - a.lat) * M_PER_DEG;
	const dLon = (b.lon - a.lon) * M_PER_DEG * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
	return Math.hypot(dLat, dLon);
}

/** Shortest distance in metres from `p` to the segment `a`–`b`. */
function distToSegment(p: LL, a: LL, b: LL): number {
	const k = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
	const ax = a.lon * k;
	const ay = a.lat;
	const bx = b.lon * k;
	const by = b.lat;
	const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
	if (len2 === 0) return metres(p, a);
	const px = p.lon * k;
	const py = p.lat;
	const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / len2));
	return metres(p, { lat: ay + t * (by - ay), lon: (ax + t * (bx - ax)) / k });
}

/**
 * Greatest distance from any vertex of `from` to the polyline `to`.
 *
 * Exported because the DIRECTION carries information the symmetric figure
 * hides: on leg 71e5544efa614a06 the float line strayed 63.7 m from the quant
 * line while the quant line strayed only 7.8 m from float's — the signature of
 * an excursion present in one arm and absent from the other. `compare-match
 * --leg` prints both. For classification use {@link polylineDeviationM}.
 */
export function maxDeviationM(from: readonly LL[], to: readonly LL[]): number {
	if (to.length === 0) return Number.POSITIVE_INFINITY;
	if (to.length === 1) return Math.max(...from.map((p) => metres(p, to[0])));
	let worst = 0;
	for (const p of from) {
		let best = Number.POSITIVE_INFINITY;
		for (let i = 1; i < to.length; i++) best = Math.min(best, distToSegment(p, to[i - 1], to[i]));
		if (best > worst) worst = best;
	}
	return worst;
}

/**
 * The furthest either polyline strays from the other, in metres.
 *
 * SYMMETRIC deliberately. One-way deviation is not a distance between lines: a
 * truncated arm lies exactly on top of the complete one, so `truncated → full`
 * is 0 while the lines disagree about most of the leg. Taking the max of both
 * directions makes a missing tail as loud as a detour.
 */
export function polylineDeviationM(a: readonly LL[], b: readonly LL[]): number {
	if (a.length === 0 || b.length === 0) return a.length === b.length ? 0 : Number.POSITIVE_INFINITY;
	return Math.max(maxDeviationM(a, b), maxDeviationM(b, a));
}

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
	if (qf.length !== quant.length) {
		// A different vertex COUNT is not by itself a different LINE (#396).
		// Returning DIFF here unconditionally put a redundant collinear vertex
		// (leg 5acb9ecb0d6ea26f: two polylines 0.01 m apart) in the same class as
		// a 120 m corridor change that flipped `matchImprovesDisplay` and made
		// production draw raw GPS (leg 71e5544efa614a06, #398). The manifest then
		// recorded both under one label and the ledger could not say which had
		// been served.
		//
		// So measure. Within the same NEAR bar the equal-count branch uses, two
		// differently-sampled polylines of the same route are NEAR; anything that
		// moves the line further stays DIFF.
		//
		// `ts` is deliberately not compared here: with no vertex correspondence
		// there is nothing to compare it against. A leg whose geometry matches
		// but whose timestamps have shifted is therefore NEAR by this branch —
		// acceptable because the display splice is what varies in vertex count,
		// and its timestamps are interpolated within the coarse chord window.
		const dev = polylineDeviationM(
			float,
			quant.map((p) => ({ lat: Number(p.la) / 1e7, lon: Number(p.lo) / 1e7 })),
		);
		return dev <= NEAR_DEVIATION_M ? "NEAR" : "DIFF";
	}
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
