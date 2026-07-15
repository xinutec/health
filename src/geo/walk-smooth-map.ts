/**
 * Continuous MAP walk-path reconstruction — the smart replacement for the
 * discrete Viterbi snap (`pedestrian-match.ts`) and its post-hoc geometric
 * cleanups (`docs/proposals/geometry-roadmap.md`, Phase 1).
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
import { routeChordAroundBuildings } from "./walk-building-escape.js";

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
 * Apply the SPD normal matrix `A = diag(d) + wAcc·LᵀL + wEdge·D₁ᵀD₁` to a
 * vector, matrix-free, where `L` is the second-difference (biharmonic) stencil
 * `[1, −2, 1]` and `D₁` the first-difference stencil `[−1, 1]`. `d` is the
 * combined GPS + network diagonal; `wEdge` (default 0 = absent) is the uniform
 * edge weight of the step-magnitude contraction factor.
 */
function applyA(v: Float64Array, d: Float64Array, wAcc: number, wEdge = 0): Float64Array {
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
	if (wEdge > 0) {
		// Scatter D₁ᵀD₁v: edge k couples rows k (−) and k+1 (+).
		for (let k = 0; k + 1 < n; k++) {
			const f = wEdge * (v[k + 1] - v[k]);
			out[k] -= f;
			out[k + 1] += f;
		}
	}
	return out;
}

/** Diagonal of `A = diag(d) + wAcc·LᵀL + wEdge·D₁ᵀD₁`, for Jacobi
 *  preconditioning. The biharmonic stencil contributes 1/5/6/5/1 down the band;
 *  the first-difference stencil contributes 1/2/…/2/1. */
function diagOfA(d: Float64Array, wAcc: number, wEdge = 0): Float64Array {
	const n = d.length;
	const out = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		let ltl = 0;
		if (i <= n - 3) ltl += 1; // stencil k=i, coefficient on row i is +1
		if (i - 1 >= 0 && i - 1 <= n - 3) ltl += 4; // k=i-1, coefficient −2
		if (i - 2 >= 0 && i - 2 <= n - 3) ltl += 1; // k=i-2, coefficient +1
		let d1 = 0;
		if (i <= n - 2) d1 += 1; // edge i touches row i
		if (i >= 1) d1 += 1; // edge i-1 touches row i
		out[i] = d[i] + wAcc * ltl + wEdge * d1;
	}
	return out;
}

/** Solve the SPD system `A x = b` (A = diag(d) + wAcc·LᵀL + wEdge·D₁ᵀD₁) by
 *  Jacobi-preconditioned conjugate gradient. `x0` seeds the iterate. */
