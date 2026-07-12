/**
 * Rail-leg reconciliation passes.
 *
 * Merges adjacent same-route train segments, enforces the back-to-back
 * shared-station constraint between rail legs, parses station-pair
 * wayNames, and attaches precomputed snapped rail geometry. Extracted
 * from the velocity orchestrator.
 */

import type { EnrichedSegment } from "../enriched-segment.js";
import type { FilteredPoint } from "../kalman.js";
import { haversineMeters } from "../place-snap.js";
import { interpolateTimes } from "../rail-snap.js";
import { effectiveMode, samplesInWindow } from "../segment-util.js";
import { MOVING_MERGE_MAX_GAP_S } from "./moving.js";
import { expandTubeLineNames, findRunAlightFix } from "./rail-runs.js";

/** The boarding→alighting station pair at the core of a train wayName
 *  ("Victoria → King's Cross St Pancras"), stripped of any "· Line"
 *  suffix. Null when the segment isn't a station-pair-labelled train. */
function trainStationPair(seg: EnrichedSegment): string | null {
	if (effectiveMode(seg) !== "train") return null;
	const w = seg.wayName;
	if (!w?.includes("→")) return null;
	return w.split(" · ")[0].trim();
}

/**
 * Merge consecutive train segments that resolve to the SAME board→alight
 * station pair into one ride. The rail/underground reconstruction can
 * leave a single tube journey as two adjacent train segments — a
 * late-synced fix re-segmenting it, or a coarse-fix split — and only one
 * half may carry the line name, so the timeline shows two identical-route
 * "train A → B" rows back to back (the 2026-06-12 Victoria→King's Cross
 * case). Coalesce them, keeping the line-named label and any snapped
 * geometry. Two DIFFERENT routes never share a station-pair string, so a
 * genuine interchange (a walk separates the legs anyway) is untouched.
 * Pure.
 */
export function mergeAdjacentSameRouteTrains(segments: EnrichedSegment[]): EnrichedSegment[] {
	const out: EnrichedSegment[] = [];
	for (const seg of segments) {
		const prev = out[out.length - 1];
		const pair = trainStationPair(seg);
		if (
			prev &&
			pair !== null &&
			trainStationPair(prev) === pair &&
			seg.startTs - prev.endTs <= MOVING_MERGE_MAX_GAP_S
		) {
			const w0 = prev.pointCount;
			const w1 = seg.pointCount;
			const wTot = w0 + w1 || 1;
			prev.endTs = seg.endTs;
			prev.pointCount = w0 + w1;
			prev.avgSpeed = Math.round(((prev.avgSpeed * w0 + seg.avgSpeed * w1) / wTot) * 10) / 10;
			prev.maxSpeed = Math.round(Math.max(prev.maxSpeed, seg.maxSpeed) * 10) / 10;
			prev.linearity = Math.round(((prev.linearity * w0 + seg.linearity * w1) / wTot) * 100) / 100;
			// Keep the more specific label — the half that resolved a line.
			if (!(prev.wayName ?? "").includes(" · ") && (seg.wayName ?? "").includes(" · ")) {
				prev.wayName = seg.wayName;
			}
			if (!prev.snappedPath && seg.snappedPath) prev.snappedPath = seg.snappedPath;
			continue;
		}
		out.push({ ...seg });
	}
	return out;
}

/** Separator between a rail run's two stations in a `wayName`. */
const RAIL_STATION_SEP = " → ";
/** Separator before the optional line-name suffix in a rail `wayName`. */
const RAIL_LINE_SEP = " · ";

/**
 * Parse a rail run's station-pair `wayName` — `"<board> → <alight>"`,
 * optionally followed by `" · <line>"`. Returns null when the string
 * is not a station-pair label (a road name, or absent).
 */
export function parseRailWayName(wayName: string | undefined): { board: string; alight: string; line?: string } | null {
	if (wayName === undefined) return null;
	const arrow = wayName.indexOf(RAIL_STATION_SEP);
	if (arrow < 0) return null;
	const board = wayName.slice(0, arrow);
	const rest = wayName.slice(arrow + RAIL_STATION_SEP.length);
	const dot = rest.indexOf(RAIL_LINE_SEP);
	if (dot < 0) return { board, alight: rest };
	return { board, alight: rest.slice(0, dot), line: rest.slice(dot + RAIL_LINE_SEP.length) };
}

