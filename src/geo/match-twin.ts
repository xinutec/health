/**
 * The BigInt twin of the map-matcher core (`map-match-core.ts`
 * `matchTrajectory` + `pedestrian-match.ts` `matchWalkSegment`) — the
 * pinned integer semantics the Lean port will implement, mirrored
 * expression by expression so the `compare-match` harness can measure
 * float↔quant decision flips and later demand quant↔Lean bit-equality.
 *
 * Same substrate as `quant-twin.ts`: 1e-7° integer coordinates, µm
 * distances (`qDist`, cos-mid Q20 polynomial), floor `isqrt`,
 * half-away-from-zero `roundDiv`. On top of it, two exact scalings turn
 * every float comparison into an integer one:
 *
 * - **Edge weights** carry the corridor ramp's denominator
 *   `S = corridorFarUm − corridorNearUm`: the float weight
 *   `len · (1 + (maxPen−1)·(d−near)/(far−near)) · bf` becomes
 *   `lenUm · (S + (maxPen−1)·(clamp(d)−near)) · bf` — the same total
 *   order, exactly. Offsets and the radius bound scale by the same `S`.
 * - **Viterbi scores** scale by `2σ²β`: emission `−½(d/σ)²` becomes
 *   `−d²·β`, transition `−|Δ|/β` becomes `−|Δ|·2σ²`, and the
 *   way-continuity prior `−nats` becomes `−nats·2σ²β`.
 *
 * Spatial-index shortcuts of the float side (SegmentNearGrid, the
 * building buckets, `nearAnyBucket`, bridge-gap grid hashing) are exact
 * by their own documented arguments, so the twin uses their SPEC — a
 * plain scan with conservative integer prefilters — rather than
 * replicating float cell arithmetic. Building edge samples and
 * projection feet are quantised to the 1e-7° grid with `roundDiv`
 * (≤ ~6 mm from the float sample; a measured near-tie class, like every
 * float↔quant deviation here). Candidate ties (equal distance) break by
 * segment index; the float side breaks them by grid-discovery order —
 * also a measured class.
 */

import {
	cosQ,
	type QPt,
	qDedupeKeep,
	qDespikeKeep,
	qDist,
	qRemoveSpurs,
	qSimplifyKeep,
	qTrim,
	roundDiv,
} from "./quant-twin.js";

/** Walk-profile constants, exact-rational where the float profile has a
 *  fraction (`maxLenFactor` 1.4 = 7/5, `maxRoadlessFraction` 0.4 = 2/5). */
export interface QMatchProfile {
	minFixes: number;
	radiusUm: bigint;
	maxCandidatesPerFix: number;
	sigmaUm: bigint;
	betaUm: bigint;
	gapBridgeUm: bigint;
	detourFactor: bigint;
	detourSlackUm: bigint;
	maxLenNum: bigint;
	maxLenDen: bigint;
	maxLenSlackUm: bigint;
	maxRoadlessNum: bigint;
	maxRoadlessDen: bigint;
	corridorNearUm: bigint;
	corridorFarUm: bigint;
	corridorMaxPenalty: bigint;
	wayContinuityNats: bigint;
	spurReturnUm: bigint;
	spurMaxSpanVerts: number;
	simplifyTolUm: bigint;
	buildingCrossFactor: bigint;
	buildingSupportUm: bigint;
}

/** `WALK_PROFILE` in the pinned representation. */
export const WALK_QPROFILE: QMatchProfile = {
	minFixes: 3,
	radiusUm: 20_000_000n,
	maxCandidatesPerFix: 6,
	sigmaUm: 8_000_000n,
	betaUm: 12_000_000n,
	gapBridgeUm: 18_000_000n,
	detourFactor: 4n,
	detourSlackUm: 250_000_000n,
	maxLenNum: 7n,
	maxLenDen: 5n,
	maxLenSlackUm: 200_000_000n,
	maxRoadlessNum: 2n,
	maxRoadlessDen: 5n,
	corridorNearUm: 25_000_000n,
	corridorFarUm: 80_000_000n,
	corridorMaxPenalty: 40n,
	wayContinuityNats: 0n,
	spurReturnUm: 25_000_000n,
	spurMaxSpanVerts: 4,
	simplifyTolUm: 5_000_000n,
	buildingCrossFactor: 25n,
	buildingSupportUm: 15_000_000n,
};

