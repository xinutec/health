/**
 * Map-matching core — the mode-agnostic Newson-Krumm HMM machinery shared by
 * the road matcher (`road-match.ts`) and the pedestrian matcher
 * (`pedestrian-match.ts`).
 *
 * It snaps a GPS leg onto a routable OSM way network: build a graph from the
 * ways, project each fix onto nearby segments (candidates), and Viterbi-decode
 * the most likely candidate per fix under a Gaussian emission + a Newson-Krumm
 * `|route − gpsStep|` transition, with a track corridor that keeps the route on
 * the traced line. Everything that differs between modes — emission σ, candidate
 * radius, the way-continuity (turn) prior, bail thresholds — lives in a
 * {@link MatchProfile}, so a caller supplies `ROAD_PROFILE` or `WALK_PROFILE`.
 *
 * # Honest fallback
 *
 * `matchTrajectory` returns `null` ("draw the raw fixes") rather than a
 * degenerate or confidently-wrong path: too few fixes, too far off the network,
 * a disconnected graph (no feasible Viterbi path — the natural signal for a
 * fragmented pedestrian network), or an implausibly long routing detour.
 *
 * Pure and self-contained: takes a geometry bundle + profile, needs no DB or
 * network, so it is deterministic and unit-testable.
 */

/** A way from the OSM mirror. `coords` is an ordered `[lat, lon]` polyline;
 *  `subtype` is the OSM `highway` value. */
export interface OsmRoadWay {
	osmId: number;
	name: string | null;
	subtype: string | null;
	coords: Array<[number, number]>;
}

/** A closed building footprint (the first↔last edge is implicit). Structurally
 *  identical to osm-local's `BuildingFootprint`, redeclared here so the pure
 *  core does not depend on the DB layer. */
export type BuildingRing = ReadonlyArray<{ lat: number; lon: number }>;

/** The way network the matcher works against — a self-contained bundle, so the
 *  algorithm needs neither DB nor network. The caller filters to the relevant
 *  highway subtypes (drivable for roads, walkable for pedestrians).
 *  `buildings`, when supplied, is the impassable layer: an edge crossing a
 *  footprint with no raw-fix support costs `buildingCrossFactor` extra. */
export interface RoadGeometry {
	ways: OsmRoadWay[];
	buildings?: readonly BuildingRing[];
}

/** One GPS fix to map-match. */
export interface RoadFix {
	lat: number;
	lon: number;
	ts: number;
}

/** One vertex of the matched path, with an interpolated timestamp. */
export interface MatchedPoint {
	lat: number;
	lon: number;
	ts: number;
}

export interface MatchResult {
	/** The leg routed onto the ways, time-interpolated across the window. */
	path: MatchedPoint[];
	/** The full assembled route (every way vertex the Viterbi traversed),
	 *  before simplification — the geometry source for
	 *  {@link spliceRouteDetail} (#369). */
	routeDetail: MatchedPoint[];
}

/**
 * Mode-specific tuning for {@link matchTrajectory}. `ROAD_PROFILE`
 * (road-match.ts) reproduces the original road constants exactly; `WALK_PROFILE`
 * (pedestrian-match.ts) drops the way-continuity prior and tightens the radius.
 */
export interface MatchProfile {
	/** Below this many fixes the leg is too short to match — draw raw. */
	minFixes: number;
	/** Max snap distance (m) for a fix to a segment to be a candidate. */
	matchRadiusM: number;
	/** Most candidate ways considered per fix (the K nearest). Keeps Viterbi
	 *  at O(F·K²). */
	maxCandidatesPerFix: number;
	/** Emission falloff (m): σ in the Gaussian emission `exp(-½(dist/σ)²)`. */
	sigmaZ: number;
	/** Transition falloff (m): scale in `exp(-|routeDist − gpsStep|/β)`. */
	beta: number;
	/** Two vertices within this distance (m) but not sharing an OSM node are
	 *  bridged with an edge (junctions / tile borders that fail to share a node). */
	gapBridgeM: number;
	/** Coordinate decimal places for keying graph vertices (~1 cm). */
	vertexDp: number;
	/** A transition's route search is abandoned past
	 *  `gpsStep · detourFactor + detourSlackM`. */
	detourFactor: number;
	detourSlackM: number;
	/** Bail if the matched path is longer than `rawLen · maxLenFactor + maxLenSlackM`. */
	maxLenFactor: number;
	maxLenSlackM: number;
	/** Bail if more than this fraction of fixes have no candidate way. */
	maxRoadlessFraction: number;
	/** Corridor penalty: an edge within `corridorNearM` of the traced GPS track
	 *  routes unpenalised; beyond `corridorFarM` it carries the full
	 *  `corridorMaxPenalty` multiplier; ramps linearly between. Stops the router
	 *  shortcutting down a way the GPS never approached. */
	corridorNearM: number;
	corridorFarM: number;
	corridorMaxPenalty: number;
	/** Way-continuity (turn) prior, in nats, applied to a transition whose two
	 *  fixes snap to differently-named ways. Road uses 5 (a lone scattered fix
	 *  can't drag the route onto a side street); pedestrians use 0 (walkers
	 *  change ways freely at every crossing). */
	wayContinuityNats: number;
	/** A dead-end out-and-back "spur" returning within this distance (m) is
	 *  collapsed away (a routing artifact, no fix out there to justify it). */
	spurReturnM: number;
	/** Only collapse spurs up to this many vertices long. */
	spurMaxSpanVerts: number;
	/** Douglas-Peucker tolerance (m) for the final polyline (~a lane width). */
	simplifyToleranceM: number;
	/** Weight multiplier for a graph edge whose in-building portion has NO raw
	 *  fix within `buildingSupportM` — the router prefers going around the block
	 *  over an unwalked through-building passage. 1 disables (roads: buildings
	 *  aren't part of the road geometry anyway). Only the edge-weight is
	 *  penalised; the transition still scores the chosen route by its true
	 *  metric length, and `maxLenFactor` bounds any runaway detour. */
	buildingCrossFactor: number;
	/** A raw fix within this distance (m) of an edge's in-building portion marks
	 *  the crossing as genuinely walked (a station concourse, an arcade) and
	 *  waives the penalty — the GPS overrides the tidiness prior. */
	buildingSupportM: number;
}

export interface RoadMatchOpts {
	/** Override the profile's candidate snap radius (m). */
	matchRadiusM?: number;
}

interface Pt {
	lat: number;
	lon: number;
}

/**
 * The GPS track the leg actually traced — the ordered fixes as a polyline.
 * Used to penalise routing that strays from where the phone really was:
 * `distTo` is the perpendicular distance from a point to the nearest track
 * segment, `penalty` ramps that into the Dijkstra edge-weight multiplier.
 *
 * The track (not the individual fix points) is the corridor on purpose: a
 * through-road threaded by fixes 100-400 m apart stays within a few tens of
 * metres of the straight segments joining them, while a branching side
 * street leaves that line — so distance-to-track discriminates them even
 * when the fixes are sparse, which distance-to-nearest-fix would not.
 */
class TrackCorridor {
	private readonly pts: Pt[];
	private readonly nearM: number;
	private readonly farM: number;
	private readonly maxPenalty: number;
	/** Lazily-built chord grid for `distTo`. The brute-force scan — every track
	 *  chord, per graph edge — was a walkMatch hot spot (O(fixes) × O(edges)).
	 *  `penalty` is flat beyond `farM`, so the query clamps there: exact below
	 *  the clamp, and any value ≥ farM maps to the same penalty — byte-identical
	 *  edge weights. */
	private grid: SegmentNearGrid | null | undefined;
	constructor(fixes: ReadonlyArray<{ lat: number; lon: number }>, profile: MatchProfile) {
		this.pts = fixes.map((f) => ({ lat: f.lat, lon: f.lon }));
		this.nearM = profile.corridorNearM;
		this.farM = profile.corridorFarM;
		this.maxPenalty = profile.corridorMaxPenalty;
	}
	distTo(lat: number, lon: number): number {
		if (this.pts.length === 0) return 0;
		if (this.pts.length === 1) return metersBetween(lat, lon, this.pts[0].lat, this.pts[0].lon);
		if (this.grid === undefined) this.grid = SegmentNearGrid.fromTrack(this.pts, this.farM);
		if (this.grid === null) return 0;
		return this.grid.nearestDist(lat, lon, this.farM);
	}
	penalty(distM: number): number {
		if (distM <= this.nearM) return 1;
		if (distM >= this.farM) return this.maxPenalty;
		return 1 + (this.maxPenalty - 1) * ((distM - this.nearM) / (this.farM - this.nearM));
	}
	/** Penalised weight of a graph edge: its metric length times the
	 *  corridor penalty at its midpoint. Dijkstra minimises this. */
	edgeWeight(aLat: number, aLon: number, bLat: number, bLon: number): number {
		const len = metersBetween(aLat, aLon, bLat, bLon);
		return len * this.penalty(this.distTo((aLat + bLat) / 2, (aLon + bLon) / 2));
	}
}

/** Sample spacing (m) along an edge for the in-building test. */
const BUILDING_SAMPLE_STEP_M = 3;

/** Grid cell size (m) for the building-ring spatial index. House-sized rings
 *  land in 1–4 cells; a point lookup reads exactly one bucket. */
const BUILDING_GRID_CELL_M = 48;