/**
 * Physical constraint: two train legs that are back-to-back — adjacent
 * in the segment sequence with nothing between them — must share a
 * station. You cannot step off a train at one station and instantly be
 * on another train at a different station: there is no time and no
 * walk in between.
 *
 * `annotateRailRuns` and `annotateUndergroundRuns` resolve each leg's
 * boarding/alighting stations independently, so a leg reconstructed
 * from coarse underground fixes can land its boarding on a station the
 * previous leg already passed — a sequence that reads as travelling
 * backward. This pass enforces the constraint in time order, taking
 * leg A's alighting as the trusted value (established first):
 *
 *   - **Distinct alights** (A → S, B's-board → T, T ≠ S): leg B
 *     continues the journey, so it is rewritten to board where leg A
 *     alighted (S → T). Only the station label changes; split time and
 *     line name are left as resolved.
 *   - **Same alight** (A → S, B's-board → S): leg B claims a ride to a
 *     station you have *already reached* via leg A, with no travel
 *     between — physically impossible, and the boarding cannot be
 *     rewritten without collapsing B to a degenerate "S → S". Leg B is
 *     a phantom re-arrival (typically a coarse-fix reconstruction
 *     duplicating leg A's tail), so it is **absorbed** into leg A. This
 *     is the case the worldline-feasibility checker (`src/eval`) guards;
 *     before this branch existed it left the impossibility standing
 *     (the 2026-06-22 bug).
 */
export function reconcileAdjacentRailLegs(segments: EnrichedSegment[]): EnrichedSegment[] {
	const out: EnrichedSegment[] = [];
	for (const seg of segments) {
		const b = { ...seg };
		const a = out.length > 0 ? out[out.length - 1] : undefined;
		if (a !== undefined && effectiveMode(a) === "train" && effectiveMode(b) === "train") {
			const aRail = parseRailWayName(a.wayName);
			const bRail = parseRailWayName(b.wayName);
			if (aRail !== null && bRail !== null && aRail.alight !== bRail.board) {
				if (aRail.alight === bRail.alight) {
					// Phantom re-arrival — absorb leg B into the trusted,
					// established-first leg A rather than leave the impossibility.
					a.endTs = Math.max(a.endTs, b.endTs);
					a.pointCount += b.pointCount;
					a.maxSpeed = Math.max(a.maxSpeed, b.maxSpeed);
					if (a.snappedPath === undefined && b.snappedPath !== undefined) a.snappedPath = b.snappedPath;
					continue; // drop B; it is leg A's arrival, not a new ride
				}
				// Distinct alights: leg B picks the journey up from S.
				b.wayName = `${aRail.alight}${RAIL_STATION_SEP}${bRail.alight}${bRail.line ? `${RAIL_LINE_SEP}${bRail.line}` : ""}`;
			}
		}
		out.push(b);
	}
	return out;
}

/** Max duration of a NON-train segment that may sit between two train legs of
 *  one continuous ride and still be absorbed into it — a GPS-surfacing sliver,
 *  a brief platform interchange, or a mis-moded fragment. A longer gap means the
 *  rider actually got off (a real stopover), so the run is two journeys. */
const RAIL_JOURNEY_SLIVER_MAX_S = 10 * 60;
/** A longer intervening segment is still part of the ride if it carries a
 *  motorised peak — the underground GPS surfaced at tube speed, so the segment
 *  is a mis-moded tunnel leg, not a real street walk/stop. The bound sits above
 *  the cycling ceiling (CYCLING_MAX_SPEED_KMH = 35), so a genuine walk between
 *  two separate rides (which peaks at walking pace, even with a lone GPS spike)
 *  is never absorbed — that case must break the run (2026-06-24 Wembley Park →
 *  Euston Square, where the Finchley Rd → Baker St tunnel surfaced as a 13-min
 *  "walk" peaking at tube speed). The single-through-line gate still applies. */
const RAIL_JOURNEY_TRANSIT_PEAK_KMH = 40;
/** Radius (m) for the line lookup at a train leg's fix centroid. Generous: an
 *  underground-reconstructed leg's surfaced fixes can sit a few hundred metres
 *  off the line, and the per-line station-membership check is the real gate, so
 *  a loose radius only widens the (membership-filtered) candidate set. */
const RAIL_JOURNEY_LINES_RADIUS_M = 800;

/** Representative location of a train leg for the line lookup: the centroid of
 *  its GPS fixes (the leg carries no centroid field — those are attached to
 *  stays only), falling back to a segment centroid if one is present (tests). */
