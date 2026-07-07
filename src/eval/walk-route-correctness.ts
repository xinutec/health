/**
 * Truth-anchored route-correctness — the honest referee for a drawn walk, the
 * gate the off-walkable and corridor-stall proxies cannot be
 * (`docs/proposals/geometry-roadmap.md`, Phase 0).
 *
 * The confirmed ground-truth narratives name the street a walk ran along
 * ("walking on Barn Rise"). This measures what fraction of the DRAWN line's
 * length actually runs along that named street. The discriminating property:
 * it judges by NAME, not geometry, so
 *
 *   - an invented detour onto a *different* street drops the fraction (the
 *     failure class off-walkable-p90 rewards — the line hugs *a* pavement, just
 *     the wrong one), while
 *   - a genuine there-and-back on the SAME street keeps it high (the false
 *     positive that a corridor-stall gate would wrongly flag).
 *
 * It is a proxy, not perfect: the narrative names only the dominant street, so a
 * faithful walk that also crosses a connector scores below 1. It is therefore
 * used as a baseline-vs-candidate DELTA (did the change move more of the line
 * onto the wrong street?), not an absolute pass mark. Pure and deterministic.
 */

import type { RoadGeometry } from "../geo/road-match.js";
import type { LatLon } from "./walk-score.js";

/** Normalise a street name for comparison: lowercase, collapse internal
 *  whitespace, trim. "  Barn   Rise " and "barn rise" compare equal. */
export function normaliseWayName(name: string): string {
	return name.toLowerCase().replace(/\s+/g, " ").trim();
}

function metersBetween(a: LatLon, b: LatLon): number {
	const dLat = (b.lat - a.lat) * 111_320;
	const dLon = (b.lon - a.lon) * 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
	return Math.hypot(dLat, dLon);
}

/** Nearest walkable way to `p` with a name, as `{ name, distM }`, or null when
 *  no named way is within `radiusM`. Unnamed ways are ignored — an unnamed
 *  footway can't corroborate a named-street claim either way. */
function nearestNamedWay(p: LatLon, roads: RoadGeometry, radiusM: number): { name: string; distM: number } | null {
	let best: { name: string; distM: number } | null = null;
	for (const w of roads.ways) {
		if (!w.name) continue;
		for (let i = 1; i < w.coords.length; i++) {
			const a = { lat: w.coords[i - 1][0], lon: w.coords[i - 1][1] };
			const b = { lat: w.coords[i][0], lon: w.coords[i][1] };
			const cosLat = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
			const bx = (b.lon - a.lon) * 111_320 * cosLat;
			const by = (b.lat - a.lat) * 111_320;
			const px = (p.lon - a.lon) * 111_320 * cosLat;
			const py = (p.lat - a.lat) * 111_320;
			const len2 = bx * bx + by * by;
			const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len2));
			const d = Math.hypot(px - t * bx, py - t * by);
			if (d <= radiusM && (best === null || d < best.distM)) best = { name: normaliseWayName(w.name), distM: d };
		}
	}
	return best;
}

/**
 * Fraction [0,1] of the drawn line's length whose nearest named walkable way
 * (within `matchRadiusM`) is one of `acceptedNames` (already normalised or not —
 * they are normalised here). The line is sampled into `stepM` sub-segments and
 * each sub-segment's length is attributed by its midpoint's nearest named way,
 * so the result is length-weighted, not vertex-counted.
 *
 * Returns null when there is nothing to score against: no accepted name, no
 * walkable geometry, or a zero-length line.
 */
export function onNamedWayFraction(
	drawn: readonly LatLon[],
	acceptedNames: ReadonlySet<string>,
	walkable: RoadGeometry,
	matchRadiusM = 25,
	stepM = 5,
): number | null {
	if (acceptedNames.size === 0 || walkable.ways.length === 0 || drawn.length < 2) return null;
	const accepted = new Set<string>();
	for (const n of acceptedNames) accepted.add(normaliseWayName(n));

	let total = 0;
	let onNamed = 0;
	for (let i = 1; i < drawn.length; i++) {
		const a = drawn[i - 1];
		const b = drawn[i];
		const segLen = metersBetween(a, b);
		if (segLen === 0) continue;
		const steps = Math.max(1, Math.ceil(segLen / stepM));
		for (let k = 0; k < steps; k++) {
			const f0 = k / steps;
			const f1 = (k + 1) / steps;
			const subLen = segLen * (f1 - f0);
			const midF = (f0 + f1) / 2;
			const mid = { lat: a.lat + (b.lat - a.lat) * midF, lon: a.lon + (b.lon - a.lon) * midF };
			total += subLen;
			const near = nearestNamedWay(mid, walkable, matchRadiusM);
			if (near && accepted.has(near.name)) onNamed += subLen;
		}
	}
	if (total === 0) return null;
	return onNamed / total;
}
