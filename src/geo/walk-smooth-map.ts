/**
 * Continuous MAP walk-path reconstruction — the smart replacement for the
 * discrete Viterbi snap (`pedestrian-match.ts`) and its post-hoc geometric
 * cleanups (`docs/proposals/2026-07-true-path-reconstruction.md`, Phase 1).
 *
 * # The idea
 *
 * A walk is drawn as the maximum-a-posteriori continuous trajectory `x(t)` — the
 * single most probable path given all the evidence — rather than the cheapest
 * network path that touches the GPS dots. Three factors are fused:
 *
 *   1. **GPS emission (accuracy-weighted)** — each state is pulled toward its raw
 *      fix with a weight `1/σ²` from the fix's reported accuracy, so a precise
 *      fix anchors hard and a noisy one barely tugs (the constant-σ Viterbi threw
 *      this away).
 *   2. **Smoothness / physics prior** — the discrete second difference
 *      `xᵢ₋₁ − 2xᵢ + xᵢ₊₁` is penalised, so the path has low curvature: GPS jitter
 *      is absorbed and corners are *cut* into natural diagonals instead of the
 *      right-angle staircases a graph snap produces.
 *   3. **Soft network adherence** — each state is softly attracted to the nearest
 *      walkable surface. SOFT, not a hard snap: balanced against the GPS term the
 *      line settles *between* the raw fix and the pavement centreline — i.e. on
 *      the pavement at the walked offset — never yanked onto the wrong parallel
 *      way, and never routed around a block to reach a graph vertex.
 *
 * Because the result is continuous, smooth, and only softly map-attracted, the
 * artifacts the cleanup passes chase (invented out-and-back detours, apex
 * spikes, right-angle staircases) never form — they are low-probability under
 * the model, so there is nothing to excise.
 *
 * # The solve
 *
 * All three factors are quadratic in the state positions once the network
 * attractor targets `tᵢ` are fixed, so each outer iteration is a linear least
 * squares. The two coordinates (east, north, in a local metric frame) decouple,
 * and the normal matrix is symmetric positive-definite and pentadiagonal — the
 * GPS + network terms on the diagonal, the smoothness term's biharmonic stencil
 * in the band. Solved per coordinate by Jacobi-preconditioned conjugate
 * gradient. The attractor targets are recomputed from the current estimate each
 * outer iteration (an ICP-style alternation), a handful of which converges.
 *
 * Pure and deterministic: geometry in, path out, no DB or network. O(F·iters)
 * plus the nearest-way scan; far cheaper than the Viterbi's per-transition
 * Dijkstra routing.
 */

import { metersBetween, projectPointToSegment, type RoadGeometry } from "./map-match-core.js";

/** One GPS fix to reconstruct. `accuracyM` is the reported horizontal accuracy
 *  (metres); when absent the profile fallback σ is used. */
export interface WalkFix {
	lat: number;
	lon: number;
	ts: number;
	accuracyM?: number;
}

/** One reconstructed path vertex with its (fix) timestamp. */
export interface SmoothedPoint {
	lat: number;
	lon: number;
	ts: number;
}

/** Tuning for {@link smoothWalkMap}. All σ are in metres; a weight is `1/σ²`, so
 *  a SMALLER σ means that factor is trusted MORE. */
export interface MapSmoothProfile {
	/** Below this many fixes there is nothing to smooth — return null. */
	minFixes: number;
	/** Fallback GPS σ (m) for a fix with no reported accuracy. */
	gpsSigmaFallbackM: number;
	/** Floor on the GPS σ (m) — a suspiciously tiny reported accuracy can't be
	 *  allowed to anchor a state infinitely hard. */
	gpsSigmaMinM: number;
	/** Smoothness σ (m): the scale of the tolerated second difference. Smaller →
	 *  stiffer, straighter path; larger → follows the GPS more closely. */
	smoothSigmaM: number;
	/** Network σ (m): how tightly to hug the walkable surface. Smaller → snaps
	 *  harder onto the pavement; larger → trusts the GPS offset more. */
	networkSigmaM: number;
	/** Only attract a state to the walkable surface when the nearest way is within
	 *  this radius (m); beyond it the state is on open ground and left to GPS +
	 *  smoothness. Guards against snapping to a far, wrong parallel way. */
	networkRadiusM: number;
	/** Outer ICP iterations (attractor re-linearisation). */
	iterations: number;
}