export interface QWay {
	coords: QPt[];
	name?: string | null;
}

const DETAIL_TOLERANCE_UM = 1_500_000n;
const DEDUPE_UM = 500_000n;
const BUILDING_SAMPLE_STEP_UM = 3_000_000n;

/** `projectPointToSegment`'s twin: the clamped foot on the 1e-7° grid,
 *  the fraction as the exact rational `tn/td`, and `qDist` to the foot —
 *  the same body as `qChordDist`, with the foot and fraction kept. */
export function qProject(p: QPt, a: QPt, b: QPt): { la: bigint; lo: bigint; tn: bigint; td: bigint; dist: bigint } {
	const c = cosQ((a.la + b.la) / 2n);
	const bx = ((b.lo - a.lo) * 11132n * c) >> 20n;
	const vy = (b.la - a.la) * 11132n;
	const px = ((p.lo - a.lo) * 11132n * c) >> 20n;
	const py = (p.la - a.la) * 11132n;
	const len2 = bx * bx + vy * vy;
	if (len2 === 0n) return { la: a.la, lo: a.lo, tn: 0n, td: 1n, dist: qDist(p, a) };
	let dot = px * bx + py * vy;
	if (dot < 0n) dot = 0n;
	else if (dot > len2) dot = len2;
	const la = a.la + roundDiv(dot * (b.la - a.la), len2);
	const lo = a.lo + roundDiv(dot * (b.lo - a.lo), len2);
	return { la, lo, tn: dot, td: len2, dist: qDist(p, { la, lo, ts: 0n }) };
}

/** Polyline length in µm. */
export function qPathLength(pts: readonly QPt[]): bigint {
	let total = 0n;
	for (let i = 1; i < pts.length; i++) total += qDist(pts[i - 1], pts[i]);
	return total;
}

const absB = (x: bigint): bigint => (x < 0n ? -x : x);

/** Lower bound (µm) of any distance to the chord `a`–`b` from `p`, by
 *  latitude separation alone — exact-conservative (`qDist ≥ |Δla|·11132`
 *  and the clamped foot's latitude lies between the endpoints'). */
function latGapUm(p: QPt, a: QPt, b: QPt): bigint {
	const lo = a.la < b.la ? a.la : b.la;
	const hi = a.la < b.la ? b.la : a.la;
	if (p.la < lo) return (lo - p.la) * 11132n;
	if (p.la > hi) return (p.la - hi) * 11132n;
	return 0n;
}

/** `TrackCorridor`'s twin: brute-force nearest-chord distance (the
 *  float side's grid is exact by its own argument), clamped at `farUm`,
 *  and the ramp scaled by `S = farUm − nearUm`. */