/**
 * The impassable-building layer for edge weighting: an edge whose in-building
 * portion is unsupported by the raw fixes costs `crossFactor` extra, steering
 * the router around the block. A fix within `supportM` of every in-building
 * sample keeps the edge unpenalised — a concourse or arcade the walker really
 * crossed draws as crossed.
 *
 * A real day carries thousands of rings and `factor` runs per candidate pair
 * inside the Viterbi (measured 60+s/day when each sample scanned every ring's
 * bbox), so lookups go through a grid index — each ring is bucketed into every
 * cell its bbox covers and a point probes exactly one bucket — and results are
 * memoised per (a, b) endpoint pair (the same candidate offsets recur across a
 * whole Viterbi row).
 */
class BuildingPenalty {
	private readonly rings: BuildingRing[];
	private readonly boxes: Array<{ minLat: number; maxLat: number; minLon: number; maxLon: number }> = [];
	private readonly buckets = new Map<number, number[]>();
	private readonly cellLat: number;
	private readonly cellLon: number;
	private readonly memo = new Map<string, number>();
	/** Fix grid for `fixSupports` — the brute scan of every fix per in-building
	 *  sample was a hot spot. Cell = supportM, so a supporting fix (within
	 *  supportM per axis) is always in the 3×3 neighbourhood; probed 5×5 for a
	 *  safety ring against the equirectangular cos drift. Exact. */
	private readonly fixBuckets = new Map<number, number[]>();
	private readonly fixCellLat: number;
	private readonly fixCellLon: number;
	constructor(
		buildings: readonly BuildingRing[],
		private readonly fixes: ReadonlyArray<{ lat: number; lon: number }>,
		private readonly crossFactor: number,
		private readonly supportM: number,
	) {
		this.rings = buildings.filter((r) => r.length >= 3).map((r) => [...r]);
		const refLat = this.rings[0]?.[0]?.lat ?? 51;
		this.cellLat = BUILDING_GRID_CELL_M / 111_320;
		this.cellLon = BUILDING_GRID_CELL_M / (111_320 * Math.cos((refLat * Math.PI) / 180));
		for (let i = 0; i < this.rings.length; i++) {
			let minLat = Number.POSITIVE_INFINITY;
			let maxLat = Number.NEGATIVE_INFINITY;
			let minLon = Number.POSITIVE_INFINITY;
			let maxLon = Number.NEGATIVE_INFINITY;
			for (const p of this.rings[i]) {
				if (p.lat < minLat) minLat = p.lat;
				if (p.lat > maxLat) maxLat = p.lat;
				if (p.lon < minLon) minLon = p.lon;
				if (p.lon > maxLon) maxLon = p.lon;
			}
			this.boxes.push({ minLat, maxLat, minLon, maxLon });
			for (let cy = Math.floor(minLat / this.cellLat); cy <= Math.floor(maxLat / this.cellLat); cy++) {
				for (let cx = Math.floor(minLon / this.cellLon); cx <= Math.floor(maxLon / this.cellLon); cx++) {
					const key = cellKey(cy, cx);
					const b = this.buckets.get(key);
					if (b) b.push(i);
					else this.buckets.set(key, [i]);
				}
			}
		}
		this.fixCellLat = supportM / 111_320;
		this.fixCellLon = supportM / (111_320 * Math.cos((refLat * Math.PI) / 180));
		for (let i = 0; i < fixes.length; i++) {
			const key = cellKey(Math.floor(fixes[i].lat / this.fixCellLat), Math.floor(fixes[i].lon / this.fixCellLon));
			const b = this.fixBuckets.get(key);
			if (b) b.push(i);
			else this.fixBuckets.set(key, [i]);
		}
	}

	private inAnyRing(lat: number, lon: number): boolean {
		const bucket = this.buckets.get(cellKey(Math.floor(lat / this.cellLat), Math.floor(lon / this.cellLon)));
		if (!bucket) return false;
		for (const i of bucket) {
			const b = this.boxes[i];
			if (lat < b.minLat || lat > b.maxLat || lon < b.minLon || lon > b.maxLon) continue;
			if (pointInRingCore({ lat, lon }, this.rings[i])) return true;
		}
		return false;
	}

	private fixSupports(lat: number, lon: number): boolean {
		const cy = Math.floor(lat / this.fixCellLat);
		const cx = Math.floor(lon / this.fixCellLon);
		for (let dy = -2; dy <= 2; dy++) {
			for (let dx = -2; dx <= 2; dx++) {
				const bucket = this.fixBuckets.get(cellKey(cy + dy, cx + dx));
				if (!bucket) continue;
				for (const i of bucket) {
					const f = this.fixes[i];
					if (metersBetween(lat, lon, f.lat, f.lon) <= this.supportM) return true;
				}
			}
		}
		return false;
	}

	/** Occupied building cells dilated by one ring — `nearAnyBucket` probes ONE
	 *  key per edge sample instead of a 3×3 neighbourhood. Built lazily on the
	 *  first factor() call (matchImprovesDisplay-only geometries never pay). */
	private dilated: Set<number> | null = null;

	/** True when some 3 m sample of the edge COULD hit a non-empty building
	 *  bucket — probed at cell granularity (half-cell steps against the dilated
	 *  occupancy, which covers every cell a finer sample can land in), so an
	 *  edge nowhere near a building skips the 3 m sampling entirely.
	 *  Conservative: never false when the fine loop would find a ring. */
	private nearAnyBucket(aLat: number, aLon: number, bLat: number, bLon: number, lenM: number): boolean {
		if (this.dilated === null) {
			this.dilated = new Set<number>();
			for (const key of this.buckets.keys()) {
				// Invert cellKey: |cx| < 2^21 (half the multiplier), so rounding the
				// quotient recovers cy exactly, for negative cx too.
				const cy = Math.round(key / 4_194_304);
				const cx = key - cy * 4_194_304;
				for (let dy = -1; dy <= 1; dy++) {
					for (let dx = -1; dx <= 1; dx++) this.dilated.add(cellKey(cy + dy, cx + dx));
				}
			}
		}
		const n = Math.max(1, Math.ceil((lenM * 2) / BUILDING_GRID_CELL_M));
		for (let k = 0; k <= n; k++) {
			const t = k / n;
			const cy = Math.floor((aLat + (bLat - aLat) * t) / this.cellLat);
			const cx = Math.floor((aLon + (bLon - aLon) * t) / this.cellLon);
			if (this.dilated.has(cellKey(cy, cx))) return true;
		}
		return false;
	}

	/** The edge test itself, unmemoised — graph construction calls this once per
	 *  edge (a memo would never hit; building its string key dominated the old
	 *  profile). */
	factorOnce(aLat: number, aLon: number, bLat: number, bLon: number): number {
		const len = metersBetween(aLat, aLon, bLat, bLon);
		if (!this.nearAnyBucket(aLat, aLon, bLat, bLon, len)) return 1;
		const n = Math.max(1, Math.ceil(len / BUILDING_SAMPLE_STEP_M));
		for (let k = 0; k <= n; k++) {
			const t = k / n;
			const lat = aLat + (bLat - aLat) * t;
			const lon = aLon + (bLon - aLon) * t;
			if (this.inAnyRing(lat, lon) && !this.fixSupports(lat, lon)) return this.crossFactor;
		}
		return 1;
	}

	/** Weight multiplier for the edge a→b: `crossFactor` when some in-building
	 *  sample of the edge has no supporting fix, else 1. Memoised — routeBetween
	 *  asks about the same candidate↔endpoint hops across the whole Viterbi row. */
	factor(aLat: number, aLon: number, bLat: number, bLon: number): number {
		const key = `${aLat},${aLon},${bLat},${bLon}`;
		const hit = this.memo.get(key);
		if (hit !== undefined) return hit;
		const out = this.factorOnce(aLat, aLon, bLat, bLon);
		this.memo.set(key, out);
		return out;
	}
}

/** Even-odd ray cast (same convention as eval/walk-buildings): is `p` inside
 *  the closed ring? The last→first edge is implicit. */
function pointInRingCore(p: Pt, ring: BuildingRing): boolean {
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

/** Equirectangular metres between two lat/lon points — accurate enough at
 *  the city scale this module operates on. */
export function metersBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
	const dLat = (bLat - aLat) * 111_320;
	const dLon = (bLon - aLon) * 111_320 * Math.cos((((aLat + bLat) / 2) * Math.PI) / 180);
	return Math.hypot(dLat, dLon);
}

/**
 * Project a point onto a segment, returning the foot of the perpendicular
 * (clamped to the segment), its fractional position `t ∈ [0,1]` from `a` to
 * `b`, and the perpendicular distance in metres.
 */
export function projectPointToSegment(p: Pt, a: Pt, b: Pt): { lat: number; lon: number; t: number; distM: number } {
	const cosLat = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
	const ax = 0;
	const ay = 0;
	const bx = (b.lon - a.lon) * 111_320 * cosLat;
	const by = (b.lat - a.lat) * 111_320;
	const px = (p.lon - a.lon) * 111_320 * cosLat;
	const py = (p.lat - a.lat) * 111_320;
	const len2 = (bx - ax) * (bx - ax) + (by - ay) * (by - ay);
	let t = len2 === 0 ? 0 : ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / len2;
	t = Math.max(0, Math.min(1, t));
	const lat = a.lat + t * (b.lat - a.lat);
	const lon = a.lon + t * (b.lon - a.lon);
	const distM = metersBetween(p.lat, p.lon, lat, lon);
	return { lat, lon, t, distM };
}

/** Integer key for a grid cell — the hot grids probe buckets millions of times
 *  per day and template-string keys were a measurable slice of matcher self time
 *  (plus the GC of the throwaway strings). `|cx| < 2^21` holds for every cell
 *  size in use (the smallest, 15 m, gives |cx| ≤ ~1.4 M at the equator), so the
 *  2^22 multiplier keys the pair collision-free within double precision. */
