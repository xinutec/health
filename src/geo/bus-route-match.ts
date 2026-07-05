/**
 * Stop-anchored bus-route matcher — the algorithmic heart of C-bus
 * (`docs/proposals/decoder-roadmap.md`, Phase 2).
 *
 * Today's `bus-evidence.ts` (#247) tells a bus from a taxi by *where it
 * stops*, but it cannot NAME the route. This module does: given a road-
 * vehicle leg's board + alight coordinates and a set of candidate bus
 * routes (each an ordered list of stops), it finds the route the leg
 * actually rode — boarding at one of the route's stops and alighting at a
 * LATER stop in route order.
 *
 * The load-bearing lesson is rail-snap's, learned three reverts the hard
 * way (`docs/design/rail-snap.md`): in this GPS regime **fix positions are
 * not load-bearing** — a per-fix map-match to the route's ways shipped and
 * broke three times. So a route is matched by its STOP SEQUENCE, not by
 * tracing GPS onto its geometry. The board and alight anchor to stops; the
 * stops' route order gives direction.
 *
 * Anchoring two endpoints is necessary but NOT sufficient: with ~1000
 * routes mirrored, almost any short urban car hop has *some* route with two
 * in-order stops near its endpoints, so a taxi gets stamped as a bus (the
 * 2026-06-15 Green Park→clinic taxi was labelled "bus N22" off a two-stop
 * coincidence). So a candidate must also be **corroborated**: the leg's
 * trace has to pass the route's *intermediate* stops between board and
 * alight — a real bus passes every stop on the span, a taxi takes the
 * direct road and diverges. This still treats stop positions as
 * load-bearing: it measures each intermediate stop's distance to the trace
 * polyline (point-to-segment), and never snaps fixes onto route geometry —
 * the per-fix map-match that broke three times. A span with no intermediate
 * stops (two adjacent stops) cannot be corroborated at all and is rejected.
 *
 * A leg whose endpoints don't anchor to two in-order stops of any route, or
 * whose trace doesn't corroborate the stops between them, is left `driving`
 * (taxi/car) — never forced onto a route it didn't ride.
 *
 * Pure: no DB, no OSM, no network, no globals. The orchestrator loads the
 * candidate routes (from `bus_route_cache`) and the leg endpoints and
 * hands them in.
 */

import { effectiveMode, samplesInWindow } from "./segment-util.js";
import type { TransportMode } from "./segments.js";

/** One stop on a bus route, in route order. `seq` is the stop's position
 *  along the route (monotonic; array order matches). */
export interface BusStop {
	name: string | null;
	lat: number;
	lon: number;
	seq: number;
}

/** A candidate bus route: an ordered stop list mirrored from an OSM
 *  `route=bus` relation. `stops` is ordered by `seq` (route direction).
 *  OSM models each direction as its own relation, so a route ridden the
 *  other way is a different `BusRoute` with its own stop order. */
export interface BusRoute {
	routeRef: string;
	routeName: string | null;
	osmRelationId: number;
	stops: readonly BusStop[];
}

/** What anchors a leg to a route: where the vehicle was boarded and left
 *  (the endpoints), plus the leg's GPS `trace` (board→alight, in time
 *  order) used only to corroborate that the route's intermediate stops were
 *  actually passed (see module header). The trace is measured *against the
 *  stops*, never the other way round — fixes are not snapped to geometry. */
export interface VehicleLegEndpoints {
	board: { lat: number; lon: number };
	alight: { lat: number; lon: number };
	trace: readonly { lat: number; lon: number }[];
	/** The leg's representative speed (km/h), used as soft probabilistic
	 *  evidence: a bus is *unlikely* to average much above urban bus pace, so a
	 *  fast leg discounts the bus hypothesis — but never vetoes it (a strongly
	 *  corroborated leg can still win). Omitted ⇒ neutral (no speed evidence),
	 *  so geometry-only callers/tests are unaffected. */
	speedKmh?: number;
}

