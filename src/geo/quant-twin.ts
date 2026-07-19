/**
 * The BigInt twin of `lean/Verified/Geo/Metric.lean` — the same pinned
 * integer arithmetic, expression by expression, so the `compare-geo`
 * harness can demand bit-identical outputs from the two sides.
 *
 * Division semantics are the contract: BigInt `/` truncates toward zero
 * (= Lean `Int.tdiv`), BigInt `>>` floors (= Lean `Int.fdiv`); `isqrt`
 * is the identical Newton loop. Coordinates are 1e-7° integers,
 * distances µm, cos is the Q20 degree-6 minimax polynomial. See the
 * Lean file's docstring for the corpus probe that pinned all of this.
 *
 * The pass twins mirror the Lean recursion shapes (`simplifyIdx`,
 * `holdSpeed`, `rejectSpikes`), which the Lean files' porting notes tie
 * to the production TS forms. `spliceRouteDetail`'s twin waits for the
 * matcher-level harness (its inputs are matcher internals).
 */

export interface QPt {
	la: bigint;
	lo: bigint;
	ts: bigint;
}

/** Quantise a float fix to the pinned representation. */
export function quantPt(p: { lat: number; lon: number; ts?: number }): QPt {
	return {
		la: BigInt(Math.round(p.lat * 1e7)),
		lo: BigInt(Math.round(p.lon * 1e7)),
		ts: BigInt(Math.round(p.ts ?? 0)),
	};
}

const Q = 20n;
/** round(π/180 · 2^40) — the Lean literal. */
const RAD_Q40 = 19190098069n;
/** 1e7 · 2^20. */
const DIVX = 10485760000000n;

/** Q20 fixed-point cos of a 1e-7°-unit latitude (integer Horner). */
export function cosQ(la: bigint): bigint {
	const abs = la < 0n ? -la : la;
	const x = (abs * RAD_Q40) / DIVX;
	const x2 = (x * x) >> Q;
	let r = -1453n;
	r = ((r * x2) >> Q) + 43687n;
	r = ((r * x2) >> Q) - 524287n;
	return ((r * x2) >> Q) + 1048576n;
}

/** Newton floor square root — the identical loop to Lean's `isqrt`. */
export function isqrt(n: bigint): bigint {
	if (n < 2n) return n;
	let x = n;
	let y = (n + 1n) / 2n;
	while (y < x) {
		x = y;
		y = (x + n / x) / 2n;
	}
	return x;
}

/** µm between two points, cos at the mid-latitude (`qDist`). */
export function qDist(a: QPt, b: QPt): bigint {
	const dla = (b.la - a.la) * 11132n;
	const c = cosQ((a.la + b.la) / 2n);
	const dlo = ((b.lo - a.lo) * 11132n * c) >> Q;
	return isqrt(dla * dla + dlo * dlo);
}

/** µm between two points, cos at the first point (`qDistA`). */
export function qDistA(a: QPt, b: QPt): bigint {
	const dla = (b.la - a.la) * 11132n;
	const c = cosQ(a.la);
	const dlo = ((b.lo - a.lo) * 11132n * c) >> Q;
	return isqrt(dla * dla + dlo * dlo);
}

function roundDiv(p: bigint, q: bigint): bigint {
	return p >= 0n ? (p + q / 2n) / q : -((-p + q / 2n) / q);
}

/** µm from `p` to the segment `a`–`b` (`qChordDist`). */
export function qChordDist(p: QPt, a: QPt, b: QPt): bigint {
	const c = cosQ((a.la + b.la) / 2n);
	const bx = ((b.lo - a.lo) * 11132n * c) >> Q;
	const vy = (b.la - a.la) * 11132n;
	const px = ((p.lo - a.lo) * 11132n * c) >> Q;
	const py = (p.la - a.la) * 11132n;
	const len2 = bx * bx + vy * vy;
	if (len2 === 0n) return qDist(p, a);
	let dot = px * bx + py * vy;
	if (dot < 0n) dot = 0n;
	else if (dot > len2) dot = len2;
	const foot: QPt = {
		la: a.la + roundDiv(dot * (b.la - a.la), len2),
		lo: a.lo + roundDiv(dot * (b.lo - a.lo), len2),
		ts: 0n,
	};
	return qDist(p, foot);
}

/** `qSimplify` keep set (Lean's recursive `keepBetween`; same set as the
 *  production stack form — segment outcomes are order-independent). */