function legLocation(seg: EnrichedSegment, points: readonly FilteredPoint[]): { lat: number; lon: number } | null {
	const fixes = samplesInWindow(points, seg);
	if (fixes.length > 0) {
		let sLat = 0;
		let sLon = 0;
		for (const f of fixes) {
			sLat += f.lat;
			sLon += f.lon;
		}
		return { lat: sLat / fixes.length, lon: sLon / fixes.length };
	}
	if (seg.centroidLat !== undefined && seg.centroidLon !== undefined) {
		return { lat: seg.centroidLat, lon: seg.centroidLon };
	}
	return null;
}

/** The `OsmAdapter` slice the rail-journey assembler reads. Both calls are
 *  captured in the golden OSM trace, so the pass stays deterministic on replay. */
type RailJourneyOsm = {
	linesAtPoint(lat: number, lon: number, radiusM?: number): Promise<Set<string>>;
	stationsOnLine(lineName: string): Promise<ReadonlyArray<LineStation>>;
};

/** A station the line serves, with the coordinate of its canonical node. */
type LineStation = { name: string; lat: number; lon: number };

/** Max distance (m) from the ride's alighting fix to a station ON THE LINE for
 *  that station to be accepted as the alight. Matches the rail-run endpoint
 *  radius: the first post-ride fix is routinely a few hundred metres from the
 *  platform (the phone reports again once the rider is already walking out).
 *  Beyond it we have no idea where they got off and keep the fragment's own
 *  label rather than invent one. */
const JOURNEY_ALIGHT_MAX_M = 400;

/**
 * Resolve the alighting station of a MERGED rail journey.
 *
 * A fragment's alight label is only trustworthy for that fragment's window. The
 * last fragment of a ride that ends in a GPS blackout alights at a *mid-ride
 * waypoint* — the last station the phone saw — not at the station the rider
 * actually got off at. Inheriting `last.alight` therefore truncates the ride at
 * whatever the GPS happened to catch last (2026-06-28: the Metropolitan ride
 * Wembley Park → King's Cross went dark after Euston Square and was labelled as
 * ending there, contradicting the Victoria leg that then boarded at King's
 * Cross).
 *
 * Resolve it from the ride's own end instead: take the first fix at which the
 * rider is demonstrably off the train (the same rule `annotateRailRuns` uses)
 * and name the nearest station THE RIDE'S LINE ACTUALLY SERVES. Constraining
 * the candidates to the line is what makes the answer stable: a raw
 * `nearbyStations` lookup at King's Cross ranks the National Rail terminus node
 * 1.7 m ahead of the Underground station, so the label is a coin-flip between
 * two co-located nodes — but only one of them is on the Metropolitan line.
 *
 * Uses no OSM call of its own: the line's station set is already fetched (and
 * memoised) to decide the merge, so this is a re-read of evidence in hand.
 * Returns null when the ride's end is unobserved or lands nowhere near the
 * line — the caller then keeps the fragment's label.
 */
function resolveJourneyAlight(
	points: readonly FilteredPoint[],
	endTs: number,
	onLine: readonly LineStation[],
): string | null {
	const off = findRunAlightFix(points, endTs);
	if (off === undefined || onLine.length === 0) return null;
	const nearest = [...onLine]
		.map((s) => ({ s, d: haversineMeters(off.lat, off.lon, s.lat, s.lon) }))
		.sort((a, b) => a.d - b.d)[0];
	return nearest.d <= JOURNEY_ALIGHT_MAX_M ? nearest.s.name : null;
}

/** A station-pair-labelled train leg (the only kind the assembler reasons over). */
function isStationPairTrain(seg: EnrichedSegment | undefined): seg is EnrichedSegment {
	return seg !== undefined && effectiveMode(seg) === "train" && parseRailWayName(seg.wayName) !== null;
}

/** Suffix `relabelWalkingInterchanges` stamps on a walk it has identified as a
 *  platform-to-platform line change between two train legs sharing a station. */
const INTERCHANGE_WALK_SUFFIX = "(interchange)";

/** Is there a platform-to-platform interchange walk between the train legs at
 *  `aIdx` and `bIdx` (exclusive)? Such a walk is positive evidence of a train
 *  change, so the rail-journey assembler must not merge across it. */