/** A successful match: the named route plus the boarded/alighted stops
 *  and how well the endpoints anchored. */
export interface BusRouteMatch {
	routeRef: string;
	routeName: string | null;
	osmRelationId: number;
	boardStop: BusStop;
	alightStop: BusStop;
	/** Metres from the leg's board coord to `boardStop`. */
	boardDistM: number;
	/** Metres from the leg's alight coord to `alightStop`. */
	alightDistM: number;
	/** Stops travelled, inclusive of both ends (alight index − board index
	 *  + 1). A real ride spans ≥ 2 stops; equal endpoints never match. */
	stopSpan: number;
}

/** A board/alight coord must fall within this of a route stop to anchor
 *  to it. The board/alight coord is the leg's first/last GPS fix — where
 *  GPS reacquired *after* pulling away / *before* the stop, not the kerb
 *  itself — plus the stop's mapped-node-vs-kerb offset and urban GPS
 *  error. Measured on the 2026-06-12 Green Park→Victoria 38 leg, the leg
 *  endpoints sat 85–98 m from the true stops (Hyde Park Corner, Wilton
 *  Street), so 75 m was just too tight. 120 m admits them while still
 *  staying short of a parallel route across a junction. Tunable. */
export const BUS_STOP_ANCHOR_M = 120;

/** An intermediate stop counts as "passed" when the leg's trace polyline
 *  comes within this of it. Point-to-segment, so a coarse trace still
 *  corroborates a stop the bus drove past *between* two fixes. Same regime
 *  as the anchor radius. */
export const BUS_STOP_PASS_M = 120;

/** Minimum BUS-EVIDENCE SCORE for a candidate to be named a bus. The score is
 *  `intermediate-stop coverage × speed-plausibility` — corroboration weighted by
 *  how bus-like the leg's speed is. With no speed supplied the speed factor is 1,
 *  so this is exactly the old coverage threshold (a real bus passes ~all its
 *  intermediate stops; a taxi on a different road passes few). With speed, a fast
 *  leg's low plausibility pulls the score under the bar even on good geometry —
 *  weighted evidence, not a veto. */
export const BUS_MIN_INTERMEDIATE_COVERAGE = 0.6;

/** Speed (km/h) at which a leg is equally likely bus / not-bus — the midpoint of
 *  the plausibility logistic. Above typical urban bus pace (~15–25), below
 *  clearly-not-a-bus. */
const BUS_SPEED_MID_KMH = 38;
/** Logistic width (km/h): how sharply bus-plausibility falls as speed rises past
 *  the midpoint. Wide enough that a slightly-fast well-corroborated bus survives;
 *  narrow enough that a 50+ km/h leg's plausibility collapses. */
const BUS_SPEED_SCALE_KMH = 6;

/** P(speed | bus) as a soft plausibility in (0, 1]: ~1 at bus pace, decaying
 *  smoothly toward 0 as speed climbs — a logistic, never a hard cutoff. Neutral
 *  (1) when no speed is supplied. A London bus averages ~15–25 km/h (dwells +
 *  traffic), so e.g. 62 km/h → ~0.003: the leg is almost certainly not a bus. */
function busSpeedPlausibility(speedKmh: number | undefined): number {
	if (speedKmh === undefined) return 1;
	return 1 / (1 + Math.exp((speedKmh - BUS_SPEED_MID_KMH) / BUS_SPEED_SCALE_KMH));
}

export interface MatchOptions {
	/** Override the stop-anchor radius (metres). */
	anchorM?: number;
	/** Override the intermediate-stop pass radius (metres). */
	stopPassM?: number;
	/** Override the required intermediate-stop coverage fraction (0–1). */
	minCoverage?: number;
}

/** Metres from point `p` to the segment `a`–`b`, via a local equirectangular
 *  projection centred on `p` (exact enough at the ~hundred-metre scale this
 *  runs at). Used to ask "did the trace pass this stop?" without snapping. */
