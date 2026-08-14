/**
 * Rail and drive absorption passes.
 *
 * Folds platform waits into the boarding train, absorbs phantom
 * drive-stops and transit interchanges, and relabels short
 * platform-to-platform walks. Extracted from the velocity orchestrator.
 */

import { meanCadenceSpm, PEDESTRIAN_MIN_CADENCE_SPM } from "../../eval/worldline-feasibility.js";
import type { StepPoint } from "../biometrics.js";
import type { EnrichedSegment } from "../enriched-segment.js";
import type { FilteredPoint } from "../kalman.js";
import { lineCannotServe, type ServedStationsLookup } from "../line-membership.js";
import { type NearbyStation, pickBestStation } from "../osm.js";
import { dbOsmAdapter } from "../osm-adapter.js";
import { haversineMeters } from "../place-snap.js";
import { effectiveMode, samplesInWindow, samplesInWindowExclusiveEnd, statsOverWindow } from "../segment-util.js";
import { parseRailWayName } from "./rail-reconcile.js";
import { expandTubeLineNames, RAIL_RUN_STATION_RADIUS_M } from "./rail-runs.js";

/** Longest stationary stretch (s) before a rail run still treated as a
 *  platform / concourse wait and absorbed into boarding the train. A
 *  longer stay at the station is left as its own state. */
const PLATFORM_WAIT_MAX_S = 15 * 60;

/**
 * Absorb a platform wait into the boarding of a rail run.
 *
 * A short stationary segment immediately before a `train` segment whose
 * location resolves to that train's boarding station is the wait on the
 * platform / concourse — part of catching the train, not a separate
 * stay. Left standalone it gets mislabelled: a station is not a focus
 * place, so the place-assigner snaps the stay to the nearest focus
 * place (e.g. a King's Cross platform wait surfaced as "@ Work" 380 m
 * away). Dropping the stationary and extending the train's start back
 * over it makes the timeline read walk → train.
 *
 * The boarding station is read from the train's station-pair wayName
 * (`"<board> → <alight>"`, optionally ` · <line>`), so this works for
 * both annotateRailRuns and annotateUndergroundRuns output.
 */
export async function absorbBoardingPlatform(
	segments: EnrichedSegment[],
	points: FilteredPoint[],
	stationsLookup: (lat: number, lon: number) => Promise<NearbyStation[]> = (lat, lon) =>
		dbOsmAdapter.nearbyStations(lat, lon, RAIL_RUN_STATION_RADIUS_M),
): Promise<EnrichedSegment[]> {
	const absorbed = new Set<number>();
	const extendTo = new Map<number, number>();

	for (let k = 1; k < segments.length; k++) {
		const train = segments[k];
		if (train.mode !== "train") continue;
		const arrow = (train.wayName ?? "").indexOf(" → ");
		if (arrow < 0) continue;
		const boardingStation = (train.wayName ?? "").slice(0, arrow);

		const prev = segments[k - 1];
		if (prev.mode !== "stationary") continue;
		if (prev.endTs - prev.startTs > PLATFORM_WAIT_MAX_S) continue;

		const segPoints = samplesInWindowExclusiveEnd(points, prev);
		if (segPoints.length === 0) continue;
		const cLat = segPoints.reduce((a, p) => a + p.lat, 0) / segPoints.length;
		const cLon = segPoints.reduce((a, p) => a + p.lon, 0) / segPoints.length;
		const station = pickBestStation(await stationsLookup(cLat, cLon));
		if (!station || station.name !== boardingStation) continue;

		absorbed.add(k - 1);
		extendTo.set(k, prev.startTs);
	}

	if (absorbed.size === 0) return segments;
	const out: EnrichedSegment[] = [];
	for (let idx = 0; idx < segments.length; idx++) {
		if (absorbed.has(idx)) continue;
		const newStart = extendTo.get(idx);
		out.push(newStart !== undefined ? { ...segments[idx], startTs: newStart } : segments[idx]);
	}
	return out;
}

/** Longest a single stationary segment can be and still count as part
 *  of a transit interchange rather than a genuine stay. A platform-to-
 *  platform change or a wait for the next train runs minutes; a real
 *  stop is longer — and a real stay would also have coalesced with its
 *  neighbours in mergeAdjacentStays. */
const INTERCHANGE_SEGMENT_MAX_S = 8 * 60;

