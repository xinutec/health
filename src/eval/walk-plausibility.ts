/**
 * Walk-path plausibility — the single, tested source of truth for "how good is
 * this drawn walk", the scoring half of the truth-measurement loop (#296).
 *
 * All session the walk-quality signals were computed ad-hoc and scattered:
 * off-walkable / tortuosity / step-error in {@link scoreWalk} (drawn-path only),
 * corridor-stall inline in the render harness. This module unifies them into one
 * {@link WalkPlausibility} verdict — crucially adding the RAW-vs-matched
 * dimension `scoreWalk` lacks (it never sees the raw fixes), which is what
 * distinguishes an invented over-route from a faithful line.
 *
 * No single number is "truth" — each metric is confounded on its own (that is
 * the lesson of #293/#295). The point is to report them TOGETHER, per walk, so a
 * change is measured across every independent witness at once instead of tuned
 * against one proxy. Pure and deterministic.
 */
import type { RoadGeometry } from "../geo/road-match.js";
import { type LatLon, type PedStep, scoreWalk, type WalkScore } from "./walk-score.js";

const m = (a: LatLon, b: LatLon): number => {
	const dLat = (b.lat - a.lat) * 111_320;
	const dLon = (b.lon - a.lon) * 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
	return Math.hypot(dLat, dLon);
};

/**
 * The longest run of `path` that travels far while its monotone projection onto
 * the time-ordered `fixes` polyline barely advances — an out-and-back that makes
 * no corridor progress (metres). High for an invented detour; ~0 for a faithful
 * line, a gap-fill (corridor advances), or a there-and-back the GPS traced.
 */
export function maxCorridorStall(fixes: readonly LatLon[], path: readonly LatLon[], tolM = 15): number {
	if (path.length < 2 || fixes.length < 2) return 0;
	const fArc = [0];
	for (let i = 1; i < fixes.length; i++) fArc.push(fArc[i - 1] + m(fixes[i - 1], fixes[i]));
	const pArc = [0];
	for (let i = 1; i < path.length; i++) pArc.push(pArc[i - 1] + m(path[i - 1], path[i]));

	// Monotone projection of the path onto the fix polyline — as the MIN-COST
	// monotone assignment (DP), not a greedy nearest-projection ratchet. The
	// greedy version mis-scored out-and-back walks: on a street walked TWICE the
	// locally-nearest projection of an early smoothed vertex could land on the
	// RETURN pass (far arc), ratcheting the floor forward so the whole rest of
	// the walk read as one giant stall (measured: a line ≤ 12 m off a 118 m-stall
	// matched line scored 2169 m). Choosing the jointly-cheapest monotone
	// assignment puts each pass of the drawn line on the pass of the fixes it
	// actually follows; an invented detour still cannot advance (no nearby fixes
	// ahead), so the stall it is meant to catch is unchanged.
	const V = path.length;
	const S = fixes.length - 1;
	const dist = new Float64Array(V * S);
	const arc = new Float64Array(V * S);
	for (let k = 0; k < V; k++) {
		const v = path[k];
		for (let i = 0; i < S; i++) {
			const a = fixes[i];
			const b = fixes[i + 1];
			const cosLat = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
			const bx = (b.lon - a.lon) * 111_320 * cosLat;
			const by = (b.lat - a.lat) * 111_320;
			const px = (v.lon - a.lon) * 111_320 * cosLat;
			const py = (v.lat - a.lat) * 111_320;
			const l2 = bx * bx + by * by || 1e-9;
			const t = Math.max(0, Math.min(1, (px * bx + py * by) / l2));
			dist[k * S + i] = Math.hypot(px - t * bx, py - t * by);
			arc[k * S + i] = fArc[i] + t * (fArc[i + 1] - fArc[i]);
		}
	}
	// DP over (vertex, fix-segment): cost = own projection distance + cheapest
	// predecessor whose arc position is ≤ ours + 1 m (the same 1 m backtrack
	// tolerance the greedy version allowed). Prefix-min over the predecessor
	// candidates sorted by arc makes each step O(S log S).
	let prevCost = new Float64Array(S);
	let cost = new Float64Array(S);
	const parent = new Int32Array(V * S).fill(-1);
	for (let i = 0; i < S; i++) prevCost[i] = dist[i];
	const order = new Array<number>(S);
	const prefixMinCost = new Float64Array(S);
	const prefixMinIdx = new Int32Array(S);
	for (let k = 1; k < V; k++) {
		for (let i = 0; i < S; i++) order[i] = i;
		const prevBase = (k - 1) * S;
		order.sort((x, y) => arc[prevBase + x] - arc[prevBase + y]);
		for (let r = 0; r < S; r++) {
			const c = prevCost[order[r]];
			if (r === 0 || c < prefixMinCost[r - 1]) {
				prefixMinCost[r] = c;
				prefixMinIdx[r] = order[r];
			} else {
				prefixMinCost[r] = prefixMinCost[r - 1];
				prefixMinIdx[r] = prefixMinIdx[r - 1];
			}
		}
		for (let i = 0; i < S; i++) {
			// Last rank whose predecessor arc ≤ this candidate's arc + 1 m.
			const sMax = arc[k * S + i] + 1;
			let lo = 0;
			let hi = S - 1;
			let r = -1;
			while (lo <= hi) {
				const mid = (lo + hi) >> 1;
				if (arc[prevBase + order[mid]] <= sMax) {
					r = mid;
					lo = mid + 1;
				} else hi = mid - 1;
			}
			if (r < 0) {
				cost[i] = Number.POSITIVE_INFINITY;
			} else {
				cost[i] = dist[k * S + i] + prefixMinCost[r];
				parent[k * S + i] = prefixMinIdx[r];
			}
		}
		[prevCost, cost] = [cost, prevCost];
	}
	// Backtrack the optimal assignment into per-vertex corridor positions.
	let bestI = 0;
	for (let i = 1; i < S; i++) if (prevCost[i] < prevCost[bestI]) bestI = i;
	const cp = new Float64Array(V);
	for (let k = V - 1; k >= 0; k--) {
		cp[k] = arc[k * S + bestI];
		if (k > 0) bestI = parent[k * S + bestI] >= 0 ? parent[k * S + bestI] : bestI;
	}

	let j = 0;
	let worst = 0;
	for (let k = 0; k < V; k++) {
		while (cp[k] - cp[j] > tolM) j++;
		worst = Math.max(worst, pArc[k] - pArc[j]);
	}
	return worst;
}