function cellKey(cy: number, cx: number): number {
	return cy * 4_194_304 + cx;
}

/**
 * Exact nearest-segment queries over a set of polyline chords, via a grid of
 * rasterised chord samples and an expanding-ring search.
 *
 * The brute-force alternative — project the query onto EVERY chord — is what
 * made `nearestRoadDist` and `TrackCorridor.distTo` the walkMatch hot spots
 * (O(chords) per query, called per drawn-line sample / per graph edge; measured
 * ~4 s/day). The grid answers the same query in near-constant time and is
 * EXACT, not approximate: rings are scanned outward until no unscanned chord
 * can possibly beat the best projection found (unscanned ⇒ every rasterised
 * sample ≥ (k−1)·cell away ⇒ true distance ≥ (k−1)·cell − cell/4, the
 * rasterisation step being ≤ cell/2 — the 1.5-cell stop margin also absorbs
 * the equirectangular cos drift across a leg-sized disc). Same floats in, min
 * of the same projections out ⇒ byte-identical results.
 *
 * `clampM` truncates the search for callers that only care up to a saturation
 * distance (the corridor penalty is flat beyond `corridorFarM`): the query
 * returns `min(trueDist, clampM)`, exact below the clamp.
 */
export class SegmentNearGrid {
	private readonly chords: Array<{ a: Pt; b: Pt }>;
	private readonly buckets = new Map<number, number[]>();
	private readonly cellM: number;
	private readonly cellLat: number;
	private readonly cellLon: number;
	private readonly seenGen: Uint32Array;
	private gen = 0;
	private minCy = 0;
	private maxCy = 0;
	private minCx = 0;
	private maxCx = 0;

	constructor(chords: Array<{ a: Pt; b: Pt }>, cellM: number, refLat: number) {
		this.chords = chords;
		this.cellM = cellM;
		this.cellLat = cellM / 111_320;
		this.cellLon = cellM / (111_320 * Math.cos((refLat * Math.PI) / 180));
		this.seenGen = new Uint32Array(chords.length);
		let first = true;
		for (let i = 0; i < chords.length; i++) {
			const { a, b } = chords[i];
			const steps = Math.max(1, Math.ceil((metersBetween(a.lat, a.lon, b.lat, b.lon) * 2) / cellM));
			let lastKey = Number.NaN;
			for (let k = 0; k <= steps; k++) {
				const f = k / steps;
				const cy = Math.floor((a.lat + f * (b.lat - a.lat)) / this.cellLat);
				const cx = Math.floor((a.lon + f * (b.lon - a.lon)) / this.cellLon);
				if (first || cy < this.minCy) this.minCy = cy;
				if (first || cy > this.maxCy) this.maxCy = cy;
				if (first || cx < this.minCx) this.minCx = cx;
				if (first || cx > this.maxCx) this.maxCx = cx;
				first = false;
				const key = cellKey(cy, cx);
				if (key === lastKey) continue;
				lastKey = key;
				const b2 = this.buckets.get(key);
				if (b2) {
					if (b2[b2.length - 1] !== i) b2.push(i);
				} else this.buckets.set(key, [i]);
			}
		}
	}

	/** From a set of OSM ways (each coord pair becomes a chord). */
	static fromWays(ways: readonly OsmRoadWay[], cellM: number): SegmentNearGrid | null {
		const chords: Array<{ a: Pt; b: Pt }> = [];
		for (const w of ways) {
			for (let i = 1; i < w.coords.length; i++) {
				chords.push({
					a: { lat: w.coords[i - 1][0], lon: w.coords[i - 1][1] },
					b: { lat: w.coords[i][0], lon: w.coords[i][1] },
				});
			}
		}
		if (chords.length === 0) return null;
		return new SegmentNearGrid(chords, cellM, chords[0].a.lat);
	}

	/** From an ordered track polyline (consecutive point pairs become chords). */
	static fromTrack(pts: readonly Pt[], cellM: number): SegmentNearGrid | null {
		if (pts.length < 2) return null;
		const chords: Array<{ a: Pt; b: Pt }> = [];
		for (let i = 1; i < pts.length; i++) chords.push({ a: pts[i - 1], b: pts[i] });
		return new SegmentNearGrid(chords, cellM, pts[0].lat);
	}

	/** Exact `min(distance to nearest chord, clampM)`. */
	nearestDist(lat: number, lon: number, clampM = Number.POSITIVE_INFINITY): number {
		const cy = Math.floor(lat / this.cellLat);
		const cx = Math.floor(lon / this.cellLon);
		// Rings past the occupied bounding box (plus one) cannot contain a bucket.
		const maxK = Math.max(cy - this.minCy, this.maxCy - cy, cx - this.minCx, this.maxCx - cx, 0) + 1;
		this.gen++;
		const p: Pt = { lat, lon };
		let best = Number.POSITIVE_INFINITY;
		for (let k = 0; k <= maxK; k++) {
			if ((k - 1.5) * this.cellM >= Math.min(best, clampM)) break;
			// Cells at Chebyshev distance exactly k.
			const yLo = cy - k;
			const yHi = cy + k;
			for (let x = cx - k; x <= cx + k; x++) {
				best = this.probe(cellKey(yLo, x), p, best);
				if (k > 0) best = this.probe(cellKey(yHi, x), p, best);
			}
			for (let y = yLo + 1; y <= yHi - 1; y++) {
				best = this.probe(cellKey(y, cx - k), p, best);
				best = this.probe(cellKey(y, cx + k), p, best);
			}
		}
		return Math.min(best, clampM);
	}

	private probe(key: number, p: Pt, best: number): number {
		const bucket = this.buckets.get(key);
		if (!bucket) return best;
		for (const i of bucket) {
			if (this.seenGen[i] === this.gen) continue;
			this.seenGen[i] = this.gen;
			const d = segmentDistM(p, this.chords[i].a, this.chords[i].b);
			if (d < best) best = d;
		}
		return best;
	}
}

/** {@link projectPointToSegment}'s distance only, allocation-free — the grid
 *  probe runs it per candidate chord on the hot path and the projection object
 *  was pure GC churn there. Identical arithmetic, identical floats. */
function segmentDistM(p: Pt, a: Pt, b: Pt): number {
	const cosLat = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
	const bx = (b.lon - a.lon) * 111_320 * cosLat;
	const by = (b.lat - a.lat) * 111_320;
	const px = (p.lon - a.lon) * 111_320 * cosLat;
	const py = (p.lat - a.lat) * 111_320;
	const len2 = bx * bx + by * by;
	let t = len2 === 0 ? 0 : (px * bx + py * by) / len2;
	t = Math.max(0, Math.min(1, t));
	return metersBetween(p.lat, p.lon, a.lat + t * (b.lat - a.lat), a.lon + t * (b.lon - a.lon));
}

/**
 * Fraction of `fixes` whose nearest way in `geo` is further than `thresholdM`.
 * A low value means the raw GPS already hugs the network; a high value means the
 * raw track is genuinely off-network ("through the buildings"). Pure.
 */
export function fractionOffRoad(fixes: readonly RoadFix[], geo: RoadGeometry, thresholdM: number): number {
	if (fixes.length === 0) return 0;
	let off = 0;
	for (const f of fixes) {
		let best = Number.POSITIVE_INFINITY;
		for (const w of geo.ways) {
			for (let i = 1; i < w.coords.length; i++) {
				const d = projectPointToSegment(
					f,
					{ lat: w.coords[i - 1][0], lon: w.coords[i - 1][1] },
					{ lat: w.coords[i][0], lon: w.coords[i][1] },
				).distM;
				if (d < best) best = d;
				if (best <= thresholdM) break;
			}
			if (best <= thresholdM) break;
		}
		if (best > thresholdM) off++;
	}
	return off / fixes.length;
}

/** Grid cell (m) for way-distance queries — off-network excursions of interest
 *  are a few tens of metres, so most queries resolve within a ring or two. */
const WAY_DIST_GRID_CELL_M = 64;

/** Nearest distance (m) from a point to any way in `geo`. `index`, when the
 *  caller has one (built once per geometry via {@link SegmentNearGrid.fromWays}),
 *  answers in near-constant time; without it this is a full scan of every way
 *  chord — fine for a one-off query, the hot spot when called per sample. */
export function nearestRoadDist(p: Pt, geo: RoadGeometry, index?: SegmentNearGrid | null): number {
	if (index) return index.nearestDist(p.lat, p.lon);
	let best = Number.POSITIVE_INFINITY;
	for (const w of geo.ways) {
		for (let i = 1; i < w.coords.length; i++) {
			const d = projectPointToSegment(
				p,
				{ lat: w.coords[i - 1][0], lon: w.coords[i - 1][1] },
				{ lat: w.coords[i][0], lon: w.coords[i][1] },
			).distM;
			if (d < best) best = d;
		}
	}
	return best;
}

/**
 * Maximum off-network distance of a *drawn polyline* — sampling not just the
 * vertices but points every `stepM` along each chord. The signal
 * {@link fractionOffRoad} misses: sparse fixes each on a way, joined by a chord
 * that cuts across a block. The map draws the chords, so the chords are what we
 * must measure. Pure.
 */