function hasInterchangeWalkBetween(segments: readonly EnrichedSegment[], aIdx: number, bIdx: number): boolean {
	for (let m = aIdx + 1; m < bIdx; m++) {
		const seg = segments[m];
		if (
			effectiveMode(seg) === "walking" &&
			seg.wayName !== undefined &&
			seg.wayName.endsWith(INTERCHANGE_WALK_SUFFIX)
		) {
			return true;
		}
	}
	return false;
}

/**
 * Find a single rail line that serves EVERY station the run's train legs touch,
 * or null. Candidates are the lines named on the legs plus the UNION of lines
 * passing near each leg centroid — a union, not an intersection, because an
 * underground-reconstructed leg has a coarse centroid that can miss its own line
 * within the lookup radius, but a clean above-ground leg in the same run still
 * contributes the through-line. Each candidate is then confirmed by full station
 * membership via `stationsOnLine` (memoised), so the looser candidate set cannot
 * cause a wrong merge: only a line that genuinely serves *all* the run's stations
 * passes. A returned line means one continuous ride on it is consistent with
 * every leg; null means the legs span more than one line — a genuine interchange
 * — so the run is left intact.
 */
async function findThroughLine(
	trains: EnrichedSegment[],
	stations: ReadonlySet<string>,
	points: readonly FilteredPoint[],
	osm: RailJourneyOsm,
	stationsOnLineMemo: Map<string, readonly LineStation[]>,
): Promise<string | null> {
	const tried = new Set<string>();
	const want = [...stations];
	const serves = async (line: string): Promise<boolean> => {
		if (tried.has(line)) return false;
		tried.add(line);
		let onLine = stationsOnLineMemo.get(line);
		if (onLine === undefined) {
			onLine = await osm.stationsOnLine(line);
			stationsOnLineMemo.set(line, onLine);
		}
		const names = new Set(onLine.map((s) => s.name));
		return want.every((s) => names.has(s));
	};
	// Cheapest candidates first: a line a leg already names costs no OSM call.
	for (const t of trains) {
		const line = parseRailWayName(t.wayName)?.line;
		if (line && (await serves(line))) return line;
	}
	// Fall back to the lines passing near each leg, lazily — stop at the first
	// leg whose neighbourhood yields a serving line (a clean above-ground leg
	// finds the through-line, so the coarse underground legs are never queried).
	for (const t of trains) {
		const loc = legLocation(t, points);
		if (loc === null) continue;
		for (const line of await osm.linesAtPoint(loc.lat, loc.lon, RAIL_JOURNEY_LINES_RADIUS_M)) {
			if (await serves(line)) return line;
		}
	}
	return null;
}

/**
 * Assemble fragmented single-line rail journeys into one ride.
 *
 * When the GPS surfaces mid-tunnel, one continuous Underground ride is shattered
 * into several `train` segments separated by short slivers — platform jitter
 * mis-scored as walking/stationary, or even a mis-moded vehicle leg from the
 * surfaced fixes. The heuristic merges below only coalesce legs with an
 * *identical* station pair, so a `Wembley Park → Finchley Road`,
 * `Finchley Road → Baker Street`, `Baker Street → Euston Square` chain survives
 * as three legs plus phantom interchanges, when it was one Metropolitan-line
 * ride the whole way (the 2026-06-23 case).
 *
 * For a maximal run of station-pair train legs separated only by short slivers,
 * if a SINGLE rail line serves every station the legs touch, the run is one ride
 * on that line: collapse it to one `train` segment `first.board → last.alight ·
 * line`, absorbing the slivers. When no single line serves them all the run is a
 * genuine multi-line interchange and the legs are left intact — the line
 * topology, not a GPS heuristic, draws that distinction. Pure given the
 * `OsmAdapter` (both lookups captured for golden determinism).
 */