/** Starting profile — tuned against `score-walk-match` before wiring. Trusts the
 *  smoothness and network priors a little more than the raw GPS, which is what
 *  removes jitter and hugs the pavement without over-snapping. */
export const DEFAULT_MAP_SMOOTH_PROFILE: MapSmoothProfile = {
	minFixes: 4,
	gpsSigmaFallbackM: 15,
	gpsSigmaMinM: 4,
	smoothSigmaM: 6,
	networkSigmaM: 12,
	networkRadiusM: 25,
	iterations: 6,
};

interface Pt {
	lat: number;
	lon: number;
}

/** Nearest point on any walkable way to `p`, with its distance (m); null when the
 *  network is empty. Brute force with early exit — the way count is modest and
 *  this beats building an index for a one-shot per-leg solve. */
function nearestWalkablePoint(p: Pt, geo: RoadGeometry): { lat: number; lon: number; distM: number } | null {
	let best: { lat: number; lon: number; distM: number } | null = null;
	for (const w of geo.ways) {
		for (let i = 1; i < w.coords.length; i++) {
			const a = { lat: w.coords[i - 1][0], lon: w.coords[i - 1][1] };
			const b = { lat: w.coords[i][0], lon: w.coords[i][1] };
			const proj = projectPointToSegment(p, a, b);
			if (best === null || proj.distM < best.distM) best = { lat: proj.lat, lon: proj.lon, distM: proj.distM };
		}
	}
	return best;
}

/**
 * Apply the SPD normal matrix `A = diag(d) + wAcc·LᵀL` to a vector, matrix-free,
 * where `L` is the second-difference (biharmonic) stencil `[1, −2, 1]`. `d` is
 * the combined GPS + network diagonal.
 */
function applyA(v: Float64Array, d: Float64Array, wAcc: number): Float64Array {
	const n = v.length;
	const out = new Float64Array(n);
	for (let i = 0; i < n; i++) out[i] = d[i] * v[i];
	// Lv has length n-2: (Lv)[k] = v[k] − 2v[k+1] + v[k+2].
	for (let k = 0; k + 2 < n; k++) {
		const lv = wAcc * (v[k] - 2 * v[k + 1] + v[k + 2]);
		// Scatter LᵀLv: this residual touches rows k (+1), k+1 (−2), k+2 (+1).
		out[k] += lv;
		out[k + 1] -= 2 * lv;
		out[k + 2] += lv;
	}
	return out;
}

/** Diagonal of `A = diag(d) + wAcc·LᵀL`, for Jacobi preconditioning. The
 *  biharmonic stencil contributes 1/5/6/5/1 down the band. */
function diagOfA(d: Float64Array, wAcc: number): Float64Array {
	const n = d.length;
	const out = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		let ltl = 0;
		if (i <= n - 3) ltl += 1; // stencil k=i, coefficient on row i is +1
		if (i - 1 >= 0 && i - 1 <= n - 3) ltl += 4; // k=i-1, coefficient −2
		if (i - 2 >= 0 && i - 2 <= n - 3) ltl += 1; // k=i-2, coefficient +1
		out[i] = d[i] + wAcc * ltl;
	}
	return out;
}

/** Solve the SPD system `A x = b` (A = diag(d) + wAcc·LᵀL) by Jacobi-
 *  preconditioned conjugate gradient. `x0` seeds the iterate. */
