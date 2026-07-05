/**
 * Tube-journey assembler — Phase B of
 * `docs/proposals/decoder-roadmap.md`.
 *
 * Composes the per-minute decoded state list into segment-level
 * tube-journey segments. Each journey wraps a contiguous run of:
 *
 *   - train minutes (any line)
 *   - intra-station walking minutes (mode=walking AND GPS near a
 *     tube-station POI)
 *
 * bracketed by surface walking / stationary / other minutes that
 * sit outside any tube-station POI. The wrapper preserves the
 * per-minute classifications verbatim — it just adds segment-
 * level structure on top.
 *
 * The leg list within a journey is derived from the train-
 * candidate generator's emitted candidates and the per-minute
 * walking-inside-station minutes. Lines that the journey passes
 * through are collected into `lines`. The intra-station step
 * count (cadence summed across walking minutes inside the
 * journey) is exposed so the user's daily walking step total is
 * unchanged.
 *
 * Pure module.
 */

import type { RouteGraph, RouteNode } from "../geo/route-graph.js";
import type { Observation } from "./observation.js";
import type { State } from "./state-space.js";
import type { TrainCandidate } from "./train-candidate-generator.js";

export interface AssembleTubeJourneysInput {
	observations: readonly Observation[];
	states: readonly State[];
	routeGraph: RouteGraph;
	trainCandidates: readonly TrainCandidate[];
}

export type TubeLeg =
	| {
			kind: "train";
			startMin: number;
			endMin: number;
			line: string;
			boardStationName?: string;
			alightStationName?: string;
	  }
	| {
			kind: "interchangeWalk";
			startMin: number;
			endMin: number;
			stationName?: string;
	  };

export interface TubeJourney {
	startMin: number;
	endMin: number;
	startTs: number;
	endTs: number;
	boardStationName?: string;
	alightStationName?: string;
	lines: readonly string[];
	legs: readonly TubeLeg[];
	intraStepCount: number;
}

/** Radius (m) within which a walking-mode minute's GPS counts as
 *  "inside a tube station". Tube stations are tagged at the
 *  street entrance; the 150 m radius covers entrance + concourse
 *  + platform footprint without bleeding into surrounding shops.
 *  Aligned with `STATION_FOOTPRINT_M` in the train-candidate
 *  generator. */
const STATION_FOOTPRINT_M = 200;

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6_371_000;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Nearest station node to (lat, lon), within `STATION_FOOTPRINT_M`. */
function nearestStation(routeGraph: RouteGraph, lat: number, lon: number): RouteNode | null {
	let best: RouteNode | null = null;
	let bestDist = STATION_FOOTPRINT_M;
	for (const node of routeGraph.nodes.values()) {
		if (node.stationName === undefined) continue;
		const d = haversineMeters(lat, lon, node.point.lat, node.point.lon);
		if (d < bestDist) {
			bestDist = d;
			best = node;
		}
	}
	return best;
}

/** True iff the minute's mode is `walking` and its GPS sits
 *  within `STATION_FOOTPRINT_M` of any station node. */
function isWalkingInsideStation(routeGraph: RouteGraph, ob: Observation, st: State): boolean {
	if (st.mode !== "walking") return false;
	if (ob.gps === null) return false;
	return nearestStation(routeGraph, ob.gps.lat, ob.gps.lon) !== null;
}

/** A "tube-journey minute" is one that the wrapper groups into a
 *  journey: train minutes (any line) and walking-inside-station
 *  minutes. */
function isTubeJourneyMinute(routeGraph: RouteGraph, ob: Observation, st: State): boolean {
	if (st.mode === "train") return true;
	return isWalkingInsideStation(routeGraph, ob, st);
}

/** Find train candidate whose window overlaps with a sub-run of
 *  the journey. Returns the line and stations of the candidate. */
function findCandidateForRun(
	trainCandidates: readonly TrainCandidate[],
	runStart: number,
	runEnd: number,
): TrainCandidate | null {
	for (const c of trainCandidates) {
		// Allow ±2 minute slack on each boundary — the HSMM's
		// natural segment boundaries may differ slightly from the
		// generator's window.
		if (c.startMin <= runEnd + 2 && c.endMin >= runStart - 2) {
			return c;
		}
	}
	return null;
}

/** Segment-shaped input for the velocity-pipeline-fed assembler.
 *  This is the subset of `EnrichedSegment` the assembler needs —
 *  carrying it as a structural type avoids a cross-package import. */