export class QCorridor {
	private readonly pts: readonly QPt[];
	private readonly nearUm: bigint;
	private readonly farUm: bigint;
	private readonly maxPen: bigint;
	readonly S: bigint;
	constructor(fixes: readonly QPt[], profile: QMatchProfile) {
		this.pts = fixes;
		this.nearUm = profile.corridorNearUm;
		this.farUm = profile.corridorFarUm;
		this.maxPen = profile.corridorMaxPenalty;
		this.S = profile.corridorFarUm - profile.corridorNearUm;
	}
	distTo(p: QPt): bigint {
		if (this.pts.length === 0) return 0n;
		if (this.pts.length === 1) return qDist(p, this.pts[0]);
		let best = this.farUm;
		for (let i = 1; i < this.pts.length; i++) {
			const a = this.pts[i - 1];
			const b = this.pts[i];
			if (latGapUm(p, a, b) >= best) continue;
			const c = cosQ((a.la + b.la) / 2n);
			const bx = ((b.lo - a.lo) * 11132n * c) >> 20n;
			const vy = (b.la - a.la) * 11132n;
			const px = ((p.lo - a.lo) * 11132n * c) >> 20n;
			const py = (p.la - a.la) * 11132n;
			const len2 = bx * bx + vy * vy;
			let d: bigint;
			if (len2 === 0n) d = qDist(p, a);
			else {
				let dot = px * bx + py * vy;
				if (dot < 0n) dot = 0n;
				else if (dot > len2) dot = len2;
				const foot: QPt = {
					la: a.la + roundDiv(dot * (b.la - a.la), len2),
					lo: a.lo + roundDiv(dot * (b.lo - a.lo), len2),
					ts: 0n,
				};
				d = qDist(p, foot);
			}
			if (d < best) best = d;
		}
		return best;
	}
	/** The ramp times `S`: `S` at/below `nearUm`, `S·maxPen` at/above
	 *  `farUm`, linear between — the float penalty's exact total order. */
	penScaled(d: bigint): bigint {
		if (d <= this.nearUm) return this.S;
		if (d >= this.farUm) return this.S * this.maxPen;
		return this.S + (this.maxPen - 1n) * (d - this.nearUm);
	}
	edgeWeightScaled(a: QPt, b: QPt): bigint {
		const mid: QPt = { la: (a.la + b.la) / 2n, lo: (a.lo + b.lo) / 2n, ts: 0n };
		return qDist(a, b) * this.penScaled(this.distTo(mid));
	}
}

/** Even-odd ray cast, cross-multiplied exact (the float side divides). */
function qPointInRing(p: QPt, ring: readonly QPt[]): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const yi = ring[i].la;
		const xi = ring[i].lo;
		const yj = ring[j].la;
		const xj = ring[j].lo;
		if (yi > p.la !== yj > p.la) {
			const dy = yj - yi;
			const lhs = (p.lo - xi) * dy;
			const rhs = (xj - xi) * (p.la - yi);
			if (dy > 0n ? lhs < rhs : lhs > rhs) inside = !inside;
		}
	}
	return inside;
}

/** `BuildingPenalty`'s twin: 3 m samples on the 1e-7° grid, all-rings
 *  scan behind an exact integer bbox reject (the float side's buckets
 *  are exact by the bbox-cover argument), all-fixes support scan. */
export class QBuildings {
	private readonly rings: QPt[][];
	private readonly boxes: Array<{ minLa: bigint; maxLa: bigint; minLo: bigint; maxLo: bigint }> = [];
	private readonly memo = new Map<string, bigint>();
	constructor(
		buildings: readonly (readonly QPt[])[],
		private readonly fixes: readonly QPt[],
		private readonly crossFactor: bigint,
		private readonly supportUm: bigint,
	) {
		this.rings = buildings.filter((r) => r.length >= 3).map((r) => [...r]);
		for (const ring of this.rings) {
			let minLa = ring[0].la;
			let maxLa = ring[0].la;
			let minLo = ring[0].lo;
			let maxLo = ring[0].lo;
			for (const p of ring) {
				if (p.la < minLa) minLa = p.la;
				if (p.la > maxLa) maxLa = p.la;
				if (p.lo < minLo) minLo = p.lo;
				if (p.lo > maxLo) maxLo = p.lo;
			}
			this.boxes.push({ minLa, maxLa, minLo, maxLo });
		}
	}

	private inAnyRing(p: QPt): boolean {
		for (let i = 0; i < this.rings.length; i++) {
			const b = this.boxes[i];
			if (p.la < b.minLa || p.la > b.maxLa || p.lo < b.minLo || p.lo > b.maxLo) continue;
			if (qPointInRing(p, this.rings[i])) return true;
		}
		return false;
	}

	private fixSupports(p: QPt): boolean {
		for (const f of this.fixes) {
			if (absB(f.la - p.la) * 11132n > this.supportUm) continue;
			if (qDist(p, f) <= this.supportUm) return true;
		}
		return false;
	}

