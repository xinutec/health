/**
 * Episode geometry — the map's half of the "one day, two renderers"
 * model. See `docs/design/episode-geometry.md`.
 *
 * The "your day" narrative renders the smoothed `DayState[]` sequence;
 * the map used to render the raw `EnrichedSegment[]` separately, so the
 * two drifted (a sub-state segment the narrative folded away still drew
 * on the map). `buildEpisodes` resolves a display geometry for each
 * `DayState`, 1:1, so both views render the same episode sequence.
 *
 * Pure: no DB, no network, no side effects. Computed inside
 * `computeVelocityFromInputs`, so it is cached with the rest of the
 * velocity result (one `getVelocityCached` entry). Geometry is strictly
 * downstream of classification and never feeds back — depiction never
 * re-decides what happened.
 *
 * The motivating fix is the per-mode SPEED-PLAUSIBILITY FILTER: a raw
 * moving episode drops fixes whose speed exceeds the physical ceiling
 * for its mode (`MAX_SPEED_FOR_MODE`). A 60 km/h fix inside a `walking`
 * episode is a neighbouring fast mode bleeding across an early segment
 * boundary — it is not walking, and the map will not draw it as walking.
 * This is the display analogue of constraint C2.
 */

import type { DayState, DayStateMode } from "../sleep/day-state.js";
import type { EnrichedSegment } from "./enriched-segment.js";
import type { FilteredPoint } from "./kalman.js";
import { MAX_SPEED_FOR_MODE } from "./mode-biometrics.js";
import { centroidOf, effectiveMode, samplesInWindow } from "./segment-util.js";

/** Geometry provenance — the only style input the map needs. Solid for
 *  `raw`/`matched`, dashed for `snapped`/`tentative`, a dot for
 *  `anchor`. No `confidence` field: the only upstream confidence is
 *  classification confidence, which is not geometry trust. */
export type EpisodeKind = "snapped" | "raw" | "anchor" | "tentative" | "matched" | "smoothed";

/** One episode's display geometry, 1:1 with a `DayState`. Self-describing
 *  (carries its own `startTs`/`endTs`/`mode`) so the map renders it
 *  without re-joining to `states`. `points` may be empty — the map then
 *  draws nothing for that episode (e.g. a synthesized pre-fix sleep). */
export interface EpisodeGeometry {
	startTs: number;
	endTs: number;
	mode: DayStateMode;
	kind: EpisodeKind;
	points: LatLon[];
	/** Stay label for an `anchor` episode (the map's marker popup). Lifted
	 *  from the state's `place` so the frontend draws markers from episodes
	 *  alone and needs no segment lookup. Absent for non-anchor episodes. */
	place?: string;
}

interface LatLon {
	lat: number;
	lon: number;
	/** UTC seconds of the underlying fix, when this vertex came from a
	 *  timestamped point (raw GPS, matched, or snapped). Absent for derived
	 *  geometry with no single moment — a stay anchor (centroid) or a gap
	 *  connector endpoint. Surfaced so the map's point-inspector can show
	 *  *when* a drawn vertex was, for debugging a stray location. */
	ts?: number;
}

/** A no-GPS `unknown` gap longer than this (metres, straight-line) is
 *  not bridged — drawing a dashed line kilometres across a city would
 *  imply a route we do not have. Display constant, the sibling of
 *  `rejectSpikes`'s 500 m spike bar; not a classifier threshold. */
const UNKNOWN_CONNECTOR_MAX_M = 2000;

/** A raw train leg whose drawn end sits more than this from its station
 *  join point gets that point stitched on, so the leg reaches its station
 *  and the neighbour doesn't bridge across the gap. Below it the gap is
 *  negligible and stitching would add a redundant near-duplicate point. */
const STATION_STITCH_MIN_M = 100;

const MOVING_MODES: ReadonlySet<DayStateMode> = new Set(["walking", "cycling", "driving", "bus", "plane"]);