export function maxPolylineOffRoad(
	path: readonly Pt[],
	geo: RoadGeometry,
	stepM = 15,
	index?: SegmentNearGrid | null,
): number {
	if (path.length === 0 || geo.ways.length === 0) return 0;
	// One grid over the ways amortises across every sample of the drawn line —
	// the per-sample full scan was the display-gate hot spot.
	const idx = index ?? SegmentNearGrid.fromWays(geo.ways, WAY_DIST_GRID_CELL_M);
	let worst = 0;
	const consider = (p: Pt): void => {
		const d = nearestRoadDist(p, geo, idx);
		if (d > worst) worst = d;
	};
	for (let i = 0; i < path.length; i++) {
		consider(path[i]);
		if (i + 1 < path.length) {
			const a = path[i];
			const b = path[i + 1];
			const chord = metersBetween(a.lat, a.lon, b.lat, b.lon);
			const n = Math.floor(chord / stepM);
			for (let k = 1; k < n; k++) {
				consider({ lat: a.lat + ((b.lat - a.lat) * k) / n, lon: a.lon + ((b.lon - a.lon) * k) / n });
			}
		}
	}
	return worst;
}

/** Distance (m) from a single point to the nearest segment of `path`. */
export function pointDistToPolyline(p: Pt, path: readonly Pt[]): number {
	if (path.length === 0) return Number.POSITIVE_INFINITY;
	if (path.length === 1) return metersBetween(p.lat, p.lon, path[0].lat, path[0].lon);
	let best = Number.POSITIVE_INFINITY;
	for (let i = 1; i < path.length; i++) best = Math.min(best, projectPointToSegment(p, path[i - 1], path[i]).distM);
	return best;
}

/** How far a candidate matched path strays from where the GPS actually was,
 *  as the `q`-quantile (0–1) of the fixes' distances to the path — NOT the max.
 *  A *systematic* error — a snap onto a parallel way — pushes most fixes off,
 *  which a high quantile (p85) catches while ignoring one or two outliers. Pure. */
export function quantilePointDistToPolyline(pts: readonly Pt[], path: readonly Pt[], q: number): number {
	if (pts.length === 0 || path.length === 0) return 0;
	const dists = pts.map((p) => pointDistToPolyline(p, path)).sort((a, b) => a - b);
	return dists[Math.min(dists.length - 1, Math.floor(dists.length * q))];
}

/** Decision returned by {@link matchImprovesDisplay}, with the metrics that
 *  drove it (so callers can log why a leg was / wasn't snapped). */
export interface DisplayMatchDecision {
	use: boolean;
	rawOffRoadM: number;
	matchedOffRoadM: number;
	strayM: number;
}

/** Quantile of fix-to-path distances used for the faithfulness check —
 *  high enough to catch a systematic parallel-way snap (most fixes off),
 *  below 1 so one or two outlier fixes don't veto an otherwise-good match. */
const STRAY_QUANTILE = 0.85;

/**
 * Whether to draw the matched path instead of the raw fixes, judged on the
 * *drawn line* rather than the fix vertices. Use the match when all three hold:
 *   1. the raw drawn line genuinely strays off-network (worst chord excursion
 *      exceeds `needsMatchM`) — so a leg already hugging the network is left alone;
 *   2. the matched line follows the network better than the raw line did; and
 *   3. the match stays faithful to where the GPS was — its {@link STRAY_QUANTILE}
 *      of fix-to-path distances is within `maxStrayM` (the parallel-way guard).
 * Pure.
 */
export function matchImprovesDisplay(
	fixes: readonly Pt[],
	matchedPath: readonly Pt[],
	geo: RoadGeometry,
	needsMatchM: number,
	maxStrayM: number,
): DisplayMatchDecision {
	const index = geo.ways.length > 0 ? SegmentNearGrid.fromWays(geo.ways, WAY_DIST_GRID_CELL_M) : null;
	const rawOffRoadM = maxPolylineOffRoad(fixes, geo, undefined, index);
	const matchedOffRoadM = maxPolylineOffRoad(matchedPath, geo, undefined, index);
	const strayM = quantilePointDistToPolyline(fixes, matchedPath, STRAY_QUANTILE);
	const use = rawOffRoadM > needsMatchM && matchedOffRoadM < rawOffRoadM && strayM <= maxStrayM;
	return { use, rawOffRoadM, matchedOffRoadM, strayM };
}

/** Below this many fixes a supported/divergent split is noise, not signal. */
const MIN_SPLICE_FIXES = 4;
/** A splice must keep the matched line for at least this fraction of fixes;
 *  below it the divergence is systematic (a parallel-way snap) and the whole
 *  match is untrustworthy — exactly the case the stray gate exists for. */
const SPLICE_MIN_SUPPORTED_FRACTION = 0.5;
/** A divergent fix farther than this from the matched path is a teleport /
 *  reacquire smear, not walking through an unmapped forecourt beside the
 *  street (the 2026-05-15 20:18Z indoor-jitter leg strayed 2.3 km) — refuse. */
const SPLICE_MAX_DIVERGENCE_M = 150;
/** More contiguous divergent runs than this is jitter straddling the stray
 *  bound, not one coherent unmapped area — splicing would draw a zigzag. */
const SPLICE_MAX_DIVERGENT_RUNS = 2;
/** The spliced line may not be longer than the raw fix line by more than this
 *  factor (+ the slack below): a forecourt splice keeps ~the raw length, while
 *  a matcher over-route hidden inside a fix-free supported span inflates it
 *  (the 2026-05-25 09:43Z leg drew 103 m past its pedometer budget). */
const SPLICE_MAX_LEN_FACTOR = 1.15;
const SPLICE_MAX_LEN_SLACK_M = 30;

/** Projection of a point onto a polyline: nearest distance plus the arc-length
 *  position of that nearest point (`cum` = precomputed cumulative vertex arcs). */
function projectToPolylineArc(p: Pt, path: readonly Pt[], cum: readonly number[]): { distM: number; arcM: number } {
	let distM = Number.POSITIVE_INFINITY;
	let arcM = 0;
	for (let i = 1; i < path.length; i++) {
		const proj = projectPointToSegment(p, path[i - 1], path[i]);
		if (proj.distM < distM) {
			distM = proj.distM;
			arcM = cum[i - 1] + (cum[i] - cum[i - 1]) * proj.t;
		}
	}
	return { distM, arcM };
}

/** The sub-polyline between arc positions `s0 ≤ s1`, endpoints interpolated
 *  (position and `ts` linearly within their segments). */
function slicePathByArc(path: readonly MatchedPoint[], cum: readonly number[], s0: number, s1: number): MatchedPoint[] {
	const at = (s: number): MatchedPoint => {
		for (let i = 1; i < path.length; i++) {
			if (s <= cum[i] || i === path.length - 1) {
				const span = cum[i] - cum[i - 1];
				const t = span > 0 ? Math.min(1, Math.max(0, (s - cum[i - 1]) / span)) : 0;
				const a = path[i - 1];
				const b = path[i];
				return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t, ts: a.ts + (b.ts - a.ts) * t };
			}
		}
		return path[path.length - 1];
	};
	const out: MatchedPoint[] = [at(s0)];
	for (let i = 0; i < path.length; i++) {
		if (cum[i] > s0 && cum[i] < s1) out.push(path[i]);
	}
	if (s1 > s0) out.push(at(s1));
	return out;
}

/**
 * Salvage a match the stray gate rejected for a LOCAL divergence (#368): keep
 * the matched line over the spans the fixes support, splice the raw fixes back
 * in over each contiguous run that genuinely leaves the matched path (an
 * unmapped station forecourt / courtyard the network has no way through). The
 * 2026-07-15 morning leg is the motivating case: 26 of 34 fixes ride the
 * matched line within metres, but the 8-fix forecourt tail pushed the p85
 * stray past the gate and the WHOLE leg fell back to raw chords.
 *
 * Refuses (`null`) when the divergence is systematic rather than local —
 * fewer than {@link SPLICE_MIN_SUPPORTED_FRACTION} of fixes support the match
 * (the parallel-way snap the gate exists for), the leg is too short to judge,
 * there is nothing to splice, or a supported run projects non-monotonically
 * onto the path. Pure.
 */
export function spliceMatchedWithDivergentRuns(
	fixes: readonly RoadFix[],
	matchedPath: readonly MatchedPoint[],
	maxStrayM: number,
): MatchedPoint[] | null {
	if (fixes.length < MIN_SPLICE_FIXES || matchedPath.length < 2) return null;
	const cum: number[] = [0];
	for (let i = 1; i < matchedPath.length; i++) {
		cum.push(
			cum[i - 1] +
				metersBetween(matchedPath[i - 1].lat, matchedPath[i - 1].lon, matchedPath[i].lat, matchedPath[i].lon),
		);
	}
	const proj = fixes.map((f) => projectToPolylineArc(f, matchedPath, cum));
	const divergent = proj.map((pr) => pr.distM > maxStrayM);
	const nDivergent = divergent.filter(Boolean).length;
	if (nDivergent === 0) return null;
	if ((fixes.length - nDivergent) / fixes.length < SPLICE_MIN_SUPPORTED_FRACTION) return null;
	// Forecourt signature only: the divergence must be NEAR the network (not a
	// teleport smear) and coherent (few contiguous runs, not jitter).
	for (let k = 0; k < fixes.length; k++) {
		if (divergent[k] && proj[k].distM > SPLICE_MAX_DIVERGENCE_M) return null;
	}
	let nRuns = 0;
	for (let k = 0; k < fixes.length; k++) {
		if (divergent[k] && (k === 0 || !divergent[k - 1])) nRuns++;
	}
	if (nRuns > SPLICE_MAX_DIVERGENT_RUNS) return null;

	const out: MatchedPoint[] = [];
	let i = 0;
	while (i < fixes.length) {
		let j = i;
		while (j + 1 < fixes.length && divergent[j + 1] === divergent[i]) j++;
		if (divergent[i]) {
			// Divergent run: the honest line is the raw fixes themselves.
			for (let k = i; k <= j; k++) out.push({ lat: fixes[k].lat, lon: fixes[k].lon, ts: fixes[k].ts });
		} else {
			const s0 = proj[i].arcM;
			const s1 = proj[j].arcM;
			// A supported run that walks BACKWARD along the path is not a clean
			// local divergence — bail rather than draw a scrambled line.
			if (s1 < s0) return null;
			out.push(...slicePathByArc(matchedPath, cum, s0, s1));
		}
		i = j + 1;
	}
	// Collapse consecutive near-duplicate vertices from slice endpoints.
	const deduped: MatchedPoint[] = [];
	for (const p of out) {
		const last = deduped[deduped.length - 1];
		if (last !== undefined && Math.abs(last.lat - p.lat) < 1e-9 && Math.abs(last.lon - p.lon) < 1e-9) continue;
		deduped.push(p);
	}
	if (deduped.length < 2) return null;
	// Length-honesty guard: refuse when the splice draws meaningfully more
	// line than the raw fixes support (an over-route inside a fix-free span).
	let rawLenM = 0;
	for (let k = 1; k < fixes.length; k++) {
		rawLenM += metersBetween(fixes[k - 1].lat, fixes[k - 1].lon, fixes[k].lat, fixes[k].lon);
	}
	let splicedLenM = 0;
	for (let k = 1; k < deduped.length; k++) {
		splicedLenM += metersBetween(deduped[k - 1].lat, deduped[k - 1].lon, deduped[k].lat, deduped[k].lon);
	}
	if (splicedLenM > rawLenM * SPLICE_MAX_LEN_FACTOR + SPLICE_MAX_LEN_SLACK_M) return null;
	return deduped;
}

