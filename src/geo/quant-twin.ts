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