/** Road-vehicle modes eligible for road map-matching (`kind:"matched"`).
 *  Walking (often off-carriageway pavement) and plane are excluded — the
 *  matcher routes only over drivable ways. See `annotateRoadMatches`. */
const ROAD_MATCH_MODES: ReadonlySet<string> = new Set(["driving", "bus", "cycling"]);

/**
 * Resolve a display geometry for every `DayState`, in order. Sequence-
 * aware: the `unknown` connector reads the previous resolved episode and
 * the next state's entry point.
 */
/** A raw GPS fix as captured (pre-Kalman). The road-vehicle drawn line uses
 *  these directly rather than the Kalman-smoothed `points` — see the road
 *  branch in `resolveEpisode`. */
export interface RawFix {
	ts: number;
	lat: number;
	lon: number;
	accuracy?: number | null;
}

export function buildEpisodes(
	states: readonly DayState[],
	segments: readonly EnrichedSegment[],
	points: readonly FilteredPoint[],
	rawFixes?: readonly RawFix[],
): EpisodeGeometry[] {
	const episodes: EpisodeGeometry[] = [];
	for (let i = 0; i < states.length; i++) {
		episodes.push(resolveEpisode(states[i], i, states, segments, points, episodes, rawFixes));
	}
	return episodes;
}