interface RoadSegment {
	u: number; // graph vertex id of coords[i-1]
	v: number; // graph vertex id of coords[i]
	lengthM: number;
	/** Name of the OSM way this segment belongs to — the way-continuity prior
	 *  compares consecutive fixes' way names. */
	wayName: string | null;
}

interface RoadGraph {
	vertices: Pt[];
	/** Adjacency: neighbour vertex + undirected edge id (weights via `weightOf`). */
	adj: Array<Array<{ to: number; e: number }>>;
	/** Real way segments — the candidate-projection surface. Excludes gap-bridge
	 *  edges, which are graph connectivity only. */
	segments: RoadSegment[];
	/** Corridor- and building-weighted cost of edge `e`, computed on FIRST read
	 *  and memoised. Dijkstra only relaxes the edges it actually reaches — a
	 *  radius-bounded region near the fixes — while the eager version paid the
	 *  corridor + building test for every edge in the disc up front (measured
	 *  the dominant walkMatch cost). Same floats on every edge that is read. */
	weightOf(e: number): number;
}

/**
 * Build a routable, undirected graph from the ways. Vertices are way nodes
 * deduplicated by rounded coordinate (shared nodes connect ways); edges are
 * consecutive node pairs within a way plus gap-bridge edges between nearby
 * vertices of different ways.
 */
function buildRoadGraph(
	ways: readonly OsmRoadWay[],
	corridor: TrackCorridor,
	profile: MatchProfile,
	bpen: BuildingPenalty | null = null,
): RoadGraph {
	const vertices: Pt[] = [];
	const adj: Array<Array<{ to: number; e: number }>> = [];
	const segments: RoadSegment[] = [];
	const idByKey = new Map<string, number>();
	// Raw endpoint coords per edge — the ORIGINAL way coords, not the deduped
	// vertex coords (a shared node keeps the first way's floats; the weight must
	// keep using this way's own, as the eager version did).
	const edgeCoords: number[] = [];
	const weights: Array<number | undefined> = [];

	const vertexId = (lat: number, lon: number): number => {
		const key = `${lat.toFixed(profile.vertexDp)},${lon.toFixed(profile.vertexDp)}`;
		let id = idByKey.get(key);
		if (id === undefined) {
			id = vertices.length;
			idByKey.set(key, id);
			vertices.push({ lat, lon });
			adj.push([]);
		}
		return id;
	};
	const addEdge = (a: number, b: number, aLat: number, aLon: number, bLat: number, bLon: number): void => {
		if (a === b) return;
		const e = weights.length;
		weights.push(undefined);
		edgeCoords.push(aLat, aLon, bLat, bLon);
		adj[a].push({ to: b, e });
		adj[b].push({ to: a, e });
	};

	for (const way of ways) {
		let prev = -1;
		let prevLat = 0;
		let prevLon = 0;
		for (const [lat, lon] of way.coords) {
			const id = vertexId(lat, lon);
			if (prev >= 0 && id !== prev) {
				addEdge(prev, id, prevLat, prevLon, lat, lon);
				segments.push({ u: prev, v: id, lengthM: metersBetween(prevLat, prevLon, lat, lon), wayName: way.name });
			}
			prev = id;
			prevLat = lat;
			prevLon = lon;
		}
	}

	bridgeGaps(vertices, adj, profile.gapBridgeM, addEdge);

	// Edge weight is corridor-penalised (routing cost), times the building
	// factor for an unsupported through-building edge; the segment's `lengthM`
	// stays the raw metric length (candidate offsets + the physical route
	// length reported to the transition model).
	const weightOf = (e: number): number => {
		let w = weights[e];
		if (w === undefined) {
			const k = e * 4;
			const aLat = edgeCoords[k];
			const aLon = edgeCoords[k + 1];
			const bLat = edgeCoords[k + 2];
			const bLon = edgeCoords[k + 3];
			const bf = bpen ? bpen.factorOnce(aLat, aLon, bLat, bLon) : 1;
			w = corridor.edgeWeight(aLat, aLon, bLat, bLon) * bf;
			weights[e] = w;
		}
		return w;
	};
	return { vertices, adj, segments, weightOf };
}

/** Add edges between vertices of different ways within `gapBridgeM` that do not
 *  share an OSM node. Candidate pairs come from a coarse grid hash so this stays
 *  linear in vertex count. */
function bridgeGaps(
	vertices: Pt[],
	adj: Array<Array<{ to: number; e: number }>>,
	gapBridgeM: number,
	addEdge: (a: number, b: number, aLat: number, aLon: number, bLat: number, bLon: number) => void,
): void {
	if (vertices.length === 0) return;
	const cellLat = gapBridgeM / 111_320;
	const midLat = vertices[0].lat;
	const cellLon = gapBridgeM / (111_320 * Math.cos((midLat * Math.PI) / 180));
	const buckets = new Map<number, number[]>();
	for (let i = 0; i < vertices.length; i++) {
		const key = cellKey(Math.floor(vertices[i].lat / cellLat), Math.floor(vertices[i].lon / cellLon));
		const b = buckets.get(key);
		if (b) b.push(i);
		else buckets.set(key, [i]);
	}
	for (let i = 0; i < vertices.length; i++) {
		const v = vertices[i];
		const baseLat = Math.floor(v.lat / cellLat);
		const baseLon = Math.floor(v.lon / cellLon);
		for (let dLat = -1; dLat <= 1; dLat++) {
			for (let dLon = -1; dLon <= 1; dLon++) {
				const b = buckets.get(cellKey(baseLat + dLat, baseLon + dLon));
				if (!b) continue;
				for (const j of b) {
					if (j <= i) continue;
					// Per-axis quick reject before the trig-bearing distance. The 1%
					// slack keeps it strictly conservative against the equirectangular
					// cos drift between the pair's own midpoint and the grid's refLat.
					if (Math.abs(vertices[j].lat - v.lat) > cellLat * 1.01 || Math.abs(vertices[j].lon - v.lon) > cellLon * 1.01)
						continue;
					const gap = metersBetween(v.lat, v.lon, vertices[j].lat, vertices[j].lon);
					if (gap > gapBridgeM) continue;
					if (adj[i].some((e) => e.to === j)) continue;
					addEdge(i, j, v.lat, v.lon, vertices[j].lat, vertices[j].lon);
				}
			}
		}
	}
}

/** A grid index over way segments for fast nearby-segment queries. Each segment
 *  is rasterised into every cell its polyline passes through, so the 3×3
 *  neighbourhood of a fix contains every segment whose nearest point is within
 *  the match radius. */
class SegmentIndex {
	private readonly cellLat: number;
	private readonly cellLon: number;
	private readonly buckets = new Map<number, number[]>();

	constructor(vertices: readonly Pt[], segments: readonly RoadSegment[], cellM: number, refLat: number) {
		this.cellLat = cellM / 111_320;
		this.cellLon = cellM / (111_320 * Math.cos((refLat * Math.PI) / 180));
		for (let i = 0; i < segments.length; i++) {
			const s = segments[i];
			const a = vertices[s.u];
			const b = vertices[s.v];
			const steps = Math.max(1, Math.ceil((s.lengthM * 2) / cellM));
			const seen = new Set<number>();
			for (let k = 0; k <= steps; k++) {
				const f = k / steps;
				const key = this.key(a.lat + f * (b.lat - a.lat), a.lon + f * (b.lon - a.lon));
				if (seen.has(key)) continue;
				seen.add(key);
				const bucket = this.buckets.get(key);
				if (bucket) bucket.push(i);
				else this.buckets.set(key, [i]);
			}
		}
	}

	private key(lat: number, lon: number): number {
		return cellKey(Math.floor(lat / this.cellLat), Math.floor(lon / this.cellLon));
	}