	factorOnce(a: QPt, b: QPt): bigint {
		const len = qDist(a, b);
		let n = (len + BUILDING_SAMPLE_STEP_UM - 1n) / BUILDING_SAMPLE_STEP_UM;
		if (n < 1n) n = 1n;
		for (let k = 0n; k <= n; k++) {
			const s: QPt = {
				la: a.la + roundDiv(k * (b.la - a.la), n),
				lo: a.lo + roundDiv(k * (b.lo - a.lo), n),
				ts: 0n,
			};
			if (this.inAnyRing(s) && !this.fixSupports(s)) return this.crossFactor;
		}
		return 1n;
	}

	factor(a: QPt, b: QPt): bigint {
		const key = `${a.la},${a.lo},${b.la},${b.lo}`;
		const hit = this.memo.get(key);
		if (hit !== undefined) return hit;
		const out = this.factorOnce(a, b);
		this.memo.set(key, out);
		return out;
	}
}

export interface QSeg {
	u: number;
	v: number;
	lenUm: bigint;
	name: string | null | undefined;
}

export interface QGraph {
	vertices: QPt[];
	adj: Array<Array<{ to: number; e: number }>>;
	segments: QSeg[];
	weightOf: (e: number) => bigint;
}

/** `buildRoadGraph`'s twin. Vertex keys are the raw integer pair —
 *  `vertexDp: 7` makes the float `toFixed(7)` key the same grid. Bridge
 *  candidates come from a plain `i < j` scan (the float grid hash is a
 *  conservative-exact prefilter); the kept set is identical, the
 *  adjacency ORDER of bridges is j-ascending here vs bucket order there
 *  (equal-weight tie class, measured). */
export function buildQGraph(
	ways: readonly QWay[],
	corridor: QCorridor,
	profile: QMatchProfile,
	bld: QBuildings | null,
): QGraph {
	const vertices: QPt[] = [];
	const adj: Array<Array<{ to: number; e: number }>> = [];
	const segments: QSeg[] = [];
	const idByKey = new Map<string, number>();
	const edgeCoords: QPt[] = [];
	const weights: Array<bigint | undefined> = [];

	const vertexId = (p: QPt): number => {
		const key = `${p.la},${p.lo}`;
		let id = idByKey.get(key);
		if (id === undefined) {
			id = vertices.length;
			idByKey.set(key, id);
			vertices.push({ la: p.la, lo: p.lo, ts: 0n });
			adj.push([]);
		}
		return id;
	};
	const addEdge = (a: number, b: number, ap: QPt, bp: QPt): void => {
		if (a === b) return;
		const e = weights.length;
		weights.push(undefined);
		edgeCoords.push(ap, bp);
		adj[a].push({ to: b, e });
		adj[b].push({ to: a, e });
	};

	for (const way of ways) {
		let prev = -1;
		let prevPt: QPt | null = null;
		for (const p of way.coords) {
			const id = vertexId(p);
			if (prev >= 0 && id !== prev && prevPt !== null) {
				addEdge(prev, id, prevPt, p);
				segments.push({ u: prev, v: id, lenUm: qDist(prevPt, p), name: way.name });
			}
			prev = id;
			prevPt = p;
		}
	}

	// bridgeGaps: connect near-coincident vertices of different ways.
	const gap = profile.gapBridgeUm;
	const gapSq = gap * gap + 2n * gap; // qDist ≤ gap ⟺ dla²+dlo² ≤ gap²+2·gap
	for (let i = 0; i < vertices.length; i++) {
		const vi = vertices[i];
		for (let j = i + 1; j < vertices.length; j++) {
			const vj = vertices[j];
			const dla = (vj.la - vi.la) * 11132n;
			if (absB(dla) > gap) continue;
			const c = cosQ((vi.la + vj.la) / 2n);
			const dlo = ((vj.lo - vi.lo) * 11132n * c) >> 20n;
			if (dla * dla + dlo * dlo > gapSq) continue;
			if (adj[i].some((e) => e.to === j)) continue;
			addEdge(i, j, vi, vj);
		}
	}

	const weightOf = (e: number): bigint => {
		let w = weights[e];
		if (w === undefined) {
			const a = edgeCoords[e * 2];
			const b = edgeCoords[e * 2 + 1];
			const bf = bld ? bld.factor(a, b) : 1n;
			w = corridor.edgeWeightScaled(a, b) * bf;
			weights[e] = w;
		}
		return w;
	};
	return { vertices, adj, segments, weightOf };
}