function resolveEpisode(
	state: DayState,
	index: number,
	states: readonly DayState[],
	segments: readonly EnrichedSegment[],
	points: readonly FilteredPoint[],
	resolved: readonly EpisodeGeometry[],
	rawFixes?: readonly RawFix[],
): EpisodeGeometry {
	const mode = state.mode;
	const base = { startTs: state.startTs, endTs: state.endTs, mode };
	const covering = segments.filter((s) => s.startTs < state.endTs && s.endTs > state.startTs);
	const windowFixes = samplesInWindow(points, state);

	if (mode === "train") {
		// A cached route carries a snapped rail line: draw it (clipped to
		// the state window). An uncached ride keeps no snappedPath but
		// still has real GPS for the overground stretch — draw that raw.
		// A fully GPS-dark leg has neither and draws nothing.
		const trainSeg = covering.find((s) => effectiveMode(s) === "train" && (s.snappedPath?.length ?? 0) >= 2);
		const snapped = trainSeg?.snappedPath
			?.filter((sp) => sp.ts >= state.startTs && sp.ts <= state.endTs)
			.map((sp) => ({ lat: sp.lat, lon: sp.lon, ts: sp.ts }));
		if (snapped && snapped.length >= 2) return { ...base, kind: "snapped", points: snapped };

		// Boarding / alighting join points: where the previous episode left off
		// and where the next one begins — i.e. this leg's two stations.
		const from = resolved[index - 1]?.points.at(-1);
		const to = entryPoint(states[index + 1], segments, points);

		// A reconstructed underground leg (pointCount 0) has no real GPS for the
		// ride: its window holds only teleporting cell-network garbage. Draw a
		// clean connector station-to-station in train colour, so the tube leg
		// reads as a line between its stations and the onward walk bridges from
		// the alighting end — not a green line across the gap (the 2026-06-16
		// Baker St → Green Park "walked between stations" artifact). No cap (cf.
		// the `unknown` connector): a rail leg legitimately spans km.
		const reconstructed = covering.some((s) => effectiveMode(s) === "train" && s.pointCount === 0);
		if (reconstructed) return { ...base, kind: "tentative", points: from && to ? [from, to] : [] };

		// Uncached overground leg: real GPS, but it commonly starts after the
		// train pulls away and stops before it arrives. Anchor the ends to the
		// station join points so the whole leg stays train-coloured and its
		// neighbours bridge from zero — otherwise the adjacent walk draws a green
		// line across the missing tail (the ~950 m Baker St tail on 2026-06-16).
		const raw = rejectSpikes(windowFixes).map(toLatLon);
		return { ...base, kind: "raw", points: stitchTrainEnds(raw, from, to) };
	}

	if (MOVING_MODES.has(mode)) {
		// Road map-matching (#261): a road-vehicle leg (driving / bus /
		// cycling) whose covering segment carries a `matchedPath` draws on the
		// OSM streets instead of the raw GPS — clipped to the state window. The
		// raw track scattered off the carriageway and cut corners through
		// buildings; the matched path follows the road. Falls through to raw
		// when unmatched (sparse leg, off-network, or fixtures predating #261).
		const roadSeg = covering.find((s) => (s.matchedPath?.length ?? 0) >= 2 && ROAD_MATCH_MODES.has(effectiveMode(s)));
		const matched = roadSeg?.matchedPath
			?.filter((mp) => mp.ts >= state.startTs && mp.ts <= state.endTs)
			.map((mp) => ({ lat: mp.lat, lon: mp.lon, ts: mp.ts }));
		if (matched && matched.length >= 2) return { ...base, kind: "matched", points: matched };

		// Pedestrian map-matching (#265): a walking leg whose covering segment
		// carries a `walkMatchedPath` draws on the OSM walkable network (pavement
		// / footway / residential centerline) instead of the raw GPS cutting
		// across buildings. Clipped to the state window. Falls through to the raw
		// track when the matcher bailed (off-network / fragmented graph). Same
		// solid styling as road `matched`.
		// Robust reconstruction (#296): a walking leg whose matched line was a
		// phantom out-and-back (bad-GPS reacquire) is drawn by `reconstructWalk`
		// instead — `walkSmoothedPath`, which takes precedence over the matched line
		// when present. `kind:"smoothed"`, same solid styling.
		const walkSmoothSeg = covering.find(
			(s) => (s.walkSmoothedPath?.length ?? 0) >= 2 && effectiveMode(s) === "walking",
		);
		const walkSmoothed = walkSmoothSeg?.walkSmoothedPath
			?.filter((mp) => mp.ts >= state.startTs && mp.ts <= state.endTs)
			.map((mp) => ({ lat: mp.lat, lon: mp.lon, ts: mp.ts }));
		if (walkSmoothed && walkSmoothed.length >= 2) return { ...base, kind: "smoothed", points: walkSmoothed };

		const walkMatchSeg = covering.find((s) => (s.walkMatchedPath?.length ?? 0) >= 2 && effectiveMode(s) === "walking");
		const walkMatched = walkMatchSeg?.walkMatchedPath
			?.filter((mp) => mp.ts >= state.startTs && mp.ts <= state.endTs)
			.map((mp) => ({ lat: mp.lat, lon: mp.lon, ts: mp.ts }));
		if (walkMatched && walkMatched.length >= 2) return { ...base, kind: "matched", points: walkMatched };

		// Unmatched moving leg (walking / cycling / driving / bus / plane):
		// draw the RAW GPS fixes, not the Kalman-smoothed `points`. Measured
		// (position eval, #265 Phase 1): the road-blind smoother makes good data
		// worse two ways. On a road leg it coasts on a noisy low-speed velocity
		// and swings the line up to ~75 m off the reliable GPS; on a walk it
		// both pulls a point off the path AND *truncates* — its point count
		// trails the raw fixes, so the line stops short of the leg's end and the
		// map bridges the gap with a straight chord through buildings. The raw
		// fixes sit within a few metres of where the phone actually was and run
		// the full length of the leg. (rawFixes absent — legacy callers, tests
		// — falls to the speed-filtered fixes below.) rejectSpikes drops lone
		// teleports; holdImplausibleSpeed then collapses a monotonic teleport RUN
		// (underground/indoor fixes that report good accuracy but imply impossible
		// walking speed) that both rejectSpikes and the accuracy field miss.
		if (rawFixes) {
			const rawWin = holdImplausibleSpeed(
				rejectSpikes(samplesInWindow(rawFixes, state)),
				MAX_SPEED_FOR_MODE[mode] ?? Number.POSITIVE_INFINITY,
			);
			if (rawWin.length >= 2) {
				return { ...base, kind: "raw", points: rawWin.map((p) => ({ lat: p.lat, lon: p.lon, ts: p.ts })) };
			}
		}

		// Speed-plausibility filter THEN geometric spike rejection. The
		// filter drops a faster neighbour's fixes that bled across the
		// boundary (e.g. a decelerating train's tail landing inside the
		// following walk at vehicle speed); rejectSpikes drops teleports.
		// They are complementary — the bleed is smooth and monotonic, so
		// rejectSpikes alone would miss it.
		const cap = MAX_SPEED_FOR_MODE[mode];
		const plausible = cap === undefined ? windowFixes : windowFixes.filter((p) => p.speed_kmh <= cap);
		return { ...base, kind: "raw", points: rejectSpikes(plausible).map(toLatLon) };
	}

	if (mode === "stationary" || mode === "sleeping") {
		const anchor = stayAnchor(covering, windowFixes);
		return { ...base, kind: "anchor", points: anchor ? [anchor] : [], ...(state.place ? { place: state.place } : {}) };
	}

	if (mode === "unknown") {
		// A no-GPS gap: a tentative connector between the previous drawn
		// point and the next state's entry point, capped so it cannot
		// imply a cross-city route. Either endpoint missing → draw nothing.
		const from = resolved[index - 1]?.points.at(-1);
		const to = entryPoint(states[index + 1], segments, points);
		if (from && to && equirectMeters(from.lat, from.lon, to.lat, to.lon) <= UNKNOWN_CONNECTOR_MAX_M) {
			return { ...base, kind: "tentative", points: [from, to] };
		}
		return { ...base, kind: "tentative", points: [] };
	}

	return { ...base, kind: "raw", points: rejectSpikes(windowFixes).map(toLatLon) };
}