function solvePCG(d: Float64Array, wAcc: number, b: Float64Array, x0: Float64Array): Float64Array {
	const n = b.length;
	const invDiag = diagOfA(d, wAcc);
	for (let i = 0; i < n; i++) invDiag[i] = 1 / invDiag[i];
	const x = new Float64Array(n);
	x.set(x0);
	// r = b − A x
	const ax0 = applyA(x, d, wAcc);
	const r = new Float64Array(n);
	for (let i = 0; i < n; i++) r[i] = b[i] - ax0[i];
	const z = new Float64Array(n);
	for (let i = 0; i < n; i++) z[i] = invDiag[i] * r[i];
	const p = new Float64Array(n);
	p.set(z);
	let rz = 0;
	for (let i = 0; i < n; i++) rz += r[i] * z[i];

	let bNorm = 0;
	for (let i = 0; i < n; i++) bNorm += b[i] * b[i];
	const tol2 = Math.max(1e-18, bNorm * 1e-14);

	const maxIter = Math.min(2 * n + 50, 2000);
	for (let it = 0; it < maxIter; it++) {
		const ap = applyA(p, d, wAcc);
		let pap = 0;
		for (let i = 0; i < n; i++) pap += p[i] * ap[i];
		if (pap <= 0) break; // numerical guard (A is SPD, so this is only round-off)
		const alpha = rz / pap;
		for (let i = 0; i < n; i++) {
			x[i] += alpha * p[i];
			r[i] -= alpha * ap[i];
		}
		let rNorm = 0;
		for (let i = 0; i < n; i++) rNorm += r[i] * r[i];
		if (rNorm <= tol2) break;
		for (let i = 0; i < n; i++) z[i] = invDiag[i] * r[i];
		let rzNew = 0;
		for (let i = 0; i < n; i++) rzNew += r[i] * z[i];
		const beta = rzNew / rz;
		for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
		rz = rzNew;
	}
	return x;
}

/**
 * Reconstruct a walk leg as the MAP continuous trajectory under GPS emission,
 * a smoothness/physics prior, and soft walkable-surface adherence. Returns the
 * smoothed path (one vertex per fix, timestamps preserved), or null when the leg
 * is too short. Never throws; deterministic.
 */
export function smoothWalkMap(
	fixes: readonly WalkFix[],
	walkable: RoadGeometry,
	profile: MapSmoothProfile = DEFAULT_MAP_SMOOTH_PROFILE,
): SmoothedPoint[] | null {
	const n = fixes.length;
	if (n < profile.minFixes) return null;

	// Local equirectangular frame (metres) anchored at the first fix.
	const lat0 = fixes[0].lat;
	const lon0 = fixes[0].lon;
	const cosLat = Math.cos((lat0 * Math.PI) / 180);
	const toE = (lon: number) => (lon - lon0) * 111_320 * cosLat;
	const toN = (lat: number) => (lat - lat0) * 111_320;
	const toLon = (e: number) => lon0 + e / (111_320 * cosLat);
	const toLat = (nMet: number) => lat0 + nMet / 111_320;

	const ze = new Float64Array(n);
	const zn = new Float64Array(n);
	const wGps = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		ze[i] = toE(fixes[i].lon);
		zn[i] = toN(fixes[i].lat);
		const sigma = Math.max(profile.gpsSigmaMinM, fixes[i].accuracyM ?? profile.gpsSigmaFallbackM);
		wGps[i] = 1 / (sigma * sigma);
	}
	const wAcc = 1 / (profile.smoothSigmaM * profile.smoothSigmaM);
	const wNetFull = 1 / (profile.networkSigmaM * profile.networkSigmaM);

	// Initialise the estimate at the raw fixes.
	let e: Float64Array = new Float64Array(n);
	e.set(ze);
	let nn: Float64Array = new Float64Array(n);
	nn.set(zn);

	for (let iter = 0; iter < profile.iterations; iter++) {
		// Re-linearise the network attractor at the current estimate.
		const d = new Float64Array(n);
		const be = new Float64Array(n);
		const bn = new Float64Array(n);
		for (let i = 0; i < n; i++) {
			d[i] = wGps[i];
			be[i] = wGps[i] * ze[i];
			bn[i] = wGps[i] * zn[i];
			if (walkable.ways.length > 0) {
				const cur = { lat: toLat(nn[i]), lon: toLon(e[i]) };
				const near = nearestWalkablePoint(cur, walkable);
				if (near && near.distM <= profile.networkRadiusM) {
					d[i] += wNetFull;
					be[i] += wNetFull * toE(near.lon);
					bn[i] += wNetFull * toN(near.lat);
				}
			}
		}
		e = solvePCG(d, wAcc, be, e);
		nn = solvePCG(d, wAcc, bn, nn);
	}

	const out: SmoothedPoint[] = [];
	for (let i = 0; i < n; i++) out.push({ lat: toLat(nn[i]), lon: toLon(e[i]), ts: fixes[i].ts });
	return out;
}