export interface QCand {
	la: bigint;
	lo: bigint;
	dist: bigint;
	si: number;
	tn: bigint;
	td: bigint;
}

/** `candidatesForFix`'s twin: scan every segment (the float grid is a
 *  conservative-exact prefilter), keep projections within the radius,
 *  sort by distance with segment index as the tie-break. */
export function qCandidatesForFix(fix: QPt, graph: QGraph, radiusUm: bigint, maxCandidates: number): QCand[] {
	const cands: QCand[] = [];
	for (let si = 0; si < graph.segments.length; si++) {
		const s = graph.segments[si];
		const a = graph.vertices[s.u];
		const b = graph.vertices[s.v];
		if (latGapUm(fix, a, b) > radiusUm) continue;
		const proj = qProject(fix, a, b);
		if (proj.dist <= radiusUm) cands.push({ la: proj.la, lo: proj.lo, dist: proj.dist, si, tn: proj.tn, td: proj.td });
	}
	cands.sort((p, q) => (p.dist < q.dist ? -1 : p.dist > q.dist ? 1 : p.si - q.si));
	return cands.slice(0, maxCandidates);
}

class QHeap {
	private readonly heap: Array<{ p: bigint; v: number }> = [];
	get size(): number {
		return this.heap.length;
	}
	push(p: bigint, v: number): void {
		const h = this.heap;
		h.push({ p, v });
		let i = h.length - 1;
		while (i > 0) {
			const parent = (i - 1) >> 1;
			if (h[parent].p <= h[i].p) break;
			[h[parent], h[i]] = [h[i], h[parent]];
			i = parent;
		}
	}
	pop(): { p: bigint; v: number } | undefined {
		const h = this.heap;
		const top = h[0];
		if (top === undefined) return undefined;
		const last = h.pop();
		if (last !== undefined && h.length > 0) {
			h[0] = last;
			let i = 0;
			for (;;) {
				const l = 2 * i + 1;
				const r = 2 * i + 2;
				let s = i;
				if (l < h.length && h[l].p < h[s].p) s = l;
				if (r < h.length && h[r].p < h[s].p) s = r;
				if (s === i) break;
				[h[s], h[i]] = [h[i], h[s]];
				i = s;
			}
		}
		return top;
	}
}

class QLazyDijkstra {
	readonly dist: Array<bigint | null>;
	readonly prev: Int32Array;
	private readonly done: Uint8Array;
	private readonly heap = new QHeap();
	private exhausted = false;
	constructor(
		private readonly graph: QGraph,
		source: number,
		private readonly maxRadiusW: bigint,
	) {
		const n = graph.vertices.length;
		this.dist = new Array<bigint | null>(n).fill(null);
		this.prev = new Int32Array(n).fill(-1);
		this.done = new Uint8Array(n);
		this.dist[source] = 0n;
		this.heap.push(0n, source);
	}

	settle(target: number): void {
		if (this.done[target] === 1 || this.exhausted) return;
		while (this.heap.size > 0) {
			const cur = this.heap.pop();
			if (cur === undefined) break;
			const u = cur.v;
			if (this.done[u]) continue;
			this.done[u] = 1;
			if (cur.p > this.maxRadiusW) {
				this.exhausted = true;
				return;
			}
			for (const e of this.graph.adj[u]) {
				const nd = cur.p + this.graph.weightOf(e.e);
				const dv = this.dist[e.to];
				if (dv === null || nd < dv) {
					this.dist[e.to] = nd;
					this.prev[e.to] = u;
					this.heap.push(nd, e.to);
				}
			}
			if (u === target) return;
		}
		this.exhausted = true;
	}
}

