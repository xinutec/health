/**
 * Building-escape walk corrector — the explicit, case-based reconstruction of a
 * drawn walk line so it stops running through houses
 * (`docs/proposals/geometry-roadmap.md`).
 *
 * The design (Pippijn's), stated as three cases over the drawn line + the OSM
 * walkable network + building footprints:
 *
 *   1. **A vertex lands inside a building** → move it OUT onto the nearest street
 *      *on that building's side*: escape the nearest wall, then snap to the
 *      nearest walkable way just outside it. Never jumps across the block to a
 *      slightly-nearer far-side street.
 *   2. **The gap between two vertices is implausible** — it crosses a building,
 *      OR it is an *urban block cut*: far off every walkable way in built
 *      surroundings (a chord threading BETWEEN mapped footprints across a block,
 *      which containment alone cannot see) → route the gap along the walkable
 *      streets between the two anchored endpoints and insert those points, so
 *      the line goes *around* the block instead of through it.
 *   3. **No streets nearby** (open ground / forest) → trust the GPS; never move a
 *      vertex when there is no walkable surface to move it onto.
 *
 * Pure and deterministic; geometry in, geometry out, no DB or network.
 */

import { metersBetween, projectPointToSegment, type RoadGeometry } from "./map-match-core.js";
import type { BuildingFootprint } from "./osm-local.js";
import { routeOnWalkable } from "./walkable-route.js";

export interface EscapeOptions {
	/** Step (m) past the escaped wall, so the point clears the footprint before it
	 *  is snapped to a way. */
	wallMarginM: number;
	/** Only snap the escaped point to a street within this radius (m) of the exit;
	 *  beyond it there is no near-side street to land on, so the point is left just
	 *  outside the wall rather than teleported to a distant way. */
	streetSnapRadiusM: number;
}

export const DEFAULT_ESCAPE_OPTIONS: EscapeOptions = {
	wallMarginM: 2,
	streetSnapRadiusM: 20,
};

