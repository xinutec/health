/**
 * Miss-driven rail-route cache fill (#363).
 *
 * `annotateSnappedPaths` draws a train leg on rails only when its
 * `<board> → <alight>[ · <line>]` label has a row in `rail_route_cache`.
 * The nightly `refresh-rail-routes` job computes routes from history, so a
 * key first seen TODAY — a new journey, or a blackout-fragmented one —
 * used to draw raw until tomorrow's run.
 *
 * This module closes that gap from the serving path without ever touching
 * the request itself: after a day is computed, any labelled-but-unsnapped
 * train leg is queued, and a single background worker computes that one
 * route (the same snap composite the nightly job uses: pooled-corridor
 * snap over the leg's own fixes, then the known-line fallback) and
 * inserts the row. The next cache-miss view of the day picks it up.
 *
 * Fast without being wrong:
 *  - the snapper's own guards are unchanged — an unroutable key stays
 *    un-snapped (draw raw), never a guessed line;
 *  - inserts never overwrite an existing row, so the nightly job's
 *    pooled-cloud geometry (computed from every historic ride) always
 *    wins over a single-day fill;
 *  - unroutable keys go on a cooldown so a lineless fragment label does
 *    not re-run the corridor scan on every page view;
 *  - one worker, one route at a time — the heavy corridor query cannot
 *    pile up under concurrent day views.
 */

import { db } from "../db/pool.js";
import { stationsOnLine } from "./line-stations.js";
import { queryRailCorridor } from "./osm-local.js";
import { parseRailWayName, snapTrainSegment, snapTrainSegmentOnLine, type TrainSegment } from "./rail-snap.js";

type Geometry = Array<{ lat: number; lon: number }>;

/** A train leg that wanted a snapped route and found no cache row. */
export interface RouteFillCandidate {
	/** The leg's `wayName` — the cache key. */
	key: string;
	seg: TrainSegment;
	/** The day's own fixes inside the leg's window (the corridor evidence). */
	fixes: Geometry;
}

/** The minimal segment shape the candidate scan reads. */
export interface FillSegment {
	mode: string;
	refinedMode?: string;
	startTs: number;
	endTs: number;
	wayName?: string;
	snappedPath?: unknown;
}

/**
 * Scan a computed day for train legs with a route label but no snapped
 * path — the cache misses worth filling. Legs sharing a key pool their
 * fixes (the same route ridden twice that day is one route). Pure.
 */
export function unsnappedTrainRoutes(
	segments: readonly FillSegment[],
	points: ReadonlyArray<{ ts: number; lat: number; lon: number }>,
): RouteFillCandidate[] {
	const byKey = new Map<string, RouteFillCandidate>();
	for (const s of segments) {
		if ((s.refinedMode ?? s.mode) !== "train" || !s.wayName || s.snappedPath) continue;
		const fixes = points.filter((p) => p.ts >= s.startTs && p.ts <= s.endTs).map((p) => ({ lat: p.lat, lon: p.lon }));
		const cur = byKey.get(s.wayName);
		if (cur) {
			cur.fixes.push(...fixes);
		} else {
			byKey.set(s.wayName, {
				key: s.wayName,
				seg: { startTs: s.startTs, endTs: s.endTs, wayName: s.wayName },
				fixes,
			});
		}
	}
	return [...byKey.values()];
}

/**
 * Compute one route's snapped geometry — the same composite as the nightly
 * `refresh-rail-routes` pass 2, so a miss-filled row and a nightly row are
 * the same algorithm on different corridor evidence (one day's fixes vs the
 * pooled historic cloud). First the corridor-weighted snap over the given
 * fixes; if that refuses (thin cloud, ambiguous corridor) and the label
 * names a line, route between the two stations over ONLY that line's ways.
 * Null means "leave it raw" — never a guessed path.
 */
