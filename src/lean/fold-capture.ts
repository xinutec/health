/**
 * The refinement cascade's own record of what it was handed and what it asked.
 *
 * Task #424. `Verified.Geo.PassFold` runs the same 38 passes in Lean, and
 * `verified_cli day` executes them — but a parity run needs three things the
 * golden fixtures do not have:
 *
 *   1. The cascade's INPUT segments. A fixture stores the day's final output;
 *      the cascade starts from `physicallyCorrected`, dozens of decisions
 *      earlier.
 *   2. The `tzAt` answers. `tzLookup` is a direct import in `velocity.ts`, not
 *      an `OsmAdapter` method, so `RecordingOsmAdapter` never sees it.
 *   3. The `bestPlace` answers. Same shape: `bestPlace` is imported by
 *      `consolidateJitterStays`, which passes it the adapter rather than being
 *      routed through one.
 *
 * Everything else the Lean `Env` needs is already in the fixture — the track,
 * the step / HR / sleep series, the four caches, and the `osmTrace` that
 * answers the six mirror lookups.
 *
 * # Why this records rather than recomputes
 *
 * The alternative is to re-derive the questions from the track: run the same
 * centroid and midpoint arithmetic outside the pass and ask at those points.
 * That duplicates the decision under test. If the Lean port and the TS pass
 * disagree about WHICH coordinate to ask about, a recomputed table would ask
 * the Lean question and answer it, hiding the disagreement; a recorded table
 * has only the TS question, so the Lean arm misses and the fold aborts naming
 * the key. The miss IS the finding.
 *
 * # Off unless asked
 *
 * Gated on `FOLD_CAPTURE`, and the whole object is `undefined` otherwise, so
 * production pays one `undefined` check per pass and nothing else. It is a
 * measurement scaffold, not a feature: the regime (`pippijn@da7c800c`) is that
 * production output comes from TS while Lean runs alongside as measurement.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { EnrichedSegment } from "../geo/enriched-segment.js";
import type { EpisodeGeometry } from "../geo/episode-geometry.js";
import type { ModeStats } from "../geo/mode-biometrics.js";
import type { TrackSegment } from "../geo/segments.js";
import type { DayState } from "../sleep/day-state.js";

/** A recorded `tzAt(lat, lon)` answer. */
export interface TzQuery {
	lat: number;
	lon: number;
	tz: string;
}

/** The day's observations as the cascade actually saw them.
 *
 *  Written out rather than re-derived from the fixture, because two of them are
 *  COMPUTED upstream, not stored: `points` is the Kalman track and `rawFixes`
 *  is the in-day slice before quality filtering. Re-deriving either would put a
 *  second implementation of an upstream stage between the fixture and the
 *  measurement, and a disagreement there would read as a fold divergence. */
export interface FoldObservations {
	/** The Kalman-filtered track — `Env.points`. */
	points: { ts: number; lat: number; lon: number; speedKmh: number }[];
	/** The RAW in-day fixes the underground reconstruction mines. Pre-Kalman
	 *  AND pre-quality-filter: smoothing destroys the coarse cell-network
	 *  pattern it looks for. */
	rawFixes: { ts: number; lat: number; lon: number; accuracy: number | null }[];
	/** Quality-filtered but UN-snapped fixes — what the walk draw weighs. */
	displayFixes: { ts: number; lat: number; lon: number; accuracy: number | null }[];
	steps: { ts: number; steps: number }[];
	hr: { ts: number; bpm: number }[];
	sleep: { startTs: number; endTs: number }[];
}

/** What the stages AFTER the fold read, beyond the fold's own observations.
 *
 *  All four are sliced or loaded upstream of `computeVelocityFromInputs`'s tail
 *  and none survives into the fixture, so like `FoldObservations` they are
 *  written out rather than re-derived. The two raw-fix series are the point of
 *  the sleep-place attribution: they are NOT today's track — the morning slice
 *  and the PREVIOUS evening's are where the user actually slept when today's
 *  first stationary segment is hours late. */
export interface DownstreamInputs {
	morningRaw: { ts: number; lat: number; lon: number }[];
	prevEveningRaw: { ts: number; lat: number; lon: number }[];
	/** Fitbit windows before place attribution — `RawSleepWindow`. */
	rawSleep: { startTs: number; endTs: number; tz: string | null; minutesAsleep: number }[];
	/** `bounds.endUtc` — how far `applyDwellContinuation` may continue a dwell. */
	dayEndTs: number;
}

/** A recorded `bestPlace` naming question asked at a stay WINDOW — the key, not
 *  the answer. `Verified.Geo.BestPlace` computes the label now; what it cannot
 *  compute is the venue-local clock, so `fold-payload.ts` resolves the stay's
 *  minutes and its midpoint hour from these five and sends those.
 *
 *  Asked from TWO places — the OSM enrichment loop names every stay, and
 *  `consolidateJitterStays` re-names a merged one — which is why this is its own
 *  type rather than the jitter pass's `JitterPlaceQuery`. That one carries the
 *  answer as well; the answer is not what crosses. */
export interface StayPlaceQuery {
	lat: number;
	lon: number;
	startTs: number;
	endTs: number;
	tz: string;
}

/** A recorded sleep-stay label re-resolution: `bestPlace(preferResidential)`
 *  composed with `placeLabel`, asked per stay centroid. A SHELL — venue naming
 *  against the mirror, the same class as the jitter pass's `bestPlace`. */