class QRouteCache {
	private readonly cache = new Map<number, QLazyDijkstra>();
	constructor(
		private readonly graph: QGraph,
		private readonly maxRadiusW: bigint,
	) {}
	from(source: number): QLazyDijkstra {
		let r = this.cache.get(source);
		if (r === undefined) {
			r = new QLazyDijkstra(this.graph, source, this.maxRadiusW);
			this.cache.set(source, r);
		}
		return r;
	}
}

const candPt = (c: QCand): QPt => ({ la: c.la, lo: c.lo, ts: 0n });

/** `routeBetween`'s twin. Offsets and the same-segment hop are µm via
 *  `roundDiv`, lifted into the `S`-scaled weighted domain for the
 *  comparisons; the reported distance stays the true metric length. */
function qRouteBetween(
	a: QCand,
	b: QCand,
	graph: QGraph,
	cache: QRouteCache,
	bld: QBuildings | null,
	S: bigint,
): { distUm: bigint; verts: QPt[] } | null {
	const sa = graph.segments[a.si];
	const sb = graph.segments[b.si];
	let best: { weighted: bigint; verts: QPt[] } | null = null;
	if (sa.u === sb.u && sa.v === sb.v) {
		const distUm = roundDiv(absB(b.tn - a.tn) * sa.lenUm, a.td);
		const verts: QPt[] = [candPt(a), candPt(b)];
		const bf = bld ? bld.factor(verts[0], verts[1]) : 1n;
		if (bf === 1n) return { distUm, verts };
		best = { weighted: distUm * S * bf, verts };
	}

	const offsetFactor = (c: QCand, vid: number): bigint => {
		if (!bld) return 1n;
		return bld.factor(candPt(c), graph.vertices[vid]);
	};
	const aEnds = [
		{ vid: sa.u, offsetW: roundDiv(a.tn * sa.lenUm, a.td) * offsetFactor(a, sa.u) * S },
		{ vid: sa.v, offsetW: roundDiv((a.td - a.tn) * sa.lenUm, a.td) * offsetFactor(a, sa.v) * S },
	];
	const bEnds = [
		{ vid: sb.u, offsetW: roundDiv(b.tn * sb.lenUm, b.td) * offsetFactor(b, sb.u) * S },
		{ vid: sb.v, offsetW: roundDiv((b.td - b.tn) * sb.lenUm, b.td) * offsetFactor(b, sb.v) * S },
	];
	for (const ae of aEnds) {
		const rd = cache.from(ae.vid);
		for (const be of bEnds) {
			rd.settle(be.vid);
			const mid = rd.dist[be.vid];
			if (mid === null) continue;
			const weighted = ae.offsetW + mid + be.offsetW;
			if (best && weighted >= best.weighted) continue;
			const idPath: number[] = [];
			for (let v = be.vid; v !== -1; v = rd.prev[v]) idPath.push(v);
			idPath.reverse();
			if (idPath[0] !== ae.vid) continue;
			const verts: QPt[] = [candPt(a)];
			for (const vid of idPath) verts.push(graph.vertices[vid]);
			verts.push(candPt(b));
			const kept = qDedupeKeep(verts).map((i) => verts[i]);
			best = { weighted, verts: kept };
		}
	}
	return best ? { distUm: qPathLength(best.verts), verts: best.verts } : null;
}

function qAppendInterpolated(out: QPt[], verts: readonly QPt[], startTs: bigint, endTs: bigint): void {
	if (verts.length === 0) return;
	const cum: bigint[] = [0n];
	for (let i = 1; i < verts.length; i++) cum.push(cum[i - 1] + qDist(verts[i - 1], verts[i]));
	const total = cum[cum.length - 1];
	for (let i = 1; i < verts.length; i++) {
		const ts = total > 0n ? startTs + roundDiv((endTs - startTs) * cum[i], total) : endTs;
		out.push({ la: verts[i].la, lo: verts[i].lo, ts });
	}
}

export interface QMatchResult {
	path: QPt[];
	routeDetail: QPt[];
}