export async function computeRailRoute(cand: RouteFillCandidate): Promise<Geometry | null> {
	const geo = await queryRailCorridor(cand.fixes);
	const snapped = snapTrainSegment(cand.seg, geo, cand.fixes);
	if (snapped) return snapped.path.map((p) => ({ lat: p.lat, lon: p.lon }));

	const parsed = parseRailWayName(cand.key);
	if (!parsed?.line) return null;
	const stns = await stationsOnLine(parsed.line);
	const board = stns.find((s) => s.name === parsed.board);
	const alight = stns.find((s) => s.name === parsed.alight);
	if (!board || !alight) return null;
	// Station-anchored bbox: a one-off ride's thin fixes may not span
	// board → alight, so the scan is anchored on the stations themselves.
	const lineGeo = await queryRailCorridor([
		{ lat: board.lat, lon: board.lon },
		{ lat: alight.lat, lon: alight.lon },
		...cand.fixes,
	]);
	const onLine = snapTrainSegmentOnLine(cand.seg, lineGeo);
	return onLine ? onLine.path.map((p) => ({ lat: p.lat, lon: p.lon })) : null;
}

/** Retry an unroutable / failed key at most this often. Route keys are
 *  stable strings; if the OSM mirror or the label didn't change, neither
 *  will the outcome — the cooldown only exists so a browsable-but-broken
 *  day doesn't re-run the corridor scan on every view. */
const FILL_COOLDOWN_MS = 6 * 3600 * 1000;

interface FillDeps {
	exists(key: string): Promise<boolean>;
	compute(cand: RouteFillCandidate): Promise<Geometry | null>;
	store(key: string, geometry: Geometry): Promise<void>;
	now?: () => number;
	cooldownMs?: number;
}

/**
 * Serial background worker over route-fill candidates. `schedule` is
 * fire-and-forget and re-entrant: keys already queued, in flight, or
 * cooling down after a null/failed compute are skipped. Nothing here ever
 * throws to the caller.
 */
export class RailRouteFillQueue {
	private readonly pending: RouteFillCandidate[] = [];
	private readonly queued = new Set<string>();
	private readonly cooldownUntil = new Map<string, number>();
	private draining: Promise<void> | null = null;

	constructor(private readonly deps: FillDeps) {}

	private now(): number {
		return this.deps.now?.() ?? Date.now();
	}

	schedule(cands: readonly RouteFillCandidate[]): void {
		for (const c of cands) {
			if (this.queued.has(c.key)) continue;
			const until = this.cooldownUntil.get(c.key);
			if (until !== undefined && this.now() <= until) continue;
			this.queued.add(c.key);
			this.pending.push(c);
		}
		if (!this.draining && this.pending.length > 0) {
			this.draining = this.drain();
		}
	}

	/** Resolves when the queue is empty (test hook). */
	async idle(): Promise<void> {
		while (this.draining) await this.draining;
	}

	private async drain(): Promise<void> {
		while (this.pending.length > 0) {
			const c = this.pending[0];
			this.pending.shift();
			try {
				if (!(await this.deps.exists(c.key))) {
					const geom = await this.deps.compute(c);
					if (geom && geom.length >= 2) {
						await this.deps.store(c.key, geom);
						console.log(`rail-route fill: cached "${c.key}" (${geom.length} pts, ${c.fixes.length} fixes)`);
					} else {
						this.cooldownUntil.set(c.key, this.now() + (this.deps.cooldownMs ?? FILL_COOLDOWN_MS));
					}
				}
			} catch (e) {
				console.warn(`rail-route fill failed for "${c.key}":`, e);
				this.cooldownUntil.set(c.key, this.now() + (this.deps.cooldownMs ?? FILL_COOLDOWN_MS));
			} finally {
				this.queued.delete(c.key);
			}
		}
		this.draining = null;
	}
}

let defaultQueue: RailRouteFillQueue | null = null;

/**
 * Serving-path entry point: queue background fills for a computed day's
 * unsnapped train routes. Insert-if-absent — the nightly pooled recompute
 * remains authoritative for keys it covers.
 */
export function scheduleRailRouteFill(cands: readonly RouteFillCandidate[]): void {
	if (cands.length === 0) return;
	defaultQueue ??= new RailRouteFillQueue({
		exists: async (key) =>
			(await db()
				.selectFrom("rail_route_cache")
				.select("route_key")
				.where("route_key", "=", key)
				.executeTakeFirst()) !== undefined,
		compute: computeRailRoute,
		store: async (key, geometry) => {
			await db()
				.insertInto("rail_route_cache")
				.values({ route_key: key, geometry_json: JSON.stringify(geometry) })
				// Insert-if-absent: a concurrent nightly upsert wins.
				.onDuplicateKeyUpdate({ route_key: key })
				.execute();
		},
	});
	defaultQueue.schedule(cands);
}