/** Longest a phantom drive-stop can be and still get absorbed. Real
 *  brief drive stops (drop-off, ATM, quick errand) tend to run a few
 *  minutes; longer stops are genuine and shouldn't be absorbed even if
 *  the user happened not to step out of the car. */
const DRIVE_STOP_ABSORB_MAX_S = 15 * 60;

/** Maximum steps accumulated inside a phantom drive-stop. Even briefly
 *  getting out of a car generates a handful of step counts; zero or near-
 *  zero is the biometric tell for "stayed in the vehicle the whole
 *  time". */
const DRIVE_STOP_ABSORB_MAX_STEPS = 5;

/**
 * Absorb a phantom drive-stop into the surrounding drives.
 *
 * A short `stationary` segment sandwiched between two `driving`
 * segments — when the biometric data shows zero / near-zero steps
 * across it — is a GPS-noise-driven phantom stop, not a real one.
 * Classic shape: dense-urban congestion or signal occlusion drops the
 * speed reading to zero, the classifier calls it stationary, and the
 * nearest typed OSM POI (in our motivating case, "The Lanesborough")
 * becomes the place label.
 *
 * If the user actually got out of the car, the watch records steps
 * almost immediately — even three steps from the seat to the kerb
 * appear. Zero steps over a 5–15 minute "stop" is the unambiguous
 * tell that the vehicle never opened its doors.
 *
 * Mirrors `absorbInterchanges` for the road case. Only fires when
 * the sandwich is `driving → short stationary → driving` — a stop at
 * the start or end of a day, or before a longer stay, is left alone.
 */
export function absorbDriveStops(segments: EnrichedSegment[], steps: readonly StepPoint[]): EnrichedSegment[] {
	const stepsBetween = (startTs: number, endTs: number): number => {
		let total = 0;
		for (const p of steps) if (p.ts >= startTs && p.ts <= endTs) total += p.steps;
		return total;
	};
	const onePass = (input: EnrichedSegment[]): { out: EnrichedSegment[]; changed: boolean } => {
		const out: EnrichedSegment[] = [];
		let changed = false;
		let i = 0;
		while (i < input.length) {
			const seg = input[i];
			if (effectiveMode(seg) !== "driving" || i + 2 >= input.length) {
				out.push(seg);
				i++;
				continue;
			}
			const middle = input[i + 1];
			const next = input[i + 2];
			const isPhantomStop =
				effectiveMode(middle) === "stationary" &&
				effectiveMode(next) === "driving" &&
				middle.endTs - middle.startTs <= DRIVE_STOP_ABSORB_MAX_S &&
				stepsBetween(middle.startTs, middle.endTs) <= DRIVE_STOP_ABSORB_MAX_STEPS;
			if (isPhantomStop) {
				out.push({
					...seg,
					endTs: next.endTs,
					pointCount: seg.pointCount + middle.pointCount + next.pointCount,
				});
				i += 3;
				changed = true;
				continue;
			}
			out.push(seg);
			i++;
		}
		return { out, changed };
	};
	let current = segments;
	for (let guard = 0; guard < 10; guard++) {
		const { out, changed } = onePass(current);
		if (!changed) return out;
		current = out;
	}
	return current;
}

/**
 * Absorb a transit interchange into the train it follows.
 *
 * A run of short `stationary` segments immediately after a `train`
 * segment and followed by further movement is not a stay — it is the
 * interchange between trains: a platform-to-platform walk, a wait, or
 * an underground hop the classifier read as stationary because the
 * scattered fixes have little net displacement. Left alone each gets a
 * spurious place label — whatever OSM venue is nearest the noisy
 * underground centroid. This extends the preceding train over the run
 * and drops the run's segments, so the journey reads train → onward
 * with no phantom stop.
 *
 * Only fires for a run *between a train and another moving segment*. A
 * short stationary that ends the day, or that sits before a longer
 * stay, is left as a stay.
 */