export async function assembleRailJourney(
	segments: EnrichedSegment[],
	points: readonly FilteredPoint[],
	osm: RailJourneyOsm,
): Promise<EnrichedSegment[]> {
	const out: EnrichedSegment[] = [];
	const stationsOnLineMemo = new Map<string, readonly LineStation[]>();
	let i = 0;
	while (i < segments.length) {
		if (!isStationPairTrain(segments[i])) {
			out.push(segments[i]);
			i++;
			continue;
		}
		// Extend a maximal run: train legs plus short intervening slivers. A sliver
		// is only inside the run if another train leg follows it — a trailing
		// sliver is not part of the ride. `lastTrain` tracks the run's final leg.
		let lastTrain = i;
		let k = i + 1;
		while (k < segments.length) {
			if (isStationPairTrain(segments[k])) {
				lastTrain = k;
				k++;
				continue;
			}
			if (segments[k].endTs - segments[k].startTs < RAIL_JOURNEY_SLIVER_MAX_S) {
				k++;
				continue;
			}
			// A longer middle is still inside the ride when it is mis-moded tunnel
			// transit (a motorised peak), not a real walk/stop the rider got off for.
			if (segments[k].maxSpeed >= RAIL_JOURNEY_TRANSIT_PEAK_KMH) {
				k++;
				continue;
			}
			break;
		}
		if (lastTrain === i) {
			out.push(segments[i]);
			i++;
			continue;
		}
		// Partition the run's train legs into maximal SINGLE-LINE sub-runs and merge
		// each on its own. A run can span a genuine interchange — e.g. Metropolitan
		// then Victoria at King's Cross — where no single line serves every station,
		// but each side is one continuous ride. The old all-or-nothing test (one
		// line for the WHOLE run) bailed on such runs and left every leg shattered;
		// here we grow a sub-run while one line still serves all its stations, emit
		// it as one leg, then continue from the changeover. Slivers WITHIN a sub-run
		// are absorbed; slivers BETWEEN sub-runs (the interchange) pass through.
		const trainPositions: number[] = [];
		for (let m = i; m <= lastTrain; m++) {
			if (isStationPairTrain(segments[m])) trainPositions.push(m);
		}
		const stationsOf = (segs: readonly EnrichedSegment[]): Set<string> => {
			const s = new Set<string>();
			for (const t of segs) {
				const r = parseRailWayName(t.wayName);
				if (r) {
					s.add(r.board);
					s.add(r.alight);
				}
			}
			return s;
		};
		let cursor = i;
		let p = 0;
		while (p < trainPositions.length) {
			// Longest prefix trainPositions[p..e] that is one continuous ride. Three
			// gates must all hold to extend the prefix by a fragment:
			//   1. A single line serves every station the prefix touches
			//      (`findThroughLine`) — the geometric through-line test.
			//   2. The fragment's OWN line label is compatible with the lines the
			//      prefix has already committed to. A continuous ride never changes
			//      physical line, so an explicit Metropolitan fragment followed by an
			//      explicit Jubilee fragment is an interchange even when one line
			//      (Jubilee) happens to serve all three stations. Labels are expanded
			//      to physical lines so a shared-track combined name ("Circle, H&C and
			//      Metropolitan Lines") stays compatible with a plain "Metropolitan
			//      Line". Unlabelled fragments impose no line constraint.
			//   3. No platform-to-platform interchange walk sits between the fragments.
			//      `relabelWalkingInterchanges` rewrites a short walk between two train
			//      legs that share a station to "<station> (interchange)" — positive
			//      evidence the rider changed trains. The geometric through-line test
			//      alone misses this when the first leg is unlabelled and a single line
			//      happens to serve both ends (2026-06-16 Wembley Park → Baker Street →
			//      Green Park: Jubilee serves all three, but the rider rode the
			//      Metropolitan to Baker Street and changed there). The interchange walk
			//      breaks the run UNLESS both fragments carry explicit labels proving
			//      one shared line — a genuine same-line surfacing that merely happened
			//      to share a station still merges.
			let groupLine: string | null = null;
			let e = p;
			let allowed: Set<string> | null = null;
			for (let c = p; c < trainPositions.length; c++) {
				const fragLine = parseRailWayName(segments[trainPositions[c]].wayName)?.line;
				let nextAllowed: Set<string> | null = allowed;
				if (fragLine !== undefined) {
					const expanded = new Set<string>(expandTubeLineNames(fragLine));
					if (allowed === null) {
						nextAllowed = expanded;
					} else {
						const inter = new Set<string>();
						for (const l of allowed) if (expanded.has(l)) inter.add(l);
						nextAllowed = inter;
					}
					if (nextAllowed.size === 0) break; // line-label interchange: a physical line change
				}
				if (c > p && hasInterchangeWalkBetween(segments, trainPositions[c - 1], trainPositions[c])) {
					// Both fragments explicitly the same line (allowed carried a prior
					// label and this one intersects it) proves the interchange marker
					// spurious; otherwise trust it and split here.
					const provenSameLine = fragLine !== undefined && allowed !== null;
					if (!provenSameLine) break;
				}
				const sub = trainPositions.slice(p, c + 1).map((idx) => segments[idx]);
				const ln = await findThroughLine(sub, stationsOf(sub), points, osm, stationsOnLineMemo);
				if (ln === null) break;
				groupLine = ln;
				allowed = nextAllowed;
				e = c;
			}
			const firstPos = trainPositions[p];
			const lastPos = trainPositions[e];
			// Emit any segments before this sub-run unchanged (interchange slivers
			// between sub-runs).
			while (cursor < firstPos) {
				out.push(segments[cursor]);
				cursor++;
			}
			const first = parseRailWayName(segments[firstPos].wayName);
			const last = parseRailWayName(segments[lastPos].wayName);
			if (firstPos === lastPos || groupLine === null || first === null || last === null) {
				// A lone leg, or an unresolvable line — pass the train leg(s) through
				// unchanged rather than fabricate a merge.
				for (let m = firstPos; m <= lastPos; m++) out.push(segments[m]);
			} else {
				// Collapse [firstPos..lastPos] into one leg; intervening slivers are
				// absorbed (their time is covered by the leg). snappedPath is left for
				// the later rail-snap pass to attach from the merged route key.
				let pointCount = 0;
				let maxSpeed = 0;
				for (let m = firstPos; m <= lastPos; m++) {
					pointCount += segments[m].pointCount;
					maxSpeed = Math.max(maxSpeed, segments[m].maxSpeed);
				}
				// The ride's alight, resolved from the ride's own end against the
				// stations its line serves — NOT inherited from the last fragment,
				// whose label stops wherever the GPS last surfaced. See
				// resolveJourneyAlight. Falls back to the fragment's label when the
				// ride's end is unobserved, and never collapses to a degenerate
				// "X → X".
				const resolved = resolveJourneyAlight(points, segments[lastPos].endTs, stationsOnLineMemo.get(groupLine) ?? []);
				const alight = resolved !== null && resolved !== first.board ? resolved : last.alight;
				const reason = `rail-journey assembly: ${e - p + 1} fragments on ${groupLine} (GPS surfaced mid-ride) merged into one continuous ride`;
				out.push({
					...segments[firstPos],
					mode: "train",
					refinedMode: "train",
					endTs: segments[lastPos].endTs,
					wayName: `${first.board} → ${alight} · ${groupLine}`,
					snappedPath: undefined,
					pointCount,
					maxSpeed,
					refinedReason: segments[firstPos].refinedReason ? `${segments[firstPos].refinedReason}; ${reason}` : reason,
				});
			}
			cursor = lastPos + 1;
			p = e + 1;
		}
		i = lastTrain + 1;
	}
	return out;
}

