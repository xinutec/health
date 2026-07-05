/**
 * Building-crossing referee — the headline metric for a drawn walk that the
 * off-walkable and corridor-stall proxies are structurally blind to
 * (`docs/proposals/2026-07-continuous-field-walk-reconstruction.md`, Phase 0).
 *
 * A graph-snapped walk can cut a diagonal chord across a building block and still
 * score WELL on off-walkable-p90 — a chord lying on a way centreline is "near a
 * walkable way." The one thing that makes that obviously wrong is that the line
 * runs *through a house*. This measures exactly that: the length of the drawn line
 * that lies inside any building footprint. A faithful walk reads 0.
 *
 * Pure and deterministic; geometry only, no DB.
 */

import type { RoadGeometry } from "../geo/map-match-core.js";
import type { BuildingFootprint } from "../geo/osm-local.js";
import type { LatLon } from "./walk-score.js";

function metersBetween(a: LatLon, b: LatLon): number {
	const dLat = (b.lat - a.lat) * 111_320;
	const dLon = (b.lon - a.lon) * 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
	return Math.hypot(dLat, dLon);
}

/**
 * Even-odd ray cast: is `p` inside the closed polygon `ring`? The ring need not
 * repeat its first vertex — the edge from last→first is closed implicitly. Points
 * exactly on an edge are reported inconsistently (as any ray-cast), which is fine
 * for a length metric sampled at sub-metre spacing.
 */
export function pointInRing(p: LatLon, ring: BuildingFootprint): boolean {
	if (ring.length < 3) return false;
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const yi = ring[i].lat;
		const xi = ring[i].lon;
		const yj = ring[j].lat;
		const xj = ring[j].lon;
		const intersects = yi > p.lat !== yj > p.lat && p.lon < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi;
		if (intersects) inside = !inside;
	}
	return inside;
}

function inAnyBuilding(p: LatLon, buildings: readonly BuildingFootprint[]): boolean {
	for (const ring of buildings) if (pointInRing(p, ring)) return true;
	return false;
}

/**
 * Total length (m) of the drawn line lying inside any building footprint. The
 * line is sampled into `stepM` sub-segments and each sub-segment's length is
 * attributed by whether its midpoint is inside a building, so the result is
 * length-weighted. Returns 0 for a degenerate line or an empty building set.
 */
export function buildingCrossingM(
	drawn: readonly LatLon[],
	buildings: readonly BuildingFootprint[],
	stepM = 2,
): number {
	if (drawn.length < 2 || buildings.length === 0) return 0;
	let crossed = 0;
	for (let i = 1; i < drawn.length; i++) {
		const a = drawn[i - 1];
		const b = drawn[i];
		const segLen = metersBetween(a, b);
		if (segLen === 0) continue;
		const steps = Math.max(1, Math.ceil(segLen / stepM));
		for (let k = 0; k < steps; k++) {
			const midF = (k + 0.5) / steps;
			const mid = { lat: a.lat + (b.lat - a.lat) * midF, lon: a.lon + (b.lon - a.lon) * midF };
			if (inAnyBuilding(mid, buildings)) crossed += segLen / steps;
		}
	}
	return crossed;
}

/** A drawn point within this (m) of a walkable way is ON the mapped path. */
const ON_WAY_M = 8;

/** Distance (m) from `p` to the nearest point of any way polyline. */
function distToWays(p: LatLon, geo: RoadGeometry): number {
	let best = Number.POSITIVE_INFINITY;
	const cosLat = Math.cos((p.lat * Math.PI) / 180);
	for (const way of geo.ways) {
		for (let i = 1; i < way.coords.length; i++) {
			const [aLat, aLon] = way.coords[i - 1];
			const [bLat, bLon] = way.coords[i];
			const bx = (bLon - aLon) * 111_320 * cosLat;
			const by = (bLat - aLat) * 111_320;
			const px = (p.lon - aLon) * 111_320 * cosLat;
			const py = (p.lat - aLat) * 111_320;
			const len2 = bx * bx + by * by;
			let t = len2 > 0 ? (px * bx + py * by) / len2 : 0;
			t = Math.max(0, Math.min(1, t));
			const d = Math.hypot(px - t * bx, py - t * by);
			if (d < best) best = d;
		}
	}
	return best;
}

/**
 * The TRUE-DEFECT lens on building crossings: length (m) of the drawn line
 * inside a building footprint while more than `onWayM` from every walkable way.
 * A line riding a mapped through-building footway — the Bridge Road arcade, a
 * King's Cross concourse — is a legitimate passage OSM says is walkable and
 * counts 0 here; a chord through a house with no path counts in full. The raw
 * {@link buildingCrossingM} stays as the superset measure.
 */
export function offPathBuildingCrossingM(
	drawn: readonly LatLon[],
	buildings: readonly BuildingFootprint[],
	walkable: RoadGeometry,
	onWayM = ON_WAY_M,
	stepM = 2,
): number {
	if (drawn.length < 2 || buildings.length === 0) return 0;
	let crossed = 0;
	for (let i = 1; i < drawn.length; i++) {
		const a = drawn[i - 1];
		const b = drawn[i];
		const segLen = metersBetween(a, b);
		if (segLen === 0) continue;
		const steps = Math.max(1, Math.ceil(segLen / stepM));
		for (let k = 0; k < steps; k++) {
			const midF = (k + 0.5) / steps;
			const mid = { lat: a.lat + (b.lat - a.lat) * midF, lon: a.lon + (b.lon - a.lon) * midF };
			if (inAnyBuilding(mid, buildings) && distToWays(mid, walkable) > onWayM) crossed += segLen / steps;
		}
	}
	return crossed;
}