export interface SleepPlaceQuery {
	lat: number;
	lon: number;
	label: string | null;
}

/** What one day's cascade consumed and produced. Merged with the day's
 *  `CapturedDay` by `fold-payload.ts` into a `verified_cli day` request. */
export interface FoldCaptureFile {
	date: string;
	user: string;
	/** The SPLIT STAGE's input — `classifySegments`' output, before either
	 *  biometric split or the stay bridge (#430). The earliest boundary the day
	 *  gate reaches, and the only one whose input nothing upstream of it in Lean
	 *  produced. */
	segsRaw: TrackSegment[];
	/** The split stage's output — `refinedSegments`, what the OSM enrichment loop
	 *  is handed, and the boundary that stage is measured at. */
	segsSplit: TrackSegment[];
	/** The OSM enrichment loop's output — `enriched`, five stages before pass 1.
	 *  An ORACLE only, as of #430 B2: it used to be where the Lean chain started,
	 *  because the enrichment stage between it and `segsSplit` was unported. Now
	 *  `Verified.Geo.EnrichFold` produces it and this grades that. */
	segsPre: EnrichedSegment[];
	/** The mined `mode_biometrics` rows — the only observation the corrections
	 *  need that the fold does not, and the only one not already in `obs`. */
	modeStats: ModeStats[];
	/** The cascade's input — `physicallyCorrected`, before pass 1. Recorded
	 *  rather than recomputed, so the Lean corrections are compared against what
	 *  the TS run actually handed the fold (#428). */
	segsIn: EnrichedSegment[];
	/** The cascade's output — what the 38 passes produced. The oracle. */
	segsOut: EnrichedSegment[];
	obs: FoldObservations;
	tzAt: TzQuery[];
	bestPlace: StayPlaceQuery[];
	/** Absent when the run ended between the fold and the day's return — the
	 *  file is written twice for exactly that reason, so a throw in the tail
	 *  leaves the fold half readable rather than losing the day. */
	tail?: DownstreamInputs;
	sleepPlace?: SleepPlaceQuery[];
	/** The served timeline and its geometry — the downstream oracle. */
	statesOut?: DayState[];
	episodesOut?: EpisodeGeometry[];
}

export interface FoldCapture {
	recordTz: (lat: number, lon: number, tz: string) => void;
	recordBestPlace: (q: StayPlaceQuery) => void;
	recordSleepPlace: (q: SleepPlaceQuery) => void;
	write: (
		date: string,
		user: string,
		segsRaw: TrackSegment[],
		segsSplit: TrackSegment[],
		segsPre: EnrichedSegment[],
		modeStats: ModeStats[],
		segsIn: EnrichedSegment[],
		segsOut: EnrichedSegment[],
		obs: FoldObservations,
	) => void;
	/** Re-write the day's file with the tail's inputs and outputs. Called at
	 *  every return site of `computeVelocityFromInputs`, including the empty-day
	 *  arm — a day that returns early returns a real timeline, and a capture that
	 *  skipped it would compare the Lean chain against nothing. */
	writeTail: (tail: DownstreamInputs, states: DayState[], episodes: EpisodeGeometry[]) => void;
}

/** `undefined` unless `FOLD_CAPTURE` names a directory to write into. */
export function foldCaptureFromEnv(): FoldCapture | undefined {
	const dir = process.env.FOLD_CAPTURE;
	if (!dir) return undefined;
	const tzAt: TzQuery[] = [];
	const bestPlace: StayPlaceQuery[] = [];
	const sleepPlace: SleepPlaceQuery[] = [];
	let file: FoldCaptureFile | undefined;
	const flush = (): void => {
		if (file === undefined) return;
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, `${file.date}-${file.user}.json`), JSON.stringify(file));
	};
	return {
		recordTz: (lat, lon, tz) => {
			tzAt.push({ lat, lon, tz });
		},
		// Projected, not pushed whole: the jitter pass hands its own
		// `JitterPlaceQuery`, which carries the ANSWER too, and the answer is
		// exactly what stopped crossing when `bestPlace` became Lean (#430).
		recordBestPlace: ({ lat, lon, startTs, endTs, tz }) => {
			bestPlace.push({ lat, lon, startTs, endTs, tz });
		},
		recordSleepPlace: (q) => {
			sleepPlace.push(q);
		},
		write: (date, user, segsRaw, segsSplit, segsPre, modeStats, segsIn, segsOut, obs) => {
			file = { date, user, segsRaw, segsSplit, segsPre, modeStats, segsIn, segsOut, obs, tzAt, bestPlace, sleepPlace };
			flush();
			console.log(
				`fold-capture ${date}: ${segsRaw.length} raw, ${segsSplit.length} split, ${segsPre.length} pre, ` +
					`${segsIn.length} in, ${segsOut.length} out, ` +
					`${obs.points.length} pts, ${tzAt.length} tz, ${bestPlace.length} place`,
			);
		},
		writeTail: (tail, states, episodes) => {
			if (file === undefined) return;
			file = { ...file, tail, sleepPlace, statesOut: states, episodesOut: episodes };
			flush();
			console.log(
				`fold-capture ${file.date}: tail ${states.length} states, ${episodes.length} episodes, ` +
					`${tail.rawSleep.length} sleep, ${sleepPlace.length} sleep-place`,
			);
		},
	};
}