/**
 * Attach a `snappedPath` to every train segment whose route is in the
 * precomputed cache.
 *
 * The snapped rail geometry is expensive to compute (a heavy OSM
 * spatial scan) so it is never computed on the request path. The
 * `refresh-rail-routes` CLI computes it offline and stores it in
 * `rail_route_cache`, keyed by the train run's `<board> → <alight>`
 * label. Here we do one indexed lookup, attach the geometry, and
 * interpolate the segment's time window along it. A train run whose
 * route is not yet cached simply keeps no `snappedPath` and the
 * frontend draws its raw fixes — it becomes snapped once the cron has
 * run. Purely additive: the raw track and day-state timeline are
 * untouched.
 */
export function annotateSnappedPaths(
	segments: EnrichedSegment[],
	railRouteCache: ReadonlyArray<{ routeKey: string; geometryJson: string }>,
): EnrichedSegment[] {
	const keys = new Set(
		segments.filter((s) => effectiveMode(s) === "train" && s.wayName).map((s) => s.wayName as string),
	);
	if (keys.size === 0) return segments;

	const geomByKey = new Map<string, Array<{ lat: number; lon: number }>>();
	for (const r of railRouteCache) {
		if (!keys.has(r.routeKey)) continue;
		try {
			const geom = JSON.parse(r.geometryJson) as Array<{ lat: number; lon: number }>;
			if (Array.isArray(geom) && geom.length >= 2) geomByKey.set(r.routeKey, geom);
		} catch {
			// A malformed cache row is non-fatal — skip it; the run draws raw.
		}
	}
	if (geomByKey.size === 0) return segments;

	return segments.map((seg): EnrichedSegment => {
		if (effectiveMode(seg) !== "train" || !seg.wayName) return seg;
		const geom = geomByKey.get(seg.wayName);
		if (!geom) return seg;
		return { ...seg, snappedPath: interpolateTimes(geom, seg.startTs, seg.endTs) };
	});
}