function solvePCG(d: Float64Array, wAcc: number, b: Float64Array, x0: Float64Array, wEdge = 0): Float64Array {
	const n = b.length;
	const invDiag = diagOfA(d, wAcc, wEdge);
	for (let i = 0; i < n; i++) invDiag[i] = 1 / invDiag[i];
	const x = new Float64Array(n);
	x.set(x0);
	// r = b − A x
	const ax0 = applyA(x, d, wAcc, wEdge);
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
		const ap = applyA(p, d, wAcc, wEdge);
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

/** How far (m) from a staircase-artifact corner the full de-boxing deviation
 *  budget reaches; the budget tapers linearly to the tight budget at this
 *  distance. */
const REFINE_CORNER_REACH_M = 30;
/** Two sharp corners of the matched line within this of each other are the
 *  STAIRCASE-ARTIFACT signature (a graph snap zigzagging between parallel
 *  edges) — only there does the refinement earn its full budget. An isolated
 *  sharp corner is real street geometry: the walked pavement goes AROUND it,
 *  so "rounding" it 8–12 m puts the line through the corner building. */
const REFINE_STAIRCASE_NEIGHBOR_M = 25;
/** Deviation budget (m) everywhere outside a staircase artifact — enough to
 *  soften vertex hairlines, far too little to split the difference toward GPS
 *  wobble. The 2026-07-14 morning walk measured why this must be tight: the
 *  matched line rode the correct streets at 0 m off-network and the refinement's
 *  whole-line 12 m licence redrew the mid-leg up to ~12 m off-street toward
 *  ordinary GPS wobble — a half-snap zigzag worse than the raw draw (#359). */
const REFINE_STRAIGHT_DEVIATION_M = 2.5;

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

	// The refinement's mandate is the STAIRCASE ARTIFACT — a graph snap
	// zigzagging boxy corners between parallel edges, which the fix evidence
	// consistently cuts through. Its licence to leave the matched line is
	// therefore LOCAL: the full maxDeviationM budget within reach of a CLUSTERED
	// sharp corner (one with another sharp corner ≤ REFINE_STAIRCASE_NEIGHBOR_M
	// away), tapering to a tight budget everywhere else. An isolated corner is
	// real street geometry and a whole-line budget measurably redraws the
	// straights toward ordinary GPS wobble (see REFINE_STRAIGHT_DEVIATION_M).
	const cl = Math.cos((matchedPath[0].lat * Math.PI) / 180);
	const distM = (a: { lat: number; lon: number }, b: { lat: number; lon: number }): number =>
		Math.hypot((a.lat - b.lat) * 111_320, (a.lon - b.lon) * 111_320 * cl);
	const corners: Array<{ lat: number; lon: number }> = [];
	for (let i = 1; i < matchedPath.length - 1; i++) {
		if (countSharpTurns(matchedPath.slice(i - 1, i + 2)) > 0) corners.push(matchedPath[i]);
	}
	const artifactCorners = corners.filter((c, i) =>
		corners.some((o, j) => j !== i && distM(c, o) <= REFINE_STAIRCASE_NEIGHBOR_M),
	);
	const budgetAt = (p: { lat: number; lon: number }): number => {
		let dMin = Number.POSITIVE_INFINITY;
		for (const c of artifactCorners) dMin = Math.min(dMin, distM(p, c));
		const t = Math.min(1, dMin / REFINE_CORNER_REACH_M);
		return maxDeviationM + (REFINE_STRAIGHT_DEVIATION_M - maxDeviationM) * t;
	};

	// Faithfulness clamp — the vetted matched line is on the pavement and
	// route-faithful. Any vertex past its local budget is pulled radially back to
	// the budget radius, so a corner-cut survives (near-corner, full budget)
	// while a straight stretch stays on the line and a block-crossing excursion
	// (the raw-GPS noise the off-walkable scorer punishes) is capped everywhere.
	const clamped = smoothed.map((p) => {
		const near = nearestWalkablePoint(p, corridor);
		const budget = budgetAt(p);
		if (!near || near.distM <= budget) return p;
		const f = budget / near.distM;
		return {
			lat: near.lat + (p.lat - near.lat) * f,
			lon: near.lon + (p.lon - near.lon) * f,
			ts: p.ts,
		};
	});

	// Splice back skipped route vertices (#361). The smoother resamples the
	// matched line one-vertex-per-FIX, so a route corner with no fix near it (a
	// street junction the GPS wobble skipped past) vanishes from the output and
	// the chord between the neighbouring vertices cuts the block — a defect the
	// per-vertex clamp above is structurally blind to (every VERTEX is on-route;
	// the EDGE shortcuts). Re-insert every matched vertex that lies between two
	// consecutive output vertices (by arclength along the matched line) and
	// deviates from their chord by more than ITS OWN local budget: a real
	// junction corner (tight budget) is always restored; a staircase-artifact
	// zigzag vertex (full budget) stays cut — the de-boxing mandate.
	const toXY = (p: { lat: number; lon: number }): [number, number] => [
		(p.lon - matchedPath[0].lon) * 111_320 * cl,
		(p.lat - matchedPath[0].lat) * 111_320,
	];
	const cum: number[] = [0];
	for (let i = 1; i < matchedPath.length; i++) cum.push(cum[i - 1] + distM(matchedPath[i - 1], matchedPath[i]));
	// Arclength of the nearest point on the matched line to `p`.
	const arcOf = (p: { lat: number; lon: number }): number => {
		const [px, py] = toXY(p);
		let bestD = Number.POSITIVE_INFINITY;
		let bestS = 0;
		for (let i = 1; i < matchedPath.length; i++) {
			const [ax, ay] = toXY(matchedPath[i - 1]);
			const [bx, by] = toXY(matchedPath[i]);
			const dx = bx - ax;
			const dy = by - ay;
			const len2 = dx * dx + dy * dy || 1e-9;
			const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
			const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
			if (d < bestD) {
				bestD = d;
				bestS = cum[i - 1] + Math.sqrt(len2) * t;
			}
		}
		return bestS;
	};
	const chordDistM = (
		v: { lat: number; lon: number },
		a: { lat: number; lon: number },
		b: { lat: number; lon: number },
	): number => {
		const [px, py] = toXY(v);
		const [ax, ay] = toXY(a);
		const [bx, by] = toXY(b);
		const dx = bx - ax;
		const dy = by - ay;
		const len2 = dx * dx + dy * dy || 1e-9;
		const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
		return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
	};
	const arcs = clamped.map(arcOf);
	// First pass: which route vertices does each gap owe? A gap's endpoints get
	// SNAPPED onto the route when it receives an insertion — a restored corner
	// entered and left from 2.5 m beside the line would otherwise kink at the
	// seams (measured: +3 sharp turns on the isolated-corner scene).
	//
	// BOUNDED DETOUR ONLY: a restored right-angle corner lengthens the chord by
	// at most ~√2, so a gap whose insertions would grow it beyond
	// SPLICE_MAX_LEN_RATIO is NOT a skipped corner — it is a matcher route spur
	// or a mis-projection on a self-overlapping route, exactly the artifacts the
	// trim pass removes; reinstating one measured stall 11→300 m with 103 m of
	// building crossing on a single leg. Those gaps keep the plain chord.
	const SPLICE_MAX_LEN_RATIO = 1.6;
	const inserts: number[][] = clamped.map(() => []);
	const snapToRoute = new Set<number>();
	for (let i = 0; i + 1 < clamped.length; i++) {
		const sA = arcs[i];
		const sB = arcs[i + 1];
		// Forward progress only — never splice across a backtracking pair.
		if (sB <= sA) continue;
		const gap: number[] = [];
		for (let k = 0; k < matchedPath.length; k++) {
			if (cum[k] <= sA || cum[k] >= sB) continue;
			if (chordDistM(matchedPath[k], clamped[i], clamped[i + 1]) <= budgetAt(matchedPath[k])) continue;
			gap.push(k);
		}
		if (gap.length === 0) continue;
		const chain = [clamped[i], ...gap.map((k) => matchedPath[k]), clamped[i + 1]];
		let pathLen = 0;
		for (let k = 1; k < chain.length; k++) pathLen += distM(chain[k - 1], chain[k]);
		const chord = Math.max(1, distM(clamped[i], clamped[i + 1]));
		if (pathLen > chord * SPLICE_MAX_LEN_RATIO) continue;
		inserts[i] = gap;
		snapToRoute.add(i);
		snapToRoute.add(i + 1);
	}
	if (snapToRoute.size === 0) return clamped;
	const positioned = clamped.map((p, i) => {
		if (!snapToRoute.has(i)) return p;
		const near = nearestWalkablePoint(p, corridor);
		return near ? { lat: near.lat, lon: near.lon, ts: p.ts } : p;
	});
	const out: SmoothedPoint[] = [positioned[0]];
	for (let i = 0; i + 1 < positioned.length; i++) {
		const a = positioned[i];
		const b = positioned[i + 1];
		for (const k of inserts[i]) {
			const frac = (cum[k] - arcs[i]) / (arcs[i + 1] - arcs[i]);
			out.push({ lat: matchedPath[k].lat, lon: matchedPath[k].lon, ts: Math.round(a.ts + (b.ts - a.ts) * frac) });
		}
		out.push(b);
	}
	return out;
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

// ---------------------------------------------------------------------------
// reconstructWalk — the robust, annealed MAP reconstruction (true-path Phase 1)
// ---------------------------------------------------------------------------
//
// The upgrade over smoothWalkMap: NO input is trusted as ground truth. The plain
// smoother above is a convex weighted least-squares — it believes every fix's
// position (accuracy only changes the strength), so a tight cluster of
// confidently-wrong fixes (a post-tunnel GPS reacquire smear) still wins and the
// line detours to follow it. Measured on the corpus that is a wash: gross phantom
// detours dissolve but the line wanders off-pavement and through buildings.
//
// reconstructWalk fixes this with a SMARTER MINIMISER, not more trust in the
// numbers:
//
//   1. Redescending robust GPS emission (Geman-McClure). Past a residual scale a
//      fix's influence falls toward zero — a fix that disagrees with the CONSENSUS
//      trajectory (its temporal neighbours + the map) is rejected, not merely
//      down-weighted. Outliers are inferred from mutual inconsistency, not from
//      the reported accuracy.
//   2. Graduated Non-Convexity = deterministic annealing. The robust loss is
//      non-convex, so one solve can commit to the phantom as "inliers". We start
//      with the kernel scale c large (nearly quadratic → a broad, convex fit),
//      then geometrically anneal c down, progressively sharpening the outlier
//      rejection. Escapes the wrong basin like simulated annealing but with NO RNG
//      — the golden corpus needs reproducibility. Each inner step is the same
//      Jacobi-PCG least-squares as smoothWalkMap (IRLS on the robust weights).
//   3. Accuracy is only a weak, clamped scale prior ("use it a bit") — it sets the
//      per-fix base trust within a narrow band, never dominating; the robust
//      kernel does the real inlier/outlier work.
//   4. Map as first-class factors: soft walkable attraction (as before) PLUS a
//      one-sided BUILDING REPULSION — a state inside a footprint is pulled to its
//      nearest boundary, so a line through a house is high-energy by construction
//      (this is what turns the corpus wash into a win, subsuming the case-based
//      building corrector).
//   5. Optional ANCHOR endpoints: pin the first/last state to a confident
//      coordinate (station entrance / stay centroid) so a leg is reconstructed
//      BETWEEN known truths, not from free-floating GPS.
//
// Every factor is soft and robust; the MAP estimate is the drawn path. Pure and
// deterministic. Honest fallback (too few fixes) → null, as smoothWalkMap.

/** A soft endpoint anchor: pull a terminal state toward a confident coordinate. */
export interface WalkAnchor {
	lat: number;
	lon: number;
	/** Trust as a Gaussian σ (m); smaller pins harder. */
	sigmaM: number;
}

/** Tuning for {@link reconstructWalk}. σ are metres; weight is `1/σ²`. */
export interface ReconstructProfile {
	minFixes: number;
	/** Accuracy → weak per-fix trust: the reported accuracy is CLAMPED to this
	 *  band before becoming the base σ, so the best/worst fix differ by at most
	 *  `(max/min)²` in weight — a nudge, not a verdict. */
	accClampMinM: number;
	accClampMaxM: number;
	/** Base σ for a fix with no reported accuracy. */
	accFallbackM: number;
	/** Geman-McClure GNC schedule for the GPS emission: anneal the kernel scale
	 *  from `gncStartM` (large → convex, everything an inlier) down to
	 *  `gncTargetM` (redescending → rejects gross outliers), over `gncSteps`. */
	gncStartM: number;
	gncTargetM: number;
	gncSteps: number;
	/** IRLS / attractor re-linearisations per anneal step. */
	innerIters: number;
	/** Smoothness σ (m): scale of the tolerated second difference (physics prior).
	 *  This is what carries the path THROUGH a rejected outlier. */
	smoothSigmaM: number;
	/** Walkable-attraction σ (m) and gating radius (m). */
	networkSigmaM: number;
	networkRadiusM: number;
	/** Redescending scale (m) for the network attraction: the pull is
	 *  `wNet · gm(nearDist, networkRobustM)`, so a state CLOSE to a way is hugged
	 *  hard (matcher-like on clean GPS) while a state far from any way barely tugs
	 *  (a phantom-dissolved leg or a wrong parallel way is not yanked). This is the
	 *  hard/soft unification — adaptive by distance-to-network, not a fixed σ. */
	networkRobustM: number;
	/** Building-repulsion σ (m): weight `1/σ²` of the clearance factor. Small →
	 *  buildings are near-impassable. */
	buildingSigmaM: number;
	/** Building CLEARANCE band (m): a state is repelled to at least this far
	 *  OUTSIDE the nearest wall whenever it is inside a footprint OR within the band
	 *  outside it. A field (not just when-inside), so a chord grazing a corner is
	 *  pushed off the wall even with no vertex inside it. */
	buildingClearM: number;
	/** Densify the state chain to ≤ this spacing (m) by inserting FREE states
	 *  between fixes, so the line can bend around a building BETWEEN fixes — a
	 *  straight chord clipping a block would otherwise cross it with no vertex
	 *  inside to repel. */
	targetSpacingM: number;
	/** A FREE state gets a WEAK, non-robust tether (this σ, m) toward its
	 *  interpolated position on the raw GPS corridor — enough to stop it drifting
	 *  off the corridor (which inflates the over-route/corridor-stall metric) while
	 *  still free enough to bend around a building. Large → nearly free. */
	freeTetherSigmaM: number;
	/** Step-magnitude factor (#320): mean stride (m/step) converting the leg's
	 *  pedometer count into a displacement budget. */
	stepStrideM: number;
	/** Drawn length up to `budget × slack` draws no force — covers stride
	 *  variance, GPS length inflation, and honest pedometer undercount. */
	stepSlackRatio: number;
	/** Base σ (m) of the per-edge contraction factor; the effective edge weight
	 *  is `ramp/σ²` (see the ramp in {@link reconstructWalk}). */
	stepSigmaM: number;
	/** Width (in excess ratio above 1) over which the quadratic ramp
	 *  `((L/target − 1)/width)²` reaches σ-strength. The slack ratio already
	 *  absorbs all LEGITIMATE variance (stride spread, GPS length inflation,
	 *  honest undercount), so beyond it the violation turns physically
	 *  impossible over a narrow band — the ramp must saturate quickly or the
	 *  map priors out-muscle the evidence mid-collapse. */
	stepRampWidthRatio: number;
	/** Ramp saturation: the quadratic excess ramp is capped here, bounding the
	 *  factor even on a grotesque smear. */
	stepRampCap: number;
	/** Extra re-linearisations at the final GNC scale while the step budget is
	 *  still violated > 5 % — a smear contracts a bounded distance per solve, so
	 *  the fixed schedule alone leaves a gross one half-collapsed. Bounded; a
	 *  leg at equilibrium breaks out immediately. */
	stepExtraIters: number;
	/** HARD building constraint (#353a): after each inner solve, any state
	 *  strictly INSIDE a footprint is PROJECTED to its clearance target instead
	 *  of merely pulled — occupancy of a footprint becomes impossible for the
	 *  iterate, not just expensive. Exemptions keep it honest: states whose RAW
	 *  observation sits inside a footprint as part of a sustained run
	 *  (genuine indoor presence — a café, a mall walkway; see
	 *  `indoorPresenceMinFixes`), states within `passageWayReachM` of a
	 *  walkable way (mapped passages), and the two terminal states (a walk
	 *  legitimately starts at an indoor doorway). */
	hardProjectBuildings: boolean;
	/** HARD building constraint (#353b): after the anneal, any output edge that
	 *  still PASSES THROUGH a footprint (both ends outside — the between-vertex
	 *  gap projection can't see) is routed around that ring's own corners.
	 *  Kept only when a bounded crossing-free corner path exists; presence-
	 *  exempt rings are never routed around. */
	insertCornerDetours: boolean;
	/** ≥ this many CONSECUTIVE observed fixes raw-inside the SAME footprint =
	 *  genuine indoor presence: the building is occupied, not an obstacle. The
	 *  clearance field and both hard constraints are OFF for those states
	 *  (weight-don't-filter: evidence of entry beats the impossibility prior).
	 *  Judged on the RAW observations so the exemption is stable evidence the
	 *  solver cannot drag. */
	indoorPresenceMinFixes: number;
	/** A state within this of a walkable way is never hard-projected — the
	 *  mapped-passage class (ways THROUGH buildings) is owned by the way
	 *  attraction + passage snap, not the building constraint. Matches the
	 *  corrector's `onWayM` exemption. */
	passageWayReachM: number;
}

export const DEFAULT_RECONSTRUCT_PROFILE: ReconstructProfile = {
	minFixes: 4,
	accClampMinM: 10,
	accClampMaxM: 35,
	accFallbackM: 20,
	gncStartM: 60,
	gncTargetM: 20,
	gncSteps: 8,
	innerIters: 2,
	smoothSigmaM: 6,
	networkSigmaM: 5,
	networkRadiusM: 25,
	networkRobustM: 12,
	buildingSigmaM: 1.5,
	buildingClearM: 4,
	// Densification OFF (vertex-per-fix). Measured 2026-07-07: inserting free
	// states between fixes did NOT reduce building-crossing (those residuals are
	// OSM graph gaps, #305) and it inflated corridor-stall ~2× — a scoring
	// artifact of projecting a many-vertex line onto the sparse raw fixes, not real
	// wander. Vertex-per-fix ties the matcher on corridor-stall while keeping the
	// phantom-dissolution win. Kept as a knob for a future building-aware pass.
	targetSpacingM: 100000,
	freeTetherSigmaM: 40,
	// Step-magnitude factor (#320). σ=20 m puts the SATURATED factor (ramp-capped
	// at 16 → weight 0.04) well above the strongest clamped GPS emission (1/10² =
	// 0.01) — a gross coherent smear (the class the robust kernel cannot reject,
	// e.g. 07-06: 418 steps ≈ 300 m against 1.9 km drawn) is contracted to the
	// budget. A mild excess (≤ ~2× target) ramps quadratically from zero, so an
	// honest leg with an undercounting pedometer feels a force ≪ its GPS
	// consensus and barely moves. Slack 1.4 keeps the factor fully off for any
	// leg within pedometer agreement.
	stepStrideM: 0.75,
	stepSlackRatio: 1.4,
	stepSigmaM: 20,
	stepRampWidthRatio: 0.25,
	stepRampCap: 16,
	stepExtraIters: 12,
	// Hard building constraint (#353), corpus verdict 2026-07-14 over 154 walks
	// (arms sweepable without a rebuild via RECON_SPACING_M / RECON_HARD_PROJECT
	// / RECON_CORNERS, see reconstructProfileFromEnv):
	// - CORNER INSERTION ships: ΣoffPath 1081→987 m, walks-with-crossings
	//   36→30, corridor-stall and drawn length unchanged, ZERO introduced
	//   crossings.
	// - HARD PROJECTION is REFUTED — do not enable: it INTRODUCED crossings on
	//   2 clean walks (the projected vertex's re-angled edges cut neighbouring
	//   footprints), regressed stall on 3, and netted ~nothing (the soft
	//   clearance field already does the vertex work).
	// - Free-state densification (targetSpacingM) re-measured under the FIXED
	//   min-cost-DP stall metric and STILL refuted: +4 % drawn length and 8
	//   stall regressions for no crossing gain. Vertex-per-fix stands.
	hardProjectBuildings: false,
	insertCornerDetours: true,
	indoorPresenceMinFixes: 3,
	passageWayReachM: 8,
};

/** The default profile with the #353 experiment knobs overridable from the
 *  environment, so the referee can sweep arms without a rebuild. Unset env =
 *  the committed defaults — the golden gates always measure shipped behaviour. */
export function reconstructProfileFromEnv(base: ReconstructProfile = DEFAULT_RECONSTRUCT_PROFILE): ReconstructProfile {
	const num = (v: string | undefined, d: number) => (v ? Number(v) : d);
	const flag = (v: string | undefined, d: boolean) => (v === undefined ? d : v === "1");
	return {
		...base,
		targetSpacingM: num(process.env.RECON_SPACING_M, base.targetSpacingM),
		hardProjectBuildings: flag(process.env.RECON_HARD_PROJECT, base.hardProjectBuildings),
		insertCornerDetours: flag(process.env.RECON_CORNERS, base.insertCornerDetours),
	};
}

/** Geman-McClure IRLS weight for residual `r` at kernel scale `c` (both metres):
 *  `(c²/(c²+r²))²` ∈ (0,1]. Redescending — →1 as r→0 (full trust), →0 as r≫c
 *  (rejected). Large c ⇒ ≈1 everywhere (quadratic); small c ⇒ sharp rejection. */
function gmWeight(r: number, c: number): number {
	const c2 = c * c;
	const t = c2 / (c2 + r * r);
	return t * t;
}

/** Closest point on the metric segment a→b to (px,py), clamped to the segment;
 *  returns the point and its SQUARED distance (avoids a sqrt in the hot loop). */
function projMetric(
	px: number,
	py: number,
	ax: number,
	ay: number,
	bx: number,
	by: number,
): { x: number; y: number; d2: number } {
	const dx = bx - ax;
	const dy = by - ay;
	const len2 = dx * dx + dy * dy || 1e-9;
	let t = ((px - ax) * dx + (py - ay) * dy) / len2;
	t = t < 0 ? 0 : t > 1 ? 1 : t;
	const x = ax + t * dx;
	const y = ay + t * dy;
	const ex = px - x;
	const ey = py - y;
	return { x, y, d2: ex * ex + ey * ey };
}

/**
 * A uniform-grid spatial index over the leg's walkable segments and building
 * rings, in the local metric frame. Replaces the O(states × all-segments) brute
 * force in the reconstruct hot loop with an O(states × local-cell) lookup — the
 * difference between a per-leg solve that crawls over the whole-day network and
 * one that is near-constant per query. Built once per leg; pure.
 */
class WalkGrid {
	private readonly cell: number;
	/** Flat [ax,ay,bx,by] × nSeg, metric. */
	private readonly seg: Float64Array;
	private readonly segCells = new Map<number, number[]>();
	private readonly rings: { pts: Float64Array; minx: number; miny: number; maxx: number; maxy: number }[] = [];
	private readonly ringCells = new Map<number, number[]>();
	/** Cell key: pack signed cell coords into one number (cells fit in ±32k). */
	private static key(cx: number, cy: number): number {
		return (cx + 32768) * 65536 + (cy + 32768);
	}

	constructor(segs: readonly number[][], rings: readonly Float64Array[], cell: number) {
		this.cell = cell;
		this.seg = new Float64Array(segs.length * 4);
		for (let i = 0; i < segs.length; i++) {
			const s = segs[i];
			this.seg[i * 4] = s[0];
			this.seg[i * 4 + 1] = s[1];
			this.seg[i * 4 + 2] = s[2];
			this.seg[i * 4 + 3] = s[3];
			this.insertBox(
				this.segCells,
				i,
				Math.min(s[0], s[2]),
				Math.min(s[1], s[3]),
				Math.max(s[0], s[2]),
				Math.max(s[1], s[3]),
			);
		}
		for (let r = 0; r < rings.length; r++) {
			const pts = rings[r];
			let minx = Infinity;
			let miny = Infinity;
			let maxx = -Infinity;
			let maxy = -Infinity;
			for (let k = 0; k < pts.length; k += 2) {
				minx = Math.min(minx, pts[k]);
				maxx = Math.max(maxx, pts[k]);
				miny = Math.min(miny, pts[k + 1]);
				maxy = Math.max(maxy, pts[k + 1]);
			}
			this.rings.push({ pts, minx, miny, maxx, maxy });
			this.insertBox(this.ringCells, r, minx, miny, maxx, maxy);
		}
	}

	private insertBox(
		map: Map<number, number[]>,
		id: number,
		minx: number,
		miny: number,
		maxx: number,
		maxy: number,
	): void {
		const c = this.cell;
		for (let cx = Math.floor(minx / c); cx <= Math.floor(maxx / c); cx++) {
			for (let cy = Math.floor(miny / c); cy <= Math.floor(maxy / c); cy++) {
				const k = WalkGrid.key(cx, cy);
				const list = map.get(k);
				if (list) list.push(id);
				else map.set(k, [id]);
			}
		}
	}

	/** Nearest point on any walkable segment to (px,py) within maxR, else null.
	 *  Also returns the winning segment's unit tangent (tx,ty), so the caller
	 *  can build a NORMAL-ONLY (point-to-line) attraction: hugging the way must
	 *  not resist sliding along it. */
	nearest(
		px: number,
		py: number,
		maxR: number,
	): { x: number; y: number; distM: number; tx: number; ty: number } | null {
		const c = this.cell;
		const R = Math.max(1, Math.ceil(maxR / c));
		const cx0 = Math.floor(px / c);
		const cy0 = Math.floor(py / c);
		let best = maxR * maxR;
		let bx = 0;
		let by = 0;
		let bestSeg = -1;
		const seen = new Set<number>();
		for (let cx = cx0 - R; cx <= cx0 + R; cx++) {
			for (let cy = cy0 - R; cy <= cy0 + R; cy++) {
				const list = this.segCells.get(WalkGrid.key(cx, cy));
				if (!list) continue;
				for (const i of list) {
					if (seen.has(i)) continue;
					seen.add(i);
					const p = projMetric(px, py, this.seg[i * 4], this.seg[i * 4 + 1], this.seg[i * 4 + 2], this.seg[i * 4 + 3]);
					if (p.d2 < best) {
						best = p.d2;
						bx = p.x;
						by = p.y;
						bestSeg = i;
					}
				}
			}
		}
		if (bestSeg < 0) return null;
		const dx = this.seg[bestSeg * 4 + 2] - this.seg[bestSeg * 4];
		const dy = this.seg[bestSeg * 4 + 3] - this.seg[bestSeg * 4 + 1];
		const len = Math.hypot(dx, dy) || 1;
		return { x: bx, y: by, distM: Math.sqrt(best), tx: dx / len, ty: dy / len };
	}

	/** Building-CLEARANCE target for (px,py): the point `clearM` OUTSIDE the nearest
	 *  wall, whenever the state is inside a footprint OR within `clearM` of a wall
	 *  from outside; else null. A field (not just when-inside), so a chord grazing a
	 *  corner is pushed off the wall even with no vertex strictly inside. */
	clearanceTarget(px: number, py: number, clearM: number): { x: number; y: number; inside: boolean } | null {
		const c = this.cell;
		const cx0 = Math.floor(px / c);
		const cy0 = Math.floor(py / c);
		let inside = false;
		let bestD2 = Infinity;
		let wx = 0;
		let wy = 0;
		let found = false;
		const seen = new Set<number>();
		for (let cx = cx0 - 1; cx <= cx0 + 1; cx++) {
			for (let cy = cy0 - 1; cy <= cy0 + 1; cy++) {
				const list = this.ringCells.get(WalkGrid.key(cx, cy));
				if (!list) continue;
				for (const r of list) {
					if (seen.has(r)) continue;
					seen.add(r);
					const ring = this.rings[r];
					const pts = ring.pts;
					const n = pts.length / 2;
					if (px >= ring.minx && px <= ring.maxx && py >= ring.miny && py <= ring.maxy) {
						let ins = false;
						for (let i = 0, j = n - 1; i < n; j = i++) {
							const yi = pts[i * 2 + 1];
							const xi = pts[i * 2];
							const yj = pts[j * 2 + 1];
							const xj = pts[j * 2];
							if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) ins = !ins;
						}
						if (ins) inside = true;
					}
					for (let i = 0, j = n - 1; i < n; j = i++) {
						const p = projMetric(px, py, pts[j * 2], pts[j * 2 + 1], pts[i * 2], pts[i * 2 + 1]);
						if (p.d2 < bestD2) {
							bestD2 = p.d2;
							wx = p.x;
							wy = p.y;
							found = true;
						}
					}
				}
			}
		}
		if (!found) return null;
		const dist = Math.sqrt(bestD2);
		if (!inside && dist > clearM) return null; // already clear
		if (dist < 1e-6) return null; // exactly on the wall — no defined normal
		// Outward unit: toward the wall when inside (escape), away from it when outside.
		const ux = inside ? (wx - px) / dist : (px - wx) / dist;
		const uy = inside ? (wy - py) / dist : (py - wy) / dist;
		return { x: wx + ux * clearM, y: wy + uy * clearM, inside };
	}

	/** Index of the ring containing (px,py), or −1. Same even-odd test as the
	 *  clearance field, exposed for the indoor-presence exemption (#353): raw
	 *  observations are classified once, so the exemption is stable evidence. */
	ringContaining(px: number, py: number): number {
		const c = this.cell;
		const cx0 = Math.floor(px / c);
		const cy0 = Math.floor(py / c);
		const seen = new Set<number>();
		for (let cx = cx0 - 1; cx <= cx0 + 1; cx++) {
			for (let cy = cy0 - 1; cy <= cy0 + 1; cy++) {
				const list = this.ringCells.get(WalkGrid.key(cx, cy));
				if (!list) continue;
				for (const r of list) {
					if (seen.has(r)) continue;
					seen.add(r);
					const ring = this.rings[r];
					if (px < ring.minx || px > ring.maxx || py < ring.miny || py > ring.maxy) continue;
					const pts = ring.pts;
					const n = pts.length / 2;
					let ins = false;
					for (let i = 0, j = n - 1; i < n; j = i++) {
						const yi = pts[i * 2 + 1];
						const xi = pts[i * 2];
						const yj = pts[j * 2 + 1];
						const xj = pts[j * 2];
						if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) ins = !ins;
					}
					if (ins) return r;
				}
			}
		}
		return -1;
	}
}