function pointToSegmentMeters(
	p: { lat: number; lon: number },
	a: { lat: number; lon: number },
	b: { lat: number; lon: number },
): number {
	const mPerDegLat = 111_320;
	const mPerDegLon = 111_320 * Math.cos((p.lat * Math.PI) / 180);
	const px = p.lon * mPerDegLon;
	const py = p.lat * mPerDegLat;
	const ax = a.lon * mPerDegLon;
	const ay = a.lat * mPerDegLat;
	const bx = b.lon * mPerDegLon;
	const by = b.lat * mPerDegLat;
	const dx = bx - ax;
	const dy = by - ay;
	const len2 = dx * dx + dy * dy;
	const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
	const cx = ax + t * dx;
	const cy = ay + t * dy;
	return Math.hypot(px - cx, py - cy);
}

/** Fraction of `intermediates` (the stops strictly between board and alight)
 *  the trace passes within `passM`. 0 when there are no intermediate stops (a
 *  two-stop span has nothing to corroborate — the taxi-as-bus failure) or the
 *  trace is degenerate. A real bus passes ~all of them; a taxi on a different
 *  road, few. */
function traceCoverage(
	trace: readonly { lat: number; lon: number }[],
	intermediates: readonly BusStop[],
	passM: number,
): number {
	if (intermediates.length === 0) return 0;
	if (trace.length < 2) return 0;
	let passed = 0;
	for (const stop of intermediates) {
		let nearest = Number.POSITIVE_INFINITY;
		for (let i = 0; i + 1 < trace.length; i++) {
			nearest = Math.min(nearest, pointToSegmentMeters(stop, trace[i], trace[i + 1]));
			if (nearest <= passM) break;
		}
		if (nearest <= passM) passed++;
	}
	return passed / intermediates.length;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6_371_000;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

interface Anchor {
	stop: BusStop;
	/** Position in route order (array index). */
	idx: number;
	distM: number;
}

/** Stops within `anchorM` of `coord`, with their route-order index. */
function anchorsNear(coord: { lat: number; lon: number }, route: BusRoute, anchorM: number): Anchor[] {
	const out: Anchor[] = [];
	route.stops.forEach((stop, idx) => {
		const distM = haversineMeters(coord.lat, coord.lon, stop.lat, stop.lon);
		if (distM <= anchorM) out.push({ stop, idx, distM });
	});
	return out;
}

/**
 * Find the bus route the leg rode. For each candidate route, anchor the
 * board and alight coords to stops within `anchorM`, then take the
 * in-route-order pair (boardIdx < alightIdx) with the smallest combined
 * anchor distance. Across routes, the smallest combined-distance match
 * wins. Returns null when no route's stop sequence admits an in-order
 * board→alight pair — the leg stays driving (taxi/car).
 *
 * Direction is enforced by `alightIdx > boardIdx`: a leg ridden the other
 * way matches the opposite-direction relation (a separate `BusRoute`), not
 * this one. Equal endpoints (anchoring to the same stop) never satisfy the
 * strict inequality, so a non-ride can't masquerade as a zero-span match.
 */
export function matchBusRoute(
	leg: VehicleLegEndpoints,
	routes: readonly BusRoute[],
	opts?: MatchOptions,
): BusRouteMatch | null {
	const anchorM = opts?.anchorM ?? BUS_STOP_ANCHOR_M;
	const stopPassM = opts?.stopPassM ?? BUS_STOP_PASS_M;
	const minScore = opts?.minCoverage ?? BUS_MIN_INTERMEDIATE_COVERAGE;
	const speedPlausibility = busSpeedPlausibility(leg.speedKmh);
	let best: BusRouteMatch | null = null;
	for (const route of routes) {
		const boardCands = anchorsNear(leg.board, route, anchorM);
		const alightCands = anchorsNear(leg.alight, route, anchorM);
		if (boardCands.length === 0 || alightCands.length === 0) continue;

		let bestPair: { board: Anchor; alight: Anchor; total: number } | null = null;
		for (const board of boardCands) {
			for (const alight of alightCands) {
				if (alight.idx <= board.idx) continue; // direction + non-zero span
				// Bus evidence = intermediate-stop coverage × speed-plausibility.
				// Coverage rejects a taxi that anchors two of a route's stops but
				// drove a different road (and a 2-stop span, nothing to
				// corroborate). Speed-plausibility discounts a leg too fast to be a
				// bus — weighted, so strong corroboration can still carry a
				// slightly-fast leg, but a 60 km/h chord can't be a bus however
				// well its straight line happens to parallel the route.
				const intermediates = route.stops.slice(board.idx + 1, alight.idx);
				const score = traceCoverage(leg.trace, intermediates, stopPassM) * speedPlausibility;
				if (score < minScore) continue;
				const total = board.distM + alight.distM;
				if (bestPair === null || total < bestPair.total) bestPair = { board, alight, total };
			}
		}
		if (bestPair === null) continue;

		if (best === null || bestPair.total < best.boardDistM + best.alightDistM) {
			best = {
				routeRef: route.routeRef,
				routeName: route.routeName,
				osmRelationId: route.osmRelationId,
				boardStop: bestPair.board.stop,
				alightStop: bestPair.alight.stop,
				boardDistM: bestPair.board.distM,
				alightDistM: bestPair.alight.distM,
				stopSpan: bestPair.alight.idx - bestPair.board.idx + 1,
			};
		}
	}
	return best;
}

/** A timeline-ready label for a matched route, in the same `From → To ·
 *  Ref` shape the ground-truth bus cells use (`ground-truth.ts`). Falls
 *  back to the bare ref when a stop has no name. */
export function busRouteLabel(match: BusRouteMatch): string {
	const from = match.boardStop.name;
	const to = match.alightStop.name;
	return from && to ? `${from} → ${to} · ${match.routeRef}` : match.routeRef;
}

/** The fields `annotateBusRoutes` reads/writes on a pipeline segment — a
 *  structural subset of `EnrichedSegment`, so this module stays free of a
 *  velocity import cycle. */
export interface BusRouteAnnotatable {
	startTs: number;
	endTs: number;
	mode: TransportMode;
	refinedMode?: TransportMode;
	vehicleKind?: "bus";
	wayName?: string;
	/** Leg average speed (km/h) — soft speed evidence for the bus hypothesis. */
	avgSpeed?: number;
}

type TsFix = { ts: number; lat: number; lon: number };

/**
 * Name the bus route each road-vehicle leg rode. For every segment whose
 * effective mode is `driving`, anchor its first + last fix to a cached
 * route's stops (`matchBusRoute`); on a match, mark it `vehicleKind:"bus"`
 * and set `wayName` to the route label. Purely additive — an unmatched leg
 * (taxi/car, or no routes loaded) is returned untouched, so with an empty
 * `routes` set the pass is a no-op. Stronger than the dwell-based
 * `bus-evidence` pass: a leg that matches a route's stop sequence IS that
 * bus even with too few dwells to score, which is the short-ride
 * (06-12 Green Park→clinic) failure that motivated C-bus.
 */
export function annotateBusRoutes<T extends BusRouteAnnotatable>(
	segments: readonly T[],
	points: readonly TsFix[],
	routes: readonly BusRoute[],
	opts?: MatchOptions,
): T[] {
	if (routes.length === 0) return segments.slice();
	const out: T[] = [];
	for (const seg of segments) {
		const effective = effectiveMode(seg);
		if (effective !== "driving") {
			out.push(seg);
			continue;
		}
		const legFixes = samplesInWindow(points, seg);
		if (legFixes.length < 2) {
			out.push(seg);
			continue;
		}
		const board = legFixes[0];
		const alight = legFixes[legFixes.length - 1];
		const match = matchBusRoute({ board, alight, trace: legFixes, speedKmh: seg.avgSpeed }, routes, opts);
		if (match === null) {
			out.push(seg);
			continue;
		}
		out.push({ ...seg, vehicleKind: "bus", wayName: busRouteLabel(match) });
	}
	return out;
}