/** Anchor a raw train leg's geometry to its station join points. A train's
 *  GPS commonly starts after it pulls away and stops before it arrives, so
 *  `raw` falls short of the boarding (`from`) and alighting (`to`) ends; the
 *  adjacent walk then bridges green across the gap. Prepend `from` / append
 *  `to` (when present and more than STATION_STITCH_MIN_M from the existing
 *  end) so the whole leg stays train-coloured and neighbours bridge from
 *  zero. The fixes in between are untouched. */
function stitchTrainEnds(raw: readonly LatLon[], from: LatLon | undefined, to: LatLon | undefined): LatLon[] {
	const pts = [...raw];
	const farFromEnd = (p: LatLon, end: LatLon | undefined): boolean =>
		end === undefined || equirectMeters(p.lat, p.lon, end.lat, end.lon) > STATION_STITCH_MIN_M;
	if (from && farFromEnd(from, pts[0])) pts.unshift(from);
	if (to && farFromEnd(to, pts.at(-1))) pts.push(to);
	return pts;
}

/** A stay's single anchor point: the covering stationary segment's
 *  precomputed centroid if present, else the mean of the window fixes,
 *  else none (a synthesized pre-fix sleep has no fix to anchor to). */
function stayAnchor(covering: readonly EnrichedSegment[], windowFixes: readonly FilteredPoint[]): LatLon | undefined {
	const seg = covering.find((s) => s.centroidLat !== undefined && s.centroidLon !== undefined);
	if (seg?.centroidLat !== undefined && seg.centroidLon !== undefined) {
		return { lat: seg.centroidLat, lon: seg.centroidLon };
	}
	return centroidOf(windowFixes) ?? undefined;
}

/** A representative entry coordinate for a state — its first window fix,
 *  else its stay centroid. Used as the far end of an `unknown` connector. */
function entryPoint(
	state: DayState | undefined,
	segments: readonly EnrichedSegment[],
	points: readonly FilteredPoint[],
): LatLon | undefined {
	if (!state) return undefined;
	const first = points.find((p) => p.ts >= state.startTs && p.ts <= state.endTs);
	if (first) return { lat: first.lat, lon: first.lon };
	const covering = segments.filter((s) => s.startTs < state.endTs && s.endTs > state.startTs);
	return stayAnchor(covering, []);
}