/** `matchTrajectory`'s twin. */
export function qMatchTrajectory(
	fixes: readonly QPt[],
	ways: readonly QWay[],
	buildings: readonly (readonly QPt[])[],
	profile: QMatchProfile,
): QMatchResult | null {
	if (fixes.length < profile.minFixes) return null;

	const corridor = new QCorridor(fixes, profile);
	const bld =
		profile.buildingCrossFactor > 1n && buildings.length > 0
			? new QBuildings(buildings, fixes, profile.buildingCrossFactor, profile.buildingSupportUm)
			: null;
	const graph = buildQGraph(ways, corridor, profile, bld);
	if (graph.segments.length === 0) return null;

	const obs: Array<{ fix: QPt; cands: QCand[] }> = [];
	let roadless = 0;
	for (const fix of fixes) {
		const cands = qCandidatesForFix(fix, graph, profile.radiusUm, profile.maxCandidatesPerFix);
		if (cands.length === 0) roadless++;
		else obs.push({ fix, cands });
	}
	if (BigInt(roadless) * profile.maxRoadlessDen > BigInt(fixes.length) * profile.maxRoadlessNum) return null;
	if (obs.length < profile.minFixes) return null;

	let maxStep = 0n;
	for (let i = 1; i < obs.length; i++) {
		const d = qDist(obs[i - 1].fix, obs[i].fix);
		if (d > maxStep) maxStep = d;
	}
	const S = corridor.S;
	const cache = new QRouteCache(
		graph,
		(maxStep * profile.detourFactor + profile.detourSlackUm) * profile.corridorMaxPenalty * S,
	);

	// Score scale 2σ²β: emission −½(d/σ)² → −d²·β; transition −|Δ|/β →
	// −|Δ|·2σ²; way-continuity −nats → −nats·2σ²β. null = −∞.
	const sig2x2 = 2n * profile.sigmaUm * profile.sigmaUm;
	const switchPenScaled = profile.wayContinuityNats * sig2x2 * profile.betaUm;
	const emissionScaled = (d: bigint): bigint => -(d * d * profile.betaUm);

	const n = obs.length;
	const score: Array<Array<bigint | null>> = [];
	const back: number[][] = [];
	const routeOf: Array<Array<Array<{ distUm: bigint; verts: QPt[] } | null>>> = [];

	score.push(obs[0].cands.map((c) => emissionScaled(c.dist)));
	back.push(obs[0].cands.map(() => -1));

	for (let t = 1; t < n; t++) {
		const prev = obs[t - 1];
		const cur = obs[t];
		const gpsStep = qDist(prev.fix, cur.fix);
		const row: Array<bigint | null> = [];
		const brow: number[] = [];
		const rmat: Array<Array<{ distUm: bigint; verts: QPt[] } | null>> = [];
		for (let j = 0; j < cur.cands.length; j++) {
			let bestScore: bigint | null = null;
			let bestPrev = -1;
			const rrow: Array<{ distUm: bigint; verts: QPt[] } | null> = [];
			for (let i = 0; i < prev.cands.length; i++) {
				const route = qRouteBetween(prev.cands[i], cur.cands[j], graph, cache, bld, S);
				rrow.push(route);
				if (route === null) continue;
				const prevScore = score[t - 1][i];
				if (prevScore === null) continue;
				const trans = -(absB(route.distUm - gpsStep) * sig2x2);
				// Truthiness mirrors the float side: null/undefined/"" all skip.
				const wa = graph.segments[prev.cands[i].si].name;
				const wb = graph.segments[cur.cands[j].si].name;
				const switchPen = wa && wb && wa !== wb ? switchPenScaled : 0n;
				const s = prevScore + trans - switchPen + emissionScaled(cur.cands[j].dist);
				if (bestScore === null || s > bestScore) {
					bestScore = s;
					bestPrev = i;
				}
			}
			row.push(bestScore);
			brow.push(bestPrev);
			rmat.push(rrow);
		}
		if (row.every((s) => s === null)) return null;
		score.push(row);
		back.push(brow);
		routeOf.push(rmat);
	}

	let endJ = 0;
	let endBest: bigint | null = null;
	for (let j = 0; j < score[n - 1].length; j++) {
		const s = score[n - 1][j];
		if (s !== null && (endBest === null || s > endBest)) {
			endBest = s;
			endJ = j;
		}
	}
	if (endBest === null) return null;
	const chosen = new Int32Array(n);
	chosen[n - 1] = endJ;
	for (let t = n - 1; t > 0; t--) {
		const bp = back[t][chosen[t]];
		if (bp < 0) return null;
		chosen[t - 1] = bp;
	}

	const out: QPt[] = [];
	const first = obs[0].cands[chosen[0]];
	out.push({ la: first.la, lo: first.lo, ts: obs[0].fix.ts });
	for (let t = 1; t < n; t++) {
		const route = routeOf[t - 1][chosen[t]][chosen[t - 1]];
		if (route === null) return null;
		qAppendInterpolated(out, route.verts, obs[t - 1].fix.ts, obs[t].fix.ts);
	}

	const simplified = qSimplifyKeep(out, profile.simplifyTolUm).map((i) => out[i]);
	const cleaned = qRemoveSpurs(simplified, profile.spurReturnUm, profile.spurMaxSpanVerts);
	if (cleaned.length < 2) return null;
	const rawLen = qPathLength(fixes);
	if (qPathLength(cleaned) * profile.maxLenDen > rawLen * profile.maxLenNum + profile.maxLenSlackUm * profile.maxLenDen)
		return null;

	return { path: cleaned, routeDetail: out };
}