/** Independent evidence fused into {@link reconstructWalk} beyond the GPS/map
 *  factors: endpoint anchors (#319) and the leg's pedometer count (#320). */
export interface WalkEvidence {
	start?: WalkAnchor;
	end?: WalkAnchor;
	/** Pedometer steps recorded within the leg's window. `undefined` = no step
	 *  data (watch data absent for the day) — the step factor stays off. */
	stepsWalked?: number;
}

/**
 * Reconstruct a walk leg as the robust, annealed MAP continuous trajectory.
 * Fuses a redescending GPS emission (GNC-annealed), a smoothness/physics prior,
 * soft walkable attraction, building repulsion, optional endpoint anchors, and
 * a soft step-magnitude contraction toward the pedometer displacement budget.
 * One vertex per fix, timestamps preserved; null when too short. Deterministic.
 */
export function reconstructWalk(
	fixes: readonly WalkFix[],
	geo: RoadGeometry,
	profile: ReconstructProfile = reconstructProfileFromEnv(),
	evidence?: WalkEvidence,
): SmoothedPoint[] | null {
	if (fixes.length < profile.minFixes) return null;

	const lat0 = fixes[0].lat;
	const lon0 = fixes[0].lon;
	const cosLat = Math.cos((lat0 * Math.PI) / 180);
	const toE = (lon: number) => (lon - lon0) * 111_320 * cosLat;
	const toN = (lat: number) => (lat - lat0) * 111_320;
	const toLon = (e: number) => lon0 + e / (111_320 * cosLat);
	const toLat = (m: number) => lat0 + m / 111_320;

	// Densify: keep every fix as an OBSERVED state (GPS emission + accuracy) and
	// insert FREE states (no GPS term) between consecutive fixes so the spacing is
	// ≤ targetSpacingM. Free states are placed purely by smoothness + network +
	// building, so the line can bend AROUND a block between two fixes — a straight
	// chord would otherwise cut through it with no vertex inside to repel.
	const seedE: number[] = [];
	const seedN: number[] = [];
	const obsE: number[] = []; // GPS target (only meaningful where obsW > 0)
	const obsN: number[] = [];
	const obsW: number[] = []; // weak accuracy prior, 0 for a free state
	const ts: number[] = [];
	for (let i = 0; i < fixes.length; i++) {
		const fe = toE(fixes[i].lon);
		const fn = toN(fixes[i].lat);
		const acc = fixes[i].accuracyM ?? profile.accFallbackM;
		const sigma = Math.min(profile.accClampMaxM, Math.max(profile.accClampMinM, acc));
		seedE.push(fe);
		seedN.push(fn);
		obsE.push(fe);
		obsN.push(fn);
		obsW.push(1 / (sigma * sigma));
		ts.push(fixes[i].ts);
		if (i + 1 < fixes.length) {
			const ne = toE(fixes[i + 1].lon);
			const nn2 = toN(fixes[i + 1].lat);
			const segLen = Math.hypot(ne - fe, nn2 - fn);
			const k = Math.max(0, Math.floor(segLen / profile.targetSpacingM) - 1);
			for (let j = 1; j <= k; j++) {
				const f = j / (k + 1);
				seedE.push(fe + (ne - fe) * f);
				seedN.push(fn + (nn2 - fn) * f);
				obsE.push(0);
				obsN.push(0);
				obsW.push(0); // free state — no GPS emission
				ts.push(Math.round(fixes[i].ts + (fixes[i + 1].ts - fixes[i].ts) * f));
			}
		}
	}
	const m = seedE.length;

	const wSmooth = 1 / (profile.smoothSigmaM * profile.smoothSigmaM);
	const wNet = 1 / (profile.networkSigmaM * profile.networkSigmaM);
	const wBuild = 1 / (profile.buildingSigmaM * profile.buildingSigmaM);
	const wFreeTether = 1 / (profile.freeTetherSigmaM * profile.freeTetherSigmaM);

	// Build the spatial index once (metric frame): walkable segments + building
	// rings. This is what makes the per-state nearest-way / inside-building lookups
	// near-constant instead of a whole-network scan.
	const segs: number[][] = [];
	for (const w of geo.ways) {
		for (let i = 1; i < w.coords.length; i++) {
			segs.push([toE(w.coords[i - 1][1]), toN(w.coords[i - 1][0]), toE(w.coords[i][1]), toN(w.coords[i][0])]);
		}
	}
	const rings: Float64Array[] = [];
	for (const ring of geo.buildings ?? []) {
		if (ring.length < 3) continue;
		const arr = new Float64Array(ring.length * 2);
		for (let k = 0; k < ring.length; k++) {
			arr[k * 2] = toE(ring[k].lon);
			arr[k * 2 + 1] = toN(ring[k].lat);
		}
		rings.push(arr);
	}
	const grid =
		segs.length > 0 || rings.length > 0 ? new WalkGrid(segs, rings, Math.max(profile.networkRadiusM, 15)) : null;

	// Indoor-presence exemption (#353): a run of ≥ indoorPresenceMinFixes
	// consecutive OBSERVED fixes whose RAW positions sit inside the SAME
	// footprint is evidence of genuine entry (a café, a shop, a mall walkway) —
	// for those states, and the free states between them, the building is
	// occupied space, not an obstacle: no clearance pull, no hard projection,
	// no corner routing. Weight-don't-filter: many points inside beat the
	// impossibility prior; an isolated point or an interpolated chord does not.
	const exempt = new Uint8Array(m);
	if (grid) {
		const obsIdx: number[] = [];
		for (let i = 0; i < m; i++) if (obsW[i] > 0) obsIdx.push(i);
		let runStart = 0;
		let runRing = -2;
		const markRun = (from: number, to: number): void => {
			// from/to index into obsIdx, inclusive; exempt every STATE between
			// the run's first and last observed state (free states included).
			if (to - from + 1 < profile.indoorPresenceMinFixes) return;
			for (let s = obsIdx[from]; s <= obsIdx[to]; s++) exempt[s] = 1;
		};
		for (let k = 0; k < obsIdx.length; k++) {
			const i = obsIdx[k];
			const ring = grid.ringContaining(seedE[i], seedN[i]);
			if (ring !== runRing || ring === -1) {
				if (runRing >= 0) markRun(runStart, k - 1);
				runStart = k;
				runRing = ring;
			}
		}
		if (runRing >= 0) markRun(runStart, obsIdx.length - 1);
	}

	let e: Float64Array = Float64Array.from(seedE);
	let nn: Float64Array = Float64Array.from(seedN);

	// Step-magnitude displacement budget (#320): the drawn length may not
	// grossly exceed what the pedometer says was walked. Soft, never a gate.
	const stepTargetM =
		evidence?.stepsWalked !== undefined
			? Math.max(1, evidence.stepsWalked * profile.stepStrideM * profile.stepSlackRatio)
			: null;

	const pathLen = (): number => {
		let len = 0;
		for (let i = 0; i + 1 < m; i++) len += Math.hypot(e[i + 1] - e[i], nn[i + 1] - nn[i]);
		return len;
	};
	// Is a piece of hard evidence still grossly unsatisfied? Length beyond the
	// step budget (>5 %), or a terminal state further than 3σ from its anchor.
	const evidenceViolated = (): boolean => {
		if (stepTargetM !== null && pathLen() > stepTargetM * 1.05) return true;
		const off = (a: WalkAnchor | undefined, i: number): boolean =>
			a !== undefined && Math.hypot(e[i] - toE(a.lon), nn[i] - toN(a.lat)) > 3 * a.sigmaM;
		return off(evidence?.start, 0) || off(evidence?.end, m - 1);
	};

	// GNC: geometric anneal of the GPS kernel scale c from start → target. When
	// the step budget or an endpoint anchor is still grossly violated after the
	// schedule, keep re-linearising at the target scale (bounded by
	// stepExtraIters): a coherent smear contracts — and its whole chain migrates
	// toward the anchors — a bounded distance per solve (its GPS is rejected, so
	// only the map priors resist), while an honest leg sits at a static
	// equilibrium — its live GPS consensus holds it, so extra iterations move
	// nothing.
	const ratio = profile.gncSteps > 1 ? (profile.gncTargetM / profile.gncStartM) ** (1 / (profile.gncSteps - 1)) : 1;
	let c = profile.gncStartM;
	for (let step = 0; step < profile.gncSteps + profile.stepExtraIters; step++) {
		if (step >= profile.gncSteps && !evidenceViolated()) break;
		for (let inner = 0; inner < profile.innerIters; inner++) {
			// Per-axis diagonals: the network attraction is ANISOTROPIC (normal-only,
			// point-to-line), so east and north see different weights there. All
			// other factors contribute identically to both.
			const dE = new Float64Array(m);
			const dN = new Float64Array(m);
			const be = new Float64Array(m);
			const bn = new Float64Array(m);
			// Step-magnitude contraction, re-linearised at the current estimate:
			// when the current length L exceeds the budget target, every edge gets
			// a first-difference target of `s·(current edge)` with s = target/L —
			// a uniform shrink whose force fades to zero as L reaches the target
			// (self-limiting; it cannot over-collapse). The quadratic excess ramp
			// keeps it far below GPS consensus on an honest leg while saturating
			// above the strongest clamped emission on a gross coherent smear.
			let wEdge = 0;
			let shrink = 1;
			if (stepTargetM !== null) {
				const excess = pathLen() / stepTargetM;
				if (excess > 1) {
					const over = (excess - 1) / profile.stepRampWidthRatio;
					const ramp = Math.min(profile.stepRampCap, over * over);
					wEdge = ramp / (profile.stepSigmaM * profile.stepSigmaM);
					shrink = 1 / excess;
					// Scatter D₁ᵀ(wEdge·t) into the rhs: edge k's target t_k touches
					// rows k (−) and k+1 (+).
					for (let k = 0; k + 1 < m; k++) {
						const tE = shrink * (e[k + 1] - e[k]);
						const tN = shrink * (nn[k + 1] - nn[k]);
						be[k] -= wEdge * tE;
						be[k + 1] += wEdge * tE;
						bn[k] -= wEdge * tN;
						bn[k + 1] += wEdge * tN;
					}
				}
			}
			for (let i = 0; i < m; i++) {
				const px = e[i];
				const py = nn[i];
				// Robust GPS emission (observed states only) — reject a fix that
				// disagrees with the consensus trajectory.
				if (obsW[i] > 0) {
					const rGps = Math.hypot(px - obsE[i], py - obsN[i]);
					const wg = obsW[i] * gmWeight(rGps, c);
					dE[i] += wg;
					dN[i] += wg;
					be[i] += wg * obsE[i];
					bn[i] += wg * obsN[i];
				} else {
					// Free state: weak, non-robust tether to its interpolated position on
					// the raw corridor — keeps it from drifting off (over-route) without
					// pinning it, so it can still bow around a building.
					dE[i] += wFreeTether;
					dN[i] += wFreeTether;
					be[i] += wFreeTether * seedE[i];
					bn[i] += wFreeTether * seedN[i];
				}
				if (grid) {
					// Adaptive walkable attraction — hug hard when close to a way,
					// redescend to weak when far (the hard/soft unification). NORMAL-ONLY
					// (point-to-line, diagonal approximation): the true penalty is on the
					// distance PERPENDICULAR to the way, `wN·(n·(x−p))²` with n the way
					// normal — an isotropic point spring also resists sliding ALONG the
					// way, which drags every anchor/step correction to a crawl (measured:
					// endpoint anchors converged ~10 m per solve against it). Keeping the
					// east/north systems separable means dropping the nx·ny cross term:
					// exact for an axis-aligned way, mildly soft for a diagonal one.
					const near = grid.nearest(px, py, profile.networkRadiusM);
					if (near) {
						const wN = wNet * gmWeight(near.distM, profile.networkRobustM);
						const nx = -near.ty;
						const ny = near.tx;
						dE[i] += wN * nx * nx;
						dN[i] += wN * ny * ny;
						be[i] += wN * nx * nx * near.x;
						bn[i] += wN * ny * ny * near.y;
					}
					// Building clearance field — keep the state ≥ clearM off any wall.
					// Presence-exempt states are genuinely indoors: no pull at all.
					if (!exempt[i]) {
						const esc = grid.clearanceTarget(px, py, profile.buildingClearM);
						if (esc) {
							dE[i] += wBuild;
							dN[i] += wBuild;
							be[i] += wBuild * esc.x;
							bn[i] += wBuild * esc.y;
						}
					}
				}
			}
			// Endpoint anchors — reconstruct between confident truths.
			if (evidence?.start) {
				const w = 1 / (evidence.start.sigmaM * evidence.start.sigmaM);
				dE[0] += w;
				dN[0] += w;
				be[0] += w * toE(evidence.start.lon);
				bn[0] += w * toN(evidence.start.lat);
			}
			if (evidence?.end) {
				const w = 1 / (evidence.end.sigmaM * evidence.end.sigmaM);
				dE[m - 1] += w;
				dN[m - 1] += w;
				be[m - 1] += w * toE(evidence.end.lon);
				bn[m - 1] += w * toN(evidence.end.lat);
			}
			e = solvePCG(dE, wSmooth, be, e, wEdge);
			nn = solvePCG(dN, wSmooth, bn, nn, wEdge);
			// Hard projection (#353a): occupancy of a footprint is impossible for
			// the iterate — a non-exempt interior state inside a ring is MOVED to
			// its clearance target (projected gradient), not merely pulled.
			// Terminals are spared (a walk may start at an indoor doorway);
			// states riding a mapped way through the building are the passage
			// class and belong to the way attraction.
			if (profile.hardProjectBuildings && grid) {
				for (let i = 1; i < m - 1; i++) {
					if (exempt[i]) continue;
					const esc = grid.clearanceTarget(e[i], nn[i], profile.buildingClearM);
					if (!esc?.inside) continue;
					if (grid.nearest(e[i], nn[i], profile.passageWayReachM)) continue;
					e[i] = esc.x;
					nn[i] = esc.y;
				}
			}
			if (process.env.WALK_RECON_DEBUG === "1") {
				let len = 0;
				let maxAbs = 0;
				for (let i = 0; i + 1 < m; i++) len += Math.hypot(e[i + 1] - e[i], nn[i + 1] - nn[i]);
				for (let i = 0; i < m; i++) maxAbs = Math.max(maxAbs, Math.abs(e[i]), Math.abs(nn[i]));
				console.error(
					`[recon-dbg] step=${step} inner=${inner} c=${c.toFixed(1)} wEdge=${wEdge.toExponential(2)} shrink=${shrink.toFixed(3)} len=${len.toFixed(0)} maxAbs=${maxAbs.toExponential(2)}`,
				);
			}
		}
		c = Math.max(profile.gncTargetM, c * ratio);
	}

	const out: SmoothedPoint[] = [];
	for (let i = 0; i < m; i++) out.push({ lat: toLat(nn[i]), lon: toLon(e[i]), ts: ts[i] });

	// Corner insertion (#353b): the projection keeps VERTICES out of footprints,
	// but an edge between two exterior vertices can still pass through one (the
	// between-vertex gap). Route each such edge around the ring's own corners —
	// only when a bounded, crossing-free corner path exists, and never across a
	// presence-exempt endpoint (an edge entering an occupied café is honest).
	if (profile.insertCornerDetours && (geo.buildings?.length ?? 0) > 0) {
		const CORNER_DETOUR_MAX_RATIO = 2.5;
		const footprints = (geo.buildings ?? []).map((r) => [...r]);
		const repaired: SmoothedPoint[] = [out[0]];
		for (let i = 0; i + 1 < m; i++) {
			const a = out[i];
			const b = out[i + 1];
			if (!exempt[i] && !exempt[i + 1]) {
				const chordM = Math.hypot(toE(b.lon) - toE(a.lon), toN(b.lat) - toN(a.lat));
				const path = chordM > 1 ? routeChordAroundBuildings(a, b, footprints) : null;
				if (path && path.length > 2) {
					let lenM = 0;
					for (let k = 1; k < path.length; k++) {
						lenM += Math.hypot(toE(path[k].lon) - toE(path[k - 1].lon), toN(path[k].lat) - toN(path[k - 1].lat));
					}
					if (lenM <= chordM * CORNER_DETOUR_MAX_RATIO) {
						// Interior corners, timestamps interpolated by along-path distance.
						let acc = 0;
						for (let k = 1; k < path.length - 1; k++) {
							acc += Math.hypot(toE(path[k].lon) - toE(path[k - 1].lon), toN(path[k].lat) - toN(path[k - 1].lat));
							repaired.push({
								lat: path[k].lat,
								lon: path[k].lon,
								ts: Math.round(a.ts + (b.ts - a.ts) * (acc / lenM)),
							});
						}
					}
				}
			}
			repaired.push(b);
		}
		return repaired;
	}
	return out;
}