	/** Segment indices whose cell neighbourhood covers `(lat, lon)`. */
	near(lat: number, lon: number): number[] {
		const baseLat = Math.floor(lat / this.cellLat);
		const baseLon = Math.floor(lon / this.cellLon);
		const out = new Set<number>();
		for (let dLat = -1; dLat <= 1; dLat++) {
			for (let dLon = -1; dLon <= 1; dLon++) {
				const b = this.buckets.get(cellKey(baseLat + dLat, baseLon + dLon));
				if (b) for (const i of b) out.add(i);
			}
		}
		return [...out];
	}
}

/** A candidate way position for one fix: the projection onto a way segment, with
 *  the segment's endpoints and on-edge offset for routing. */
interface Candidate {
	lat: number;
	lon: number;
	distM: number;
	seg: RoadSegment;
	/** Fractional position from `seg.u` to `seg.v`. */
	t: number;
}

/** The `maxCandidatesPerFix` nearest way projections within radius. */
function candidatesForFix(
	fix: RoadFix,
	graph: RoadGraph,
	index: SegmentIndex,
	radiusM: number,
	maxCandidates: number,
): Candidate[] {
	const cands: Candidate[] = [];
	for (const si of index.near(fix.lat, fix.lon)) {
		const seg = graph.segments[si];
		const a = graph.vertices[seg.u];
		const b = graph.vertices[seg.v];
		const proj = projectPointToSegment(fix, a, b);
		if (proj.distM <= radiusM) cands.push({ lat: proj.lat, lon: proj.lon, distM: proj.distM, seg, t: proj.t });
	}
	cands.sort((p, q) => p.distM - q.distM);
	return cands.slice(0, maxCandidates);
}