export function absorbInterchanges(segments: EnrichedSegment[]): EnrichedSegment[] {
	const out: EnrichedSegment[] = [];
	let i = 0;
	while (i < segments.length) {
		const seg = segments[i];
		if (effectiveMode(seg) !== "train") {
			out.push(seg);
			i++;
			continue;
		}
		// Collect the run of short stationary segments following the train.
		let runEnd = i + 1;
		while (
			runEnd < segments.length &&
			effectiveMode(segments[runEnd]) === "stationary" &&
			segments[runEnd].endTs - segments[runEnd].startTs <= INTERCHANGE_SEGMENT_MAX_S
		) {
			runEnd++;
		}
		// Absorb only when the run is non-empty AND the journey continues
		// past it with a moving segment — a run that ends the day, or is
		// stopped by a longer stationary stay, is not an interchange.
		const continues = runEnd < segments.length && effectiveMode(segments[runEnd]) !== "stationary";
		if (runEnd > i + 1 && continues) {
			out.push({ ...seg, endTs: segments[runEnd - 1].endTs });
			i = runEnd;
			continue;
		}
		out.push(seg);
		i++;
	}
	return out;
}

/** A walking segment longer than this between two trains is treated as a
 *  genuine out-of-station walk, not a platform interchange. A line change
 *  inside one station is short; walking out to do something and coming back
 *  to the same station is not. */
const INTERCHANGE_WALK_MAX_S = 300;

/**
 * Relabel a short walking segment sandwiched between two train legs that
 * share a station as the interchange at that station.
 *
 * Changing lines (e.g. Metropolitan → Jubilee at Baker Street) is a walk
 * between platforms *inside* the station. GPS often resurfaces mid-change,
 * so the segment is correctly `walking` but gets named after the nearest
 * street the fix happened to see — "Allsop Place" for the 2026-06-16 Baker
 * Street change — which reads as if the user left the station. The two
 * bounding train legs already share a station (leg A alights where leg B
 * boards), so a short walk between them can only be the platform-to-platform
 * interchange. Rewrite its `wayName` to the station; mode and duration are
 * left untouched — the walk is real, only its *location* was wrong.
 */
export function relabelWalkingInterchanges(segments: EnrichedSegment[]): EnrichedSegment[] {
	return segments.map((seg, i) => {
		if (effectiveMode(seg) !== "walking") return seg;
		if (seg.endTs - seg.startTs > INTERCHANGE_WALK_MAX_S) return seg;
		const prev = segments[i - 1];
		const next = segments[i + 1];
		if (!prev || !next || effectiveMode(prev) !== "train" || effectiveMode(next) !== "train") return seg;
		const prevRail = parseRailWayName(prev.wayName);
		const nextRail = parseRailWayName(next.wayName);
		if (!prevRail || !nextRail || prevRail.alight !== nextRail.board) return seg;
		const station = prevRail.alight;
		const lineChange = prevRail.line && nextRail.line ? ` (${prevRail.line} → ${nextRail.line})` : "";
		return {
			...seg,
			wayName: `${station} (interchange)`,
			refinedReason: `walking interchange at ${station}${lineChange}`,
		};
	});
}

/** Min step speed (km/h) for a walk-tail fix to count as the boarding hop into
 *  the tunnel — the train pulling out of the real boarding station — rather than
 *  a walking step. Well above any walk/run pace. */
const BOARDING_HOP_MIN_KMH = 15;
/** The fast tail must cover at least this (m) end-to-end to be a real
 *  inter-station hop the underground reconstruction stranded in the walk — not a
 *  few metres of acceleration as the doors close, which belongs in the walk. */
const BOARDING_HOP_MIN_DIST_M = 250;

/**
 * Re-anchor an underground train's boarding to the station the preceding walk
 * delivered the rider to, reclaiming the first inter-station hop the
 * reconstruction stranded in the walk.
 *
 * When the GPS first surfaces a stop or two into a tunnel, `annotateUnderground-
 * Runs` anchors the train's boarding to the first fix it can snap to the rail
 * line — which can be one or two stations past where the rider actually boarded.
 * The walk before it then keeps a fast "tail": the GPS of the train pulling out
 * of the real boarding station toward the first surfaced one. So the drawn walk
 * line bleeds hundreds of metres on to the next station (the 2026-06-23 Hospital U →
 * Euston Square case, where the walk drew on to Great Portland Street, and the
 * boarding read "Baker Street" — two stops past Euston Square).
 *
 * If the walk before a train ends in a vehicle-paced tail covering a real
 * inter-station distance, and the fix just before that tail sits at a rail
 * station, that station is the true boarding: extend the train back to it (so it
 * reclaims the hop), trim the walk to it, and rewrite the train's boarding. The
 * fix is anchored to the station the walk's own fixes reach — strictly better
 * evidence than a fix a stop or two down the line. Pure given the station lookup.
 *
 * The re-anchor may only name a station the leg's OWN line serves. Reaching a
 * station on foot says the rider was THERE; it does not say they boarded THIS
 * line there, and a walk that ends at an interchange reaches several lines'
 * stations at once. Without that check the pass rewrites the boarding to
 * whichever station the walk touched first and erases the interchange between
 * them — 2026-07-12, where a Metropolitan-line leg ended up boarding at
 * Highbury & Islington, which the Metropolitan does not serve (#351). The
 * ALIGHT twin has carried this veto since #377; this is the symmetric half.
 */