export function qSimplifyKeep(pts: readonly QPt[], tolUm: bigint): number[] {
	if (pts.length <= 2) return pts.map((_, i) => i);
	const keep: number[] = [0];
	const between = (a: number, b: number): void => {
		let maxd = 0n;
		let idx = 0;
		for (let i = a + 1; i < b; i++) {
			const d = qChordDist(pts[i], pts[a], pts[b]);
			if (maxd < d) {
				maxd = d;
				idx = i;
			}
		}
		if (tolUm < maxd) {
			between(a, idx);
			keep.push(idx);
			between(idx, b);
		}
	};
	between(0, pts.length - 1);
	keep.push(pts.length - 1);
	return keep;
}

/** `qHoldSpeed` kept indices: earliest longest plausible-speed run;
 *  the speed test is the exact cross-multiplied integer form. */
export function qHoldSpeedKeep(fixes: readonly QPt[], capKmh: bigint): number[] {
	if (fixes.length < 2) return fixes.map((_, i) => i);
	const runFrom = (s: number): number[] => {
		const keep = [s];
		for (let i = s + 1; i < fixes.length; i++) {
			const last = fixes[keep[keep.length - 1]];
			const dt = fixes[i].ts - last.ts;
			if (dt > 0n && 36n * qDistA(last, fixes[i]) <= capKmh * dt * 10000000n) keep.push(i);
		}
		return keep;
	};
	let best: number[] = [];
	for (let s = 0; s < fixes.length; s++) {
		const run = runFrom(s);
		if (best.length < run.length) best = run;
	}
	return best;
}

/** µm from `p` to the infinite line `a`–`b` (`qPerp`). */
export function qPerp(p: QPt, a: QPt, b: QPt): bigint {
	const c = cosQ((a.la + b.la) / 2n);
	const bx = ((b.lo - a.lo) * 11132n * c) >> Q;
	const vy = (b.la - a.la) * 11132n;
	const px = ((p.lo - a.lo) * 11132n * c) >> Q;
	const py = (p.la - a.la) * 11132n;
	const len2 = bx * bx + vy * vy;
	if (len2 === 0n) return isqrt(px * px + py * py);
	const cross = px * vy - py * bx;
	return (cross < 0n ? -cross : cross) / isqrt(len2);
}

/** The ≥140° turn test as the exact squared comparison (`qTurnOk`). */
export function qTurnOk(a: QPt, c: QPt, b: QPt): boolean {
	const cl = cosQ(c.la);
	const ux = (c.lo - a.lo) * cl;
	const uy = (c.la - a.la) * 1048576n;
	const vx = (b.lo - c.lo) * cl;
	const vy = (b.la - c.la) * 1048576n;
	const un2 = ux * ux + uy * uy;
	const vn2 = vx * vx + vy * vy;
	if (un2 === 0n || vn2 === 0n) return false;
	const dot = ux * vx + uy * vy;
	return dot <= 0n && dot * dot * 1000000000n >= 586824089n * un2 * vn2;
}

/** The corridor-position arc interpolation (`qArcPos`). */
export function qArcPos(v: QPt, a: QPt, b: QPt, arcA: bigint, arcB: bigint): bigint {
	const c = cosQ((a.la + b.la) / 2n);
	const bx = ((b.lo - a.lo) * 11132n * c) >> Q;
	const vy = (b.la - a.la) * 11132n;
	const px = ((v.lo - a.lo) * 11132n * c) >> Q;
	const py = (v.la - a.la) * 11132n;
	const len2 = bx * bx + vy * vy;
	if (len2 === 0n) return arcA;
	let dot = px * bx + py * vy;
	if (dot < 0n) dot = 0n;
	else if (dot > len2) dot = len2;
	return arcA + roundDiv(dot * (arcB - arcA), len2);
}

/** `qDedupe` kept indices (strict `< 0.5 m`). */
export function qDedupeKeep(pts: readonly QPt[]): number[] {
	if (pts.length === 0) return [];
	const keep = [0];
	for (let i = 1; i < pts.length; i++) {
		if (qDist(pts[keep[keep.length - 1]], pts[i]) < 500000n) continue;
		keep.push(i);
	}
	return keep;
}

/** `qRemoveSpurs` — the Lean `spurGo` recursion over the mutated list. */
export function qRemoveSpurs(pts: readonly QPt[], retUm: bigint, maxSpan: number): QPt[] {
	const go = (l: readonly QPt[]): QPt[] => {
		if (l.length === 0) return [];
		const [x, ...rest] = l;
		if (rest.length < 2) return [x, ...rest];
		const kHi = Math.min(maxSpan - 1, rest.length - 1);
		for (let k = kHi; k >= 1; k--) {
			if (qDist(x, rest[k]) <= retUm) return [x, ...go(rest.slice(k + 1))];
		}
		return [x, ...go(rest)];
	};
	return go(pts);
}