/** Every independent walk-quality witness for one drawn leg, reported together.
 *  Extends {@link WalkScore} (drawn-path metrics) with the raw-vs-matched
 *  corridor stall and the raw track length for reference. */
export interface WalkPlausibility extends WalkScore {
	/** Out-and-back distance the drawn line makes without advancing along the raw
	 *  GPS corridor (m). The over-route signal `scoreWalk` cannot see. */
	corridorStallM: number;
	/** Length of the raw GPS track (m) — the honest baseline the drawn line is
	 *  measured against. */
	rawLengthM: number;
	/** Mean speed implied by the DRAWN line over the leg window (km/h): drawn
	 *  length ÷ (endTs − startTs). The off-walkable/stall witnesses are blind to a
	 *  path that sprints along a pavement — a run of low-accuracy fixes drawn as
	 *  real motion (underground tube, indoor GPS) shows here as an impossible
	 *  walking speed (a real walk is < ~9). 0 when the leg has no duration. */
	avgDrawnSpeedKmh: number;
}

/**
 * Score a drawn walk against ALL independent witnesses at once: the raw GPS
 * `fixes`, the walkable network, and the pedometer. `drawn` is the line the map
 * shows (matched, or raw when the matcher bailed).
 */
export function walkPlausibility(
	fixes: readonly LatLon[],
	drawn: readonly LatLon[],
	startTs: number,
	endTs: number,
	steps: readonly PedStep[] = [],
	walkable: RoadGeometry | null = null,
): WalkPlausibility {
	const base = scoreWalk(drawn, startTs, endTs, steps, walkable);
	let rawLengthM = 0;
	for (let i = 1; i < fixes.length; i++) rawLengthM += m(fixes[i - 1], fixes[i]);
	const spanSec = endTs - startTs;
	const avgDrawnSpeedKmh = spanSec > 0 ? (base.drawnLengthM / spanSec) * 3.6 : 0;
	return { ...base, corridorStallM: maxCorridorStall(fixes, drawn), rawLengthM, avgDrawnSpeedKmh };
}