export async function anchorTrainBoardingToWalkedStation(
	segments: EnrichedSegment[],
	points: FilteredPoint[],
	stationsLookup: (lat: number, lon: number) => Promise<NearbyStation[]> = (lat, lon) =>
		dbOsmAdapter.nearbyStations(lat, lon, RAIL_RUN_STATION_RADIUS_M),
	servedLookup: ServedStationsLookup = (line) => dbOsmAdapter.stationsOnLine(line),
): Promise<EnrichedSegment[]> {
	const out = segments.map((s) => ({ ...s }));
	for (let k = 1; k < out.length; k++) {
		const train = out[k];
		if (effectiveMode(train) !== "train") continue;
		const rail = parseRailWayName(train.wayName);
		if (rail === null) continue;
		const walk = out[k - 1];
		if (effectiveMode(walk) !== "walking") continue;
		// Continuity guard (2026-06-24 Wembley Park → Euston Square): when the walk
		// is bracketed by a preceding train (train → sliver-walk → train), it is an
		// underground-reconstruction artifact, not a walk-to-station. Its "boarding
		// hop" is the SAME ride continuing, so re-anchoring this leg's boarding to a
		// station scanned from the sliver invents a rail-discontinuity (board != the
		// previous leg's alighting, with no travel between) — which also defeats
		// assembleRailJourney's single-line merge downstream. Boarding continuity
		// here is owned by reconcileAdjacentRailLegs / assembleRailJourney.
		if (k >= 2 && effectiveMode(out[k - 2]) === "train") continue;
		// INCLUSIVE of the walk's closing fix, like the alight side. The step
		// that straddles the walk→train boundary is the ride pulling out, and
		// `checkWorldlineFeasibility` counts it against this leg — so a pass
		// that cannot see it is blind to exactly the evidence the invariant
		// reports (the 2026-07-01 Baker Street interchange: an 819 m step
		// landing ON the boundary, invisible to the exclusive-end window).
		const fixes = samplesInWindow(points, walk);
		if (fixes.length < 4) continue;

		// The boarding hop: the FIRST vehicle-paced RUN covering a real
		// inter-station distance — the train pulling out of the real boarding
		// station toward the first station the GPS surfaced at. The FIRST, not
		// the last: the surfaced fix often settles into a slow one as the train
		// decelerates into the next station, so a from-the-end scan would miss
		// it. A RUN, not a single step: coming out of a platform the train is
		// still accelerating, so the first observed steps are short (76 m, 86 m
		// on 07-01) and each falls under the inter-station bar on its own while
		// the run covers 981 m. Contiguous steps at hop pace accumulate, and the
		// run qualifies once its NET displacement clears the bar — the same rule
		// `anchorTrainAlightToWalkedStation` applies to its settle run.
		let split = -1;
		let hopRunSteps = 0;
		let runStart = -1;
		for (let i = 1; i < fixes.length; i++) {
			const dt = fixes[i].ts - fixes[i - 1].ts;
			const stepM = haversineMeters(fixes[i - 1].lat, fixes[i - 1].lon, fixes[i].lat, fixes[i].lon);
			const stepKmh = dt > 0 ? (stepM / dt) * 3.6 : 0;
			if (stepKmh >= BOARDING_HOP_MIN_KMH) {
				if (runStart < 0) runStart = i - 1;
				const runNetM = haversineMeters(fixes[runStart].lat, fixes[runStart].lon, fixes[i].lat, fixes[i].lon);
				if (split < 0 && runNetM >= BOARDING_HOP_MIN_DIST_M) split = runStart + 1;
				if (split >= 0) hopRunSteps = i - runStart;
			} else {
				if (split >= 0) break; // the qualifying run has ended
				runStart = -1;
			}
		}
		if (split < 1) continue; // no boarding hop
		const boardFix = fixes[split - 1];
		// Guard against a lone GPS spike that returns: the walk must actually END
		// away from the boarding fix (a real relocation onto the tube), not bounce
		// back to the cluster.
		const tailDist = haversineMeters(
			boardFix.lat,
			boardFix.lon,
			fixes[fixes.length - 1].lat,
			fixes[fixes.length - 1].lon,
		);
		if (tailDist < BOARDING_HOP_MIN_DIST_M) continue;

		const station = pickBestStation(await stationsLookup(boardFix.lat, boardFix.lon));
		if (!station) continue;

		// The scanned station EQUALLING the label is not "nothing to do": the
		// rename is a no-op but the boarding hop is still stranded in the walk,
		// where the kinematic invariant reads it as vehicle-paced walking (the
		// 2026-05-18 evening Met ride, 1.5 km at 60 km/h). Extend the boundary
		// in both cases — but, exactly as on the alight side, the same-station
		// extension demands DENSE evidence (>= 2 consecutive fast steps): a
		// lone fast step landing back at the labelled board is the stuck-GPS
		// signature, and extending there eats a real walk's tail. The rename
		// case keeps working on a single blackout hop because it is
		// additionally anchored by a DIFFERENT station the walk reached.
		const sameBoard = station.name === rail.board;
		if (sameBoard && hopRunSteps < 2) continue;
		// A RENAME must name a station this leg's line serves. The scan sees
		// whatever the walk's terminal fix is near, and at an interchange that is
		// several lines' stations; being there is not boarding THIS one. Only the
		// rename is gated — the same-station case changes no name, and a boundary
		// that reclaims a stranded hop is right whether or not the label is.
		if (!sameBoard && rail.line && (await lineCannotServe(rail.line, station.name, servedLookup))) continue;
		const reason = sameBoard
			? `boarding boundary extended back to the ${station.name} departure — reclaimed a ${Math.round(tailDist)} m hop the underground reconstruction had left in the walk`
			: `boarding re-anchored to ${station.name} (walk's terminal station) — reclaimed a ${Math.round(tailDist)} m hop the underground reconstruction had left in the walk (was boarding ${rail.board})`;
		// Mirror of the alight side: the reclaimed hop belongs to the ride now,
		// so it must stop counting toward the walk's peak. No `excludeStart` —
		// nothing precedes this walk's start, only its END moved.
		out[k - 1] = { ...walk, endTs: boardFix.ts, ...statsOverWindow(points, walk.startTs, boardFix.ts) };
		out[k] = {
			...train,
			startTs: boardFix.ts,
			wayName: sameBoard ? train.wayName : `${station.name} → ${rail.alight}${rail.line ? ` · ${rail.line}` : ""}`,
			refinedReason: train.refinedReason ? `${train.refinedReason}; ${reason}` : reason,
		};
	}
	return out;
}