export interface JourneySegment {
	startTs: number;
	endTs: number;
	mode: string;
	/** velocity.ts encodes train segments as `From → To` or
	 *  `From → To · Line Name`. The parser pulls station + line from
	 *  this. Non-train segments may carry a road name, or nothing. */
	wayName?: string;
	/** Optional cadence-derived step count over the segment window,
	 *  used to attribute walking-inside-station steps to the journey. */
	stepsTotal?: number | null;
}

/** Regex matching the trailing ` · Line Name` in `velocity.ts`'s
 *  train-segment wayName. Mirrors `PIPELINE_LINE_RE` in
 *  `src/cli/compare-vs-ground-truth.ts`. */
const TRAIN_LINE_RE = / · ([^·]+)$/;

/** Parse a `From → To[ · Line]` wayName into board / alight / line.
 *  Returns null pieces when the encoding is missing or malformed. */
function parseTrainWayName(wayName: string | undefined): {
	board: string | undefined;
	alight: string | undefined;
	line: string;
} {
	if (wayName === undefined) return { board: undefined, alight: undefined, line: "unknown_rail" };
	const lineMatch = TRAIN_LINE_RE.exec(wayName);
	const line = lineMatch?.[1] ?? "unknown_rail";
	const beforeLine = lineMatch ? wayName.slice(0, lineMatch.index) : wayName;
	const arrowIdx = beforeLine.indexOf(" → ");
	if (arrowIdx === -1) return { board: undefined, alight: undefined, line };
	return {
		board: beforeLine.slice(0, arrowIdx).trim(),
		alight: beforeLine.slice(arrowIdx + 3).trim(),
		line,
	};
}

/** Assembler variant fed by `velocity.ts`'s segment output.
 *  Composes consecutive train segments — even back-to-back with no
 *  walking minute between them — into single journeys with one leg
 *  per train segment. The user's quick platform-to-platform tube
 *  interchanges (no walking minute logged) render as one journey
 *  with multiple legs; longer interchanges with a walking segment
 *  in between render with the walking segment as an
 *  `interchangeWalk` leg. */
export function assembleTubeJourneysFromSegments(segments: readonly JourneySegment[]): TubeJourney[] {
	const journeys: TubeJourney[] = [];

	let i = 0;
	while (i < segments.length) {
		if (segments[i].mode !== "train") {
			i++;
			continue;
		}
		// Walk forward: keep including segments while they are either
		// train, OR walking sitting between two train segments
		// (interchange). Stop at the first non-train + non-interchange.
		let j = i;
		while (j < segments.length) {
			const s = segments[j];
			if (s.mode === "train") {
				j++;
				continue;
			}
			// Walking segment: only absorb if followed by another train.
			if (s.mode === "walking") {
				let k = j + 1;
				while (k < segments.length && segments[k].mode === "walking") k++;
				if (k < segments.length && segments[k].mode === "train") {
					j = k;
					continue;
				}
			}
			break;
		}

		const journeySegs = segments.slice(i, j);
		const startTs = journeySegs[0].startTs;
		const endTs = journeySegs[journeySegs.length - 1].endTs;
		const startMin = 0;
		const endMin = Math.max(0, Math.round((endTs - startTs) / 60));

		const legs: TubeLeg[] = [];
		const lines: string[] = [];
		let intraStepCount = 0;

		for (let m = 0; m < journeySegs.length; m++) {
			const s = journeySegs[m];
			const segStartMin = Math.round((s.startTs - startTs) / 60);
			const segEndMin = Math.round((s.endTs - startTs) / 60);
			if (s.mode === "train") {
				const { board, alight, line } = parseTrainWayName(s.wayName);
				legs.push({
					kind: "train",
					startMin: segStartMin,
					endMin: segEndMin,
					line,
					boardStationName: board,
					alightStationName: alight,
				});
				if (!lines.includes(line)) lines.push(line);
			} else if (s.mode === "walking") {
				legs.push({
					kind: "interchangeWalk",
					startMin: segStartMin,
					endMin: segEndMin,
				});
				if (s.stepsTotal !== undefined && s.stepsTotal !== null) intraStepCount += s.stepsTotal;
			}
		}

		let boardStationName: string | undefined;
		let alightStationName: string | undefined;
		for (const leg of legs) {
			if (leg.kind === "train" && leg.boardStationName !== undefined) {
				boardStationName = leg.boardStationName;
				break;
			}
		}
		for (let m = legs.length - 1; m >= 0; m--) {
			const leg = legs[m];
			if (leg.kind === "train" && leg.alightStationName !== undefined) {
				alightStationName = leg.alightStationName;
				break;
			}
		}

		journeys.push({
			startMin,
			endMin,
			startTs,
			endTs,
			boardStationName,
			alightStationName,
			lines,
			legs,
			intraStepCount,
		});

		i = j;
	}

	return journeys;
}