/** Even-odd ray cast: is `p` inside the closed polygon `ring`? */
function pointInRing(p: { lat: number; lon: number }, ring: BuildingFootprint): boolean {
	if (ring.length < 3) return false;
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const yi = ring[i].lat;
		const xi = ring[i].lon;
		const yj = ring[j].lat;
		const xj = ring[j].lon;
		if (yi > p.lat !== yj > p.lat && p.lon < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

/** Nearest point on the closed boundary of `ring` to `p`, with its distance (m).
 *  The ring's closing edge (last→first) is included. */
function nearestOnRing(
	p: { lat: number; lon: number },
	ring: BuildingFootprint,
): { lat: number; lon: number; distM: number } | null {
	let best: { lat: number; lon: number; distM: number } | null = null;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const proj = projectPointToSegment(p, ring[j], ring[i]);
		if (best === null || proj.distM < best.distM) best = { lat: proj.lat, lon: proj.lon, distM: proj.distM };
	}
	return best;
}

/** Nearest point on any walkable way to `p`, with its distance (m); null when the
 *  network is empty. */
function nearestWalkable(
	p: { lat: number; lon: number },
	geo: RoadGeometry,
): { lat: number; lon: number; distM: number } | null {
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
 * Grid index over way segments for the badness THRESHOLD tests ("is any way
 * within maxM?"), which run per 2 m sample over whole legs — a linear way scan
 * there dominated the corrector's runtime. Cells are sized to the largest
 * query radius, so a 3×3 probe around the query point is EXACT: a segment
 * within `maxM ≤ cellM` of `p` has a bbox cell within one cell of `p`'s.
 */
class WaySegmentGrid {
	private readonly buckets = new Map<string, Array<[Pt2, Pt2]>>();
	private readonly cellLat: number;
	private readonly cellLon: number;
	/** Largest radius (m) `within` may be asked for — fixed at build time. */
	readonly maxQueryM: number;
	constructor(geo: RoadGeometry, maxQueryM: number) {
		this.maxQueryM = maxQueryM;
		const refLat = geo.ways[0]?.coords[0]?.[0] ?? 51;
		this.cellLat = maxQueryM / 111_320;
		this.cellLon = maxQueryM / (111_320 * Math.cos((refLat * Math.PI) / 180));
		for (const w of geo.ways) {
			for (let i = 1; i < w.coords.length; i++) {
				const a: Pt2 = { lat: w.coords[i - 1][0], lon: w.coords[i - 1][1] };
				const b: Pt2 = { lat: w.coords[i][0], lon: w.coords[i][1] };
				const loLat = Math.floor(Math.min(a.lat, b.lat) / this.cellLat);
				const hiLat = Math.floor(Math.max(a.lat, b.lat) / this.cellLat);
				const loLon = Math.floor(Math.min(a.lon, b.lon) / this.cellLon);
				const hiLon = Math.floor(Math.max(a.lon, b.lon) / this.cellLon);
				for (let cy = loLat; cy <= hiLat; cy++) {
					for (let cx = loLon; cx <= hiLon; cx++) {
						const key = `${cy},${cx}`;
						const bkt = this.buckets.get(key);
						if (bkt) bkt.push([a, b]);
						else this.buckets.set(key, [[a, b]]);
					}
				}
			}
		}
	}

	/** Is any way segment within `maxM` (≤ `maxQueryM`) of `p`? */
	within(p: Pt2, maxM: number): boolean {
		const cy = Math.floor(p.lat / this.cellLat);
		const cx = Math.floor(p.lon / this.cellLon);
		for (let dy = -1; dy <= 1; dy++) {
			for (let dx = -1; dx <= 1; dx++) {
				const bkt = this.buckets.get(`${cy + dy},${cx + dx}`);
				if (!bkt) continue;
				for (const [a, b] of bkt) {
					if (projectPointToSegment(p, a, b).distM <= maxM) return true;
				}
			}
		}
		return false;
	}
}

interface Pt2 {
	lat: number;
	lon: number;
}

/** The building ring `p` is inside, or null. First match wins (footprints rarely
 *  overlap). */
function containingBuilding(
	p: { lat: number; lon: number },
	buildings: readonly BuildingFootprint[],
): BuildingFootprint | null {
	for (const ring of buildings) if (pointInRing(p, ring)) return ring;
	return null;
}

/**
 * Case 1 + case 3, per vertex. If `p` is inside a building, return the escaped
 * position — just past the nearest wall, snapped to the nearest walkable way
 * within `streetSnapRadiusM` (the near-side street). Returns null (leave it) when
 * `p` is not inside a building, or when there is no near-side street to move it
 * onto (case 3 — trust GPS).
 */
function escapedPosition(
	p: { lat: number; lon: number },
	walkable: RoadGeometry,
	buildings: readonly BuildingFootprint[],
	opts: EscapeOptions,
): { lat: number; lon: number } | null {
	const ring = containingBuilding(p, buildings);
	if (!ring) return null;

	const wall = nearestOnRing(p, ring);
	if (!wall || wall.distM < 1e-6) return null; // degenerate; leave it

	// Outward unit direction (from the interior point toward the nearest wall),
	// in a local metric frame, then step `wallMarginM` past the wall.
	const cosLat = Math.cos((p.lat * Math.PI) / 180);
	const dxE = (wall.lon - p.lon) * 111_320 * cosLat;
	const dyN = (wall.lat - p.lat) * 111_320;
	const norm = Math.hypot(dxE, dyN) || 1;
	const outside = {
		lat: wall.lat + ((dyN / norm) * opts.wallMarginM) / 111_320,
		lon: wall.lon + ((dxE / norm) * opts.wallMarginM) / (111_320 * cosLat),
	};

	// Snap to the nearest street on this side (from just outside the wall, so the
	// nearest way is the near-side one), if one is close enough. Case 3: no street
	// near → TRUST GPS, leave the vertex untouched. The street is the only evidence
	// we have for where the true path is; without it we do not move the point (and
	// certainly do not teleport it to a distant way).
	const near = nearestWalkable(outside, walkable);
	if (near && near.distM <= opts.streetSnapRadiusM) return { lat: near.lat, lon: near.lon };
	return null;
}

/**
 * Apply the building-escape correction to a drawn walk line. Generic over the
 * vertex type so every field (`ts`, etc.) is carried through untouched — only
 * `lat`/`lon` are rewritten, and only for a vertex that escapes a building.
 * Returns a new array; the input is not mutated. Currently implements cases 1 and
 * 3 (per-vertex escape + trust-GPS); case 2 (route a chord that crosses a building
 * around the block) lands in a later slice.
 */
export function escapeBuildings<T extends { lat: number; lon: number }>(
	drawn: readonly T[],
	walkable: RoadGeometry,
	buildings: readonly BuildingFootprint[],
	opts: EscapeOptions = DEFAULT_ESCAPE_OPTIONS,
): T[] {
	if (buildings.length === 0) return drawn.map((p) => ({ ...p }));
	return drawn.map((p) => {
		const moved = escapedPosition(p, walkable, buildings, opts);
		return moved ? { ...p, lat: moved.lat, lon: moved.lon } : { ...p };
	});
}

/** One corrected walk vertex. */
export interface CorrectedPoint {
	lat: number;
	lon: number;
	ts: number;
}

export interface CorrectOptions extends EscapeOptions {
	/** Densify chords longer than this (m) before escaping, so a sparse gap has
	 *  vertices the buildings can push (the precondition for case 1 to see a
	 *  crossing at all). */
	densifyStepM: number;
	/** Honesty guard for case 2: refuse a street route longer than this multiple
	 *  of the gap's straight-line distance — a longer "route around" is an
	 *  invented detour, not a plausible walk. */
	maxDetourRatio: number;
	/** Only route when both gap anchors have a walkable way within this (m). */
	routeSnapRadiusM: number;
	/** Ignore residual crossings shorter than this (m) — clipping a mis-mapped
	 *  porch corner is not worth a reroute. */
	minCrossingM: number;
	/** Whole-leg honesty budget: all accepted reroutes together may lengthen the
	 *  drawn leg by at most this fraction of its original length. A single block
	 *  detour fits comfortably; a smeared indoor leg whose every jitter would
	 *  route around shelves exhausts the budget immediately and stays honest raw
	 *  GPS. (This is what the per-gap ratio alone cannot bound: many small gaps,
	 *  each individually plausible, compounding into an invented hike.) */
	maxLegInflation: number;
	/** Budget floor (m): a short leg that IS one block detour still gets to make
	 *  it — the budget exists to stop compounding, not to forbid the single
	 *  honest reroute. Also floors the per-gap route bound: going around a block
	 *  is legitimately several times a NARROW gap's straight line, so the
	 *  `maxDetourRatio` alone would refuse exactly the honest detours. */
	minRouteBudgetM: number;
	/** Urban block-cut threshold (m): a drawn segment whose midpoint is farther
	 *  than this from EVERY walkable way — in built surroundings (see
	 *  `buildingProxM`) — is as implausible as a building crossing: you cannot
	 *  walk 25 m+ off-street through a built-up block. Deliberately ABOVE the
	 *  honest house-lined GPS drift (raw fixes legitimately sit 10–30 m off the
	 *  pavement), so a normal street walk is never flagged. The 2026-07-01 10:18
	 *  diagonal reads 31 m. */
	offNetworkM: number;
	/** A far-off-network segment counts as a block cut only when a building lies
	 *  within this (m) of its midpoint — the urban witness. Open ground (park,
	 *  field: no buildings near) is left to the GPS (case 3: a walk across a lawn
	 *  is not an artifact). */
	buildingProxM: number;
	/** An in-building sample within this (m) of a walkable way is a mapped
	 *  through-building passage — a covered arcade (the Bridge Road parade) or a
	 *  station concourse — and is NOT badness: OSM says you walk there. Beyond
	 *  it, in-building is the containment defect. */
	onWayM: number;
}

export const DEFAULT_CORRECT_OPTIONS: CorrectOptions = {
	...DEFAULT_ESCAPE_OPTIONS,
	densifyStepM: 6,
	maxDetourRatio: 2.5,
	routeSnapRadiusM: 35,
	minCrossingM: 3,
	maxLegInflation: 0.5,
	minRouteBudgetM: 150,
	offNetworkM: 25,
	buildingProxM: 30,
	onWayM: 8,
};

/**
 * The badness context for one leg: building rings with precomputed bounding
 * boxes (expanded by `buildingProxM`, so a cheap bbox test rejects the vast
 * majority of the thousands of rings a real leg carries) plus the walkable
 * network for the off-network test.
 */
interface BadnessCtx {
	buildings: readonly BuildingFootprint[];
	/** Per-ring bbox expanded by buildingProxM, aligned with `buildings`. */
	boxes: Array<{ minLat: number; maxLat: number; minLon: number; maxLon: number }>;
	walkable: RoadGeometry;
	/** Grid over the walkable segments for the per-sample threshold tests. */
	grid: WaySegmentGrid;
	opts: CorrectOptions;
}

function makeBadnessCtx(
	walkable: RoadGeometry,
	buildings: readonly BuildingFootprint[],
	opts: CorrectOptions,
): BadnessCtx {
	const boxes = buildings.map((ring) => {
		let minLat = Number.POSITIVE_INFINITY;
		let maxLat = Number.NEGATIVE_INFINITY;
		let minLon = Number.POSITIVE_INFINITY;
		let maxLon = Number.NEGATIVE_INFINITY;
		for (const p of ring) {
			if (p.lat < minLat) minLat = p.lat;
			if (p.lat > maxLat) maxLat = p.lat;
			if (p.lon < minLon) minLon = p.lon;
			if (p.lon > maxLon) maxLon = p.lon;
		}
		const dLat = opts.buildingProxM / 111_320;
		const dLon = opts.buildingProxM / (111_320 * Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180));
		return { minLat: minLat - dLat, maxLat: maxLat + dLat, minLon: minLon - dLon, maxLon: maxLon + dLon };
	});
	const grid = new WaySegmentGrid(walkable, Math.max(opts.onWayM, opts.offNetworkM));
	return { buildings, boxes, walkable, grid, opts };
}

/** Is `p` inside a building? The ctx form of {@link containingBuilding}: the
 *  precomputed (expanded) bboxes reject almost every ring before the ray cast —
 *  this runs first on every 2 m badness sample. */
function insideBuildingCtx(p: { lat: number; lon: number }, ctx: BadnessCtx): boolean {
	for (let i = 0; i < ctx.buildings.length; i++) {
		const b = ctx.boxes[i];
		if (p.lat < b.minLat || p.lat > b.maxLat || p.lon < b.minLon || p.lon > b.maxLon) continue;
		if (pointInRing(p, ctx.buildings[i])) return true;
	}
	return false;
}

/** Is a building within `buildingProxM` of `p` (or `p` inside one)? bbox
 *  prefilter first; exact ring-boundary distance only for the survivors. */
function nearBuilding(p: { lat: number; lon: number }, ctx: BadnessCtx): boolean {
	for (let i = 0; i < ctx.buildings.length; i++) {
		const b = ctx.boxes[i];
		if (p.lat < b.minLat || p.lat > b.maxLat || p.lon < b.minLon || p.lon > b.maxLon) continue;
		if (pointInRing(p, ctx.buildings[i])) return true;
		const near = nearestOnRing(p, ctx.buildings[i]);
		if (near && near.distM <= ctx.opts.buildingProxM) return true;
	}
	return false;
}

/**
 * Badness length (m) of the segment a→b — the drawn distance that is
 * implausible for a walk (2 m midpoint sampling; the geo-side superset of the
 * eval crossing metric, kept local so geo does not depend on eval):
 *
 *   - INSIDE a building footprint while more than `onWayM` off every walkable
 *     way (the containment class; a line riding a mapped through-building
 *     footway — the Bridge Road arcade, a King's Cross concourse — is a
 *     legitimate passage and never badness), or
 *   - an URBAN BLOCK CUT: farther than `offNetworkM` from every walkable way
 *     while a building sits within `buildingProxM` — off-street through a
 *     built-up block, the class containment is blind to (the line threads
 *     BETWEEN the mapped footprints, e.g. the 2026-07-01 10:18 diagonal).
 *
 * Open-ground samples (off-network but no buildings near) contribute nothing:
 * case 3, trust the GPS.
 */
function segBadnessM(a: { lat: number; lon: number }, b: { lat: number; lon: number }, ctx: BadnessCtx): number {
	const segLen = metersBetween(a.lat, a.lon, b.lat, b.lon);
	if (segLen === 0 || ctx.buildings.length === 0) return 0;
	const steps = Math.max(1, Math.ceil(segLen / 2));
	let bad = 0;
	for (let k = 0; k < steps; k++) {
		const f = (k + 0.5) / steps;
		const mid = { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
		if (insideBuildingCtx(mid, ctx)) {
			if (!ctx.grid.within(mid, ctx.opts.onWayM)) bad += segLen / steps;
			continue;
		}
		// Cheap bbox-gated building-proximity first; the way test (the formerly
		// expensive part) only runs for samples in built surroundings.
		if (!nearBuilding(mid, ctx)) continue;
		if (!ctx.grid.within(mid, ctx.opts.offNetworkM)) bad += segLen / steps;
	}
	return bad;
}

/** Total badness (m) over a polyline. */
function pathBadnessM(pts: ReadonlyArray<{ lat: number; lon: number }>, ctx: BadnessCtx): number {
	let total = 0;
	for (let i = 1; i < pts.length; i++) total += segBadnessM(pts[i - 1], pts[i], ctx);
	return total;
}

// --- case 2.5: geometric corner detour ---------------------------------
// When the street network cannot route a crossing run around a block (a
// fragmented graph, an unmapped area), the walk still did not go through the
// wall. Humans skirt a building along its perimeter — a pavement usually
// exists along a wall even when OSM maps none — so the detour is derivable
// from the footprint itself: leave the chord at the wall, follow the ring's
// corners (offset a step outside) to the far side, rejoin. Unlike case 2's
// "any badness reduction" rule (#347's inflation lever), a corner detour is
// accepted only when it ELIMINATES its run's crossing outright and stays
// within the same detour-ratio bound routes obey — partial purchases are
// impossible by construction.

/** How far outside the wall a corner-detour vertex stands (m). */
const CORNER_CLEARANCE_M = 2;
/** Recursion bound: a detour corner may itself land before ANOTHER footprint;
 *  each level fixes the first crossed ring of every sub-chord. Beyond this
 *  many nested footprints the area is dense — decline (honest trustGPS). */
const CORNER_MAX_DEPTH = 3;

/** Intersection parameters t∈(0,1) along a→b where the segment crosses the
 *  ring's boundary, ascending. Even-odd with the ring's edges. */
function segRingCrossingTs(a: Pt2, b: Pt2, ring: BuildingFootprint): number[] {
	const ts: number[] = [];
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const p = ring[j];
		const q = ring[i];
		const d1x = b.lon - a.lon;
		const d1y = b.lat - a.lat;
		const d2x = q.lon - p.lon;
		const d2y = q.lat - p.lat;
		const denom = d1x * d2y - d1y * d2x;
		if (Math.abs(denom) < 1e-18) continue;
		const t = ((p.lon - a.lon) * d2y - (p.lat - a.lat) * d2x) / denom;
		const u = ((p.lon - a.lon) * d1y - (p.lat - a.lat) * d1x) / denom;
		if (t > 1e-9 && t < 1 - 1e-9 && u >= 0 && u <= 1) ts.push(t);
	}
	return ts.sort((x, y) => x - y);
}

/** The ring's vertices from just past the edge crossed at `tEntry` to the edge
 *  crossed at `tExit`, walking the ring forward or backward, each pushed
 *  `CORNER_CLEARANCE_M` outward from the ring centroid. */
function ringCornersBetween(a: Pt2, b: Pt2, ring: BuildingFootprint, forward: boolean): Pt2[] {
	// Index of the edge (j→i form: edge k is ring[k]→ring[(k+1)%n]) each
	// crossing lies on, by re-running the intersection per edge.
	const n = ring.length;
	let entryEdge = -1;
	let exitEdge = -1;
	let tEntry = Number.POSITIVE_INFINITY;
	let tExit = Number.NEGATIVE_INFINITY;
	for (let k = 0; k < n; k++) {
		const p = ring[k];
		const q = ring[(k + 1) % n];
		const d1x = b.lon - a.lon;
		const d1y = b.lat - a.lat;
		const d2x = q.lon - p.lon;
		const d2y = q.lat - p.lat;
		const denom = d1x * d2y - d1y * d2x;
		if (Math.abs(denom) < 1e-18) continue;
		const t = ((p.lon - a.lon) * d2y - (p.lat - a.lat) * d2x) / denom;
		const u = ((p.lon - a.lon) * d1y - (p.lat - a.lat) * d1x) / denom;
		if (t <= 1e-9 || t >= 1 - 1e-9 || u < 0 || u > 1) continue;
		if (t < tEntry) {
			tEntry = t;
			entryEdge = k;
		}
		if (t > tExit) {
			tExit = t;
			exitEdge = k;
		}
	}
	if (entryEdge === -1 || exitEdge === -1 || entryEdge === exitEdge) return [];
	let cLat = 0;
	let cLon = 0;
	for (const p of ring) {
		cLat += p.lat / n;
		cLon += p.lon / n;
	}
	const cosLat = Math.cos((cLat * Math.PI) / 180);
	const corners: Pt2[] = [];
	if (forward) {
		for (let k = (entryEdge + 1) % n; ; k = (k + 1) % n) {
			corners.push(ring[k]);
			if (k === exitEdge) break;
			if (corners.length > n) return [];
		}
	} else {
		for (let k = entryEdge; ; k = (k - 1 + n) % n) {
			corners.push(ring[k]);
			if (k === (exitEdge + 1) % n) break;
			if (corners.length > n) return [];
		}
	}
	return corners.map((p) => {
		const dy = (p.lat - cLat) * 111_320;
		const dx = (p.lon - cLon) * 111_320 * cosLat;
		const len = Math.hypot(dx, dy) || 1;
		return {
			lat: p.lat + ((dy / len) * CORNER_CLEARANCE_M) / 111_320,
			lon: p.lon + ((dx / len) * CORNER_CLEARANCE_M) / (111_320 * cosLat),
		};
	});
}

/** Does the polyline enter any footprint? 2 m midpoint sampling, ctx bboxes. */
function polylineEntersBuilding(pts: readonly Pt2[], ctx: BadnessCtx): boolean {
	for (let i = 1; i < pts.length; i++) {
		const a = pts[i - 1];
		const b = pts[i];
		const segLen = metersBetween(a.lat, a.lon, b.lat, b.lon);
		const steps = Math.max(1, Math.ceil(segLen / 2));
		for (let k = 0; k <= steps; k++) {
			const f = k / steps;
			if (insideBuildingCtx({ lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f }, ctx)) return true;
		}
	}
	return false;
}

/** First footprint the segment a→b passes through, or null. */
function firstCrossedRing(a: Pt2, b: Pt2, ctx: BadnessCtx): BuildingFootprint | null {
	let best: BuildingFootprint | null = null;
	let bestT = Number.POSITIVE_INFINITY;
	for (let i = 0; i < ctx.buildings.length; i++) {
		const box = ctx.boxes[i];
		if (
			Math.max(a.lat, b.lat) < box.minLat ||
			Math.min(a.lat, b.lat) > box.maxLat ||
			Math.max(a.lon, b.lon) < box.minLon ||
			Math.min(a.lon, b.lon) > box.maxLon
		)
			continue;
		const ts = segRingCrossingTs(a, b, ctx.buildings[i]);
		// A pass-through needs an in-building span: two boundary crossings (or
		// an endpoint inside, which the anchors exclude by construction).
		if (ts.length >= 2 && ts[0] < bestT) {
			bestT = ts[0];
			best = ctx.buildings[i];
		}
	}
	return best;
}

/** Repair a chord recursively: replace each pass-through with the shorter
 *  crossing-free corner path around that ring, then fix the sub-chords the
 *  corners created. Returns the full vertex list a…b, or null when no
 *  crossing-free bounded path exists (dense surroundings — decline). */
function repairChord(a: Pt2, b: Pt2, ctx: BadnessCtx, depth: number): Pt2[] | null {
	const ring = firstCrossedRing(a, b, ctx);
	if (!ring) return [a, b];
	if (depth >= CORNER_MAX_DEPTH) return null;
	let best: Pt2[] | null = null;
	let bestLen = Number.POSITIVE_INFINITY;
	for (const forward of [true, false]) {
		const corners = ringCornersBetween(a, b, ring, forward);
		if (corners.length === 0) continue;
		// Recursively repair every sub-chord (a corner path may run before
		// ANOTHER footprint).
		const pts: Pt2[] = [a];
		let ok = true;
		let prev: Pt2 = a;
		for (const next of [...corners, b]) {
			const sub = repairChord(prev, next, ctx, depth + 1);
			if (!sub) {
				ok = false;
				break;
			}
			for (let k = 1; k < sub.length; k++) pts.push(sub[k]);
			prev = next;
		}
		if (!ok) continue;
		if (polylineEntersBuilding(pts, ctx)) continue;
		let len = 0;
		for (let k = 1; k < pts.length; k++) len += metersBetween(pts[k - 1].lat, pts[k - 1].lon, pts[k].lat, pts[k].lon);
		if (len < bestLen) {
			bestLen = len;
			best = pts;
		}
	}
	return best;
}

/** Insert intermediate vertices so no chord exceeds `stepM`; timestamps are
 *  interpolated linearly along each chord. Original vertices are kept exactly. */
function densify(drawn: readonly CorrectedPoint[], stepM: number): CorrectedPoint[] {
	const out: CorrectedPoint[] = [];
	for (let i = 0; i < drawn.length; i++) {
		if (i > 0) {
			const a = drawn[i - 1];
			const b = drawn[i];
			const len = metersBetween(a.lat, a.lon, b.lat, b.lon);
			const extra = Math.floor(len / stepM);
			for (let k = 1; k <= extra; k++) {
				const f = k / (extra + 1);
				out.push({ lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f, ts: a.ts + (b.ts - a.ts) * f });
			}
		}
		out.push({ ...drawn[i] });
	}
	return out;
}

/** One crossing-run decision record, emitted by `correctWalkPath` when a `diag`
 *  sink is supplied. Diagnostic only — lets the referee tally WHY a residual
 *  building crossing survives (graph gap vs budget vs dense-area vs the
 *  whole-line invariant), which forks the fix entirely. `outcome`:
 *  `routed` = case 2 accepted; `cornered` = case 2.5 accepted (geometric
 *  corner detour); `escaped` = case 1 accepted; `trustGPS` = all refused (the
 *  crossing stands); `invariant-revert` = the whole leg was discarded because
 *  corrections made it worse overall. */
export interface CorrectRunDiag {
	outcome: "routed" | "cornered" | "escaped" | "trustGPS" | "invariant-revert";
	straightM: number;
	runBadM: number;
	routeFound: boolean;
	routeBadM: number | null;
	addedM: number | null;
	budgetM: number;
	/** Nearest-walkable-way distance (m) at each routing anchor. Splits a
	 *  `no-route` survivor: both anchors within `routeSnapRadiusM` ⇒ the ways
	 *  exist but the graph is FRAGMENTED between them (fixable connectivity); an
	 *  anchor beyond it ⇒ snap failed / genuinely UNMAPPED nearby (accept, trust
	 *  GPS). Null on the `invariant-revert` record (no single run). */
	anchorASnapM: number | null;
	anchorBSnapM: number | null;
}

/**
 * The full case-based corrector for a drawn walk line:
 *
 *   densify → case-1 escape each vertex off a building onto its near-side street
 *   → where a gap STILL crosses a block (no vertex inside it, or no near street
 *   for the escape), case-2 route the gap along the walkable streets around the
 *   block → case-3 everywhere else: trust the GPS.
 *
 * Honesty invariants, all enforced here:
 *   - a reroute happens only when a street route exists, is at most
 *     `maxDetourRatio`× the gap's straight line, AND reduces that gap's
 *     building-crossing — otherwise the original chord is kept;
 *   - the corrected line as a whole must cross LESS building than the input, or
 *     the input is returned unchanged;
 *   - timestamps are preserved on original vertices and interpolated
 *     monotonically on inserted ones.
 *
 * Pure and deterministic. Returns a new array; input untouched.
 */
export function correctWalkPath(
	drawn: readonly CorrectedPoint[],
	walkable: RoadGeometry,
	buildings: readonly BuildingFootprint[],
	opts: CorrectOptions = DEFAULT_CORRECT_OPTIONS,
	diag?: (rec: CorrectRunDiag) => void,
): CorrectedPoint[] {
	if (drawn.length < 2 || buildings.length === 0) return drawn.map((p) => ({ ...p }));
	const ctx = makeBadnessCtx(walkable, buildings, opts);
	// Fast path: nothing implausible → nothing to do (the common clean walk pays
	// one sampling sweep and is returned untouched, un-densified).
	const originalBadM = pathBadnessM(drawn, ctx);
	if (originalBadM < opts.minCrossingM) return drawn.map((p) => ({ ...p }));

	// Densify so a bad run has enough vertices for anchors + the escape
	// fallback, then find each maximal run of implausible segments.
	const pts = densify(drawn, opts.densifyStepM);
	const segCross: number[] = [];
	for (let k = 1; k < pts.length; k++) segCross.push(segBadnessM(pts[k - 1], pts[k], ctx));

	// Whole-leg reroute budget (m): total added length across ALL accepted routes.
	let originalLenM = 0;
	for (let k = 1; k < drawn.length; k++)
		originalLenM += metersBetween(drawn[k - 1].lat, drawn[k - 1].lon, drawn[k].lat, drawn[k].lon);
	let budgetM = Math.max(originalLenM * opts.maxLegInflation, opts.minRouteBudgetM);

	const out: CorrectedPoint[] = [];
	let i = 0;
	while (i < pts.length) {
		// Next crossing run at or after vertex i.
		let runStart = -1;
		for (let s = i; s < segCross.length; s++) {
			if (segCross[s] > 0) {
				runStart = s;
				break;
			}
		}
		if (runStart === -1) {
			for (; i < pts.length; i++) out.push(pts[i]);
			break;
		}
		let runEnd = runStart;
		while (runEnd + 1 < segCross.length && segCross[runEnd + 1] > 0) runEnd++;

		// Anchors: the nearest vertices OUTSIDE any building bracketing the run —
		// routing from inside a footprint would start the street path dishonestly.
		let a = runStart;
		while (a > i && containingBuilding(pts[a], buildings)) a--;
		let b = runEnd + 1;
		while (b < pts.length - 1 && containingBuilding(pts[b], buildings)) b++;

		// Copy the clean prefix up to (and including) the start anchor.
		for (; i <= a; i++) out.push(pts[i]);

		const anchorA = pts[a];
		const anchorB = pts[b];
		let runBadM = 0;
		for (let s = a; s < b; s++) runBadM += segCross[s] ?? 0;

		// CASE 2 FIRST — route the whole gap along the streets. Holistic: one run,
		// one route; this is what avoids the zigzag a per-vertex escape produces
		// when mid-block vertices are equidistant from opposite walls.
		let replaced = false;
		// Diagnostics carried into the fallback emit (case 2's route outcome
		// explains a fallback: no route → graph gap, routeBad → dense area).
		let dStraightM = metersBetween(anchorA.lat, anchorA.lon, anchorB.lat, anchorB.lon);
		let dRouteFound = false;
		let dRouteBadM: number | null = null;
		let dRouteAddedM: number | null = null;
		const dAnchorASnapM = diag ? (nearestWalkable(anchorA, walkable)?.distM ?? null) : null;
		const dAnchorBSnapM = diag ? (nearestWalkable(anchorB, walkable)?.distM ?? null) : null;
		if (runBadM >= opts.minCrossingM) {
			const straightM = metersBetween(anchorA.lat, anchorA.lon, anchorB.lat, anchorB.lon);
			dStraightM = straightM;
			// The route bound is floored like the budget: going around a block is
			// legitimately SEVERAL times a narrow gap's straight line (a 30 m gap
			// mid-block detours ~130 m around it); the plain ratio would refuse
			// exactly the honest detours the rule exists to make.
			const route = routeOnWalkable(anchorA, anchorB, walkable, {
				snapRadiusM: opts.routeSnapRadiusM,
				maxRouteM: Math.max(opts.minRouteBudgetM, straightM * opts.maxDetourRatio),
			});
			if (route && route.length >= 2) {
				// Honesty guards: the route must be meaningfully less implausible than
				// the gap it replaces, AND its added length must fit the whole-leg
				// budget.
				const routeBadM = pathBadnessM(route, ctx);
				let total = 0;
				const cum: number[] = [0];
				for (let k = 1; k < route.length; k++) {
					total += metersBetween(route[k - 1].lat, route[k - 1].lon, route[k].lat, route[k].lon);
					cum.push(total);
				}
				const addedM = total - straightM;
				dRouteFound = true;
				dRouteBadM = routeBadM;
				dRouteAddedM = addedM;
				if (routeBadM < runBadM && addedM <= budgetM) {
					diag?.({
						outcome: "routed",
						straightM,
						runBadM,
						routeFound: true,
						routeBadM,
						addedM,
						budgetM,
						anchorASnapM: dAnchorASnapM,
						anchorBSnapM: dAnchorBSnapM,
					});
					budgetM -= Math.max(0, addedM);
					// Timestamps: interpolate along the route by cumulative distance
					// between the anchors' real times. The route's (street-snapped)
					// start supersedes the copied anchor position; its timestamp is kept.
					out.pop();
					for (let k = 0; k < route.length; k++) {
						const f = total > 0 ? cum[k] / total : 0;
						out.push({ lat: route[k].lat, lon: route[k].lon, ts: anchorA.ts + (anchorB.ts - anchorA.ts) * f });
					}
					replaced = true;
				}
			}
		}
		if (!replaced && runBadM >= opts.minCrossingM) {
			// CASE 2.5 — no street route: corner detour around the footprint(s)
			// themselves. Accepted only when it eliminates the run's crossings
			// outright (verified by construction), obeys the same detour-ratio
			// bound as routes, does not raise the composite badness (a wall-hug
			// far from every way in a truly unmapped area is not confidently a
			// walk — the block-cut rule keeps its vote), and fits the budget.
			const detour = repairChord(anchorA, anchorB, ctx, 0);
			if (process.env.WALK_CORNER_DEBUG === "1" && (!detour || detour.length <= 2)) {
				console.error(
					`[corner] decline: repairChord=${detour ? "trivial" : "null"} straight=${Math.round(dStraightM)}m runBad=${Math.round(runBadM)}m`,
				);
			}
			if (detour && detour.length > 2) {
				let total = 0;
				const cum: number[] = [0];
				for (let k = 1; k < detour.length; k++) {
					total += metersBetween(detour[k - 1].lat, detour[k - 1].lon, detour[k].lat, detour[k].lon);
					cum.push(total);
				}
				const addedM = total - dStraightM;
				const lenOK = total <= Math.max(opts.minRouteBudgetM, dStraightM * opts.maxDetourRatio);
				const detourBadM = pathBadnessM(detour, ctx);
				if (process.env.WALK_CORNER_DEBUG === "1" && !(lenOK && detourBadM < runBadM && addedM <= budgetM)) {
					console.error(
						`[corner] decline: lenOK=${lenOK} (total=${Math.round(total)} straight=${Math.round(dStraightM)}) detourBad=${Math.round(detourBadM)} vs runBad=${Math.round(runBadM)} added=${Math.round(addedM)} budget=${Math.round(budgetM)}`,
					);
				}
				if (lenOK && detourBadM < runBadM && addedM <= budgetM) {
					diag?.({
						outcome: "cornered",
						straightM: dStraightM,
						runBadM,
						routeFound: dRouteFound,
						routeBadM: detourBadM,
						addedM,
						budgetM,
						anchorASnapM: dAnchorASnapM,
						anchorBSnapM: dAnchorBSnapM,
					});
					budgetM -= Math.max(0, addedM);
					out.pop();
					for (let k = 0; k < detour.length; k++) {
						const f = total > 0 ? cum[k] / total : 0;
						out.push({ lat: detour[k].lat, lon: detour[k].lon, ts: anchorA.ts + (anchorB.ts - anchorA.ts) * f });
					}
					replaced = true;
				}
			}
		}
		if (!replaced) {
			// CASE 1 FALLBACK — no honest route around; escape each interior vertex
			// off the building onto its near-side street. Kept only if it reduces the
			// gap's crossing AND its added length fits the same whole-leg budget the
			// routes draw from — an escape can zigzag between opposite walls of a
			// wide block (or across a smeared indoor leg), inflating the path just
			// like compounded reroutes would. Else CASE 3: the original gap stands
			// (trust GPS).
			const gap = pts.slice(a, b + 1);
			const escaped = escapeBuildings(gap, walkable, buildings, opts);
			const lenOf = (xs: readonly CorrectedPoint[]): number => {
				let len = 0;
				for (let k = 1; k < xs.length; k++) len += metersBetween(xs[k - 1].lat, xs[k - 1].lon, xs[k].lat, xs[k].lon);
				return len;
			};
			const addedM = lenOf(escaped) - lenOf(gap);
			let kept = gap;
			if (pathBadnessM(escaped, ctx) < runBadM && addedM <= budgetM) {
				budgetM -= Math.max(0, addedM);
				kept = escaped;
				diag?.({
					outcome: "escaped",
					straightM: dStraightM,
					runBadM,
					routeFound: dRouteFound,
					routeBadM: dRouteBadM,
					addedM: dRouteAddedM,
					budgetM,
					anchorASnapM: dAnchorASnapM,
					anchorBSnapM: dAnchorBSnapM,
				});
			} else {
				diag?.({
					outcome: "trustGPS",
					straightM: dStraightM,
					runBadM,
					routeFound: dRouteFound,
					routeBadM: dRouteBadM,
					addedM: dRouteAddedM,
					budgetM,
					anchorASnapM: dAnchorASnapM,
					anchorBSnapM: dAnchorBSnapM,
				});
			}
			for (let k = 1; k <= b - a; k++) out.push(kept[k]);
		}
		// Continue after the end anchor (already in `out`).
		i = b + 1;
	}

	// Whole-line honesty invariant: never return a line more implausible than
	// the input.
	if (pathBadnessM(out, ctx) > originalBadM) {
		diag?.({
			outcome: "invariant-revert",
			straightM: 0,
			runBadM: 0,
			routeFound: false,
			routeBadM: null,
			addedM: null,
			budgetM,
			anchorASnapM: null,
			anchorBSnapM: null,
		});
		return drawn.map((p) => ({ ...p }));
	}
	return out;
}

/**
 * Passage snap — the drawing half of the mapped-passage exemption. The badness
 * metric rightly EXEMPTS a line riding an OSM way through a building (arcade,
 * concourse, parade cut-through), but the exemption tolerates `onWayM` of
 * lateral error — which draws the walker over the buildings BESIDE the
 * passage (measured: in-building drawn vertices 2–3 m from a way whose own
 * line threads the gap). If a stretch is excused as riding the passage, it
 * must be DRAWN riding the passage: densify it and project every point that
 * has a way within `onWayM` exactly onto that way. Strictly scoped — a
 * segment qualifies only when a sample is INSIDE a footprint, so lateral GPS
 * offset on open streets (which side you walked — signal) and open-ground
 * walks are untouched.
 */
/** Furthest a passage-snap may MOVE a point (m). Qualification uses `onWayM`
 *  (the badness exemption's band), but the measured true passage offsets are
 *  2–3 m; snapping from deeper pulls the line sideways off the raw corridor
 *  and reads as invented stall (measured: 3 corpus legs regressed at the 8 m
 *  reach, 0 at this one). A deeper in-building point keeps its position —
 *  still exempt, just not confidently ON the way. */
const PASSAGE_SNAP_REACH_M = 4;

export function snapPassages(
	pts: readonly CorrectedPoint[],
	walkable: RoadGeometry,
	buildings: readonly BuildingFootprint[],
	opts: CorrectOptions = DEFAULT_CORRECT_OPTIONS,
): CorrectedPoint[] {
	if (walkable.ways.length === 0 || buildings.length === 0 || pts.length < 2) return [...pts];
	const ctx = makeBadnessCtx(walkable, buildings, opts);
	const out: CorrectedPoint[] = [];
	// Nearest way point with the way identity + a monotone parameter along it
	// (way index, segment index, in-segment fraction) — the coherence key.
	const snapWithWay = (q: {
		lat: number;
		lon: number;
	}): { lat: number; lon: number; distM: number; wayIdx: number; t: number } | null => {
		let best: { lat: number; lon: number; distM: number; wayIdx: number; t: number } | null = null;
		for (let w = 0; w < ctx.walkable.ways.length; w++) {
			const coords = ctx.walkable.ways[w].coords;
			for (let i = 1; i < coords.length; i++) {
				const a = { lat: coords[i - 1][0], lon: coords[i - 1][1] };
				const b = { lat: coords[i][0], lon: coords[i][1] };
				const proj = projectPointToSegment(q, a, b);
				if (best === null || proj.distM < best.distM) {
					const segLen = metersBetween(a.lat, a.lon, b.lat, b.lon) || 1;
					const f = metersBetween(a.lat, a.lon, proj.lat, proj.lon) / segLen;
					best = { lat: proj.lat, lon: proj.lon, distM: proj.distM, wayIdx: w, t: i - 1 + Math.min(1, f) };
				}
			}
		}
		return best;
	};
	for (let i = 0; i < pts.length; i++) {
		if (i > 0) {
			const a = pts[i - 1];
			const b = pts[i];
			const segLen = metersBetween(a.lat, a.lon, b.lat, b.lon);
			const steps = Math.max(1, Math.ceil(segLen / 2));
			// A segment qualifies only when it is SUBSTANTIALLY inside (≥
			// minCrossingM of in-building sampled length with a way in reach) —
			// a line that merely nicks a footprint corner beside the pavement
			// must not be yanked onto the way (measured: an any-sample trigger
			// regressed corridor-stall on a dozen ordinary street walks).
			let insideM = 0;
			for (let k = 0; k <= steps; k++) {
				const f = k / steps;
				const mid = { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
				if (insideBuildingCtx(mid, ctx) && ctx.grid.within(mid, ctx.opts.onWayM)) insideM += segLen / (steps + 1);
			}
			if (insideM >= ctx.opts.minCrossingM) {
				// Follow the way through the passage: densified points that are
				// themselves INSIDE a footprint project onto it and pick up the
				// way's own bends, so a chord between two on-way vertices stops
				// cutting the corner. COHERENCE is required: every in-building
				// sample must project onto the SAME way, monotonically along it —
				// that is what traversing a passage looks like. Incoherent snaps
				// (nearest-way flips, back-and-forth parameters) would zigzag the
				// line and read as invented corridor-stall (measured), so the
				// whole stretch is left alone instead.
				const n = Math.max(1, Math.ceil(segLen / 3));
				const snapped: CorrectedPoint[] = [];
				let coherent = true;
				let wayIdx = -1;
				let dir = 0;
				let prevT = Number.NaN;
				for (let k = 1; k < n && coherent; k++) {
					const f = k / n;
					const q = {
						lat: a.lat + (b.lat - a.lat) * f,
						lon: a.lon + (b.lon - a.lon) * f,
						ts: a.ts + (b.ts - a.ts) * f,
					};
					if (!insideBuildingCtx(q, ctx)) continue;
					const near = snapWithWay(q);
					if (!near || near.distM > PASSAGE_SNAP_REACH_M) {
						coherent = false;
						break;
					}
					if (wayIdx === -1) wayIdx = near.wayIdx;
					else if (near.wayIdx !== wayIdx) {
						coherent = false;
						break;
					}
					if (!Number.isNaN(prevT) && near.t !== prevT) {
						const step = Math.sign(near.t - prevT);
						if (dir === 0) dir = step;
						else if (step !== dir) {
							coherent = false;
							break;
						}
					}
					prevT = near.t;
					snapped.push({ ...q, lat: near.lat, lon: near.lon });
				}
				if (coherent) for (const q of snapped) out.push(q);
			}
		}
		const p = pts[i];
		if (insideBuildingCtx(p, ctx)) {
			const near = snapWithWay(p);
			out.push(near && near.distM <= PASSAGE_SNAP_REACH_M ? { ...p, lat: near.lat, lon: near.lon } : { ...p });
		} else {
			out.push({ ...p });
		}
	}
	return out;
}

/**
 * The "respect the GPS" half of the GPS-first walk draw: nudge each vertex
 * fully onto its nearest walkable way when that way is within `nudgeReachM` —
 * a slight, bounded correction (GPS jitter around a pavement) — and otherwise
 * leave the vertex EXACTLY where the GPS put it. Deliberately never a partial
 * move: half-way would strand the point in no-man's-land, neither the GPS
 * truth nor the pavement. Pure; timestamps and extra fields carried through.
 */
export function nudgeTowardWays<T extends { lat: number; lon: number }>(
	drawn: readonly T[],
	walkable: RoadGeometry,
	nudgeReachM: number,
): T[] {
	if (walkable.ways.length === 0) return drawn.map((p) => ({ ...p }));
	return drawn.map((p) => {
		const near = nearestWalkable(p, walkable);
		if (near && near.distM <= nudgeReachM) return { ...p, lat: near.lat, lon: near.lon };
		return { ...p };
	});
}

// re-export for callers that want the metre helper without a second import.
export { metersBetween };