/** `spliceRouteDetail`'s twin — vertex identity is exact integer
 *  equality (the float side matches within 1e-9°, far under the grid). */
export function qSpliceRouteDetail(coarse: readonly QPt[], route: readonly QPt[], dropUm: bigint): QPt[] {
	if (coarse.length < 2 || route.length < 2) return [...coarse];
	const indexOf = (p: QPt, from: number): number => {
		for (let k = from; k < route.length; k++) {
			if (route[k].la === p.la && route[k].lo === p.lo) return k;
		}
		return -1;
	};
	const chordDist = (p: QPt, a: QPt, b: QPt): bigint => qProject(p, a, b).dist;
	const out: QPt[] = [coarse[0]];
	let ia = indexOf(coarse[0], 0);
	for (let i = 1; i < coarse.length; i++) {
		const a = coarse[i - 1];
		const b = coarse[i];
		const ib = ia >= 0 ? indexOf(b, ia + 1) : -1;
		if (ia >= 0 && ib > ia + 1) {
			let maxDev = 0n;
			for (let k = ia + 1; k < ib; k++) {
				const d = chordDist(route[k], a, b);
				if (d > maxDev) maxDev = d;
			}
			if (maxDev > DETAIL_TOLERANCE_UM && maxDev <= dropUm) {
				for (let k = ia + 1; k < ib; k++) {
					const prev = out[out.length - 1];
					if (qDist(prev, route[k]) < DEDUPE_UM) continue;
					let ts = route[k].ts;
					if (ts < a.ts) ts = a.ts;
					if (ts > b.ts) ts = b.ts;
					out.push({ la: route[k].la, lo: route[k].lo, ts });
				}
			}
		}
		out.push(b);
		ia = ib >= 0 ? ib : indexOf(b, 0);
	}
	return out;
}

export interface QWalkMatchResult {
	path: QPt[];
	coarsePath: QPt[];
}

/** `matchWalkSegment`'s twin (walk profile, trim + despike + splice). */
export function qMatchWalkSegment(
	fixes: readonly QPt[],
	ways: readonly QWay[],
	buildings: readonly (readonly QPt[])[],
): QWalkMatchResult | null {
	const result = qMatchTrajectory(fixes, ways, buildings, WALK_QPROFILE);
	if (result === null) return null;
	const trimmed = qTrim(fixes, result.path);
	const cleaned = qDespikeKeep(trimmed, fixes, 15_000_000n, 12_000_000n).map((i) => trimmed[i]);
	return {
		path: qSpliceRouteDetail(cleaned, result.routeDetail, WALK_QPROFILE.simplifyTolUm),
		coarsePath: cleaned,
	};
}