function toLatLon(p: FilteredPoint): LatLon {
	return { lat: p.lat, lon: p.lon, ts: p.ts };
}

function equirectMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
	const dLat = (bLat - aLat) * 111_320;
	const dLon = (bLon - aLon) * 111_320 * Math.cos((aLat * Math.PI) / 180);
	return Math.sqrt(dLat * dLat + dLon * dLon);
}

/**
 * Drop lone teleport spikes from a moving episode's fixes — display
 * only; the underlying data keeps every fix. A point juts out and back
 * when the detour through it (prev→point→next) is both several times
 * longer than going straight past it AND a large absolute excess. A
 * gentle path curve or a sharp corner stays well under that bar. (Moved
 * here from the frontend `map.component`, which used to do this; the
 * geometry layer now owns it so both renderers cannot diverge.)
 */
/** Kinematic hold for a drawn moving-leg line: keep a fix only if its implied
 *  speed from the last KEPT fix is within `capKmh`. A run of fixes that each
 *  require impossible speed — an underground / indoor GPS teleport, which
 *  reports GOOD self-reported accuracy (measured: 28–54 km/h "walks" at
 *  accuracy 26–30 m) — is held at the last plausible position, so the leg
 *  collapses toward stationary instead of drawing an impossible sprint.
 *  Complements `rejectSpikes` (lone geometric detours): this catches a
 *  MONOTONIC teleport run, and unlike an accuracy filter it does not trust the
 *  phone's number — the physics of the mode is the constraint (#265 Phase 1). */
export function holdImplausibleSpeed<T extends { lat: number; lon: number; ts: number }>(
	fixes: readonly T[],
	capKmh: number,
): T[] {
	if (fixes.length < 2 || !Number.isFinite(capKmh)) return [...fixes];
	// A sequential hold anchors on its start fix — but if that start is itself the
	// outlier (a stray underground tube-tail fix LEADING the leg), it holds every
	// good fix (all implausibly fast FROM the straggler) and collapses to the
	// straggler alone, which then falls through to a fallback that draws the jump
	// (today's Baker-St green-jump: a lone Baker St fix ahead of the Euston walk).
	// So take the LONGEST plausible-speed run over all start points: a leading or
	// trailing straggler is excluded, a mid-run teleport is still held within the
	// chosen run, and the real cluster is what's drawn.
	const runFrom = (s: number): T[] => {
		const keep: T[] = [fixes[s]];
		for (let i = s + 1; i < fixes.length; i++) {
			const last = keep[keep.length - 1];
			const dt = fixes[i].ts - last.ts;
			if (dt <= 0) continue;
			if ((equirectMeters(last.lat, last.lon, fixes[i].lat, fixes[i].lon) / dt) * 3.6 <= capKmh) keep.push(fixes[i]);
		}
		return keep;
	};
	let best: T[] = [];
	for (let s = 0; s < fixes.length; s++) {
		const run = runFrom(s);
		if (run.length > best.length) best = run; // strict → earliest longest run (deterministic)
	}
	return best;
}

export function rejectSpikes<T extends { lat: number; lon: number }>(pts: readonly T[]): T[] {
	if (pts.length < 3) return [...pts];
	const keep: T[] = [pts[0]];
	for (let i = 1; i < pts.length - 1; i++) {
		const prev = keep[keep.length - 1];
		const cur = pts[i];
		const next = pts[i + 1];
		const direct = equirectMeters(prev.lat, prev.lon, next.lat, next.lon);
		const through =
			equirectMeters(prev.lat, prev.lon, cur.lat, cur.lon) + equirectMeters(cur.lat, cur.lon, next.lat, next.lon);
		if (through > direct * 3 && through - direct > 500) continue;
		keep.push(cur);
	}
	keep.push(pts[pts.length - 1]);
	return keep;
}