/** Min step speed (km/h) for a LEADING walk-fix to count as the train still
 *  riding in — the same ride past the GPS-surfaced station to the real
 *  disembark, not a walking step. Mirrors BOARDING_HOP_MIN_KMH. */
const ALIGHT_HOP_MIN_KMH = 15;
/** The leading fast run must cover a real inter-station distance (m). */
const ALIGHT_HOP_MIN_DIST_M = 250;
/**
 * Re-anchor an underground train's ALIGHT to the station the FOLLOWING walk's
 * leading hop reached — the mirror of {@link anchorTrainBoardingToWalkedStation}.
 *
 * When GPS goes dark in a tunnel, the train segment closes at the last clean
 * fix (the surfaced station), and the rider's continued ride to the true
 * disembark a stop or two on the SAME line gets stranded as the FAST leading
 * fixes of the next "walking" segment. The 2026-06-29 outbound: Wembley Park →
 * Baker Street (alight pinned where GPS reappeared), then a "15-min walk" whose
 * first hop is the Metropolitan still doing ~50 km/h on to Euston Square (a
 * single 56 km/h fix labelled "walking" is the tell).
 *
 * If the walk after a train OPENS with a vehicle-paced inter-station hop, and
 * the fix where it settles sits at a rail station that shares a line with the
 * surfaced alight, that station is the true disembark: extend the train forward
 * to it (reclaiming the hop), trim the walk to it, and rewrite the alight.
 * Pure given the lookups. Runs after the boarding anchor, before railJourney.
 */