export function assembleTubeJourneys(input: AssembleTubeJourneysInput): TubeJourney[] {
	const T = input.observations.length;
	if (T === 0) return [];

	const journeys: TubeJourney[] = [];

	let t = 0;
	while (t < T) {
		if (!isTubeJourneyMinute(input.routeGraph, input.observations[t], input.states[t])) {
			t++;
			continue;
		}
		// Start of a journey at minute t. Find the maximal run.
		const journeyStart = t;
		let journeyEnd = t;
		while (
			journeyEnd + 1 < T &&
			isTubeJourneyMinute(input.routeGraph, input.observations[journeyEnd + 1], input.states[journeyEnd + 1])
		) {
			journeyEnd++;
		}

		// Tally intra-station walking steps across the WHOLE journey
		// (entry, exit, and interchanges) — the user's daily step
		// count must still reflect the time on foot inside the
		// station.
		let intraStepCount = 0;
		for (let k = journeyStart; k <= journeyEnd; k++) {
			if (input.states[k].mode !== "walking") continue;
			const ob = input.observations[k];
			if (ob.cadence !== null) intraStepCount += ob.cadence;
		}

		// Decompose the train minutes into train legs first. Legs
		// only contain TRAIN segments and INTERCHANGE walks (walks
		// that sit BETWEEN two train legs). Entry walks (before the
		// first train) and exit walks (after the last train) are
		// part of the journey's start/end span but aren't legs —
		// the leg list represents the user's transport choices
		// within the tube system, and "entered the station" /
		// "exited the station" aren't choices in the same sense.
		const trainLegs: { start: number; end: number; line: string }[] = [];
		{
			let k = journeyStart;
			while (k <= journeyEnd) {
				const st = input.states[k];
				if (st.mode !== "train") {
					k++;
					continue;
				}
				const legStart = k;
				const line = st.lineName ?? "unknown_rail";
				while (
					k <= journeyEnd &&
					input.states[k].mode === "train" &&
					(input.states[k].lineName ?? "unknown_rail") === line
				) {
					k++;
				}
				trainLegs.push({ start: legStart, end: k - 1, line });
			}
		}

		const legs: TubeLeg[] = [];
		for (let i = 0; i < trainLegs.length; i++) {
			const tl = trainLegs[i];
			const candidate = findCandidateForRun(input.trainCandidates, tl.start, tl.end);
			legs.push({
				kind: "train",
				startMin: tl.start,
				endMin: tl.end,
				line: tl.line,
				boardStationName: candidate?.boardStationName,
				alightStationName: candidate?.alightStationName,
			});
			// Interchange walk between this train leg and the next.
			if (i + 1 < trainLegs.length) {
				const next = trainLegs[i + 1];
				if (next.start > tl.end + 1) {
					const walkStart = tl.end + 1;
					const walkEnd = next.start - 1;
					const midIdx = Math.floor((walkStart + walkEnd) / 2);
					const midGps = input.observations[midIdx].gps;
					let stationName: string | undefined;
					if (midGps !== null) {
						const station = nearestStation(input.routeGraph, midGps.lat, midGps.lon);
						if (station !== null) stationName = station.stationName;
					}
					legs.push({
						kind: "interchangeWalk",
						startMin: walkStart,
						endMin: walkEnd,
						stationName,
					});
				}
			}
		}

		// Journey-level metadata: lines (unique, ordered by appearance),
		// board station = first leg's board, alight = last leg's alight.
		const lines: string[] = [];
		for (const leg of legs) {
			if (leg.kind === "train" && !lines.includes(leg.line)) lines.push(leg.line);
		}
		let boardStationName: string | undefined;
		let alightStationName: string | undefined;
		for (const leg of legs) {
			if (leg.kind === "train" && leg.boardStationName !== undefined) {
				boardStationName = leg.boardStationName;
				break;
			}
		}
		for (let i = legs.length - 1; i >= 0; i--) {
			const leg = legs[i];
			if (leg.kind === "train" && leg.alightStationName !== undefined) {
				alightStationName = leg.alightStationName;
				break;
			}
		}

		journeys.push({
			startMin: journeyStart,
			endMin: journeyEnd,
			startTs: input.observations[journeyStart].ts,
			endTs: input.observations[journeyEnd].ts,
			boardStationName,
			alightStationName,
			lines,
			legs,
			intraStepCount,
		});

		t = journeyEnd + 1;
	}

	return journeys;
}