/**
 * Profile for refining an already map-matched line (Phase 1, "both-staged"):
 * the attractor is the vetted matched path itself (a single corridor), not the
 * raw walkable network — so there is no wrong-parallel-way to flip onto. GPS
 * emission + smoothness then ROUND the boxy right-angle staircases and spikes a
 * graph snap leaves, while the matched-corridor pull keeps the line on-route.
 * The network σ is deliberately loose so the corners can round; it is the raw
 * GPS that says where the true diagonal was.
 */
export const REFINE_MATCHED_PROFILE: MapSmoothProfile = {
	minFixes: 4,
	gpsSigmaFallbackM: 12,
	gpsSigmaMinM: 4,
	smoothSigmaM: 5,
	networkSigmaM: 14,
	networkRadiusM: 45,
	iterations: 6,
};

/**
 * Refine an already map-matched walk line: round its corners toward where the
 * raw GPS actually was, using the matched path itself as the on-route corridor.
 * Returns null when the matched path or the fix count is too thin to refine.
 *
 * This is the robust half of the continuous smoother — by attracting to the one
 * vetted line rather than the whole walkable network it keeps the matcher's
 * route-faithfulness while gaining the smoother's natural geometry.
 */
export function refineMatchedPath(
	fixes: readonly WalkFix[],
	matchedPath: ReadonlyArray<{ lat: number; lon: number }>,
	profile: MapSmoothProfile = REFINE_MATCHED_PROFILE,
	maxDeviationM = 12,
): SmoothedPoint[] | null {
	if (matchedPath.length < 2) return null;
	const corridor: RoadGeometry = {
		ways: [{ osmId: 0, name: null, subtype: null, coords: matchedPath.map((p) => [p.lat, p.lon]) }],
	};
	const smoothed = smoothWalkMap(fixes, corridor, profile);
	if (!smoothed) return null;

	// Faithfulness clamp — the vetted matched line is on the pavement and
	// route-faithful; the refinement's ONLY licence is to round its boxy corners
	// toward the GPS, NOT to wander off it. Any vertex that strays past
	// maxDeviationM is pulled radially back to the clamp radius, so a corner-cut
	// survives (small deviation) while a block-crossing excursion (the raw-GPS
	// noise the off-walkable scorer punishes) is capped at the matched corridor.
	return smoothed.map((p) => {
		const near = nearestWalkablePoint(p, corridor);
		if (!near || near.distM <= maxDeviationM) return p;
		const f = maxDeviationM / near.distM;
		return {
			lat: near.lat + (p.lat - near.lat) * f,
			lon: near.lon + (p.lon - near.lon) * f,
			ts: p.ts,
		};
	});
}

/**
 * Count the sharp direction changes in a polyline — turns of at least
 * `thresholdDeg`. This is the de-boxing witness the off-walkable metric is blind
 * to: a graph-snapped line is full of ~90° staircase corners the true walk cut
 * across; the refinement should drop this count while keeping the line on-route.
 * A near-straight vertex (small turn) doesn't count. Pure.
 */
export function countSharpTurns(pts: readonly Pt[], thresholdDeg = 50): number {
	if (pts.length < 3) return 0;
	let count = 0;
	for (let i = 1; i < pts.length - 1; i++) {
		const cl = Math.cos((pts[i].lat * Math.PI) / 180);
		const ux = (pts[i].lon - pts[i - 1].lon) * cl;
		const uy = pts[i].lat - pts[i - 1].lat;
		const vx = (pts[i + 1].lon - pts[i].lon) * cl;
		const vy = pts[i + 1].lat - pts[i].lat;
		const un = Math.hypot(ux, uy);
		const vn = Math.hypot(vx, vy);
		if (un < 1e-12 || vn < 1e-12) continue;
		const turnDeg = (Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (un * vn)))) * 180) / Math.PI;
		if (turnDeg >= thresholdDeg) count++;
	}
	return count;
}

/** Straight-line-normalised path length (drawn ÷ end-to-end). Exposed for the
 *  referee and tests — the smoother's headline effect is a lower tortuosity. */
export function tortuosity(pts: readonly Pt[]): number {
	if (pts.length < 2) return 1;
	let len = 0;
	for (let i = 1; i < pts.length; i++) len += metersBetween(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
	const straight = metersBetween(pts[0].lat, pts[0].lon, pts[pts.length - 1].lat, pts[pts.length - 1].lon);
	return straight > 1 ? len / straight : 1;
}