export async function anchorTrainAlightToWalkedStation(
	segments: EnrichedSegment[],
	points: FilteredPoint[],
	/** The day's per-minute step rows. Cadence is what separates a ride still
	 *  running from a rider already walking; without it the rule falls back to
	 *  the old step-count proxy rather than guessing. */
	steps: readonly StepPoint[] = [],
	stationsLookup: (lat: number, lon: number) => Promise<NearbyStation[]> = (lat, lon) =>
		dbOsmAdapter.nearbyStations(lat, lon, RAIL_RUN_STATION_RADIUS_M),
	linesLookup: (lat: number, lon: number) => Promise<Set<string>> = (lat, lon) => dbOsmAdapter.linesAtPoint(lat, lon),
	servedLookup: ServedStationsLookup = (line) => dbOsmAdapter.stationsOnLine(line),
): Promise<EnrichedSegment[]> {
	const out = segments.map((s) => ({ ...s }));
	for (let k = 0; k < out.length - 1; k++) {
		const train = out[k];
		if (effectiveMode(train) !== "train") continue;
		const rail = parseRailWayName(train.wayName);
		if (rail === null) continue;
		const walk = out[k + 1];
		if (effectiveMode(walk) !== "walking") continue;
		// Interchange guard (mirror of the boarding side): train → walk → train
		// is an interchange sliver — the walk's leading hop is the NEXT train
		// pulling out, not this one riding in. Owned by reconcileAdjacentRailLegs
		// / assembleRailJourney, not here.
		if (k + 2 < out.length && effectiveMode(out[k + 2]) === "train") continue;
		const fixes = samplesInWindow(points, walk);
		if (fixes.length < 3) continue;

		// The alighting hop ends where the LAST vehicle-paced RUN in the walk
		// settles — a run, not a single step. With a tunnel blackout the ride
		// is one long jump (a run of one step); with continuous overground GPS
		// it is many short fast steps, each individually UNDER the sparse-hop
		// distance floor (14 s at 60 km/h is ~230 m), so a per-step
		// `stepM >= floor` test lands mid-track between fixes and the station
		// gate below then bails — the whole ride tail stays stranded in the
		// walk. Contiguous steps at hop pace accumulate instead: a run
		// qualifies once its NET displacement covers a real inter-station
		// distance. The LAST qualifying run — never the first — because GPS
		// routinely "sticks" at an intermediate surfaced station (a slow
		// cluster) while the train keeps going. The station+line gate below
		// still stops a stray late spike from hijacking the alight.
		let settle = -1;
		let settleRunSteps = 0; // how many consecutive fast steps backed the chosen settle
		let runStart = -1; // index of the fix the current vehicle-paced run started at
		for (let i = 1; i < fixes.length; i++) {
			const dt = fixes[i].ts - fixes[i - 1].ts;
			const stepM = haversineMeters(fixes[i - 1].lat, fixes[i - 1].lon, fixes[i].lat, fixes[i].lon);
			const stepKmh = dt > 0 ? (stepM / dt) * 3.6 : 0;
			if (stepKmh >= ALIGHT_HOP_MIN_KMH) {
				if (runStart < 0) runStart = i - 1;
				const runNetM = haversineMeters(fixes[runStart].lat, fixes[runStart].lon, fixes[i].lat, fixes[i].lon);
				if (runNetM >= ALIGHT_HOP_MIN_DIST_M) {
					settle = i;
					settleRunSteps = i - runStart;
				}
			} else {
				runStart = -1;
			}
		}
		// `ALIGHT_ANCHOR_DUMP=1` names which guard left a reclaimable-looking hop
		// in the walk. Every exit below is silent, so a leg that SHOULD have been
		// extended and was not is otherwise indistinguishable from one the pass
		// never looked at.
		const dump = process.env.ALIGHT_ANCHOR_DUMP === "1";
		const why = (msg: string): void => {
			if (dump) console.log(`  alight-anchor ${rail.board} → ${rail.alight}: ${msg}`);
		};
		if (settle < 1) {
			why(`no vehicle-paced inter-station run in the following walk (${fixes.length} fixes)`);
			continue;
		}
		const alightFix = fixes[settle];
		const surfaced = fixes[0];
		const hopDistM = haversineMeters(surfaced.lat, surfaced.lon, alightFix.lat, alightFix.lon);
		if (hopDistM < ALIGHT_HOP_MIN_DIST_M) {
			why(`hop is only ${Math.round(hopDistM)} m, under the ${ALIGHT_HOP_MIN_DIST_M} m floor`);
			continue;
		}

		const station = pickBestStation(await stationsLookup(alightFix.lat, alightFix.lon));
		if (!station) {
			why(
				`hop of ${Math.round(hopDistM)} m over ${settleRunSteps} step(s) settles at NO STATION — ` +
					`nothing within the lookup radius of the settle fix`,
			);
			continue;
		}

		// Line-continuity guard: the new alight must share a tube line with the
		// GPS-surfaced station — the hop stayed on the run's corridor, not off to
		// an unrelated station. Canonicalise directional/combined names before ∩
		// (the expandTubeLineNames lesson).
		const [surfacedLines, linesAtSettle] = await Promise.all([
			linesLookup(surfaced.lat, surfaced.lon),
			linesLookup(alightFix.lat, alightFix.lon),
		]);
		// A platform is 150 m long and the depot beyond it longer, so a fix that
		// settles a couple of hundred metres past the platform ends still
		// resolves the station while sitting outside every mapped rail way —
		// `linesAtPoint` answers the EMPTY SET. Empty is not disagreement:
		// nothing was asked. Read as one it rejected Wembley Park on 2026-07-07
		// (settle fix 258 m west of the node, no lines; the node itself carries
		// Metropolitan and Jubilee) and left 1651 m of Metropolitan riding —
		// seven consecutive 14 s steps at 48-65 km/h — inside the following
		// walk, where the kinematic invariant counts it as impossible walking.
		// So when the fix answers nothing, ask the station it just resolved TO;
		// a named node's own coordinates are the better probe for its lines
		// anyway (the #358 rule). A station that answers nothing either, or one
		// whose recording predates these coordinates, still fails the guard —
		// the fallback asks a second question, it does not excuse the answer.
		const alightLines =
			linesAtSettle.size > 0 || station.lat === undefined || station.lon === undefined
				? linesAtSettle
				: await linesLookup(station.lat, station.lon);
		const surfacedCanon = new Set([...surfacedLines].flatMap(expandTubeLineNames));
		const alightCanon = new Set([...alightLines].flatMap(expandTubeLineNames));
		// `ALIGHT_ANCHOR_NO_CORRIDOR=1` ablates this guard. It asks whether two
		// positions share a line, which presumes a line identifier is stable
		// along a route — true of the tube mirror ("Metropolitan" end to end),
		// false of per-section track refs (2026-04-29 compared 044 against 514a
		// and could only reject). Measured over the corpus it rejects exactly one
		// leg, that one; the ablation is how that is kept honest.
		if (process.env.ALIGHT_ANCHOR_NO_CORRIDOR !== "1" && ![...alightCanon].some((l) => surfacedCanon.has(l))) {
			why(
				`settles at ${station.name} but shares no line with the surfaced fix — ` +
					`surfaced={${[...surfacedCanon].join("|")}} alight={${[...alightCanon].join("|")}}`,
			);
			continue;
		}

		// The guard above asks whether the two ENDS share a corridor, which a
		// line running alongside the tube for miles satisfies while saying
		// nothing about the line this leg is labelled with. Ask that directly:
		// a leg cannot alight where its own line does not stop. Without it the
		// anchor turned the 2026-06-28 return into a "North London line" ride
		// alighting 7.1 km away at Wembley Park — a leg the feasibility gate
		// could only reject after the fact (#377).
		if (rail.line && (await lineCannotServe(rail.line, station.name, servedLookup))) {
			why(`settles at ${station.name}, which the ${rail.line} does not serve`);
			continue;
		}

		const hopM = Math.round(hopDistM);
		// The rail-run topology often gets the alight NAME right while the cut
		// lands early (the label is anchored on stations, the boundary on
		// segmentation windows). A settled station equal to the current label is
		// therefore NOT "nothing to do" — the ride tail is still stranded in the
		// walk; only the rename is a no-op. Extend the boundary in both cases —
		// BUT the same-station extension demands DENSE evidence (≥2 consecutive
		// fast steps). A single fast step landing at the labelled alight is the
		// stuck-GPS signature: the rider already alighted and walks while stale
		// fixes teleport to catch up — extending there eats a real walk's head.
		// The rename case keeps working on a single blackout hop because it is
		// additionally anchored by the station+line topology of a DIFFERENT
		// station the walk demonstrably reached.
		const sameAlight = station.name === rail.alight;
		// A same-station extension needs evidence the ride actually continued,
		// because the alternative — the rider already walking while stale fixes
		// teleport after them — produces the same fast steps. `settleRunSteps >= 2`
		// used to stand in for that evidence and is the wrong question: 07-14 (a
		// real ride tail, so recorded in ground truth) and 07-07 (a corroborated
		// walk to a hospital) are both single-step hops of ~1500 m, identical to
		// within noise. Ask where the rider PAUSED instead — a train still running
		// stops at its own line's stations.
		//
		// `ALIGHT_ANCHOR_NO_SINGLE_STEP=1` ablates the whole refusal, which is how
		// the two days above were graded against each other.
		// Was the rider WALKING across the stretch being reclaimed?
		//
		// `settleRunSteps >= 2` used to stand in for that and asks the wrong
		// question: 2026-07-14 and 2026-07-07 are both single-step ~1500 m hops
		// and are the same shape to within noise, yet one is a real ride tail. So
		// is the other — measured, the rider took ZERO steps across both windows
		// and started stepping only at the settle fix. GPS agrees: 1.5 km covered
		// in ~3 min, which is 28 km/h.
		//
		// Cadence answers it directly, and it is the signal the symmetric
		// invariant (`checkVehiclePedestrianRuns`) already trusts in the opposite
		// direction. Below the pedestrian floor the rider was carried, so the tail
		// is the ride's; at or above it they were on foot and extending would eat
		// a real walk's head, which is what the guard was built to prevent.
		//
		// No step data means the question was not asked: fall back to the old
		// proxy rather than assert on silence.
		const cadence = sameAlight ? meanCadenceSpm(steps, surfaced.ts, alightFix.ts) : null;
		const wasWalking = cadence !== null && cadence >= PEDESTRIAN_MIN_CADENCE_SPM;
		const singleStepRefusal = sameAlight && settleRunSteps < 2 && (cadence === null ? true : wasWalking);
		// `ALIGHT_ANCHOR_DUMP=1` names why a reclaimable-looking hop was left in
		// the walk. Every guard above this point exits silently, so a leg that
		// SHOULD have been extended and was not is otherwise indistinguishable
		// from one the pass never considered.
		why(
			`settles at ${station.name} over ${settleRunSteps} step(s), ${hopM} m — ` +
				`cadence ${cadence === null ? "unknown" : `${Math.round(cadence)} steps/min`} — ` +
				`${singleStepRefusal ? "REFUSED: same station, single step, and the rider was walking" : "extending"}`,
		);
		if (singleStepRefusal && process.env.ALIGHT_ANCHOR_NO_SINGLE_STEP !== "1") continue;
		const reason = sameAlight
			? `alight boundary extended to the ${station.name} arrival — reclaimed a ${hopM} m ride tail the early cut left in the walk`
			: `alight re-anchored to ${station.name} (walk's leading hop reached it) — reclaimed a ${hopM} m hop the GPS blackout left in the walk (was alighting ${rail.alight})`;
		out[k] = {
			...train,
			endTs: alightFix.ts,
			wayName: sameAlight ? train.wayName : `${rail.board} → ${station.name}${rail.line ? ` · ${rail.line}` : ""}`,
			refinedReason: train.refinedReason ? `${train.refinedReason}; ${reason}` : reason,
		};
		// The hop just moved into the ride, so it is no longer the walk's to
		// report. Leaving the summary alone left 2026-07-02's Euston Underpass
		// walk claiming a 187.2 km/h peak — the reclaimed 1491 m blackout hop —
		// long after the fix that produced it had been handed to the train.
		// `excludeStart` because the ride owns its arrival fix.
		out[k + 1] = { ...walk, startTs: alightFix.ts, ...statsOverWindow(points, alightFix.ts, walk.endTs, true) };
	}
	return out;
}