/** A binary min-heap keyed on numeric priority — the Dijkstra queue. */
class MinHeap {
	private readonly heap: Array<{ p: number; v: number }> = [];
	get size(): number {
		return this.heap.length;
	}
	push(p: number, v: number): void {
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
	pop(): { p: number; v: number } | undefined {
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

/** A lazily-settled radius-bounded Dijkstra from one source vertex.
 *
 *  The eager version settled the ENTIRE weighted radius disc per source —
 *  `(maxStep·detourFactor + detourSlackM)·corridorMaxPenalty` is ~23 km
 *  weighted for an 80 m walk fix gap, so every source explored most of the
 *  local graph while `routeBetween` only ever reads a handful of candidate
 *  end vertices a few hundred weighted metres away. This version pauses as
 *  soon as the requested target settles and resumes for later targets.
 *
 *  Reads are byte-identical to the eager run: Dijkstra settles vertices in
 *  nondecreasing distance order, so a settled target's `dist`/`prev` chain is
 *  final regardless of where the search paused; and the one tentative case —
 *  the eager version let `routeBetween` read a finite-but-unsettled `dist`
 *  for a vertex past the radius break — only occurs after `exhausted`, where
 *  this version has performed exactly the eager run's operation sequence. */
class LazyDijkstra {
	readonly dist: Float64Array;
	readonly prev: Int32Array;
	private readonly done: Uint8Array;
	private readonly heap = new MinHeap();
	private exhausted = false;
	constructor(
		private readonly graph: RoadGraph,
		source: number,
		private readonly maxRadiusM: number,
	) {
		const n = graph.vertices.length;
		this.dist = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
		this.prev = new Int32Array(n).fill(-1);
		this.done = new Uint8Array(n);
		this.dist[source] = 0;
		this.heap.push(0, source);
	}

	/** Run the search forward until `target` settles (its `dist`/`prev` are
	 *  final) or the radius/heap is exhausted (remaining reads are tentative,
	 *  matching the eager version's post-break state). */
	settle(target: number): void {
		if (this.done[target] === 1 || this.exhausted) return;
		while (this.heap.size > 0) {
			const cur = this.heap.pop();
			if (cur === undefined) break;
			const u = cur.v;
			if (this.done[u]) continue;
			this.done[u] = 1;
			if (cur.p > this.maxRadiusM) {
				// Same semantics as the eager `break`: the over-radius vertex is
				// marked done but never relaxed, and the search ends for good.
				this.exhausted = true;
				return;
			}
			for (const e of this.graph.adj[u]) {
				const nd = cur.p + this.graph.weightOf(e.e);
				if (nd < this.dist[e.to]) {
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

/** Memoised lazily-settled Dijkstra cache, scoped to one match run. Callers
 *  must `settle(target)` before reading `dist[target]`/walking `prev`. */
class RouteCache {
	private readonly cache = new Map<number, LazyDijkstra>();
	constructor(
		private readonly graph: RoadGraph,
		private readonly maxRadiusM: number,
	) {}
	from(source: number): LazyDijkstra {
		let r = this.cache.get(source);
		if (r === undefined) {
			r = new LazyDijkstra(this.graph, source, this.maxRadiusM);
			this.cache.set(source, r);
		}
		return r;
	}
}

/** The on-road route from candidate `a` to candidate `b`: its length (m) and the
 *  polyline from `a`'s projection to `b`'s projection. Considers the four
 *  endpoint combinations (and the same-segment case) and returns the shortest
 *  feasible one, or null when no route is within the cache's radius.
 *
 *  With a building layer (`bpen`), the projection→endpoint offsets and the
 *  same-segment direct hop are building-weighted like every graph edge —
 *  otherwise a candidate at a passage's mouth would slide through the whole
 *  building at raw metric cost, bypassing the penalty entirely (the measured
 *  2026-07-01 defect). The reported `distM` stays the true metric length. */
function routeBetween(
	a: Candidate,
	b: Candidate,
	graph: RoadGraph,
	cache: RouteCache,
	bpen: BuildingPenalty | null = null,
): { distM: number; verts: Pt[] } | null {
	// Same way segment: travel straight along it — unless that direct hop is an
	// unsupported building crossing, in which case the endpoint combos below
	// compete (the router may go around the block instead).
	let best: { weighted: number; verts: Pt[] } | null = null;
	if (a.seg.u === b.seg.u && a.seg.v === b.seg.v) {
		const distM = Math.abs(b.t - a.t) * a.seg.lengthM;
		const verts: Pt[] = [
			{ lat: a.lat, lon: a.lon },
			{ lat: b.lat, lon: b.lon },
		];
		const bf = bpen ? bpen.factor(a.lat, a.lon, b.lat, b.lon) : 1;
		if (bf === 1) return { distM, verts };
		best = { weighted: distM * bf, verts };
	}

	const offsetFactor = (c: Candidate, vid: number): number => {
		if (!bpen) return 1;
		const v = graph.vertices[vid];
		return bpen.factor(c.lat, c.lon, v.lat, v.lon);
	};
	const aEnds: Array<{ vid: number; offset: number }> = [
		{ vid: a.seg.u, offset: a.t * a.seg.lengthM * offsetFactor(a, a.seg.u) },
		{ vid: a.seg.v, offset: (1 - a.t) * a.seg.lengthM * offsetFactor(a, a.seg.v) },
	];
	const bEnds: Array<{ vid: number; offset: number }> = [
		{ vid: b.seg.u, offset: b.t * b.seg.lengthM * offsetFactor(b, b.seg.u) },
		{ vid: b.seg.v, offset: (1 - b.t) * b.seg.lengthM * offsetFactor(b, b.seg.v) },
	];
	for (const ae of aEnds) {
		const rd = cache.from(ae.vid);
		for (const be of bEnds) {
			rd.settle(be.vid);
			const mid = rd.dist[be.vid];
			if (!Number.isFinite(mid)) continue;
			const weighted = ae.offset + mid + be.offset;
			if (best && weighted >= best.weighted) continue;
			// Reconstruct the vertex path ae.vid → be.vid.
			const idPath: number[] = [];
			for (let v = be.vid; v !== -1; v = rd.prev[v]) idPath.push(v);
			idPath.reverse();
			if (idPath[0] !== ae.vid) continue; // unreached / disconnected
			const verts: Pt[] = [{ lat: a.lat, lon: a.lon }];
			for (const vid of idPath) verts.push(graph.vertices[vid]);
			verts.push({ lat: b.lat, lon: b.lon });
			best = { weighted, verts: dedupeConsecutive(verts) };
		}
	}
	return best ? { distM: pathLength(best.verts), verts: best.verts } : null;
}

/** Drop consecutive near-duplicate vertices. */
function dedupeConsecutive(pts: readonly Pt[]): Pt[] {
	const out: Pt[] = [];
	for (const p of pts) {
		const last = out[out.length - 1];
		if (last && metersBetween(last.lat, last.lon, p.lat, p.lon) < 0.5) continue;
		out.push(p);
	}
	return out;
}

/**
 * Douglas-Peucker simplification of a timestamped polyline: drop vertices within
 * `toleranceM` of the line joining the retained neighbours. Endpoints are always
 * kept. Retained vertices keep their interpolated timestamps, so the result
 * stays monotonic and window-anchored.
 */
export function simplifyPath(pts: readonly MatchedPoint[], toleranceM: number): MatchedPoint[] {
	if (pts.length <= 2) return [...pts];
	const keep = new Uint8Array(pts.length);
	keep[0] = 1;
	keep[pts.length - 1] = 1;
	const stack: Array<[number, number]> = [[0, pts.length - 1]];
	while (stack.length > 0) {
		const seg = stack.pop();
		if (seg === undefined) break;
		const [a, b] = seg;
		let maxd = -1;
		let idx = -1;
		for (let i = a + 1; i < b; i++) {
			const d = projectPointToSegment(pts[i], pts[a], pts[b]).distM;
			if (d > maxd) {
				maxd = d;
				idx = i;
			}
		}
		if (maxd > toleranceM && idx > 0) {
			keep[idx] = 1;
			stack.push([a, idx], [idx, b]);
		}
	}
	const out: MatchedPoint[] = [];
	for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
	return out;
}

/**
 * Remove dead-end out-and-back spurs: a vertex `i` from which the path departs
 * and, within `maxSpan` steps, returns to within `returnM` of `v[i]`. The
 * excursion (and the near-duplicate return vertex) is dropped. Retained vertices
 * keep their timestamps, so the result stays monotonic.
 */
function removeSpurs(pts: readonly MatchedPoint[], returnM: number, maxSpan: number): MatchedPoint[] {
	const out = [...pts];
	for (let i = 0; i < out.length - 2; i++) {
		for (let j = Math.min(i + maxSpan, out.length - 1); j >= i + 2; j--) {
			if (metersBetween(out[i].lat, out[i].lon, out[j].lat, out[j].lon) <= returnM) {
				out.splice(i + 1, j - i);
				break;
			}
		}
	}
	return out;
}

/** A curve deeper than this (m, per chord) is drawn as its way geometry rather
 *  than a straight chord — see {@link spliceRouteDetail}. */
const DETAIL_TOLERANCE_M = 1.5;

/**
 * Carry the route's way geometry back into a cleaned matched line (#369): for
 * each chord of `coarse`, re-insert the assembled route's vertices between the
 * chord's endpoints when the route curves away from it by more than
 * {@link DETAIL_TOLERANCE_M} — but no more than `simplifyDropM`. The bound is
 * exact, not heuristic: a chord over SIMPLIFY-dropped geometry deviates at
 * most the simplify tolerance (the Douglas-Peucker guarantee), while a chord
 * over a DELIBERATE excision (spur removal, over-route trim, despiked apex)
 * deviates beyond it — that is why simplify had kept the excised vertices. So
 * this pass restores exactly what simplification flattened — a 100 m chord
 * that cut a bending pavement (through the school-grounds polygon on
 * 2026-07-15) now follows the bend — and every artifact excision stays
 * excised.
 */
export function spliceRouteDetail(
	coarse: readonly MatchedPoint[],
	route: readonly MatchedPoint[],
	simplifyDropM: number,
): MatchedPoint[] {
	if (coarse.length < 2 || route.length < 2) return [...coarse];
	const indexOf = (p: MatchedPoint, from: number): number => {
		for (let k = from; k < route.length; k++) {
			if (Math.abs(route[k].lat - p.lat) < 1e-9 && Math.abs(route[k].lon - p.lon) < 1e-9) return k;
		}
		return -1;
	};
	const out: MatchedPoint[] = [coarse[0]];
	let ia = indexOf(coarse[0], 0);
	for (let i = 1; i < coarse.length; i++) {
		const a = coarse[i - 1];
		const b = coarse[i];
		const ib = ia >= 0 ? indexOf(b, ia + 1) : -1;
		if (ia >= 0 && ib > ia + 1) {
			let maxDev = 0;
			for (let k = ia + 1; k < ib; k++) maxDev = Math.max(maxDev, projectPointToSegment(route[k], a, b).distM);
			if (maxDev > DETAIL_TOLERANCE_M && maxDev <= simplifyDropM) {
				for (let k = ia + 1; k < ib; k++) {
					const prev = out[out.length - 1];
					if (metersBetween(prev.lat, prev.lon, route[k].lat, route[k].lon) < 0.5) continue;
					// Keep timestamps monotone inside the chord window.
					const ts = Math.min(Math.max(route[k].ts, a.ts), b.ts);
					out.push({ lat: route[k].lat, lon: route[k].lon, ts });
				}
			}
		}
		out.push(b);
		ia = ib >= 0 ? ib : indexOf(b, 0);
	}
	return out;
}

/** Polyline length in metres. */
export function pathLength(pts: readonly Pt[]): number {
	let total = 0;
	for (let i = 1; i < pts.length; i++) total += metersBetween(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
	return total;
}

/**
 * Each matched vertex's monotone arc-length position along the time-ordered
 * `fixes` polyline (the GPS corridor). Non-decreasing, so an out-and-back
 * excursion's outbound leg can't reduce a vertex's corridor position below an
 * earlier one — the basis for spotting a stall (path advances, corridor doesn't).
 */
function corridorPositions(fixes: readonly Pt[], path: readonly Pt[]): number[] {
	const fArc: number[] = [0];
	for (let i = 1; i < fixes.length; i++) {
		fArc.push(fArc[i - 1] + metersBetween(fixes[i - 1].lat, fixes[i - 1].lon, fixes[i].lat, fixes[i].lon));
	}
	const cp: number[] = [];
	let minS = 0;
	for (const v of path) {
		let best = Number.POSITIVE_INFINITY;
		let bestS = minS;
		for (let i = 0; i < fixes.length - 1; i++) {
			const proj = projectPointToSegment(v, fixes[i], fixes[i + 1]);
			const s = fArc[i] + proj.t * (fArc[i + 1] - fArc[i]);
			if (proj.distM < best && s >= minS - 1) {
				best = proj.distM;
				bestS = s;
			}
		}
		cp.push(bestS);
		minS = bestS;
	}
	return cp;
}

/**
 * Excise OVER-ROUTE detours from a matched path: a stretch where the line
 * leaves the GPS corridor (its vertices stray > `offCorridorM` from every fix)
 * and returns, travelling ≥ `minStallM` while the corridor advances by less than
 * `detourRatio` of that — a loop the matcher invented to reach a spot the walker
 * barely moved past. Replace it with a direct hop between the on-corridor anchors
 * that bracket it.
 *
 * The two conditions separate the bug from the look-alikes: a GAP-FILL also
 * strays from the (sparse) fixes but advances the corridor in step with the line
 * (so the ratio test spares it), and a there-and-back walk the GPS actually
 * traced advances the corridor arc in step with the path (the fixes polyline
 * contains the out-and-back). Only the GPS-unsupported detours are removed,
 * keeping the good pavement-snapping for the rest of the walk.
 *
 * A second pass catches the TEMPORAL stall (#362): a doubling-back over street
 * the walker just covered sits within `offCorridorM` of the earlier fixes —
 * spatially supported, so the first pass never flags it — while its corridor
 * position is frozen (the phone never re-walked the street). Any stretch that
 * travels ≥ `minStallM`, advances the corridor by less than `stallRatio` of
 * that (much stricter than `detourRatio`: an invented double-back advances the
 * corridor near zero, while a window polluted with real walking rises well
 * above it), and RETURNS near where it started (net displacement <
 * `returnRatio` of the span — a real corner or way-bend ends far from its
 * start, so it can never qualify) is excised the same way.
 */
export function trimOverRouteExcursions(
	fixes: readonly Pt[],
	path: readonly MatchedPoint[],
	offCorridorM = 30,
	detourRatio = 0.5,
	minStallM = 80,
	returnRatio = 0.35,
	stallRatio = 0.15,
): MatchedPoint[] {
	if (path.length < 3 || fixes.length < 2) return [...path];
	const cp = corridorPositions(fixes, path);
	const n = path.length;
	// A vertex is on-corridor when it sits within `offCorridorM` of some fix —
	// i.e. near where the phone actually was.
	const onCorridor = path.map((v) => {
		let best = Number.POSITIVE_INFINITY;
		for (const f of fixes) best = Math.min(best, metersBetween(v.lat, v.lon, f.lat, f.lon));
		return best <= offCorridorM;
	});
	const remove = new Array<boolean>(n).fill(false);
	let k = 0;
	while (k < n) {
		if (onCorridor[k]) {
			k++;
			continue;
		}
		// Off-corridor run k..b-1, bracketed by anchors a (last on-corridor before)
		// and b (first on-corridor after). Need both to form a direct hop.
		const a = k - 1;
		let b = k;
		while (b < n && !onCorridor[b]) b++;
		if (a >= 0 && b < n) {
			const span = pathLength(path.slice(a, b + 1));
			const corridorAdv = cp[b] - cp[a];
			if (span >= minStallM && corridorAdv < span * detourRatio) {
				for (let x = k; x < b; x++) remove[x] = true;
			}
		}
		k = b;
	}
	// Temporal-stall pass: reversal stretches over already-walked ground.
	const cum: number[] = [0];
	for (let i = 1; i < n; i++) {
		cum.push(cum[i - 1] + metersBetween(path[i - 1].lat, path[i - 1].lon, path[i].lat, path[i].lon));
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
			if (span < minStallM) continue;
			const netDisp = metersBetween(path[a].lat, path[a].lon, path[b].lat, path[b].lon);
			if (cp[b] - cp[a] < span * stallRatio && netDisp < span * returnRatio) found = b;
		}
		if (found >= 0) {
			for (let x = a + 1; x < found; x++) remove[x] = true;
			a = found;
		} else {
			a++;
		}
	}
	// Drop the excised vertices, then any now-coincident neighbours.
	const out: MatchedPoint[] = [];
	for (let idx = 0; idx < n; idx++) {
		if (remove[idx]) continue;
		const prev = out[out.length - 1];
		if (!prev || metersBetween(prev.lat, prev.lon, path[idx].lat, path[idx].lon) > 0.5) out.push(path[idx]);
	}
	return out;
}

/** Perpendicular distance (m) from `p` to the infinite line through `a`–`b`. */
function perpDistM(p: Pt, a: Pt, b: Pt): number {
	const cosLat = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
	const bx = (b.lon - a.lon) * 111_320 * cosLat;
	const by = (b.lat - a.lat) * 111_320;
	const px = (p.lon - a.lon) * 111_320 * cosLat;
	const py = (p.lat - a.lat) * 111_320;
	const len = Math.hypot(bx, by);
	if (len < 1e-6) return Math.hypot(px, py);
	return Math.abs(px * by - py * bx) / len;
}

/**
 * Drop matched vertices where the snapper amplified GPS jitter into a spike (a
 * tight out-and-back triangle) the raw track never made (#295): the loop hugs
 * the noisy fixes closely and keeps advancing, so the corridor tests can't see
 * it — but its APEX juts much further off the chord between its neighbours than
 * any raw fix in the same span did.
 *
 * Three conditions together isolate the artifact from a real corner:
 *  - the apex nearly DOUBLES BACK (turn ≥ `minTurnDeg`) — a corner turns ~90°,
 *    an invented out-and-back reverses ~180°;
 *  - it sticks out ≥ `minApexM` off the chord; and
 *  - it sticks out ≥ `excessM` further than the raw GPS did there — so a tight
 *    turn the raw fixes also round (the whole point of snapping to a pavement)
 *    survives. When no raw fix falls in the span the vertex is kept.
 */
export function despikeUnsupportedApexes(
	path: readonly MatchedPoint[],
	rawFixes: readonly RoadFix[],
	minApexM = 15,
	excessM = 12,
	minTurnDeg = 140,
): MatchedPoint[] {
	if (path.length < 3) return [...path];
	const cosLatOf = (p: Pt) => Math.cos((p.lat * Math.PI) / 180);
	const keep = new Array<boolean>(path.length).fill(true);
	for (let i = 1; i < path.length - 1; i++) {
		const apexH = perpDistM(path[i], path[i - 1], path[i + 1]);
		if (apexH < minApexM) continue;
		// Turn angle at the apex: 0° straight, 90° a corner, ~180° a reversal.
		const cl = cosLatOf(path[i]);
		const ux = (path[i].lon - path[i - 1].lon) * cl;
		const uy = path[i].lat - path[i - 1].lat;
		const vx = (path[i + 1].lon - path[i].lon) * cl;
		const vy = path[i + 1].lat - path[i].lat;
		const un = Math.hypot(ux, uy);
		const vn = Math.hypot(vx, vy);
		if (un < 1e-12 || vn < 1e-12) continue;
		const turnDeg = (Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (un * vn)))) * 180) / Math.PI;
		if (turnDeg < minTurnDeg) continue;
		const t0 = Math.min(path[i - 1].ts, path[i + 1].ts);
		const t1 = Math.max(path[i - 1].ts, path[i + 1].ts);
		let rawH = 0;
		let nRaw = 0;
		for (const f of rawFixes) {
			if (f.ts >= t0 && f.ts <= t1) {
				rawH = Math.max(rawH, perpDistM(f, path[i - 1], path[i + 1]));
				nRaw++;
			}
		}
		if (nRaw > 0 && apexH - rawH >= excessM) keep[i] = false;
	}
	return path.filter((_, i) => keep[i]);
}

/** Gaussian emission log-likelihood for a snap distance. */
function emission(distM: number, sigmaZ: number): number {
	const z = distM / sigmaZ;
	return -0.5 * z * z;
}

/**
 * Append a route segment's interior + end vertices to the output, dropping the
 * leading vertex (already present as the previous anchor) and assigning
 * timestamps by cumulative distance between `startTs` and `endTs`.
 */
function appendInterpolated(out: MatchedPoint[], verts: readonly Pt[], startTs: number, endTs: number): void {
	if (verts.length === 0) return;
	const cum: number[] = [0];
	for (let i = 1; i < verts.length; i++) {
		cum.push(cum[i - 1] + metersBetween(verts[i - 1].lat, verts[i - 1].lon, verts[i].lat, verts[i].lon));
	}
	const total = cum[cum.length - 1];
	for (let i = 1; i < verts.length; i++) {
		const frac = total > 0 ? cum[i] / total : 1;
		out.push({ lat: verts[i].lat, lon: verts[i].lon, ts: Math.round(startTs + (endTs - startTs) * frac) });
	}
}

/**
 * Map-match a leg onto the way network under a {@link MatchProfile}.
 *
 * Returns the leg routed onto the ways and time-interpolated across the fix
 * window — or null when it cannot be matched (too few fixes, fixes off the
 * network, a disconnected or implausibly-long route). A null result means "draw
 * the raw fixes"; this never returns a degenerate or confidently-wrong path.
 */
export function matchTrajectory(
	fixes: readonly RoadFix[],
	geo: RoadGeometry,
	profile: MatchProfile,
): MatchResult | null {
	if (fixes.length < profile.minFixes) return null;
	const radiusM = profile.matchRadiusM;

	const corridor = new TrackCorridor(fixes, profile);
	// The impassable-building layer (walk profile only): unsupported
	// through-building edges cost extra, so the router prefers the block's
	// streets; a crossing the raw fixes actually traced stays free.
	const bpen =
		profile.buildingCrossFactor > 1 && geo.buildings !== undefined && geo.buildings.length > 0
			? new BuildingPenalty(geo.buildings, fixes, profile.buildingCrossFactor, profile.buildingSupportM)
			: null;
	const graph = buildRoadGraph(geo.ways, corridor, profile, bpen);
	if (graph.segments.length === 0) return null;

	const index = new SegmentIndex(graph.vertices, graph.segments, radiusM, fixes[0].lat);

	const obs: Array<{ fix: RoadFix; cands: Candidate[] }> = [];
	let roadless = 0;
	for (const fix of fixes) {
		const cands = candidatesForFix(fix, graph, index, radiusM, profile.maxCandidatesPerFix);
		if (cands.length === 0) roadless++;
		else obs.push({ fix, cands });
	}
	if (roadless / fixes.length > profile.maxRoadlessFraction) return null;
	if (obs.length < profile.minFixes) return null;

	let maxStep = 0;
	for (let i = 1; i < obs.length; i++) {
		const d = metersBetween(obs[i - 1].fix.lat, obs[i - 1].fix.lon, obs[i].fix.lat, obs[i].fix.lon);
		if (d > maxStep) maxStep = d;
	}
	const cache = new RouteCache(
		graph,
		(maxStep * profile.detourFactor + profile.detourSlackM) * profile.corridorMaxPenalty,
	);

	const n = obs.length;
	const score: number[][] = [];
	const back: number[][] = [];
	const routeOf: Array<Array<Array<{ distM: number; verts: Pt[] } | null>>> = [];

	score.push(obs[0].cands.map((c) => emission(c.distM, profile.sigmaZ)));
	back.push(obs[0].cands.map(() => -1));

	for (let t = 1; t < n; t++) {
		const prev = obs[t - 1];
		const cur = obs[t];
		const gpsStep = metersBetween(prev.fix.lat, prev.fix.lon, cur.fix.lat, cur.fix.lon);
		const row: number[] = [];
		const brow: number[] = [];
		const rmat: Array<Array<{ distM: number; verts: Pt[] } | null>> = [];
		for (let j = 0; j < cur.cands.length; j++) {
			let bestScore = Number.NEGATIVE_INFINITY;
			let bestPrev = -1;
			const rrow: Array<{ distM: number; verts: Pt[] } | null> = [];
			for (let i = 0; i < prev.cands.length; i++) {
				const route = routeBetween(prev.cands[i], cur.cands[j], graph, cache, bpen);
				rrow.push(route);
				if (route === null) continue;
				const trans = -Math.abs(route.distM - gpsStep) / profile.beta;
				// Way-continuity prior: discourage the matched way changing name
				// between consecutive fixes (0 for pedestrians, who change freely).
				const wa = prev.cands[i].seg.wayName;
				const wb = cur.cands[j].seg.wayName;
				const switchPen = wa && wb && wa !== wb ? profile.wayContinuityNats : 0;
				const s = score[t - 1][i] + trans - switchPen + emission(cur.cands[j].distM, profile.sigmaZ);
				if (s > bestScore) {
					bestScore = s;
					bestPrev = i;
				}
			}
			row.push(bestScore);
			brow.push(bestPrev);
			rmat.push(rrow);
		}
		if (row.every((s) => !Number.isFinite(s))) return null;
		score.push(row);
		back.push(brow);
		routeOf.push(rmat);
	}

	let endJ = 0;
	let endBest = Number.NEGATIVE_INFINITY;
	for (let j = 0; j < score[n - 1].length; j++) {
		if (score[n - 1][j] > endBest) {
			endBest = score[n - 1][j];
			endJ = j;
		}
	}
	if (!Number.isFinite(endBest)) return null;
	const chosen = new Int32Array(n);
	chosen[n - 1] = endJ;
	for (let t = n - 1; t > 0; t--) {
		const bp = back[t][chosen[t]];
		if (bp < 0) return null;
		chosen[t - 1] = bp;
	}

	const out: MatchedPoint[] = [];
	const first = obs[0].cands[chosen[0]];
	out.push({ lat: first.lat, lon: first.lon, ts: obs[0].fix.ts });
	for (let t = 1; t < n; t++) {
		const route = routeOf[t - 1][chosen[t]][chosen[t - 1]];
		if (route === null) return null;
		appendInterpolated(out, route.verts, obs[t - 1].fix.ts, obs[t].fix.ts);
	}

	const cleaned = removeSpurs(
		simplifyPath(out, profile.simplifyToleranceM),
		profile.spurReturnM,
		profile.spurMaxSpanVerts,
	);
	if (cleaned.length < 2) return null;
	const matched = cleaned.map((p) => ({ lat: p.lat, lon: p.lon }));
	const rawLen = pathLength(fixes.map((f) => ({ lat: f.lat, lon: f.lon })));
	if (pathLength(matched) > rawLen * profile.maxLenFactor + profile.maxLenSlackM) return null;

	return { path: cleaned, routeDetail: out };
}