/** `qDespike` kept indices. */
export function qDespikeKeep(path: readonly QPt[], raw: readonly QPt[], minApexUm: bigint, excessUm: bigint): number[] {
	if (path.length < 3) return path.map((_, i) => i);
	const keep: number[] = [];
	for (let i = 0; i < path.length; i++) {
		if (i === 0 || i === path.length - 1) {
			keep.push(i);
			continue;
		}
		const a = path[i - 1];
		const c = path[i];
		const b = path[i + 1];
		const h = qPerp(c, a, b);
		let drop = false;
		if (h >= minApexUm && qTurnOk(a, c, b)) {
			const t0 = a.ts < b.ts ? a.ts : b.ts;
			const t1 = a.ts < b.ts ? b.ts : a.ts;
			const win = raw.filter((f) => t0 <= f.ts && f.ts <= t1);
			if (win.length > 0) {
				let rawH = 0n;
				for (const f of win) {
					const fh = qPerp(f, a, b);
					if (fh > rawH) rawH = fh;
				}
				drop = rawH + excessUm <= h;
			}
		}
		if (!drop) keep.push(i);
	}
	return keep;
}

/** `qTrim` — the full `trimOverRouteExcursions` twin (default
 *  thresholds baked, like the Lean `qTrimP`). Returns the rebuilt
 *  point list. */
export function qTrim(fixes: readonly QPt[], path: readonly QPt[]): QPt[] {
	const n = path.length;
	const nf = fixes.length;
	if (n < 3 || nf < 2) return [...path];
	const OFF = 30000000n;
	const MIN_STALL = 80000000n;
	const SLACK = 1000000n;
	const fArc: bigint[] = [0n];
	for (let i = 1; i < nf; i++) fArc.push(fArc[i - 1] + qDist(fixes[i - 1], fixes[i]));
	const cum: bigint[] = [0n];
	for (let i = 1; i < n; i++) cum.push(cum[i - 1] + qDist(path[i - 1], path[i]));
	const cp: bigint[] = [];
	let minS = 0n;
	for (const v of path) {
		let best: bigint | null = null;
		let bestS = minS;
		for (let i = 0; i + 1 < nf; i++) {
			const d = qChordDist(v, fixes[i], fixes[i + 1]);
			const s = qArcPos(v, fixes[i], fixes[i + 1], fArc[i], fArc[i + 1]);
			if ((best === null || d < best) && minS - SLACK <= s) {
				best = d;
				bestS = s;
			}
		}
		cp.push(bestS);
		minS = bestS;
	}
	const onc = path.map((v) => fixes.some((f) => qDist(v, f) <= OFF));
	const remove = new Array<boolean>(n).fill(false);
	let k = 0;
	while (k < n) {
		if (onc[k]) {
			k++;
			continue;
		}
		let b = k;
		while (b < n && !onc[b]) b++;
		if (k >= 1 && b < n) {
			const span = cum[b] - cum[k - 1];
			// detourRatio 1/2, cross-multiplied
			if (span >= MIN_STALL && (cp[b] - cp[k - 1]) * 2n < span * 1n) {
				for (let x = k; x < b; x++) remove[x] = true;
			}
		}
		k = b;
	}
	let a = 0;
	while (a < n - 2) {
		if (remove[a]) {
			a++;
			continue;
		}
		let found = -1;
		for (let b = a + 2; b < n; b++) {
			if (remove[b]) break;
			const span = cum[b] - cum[a];
			if (span < MIN_STALL) continue;
			const net = qDist(path[a], path[b]);
			// stallRatio 3/20, returnRatio 7/20
			if ((cp[b] - cp[a]) * 20n < span * 3n && net * 20n < span * 7n) found = b;
		}
		if (found >= 0) {
			for (let x = a + 1; x < found; x++) remove[x] = true;
			a = found;
		} else a++;
	}
	const out: QPt[] = [];
	for (let idx = 0; idx < n; idx++) {
		if (remove[idx]) continue;
		const prev = out[out.length - 1];
		if (!prev || !(qDist(prev, path[idx]) <= 500000n)) out.push(path[idx]);
	}
	return out;
}

/** `qRejectSpikes` kept indices (500 m = 5·10⁸ µm). */
export function qRejectSpikesKeep(pts: readonly QPt[]): number[] {
	if (pts.length < 3) return pts.map((_, i) => i);
	const keep = [0];
	for (let i = 1; i < pts.length - 1; i++) {
		const prev = pts[keep[keep.length - 1]];
		const direct = qDistA(prev, pts[i + 1]);
		const through = qDistA(prev, pts[i]) + qDistA(pts[i], pts[i + 1]);
		if (through > 3n * direct && through - direct > 500000000n) continue;
		keep.push(i);
	}
	keep.push(pts.length - 1);
	return keep;
}
