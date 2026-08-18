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
	/** `bounds.startUtc`. Read ONLY by the empty-day arm (#1055): a day with
	 *  observations takes its bounds from them. */
	dayStartTs?: number;
	/** The day's display zone, carried onto an inferred stay so it renders local
	 *  like every other state. */
	dayTz?: string | null;
	/** The cross-day bracket, ALREADY NAMED by the shell — the place a no-data
	 *  day is attributed to. `undefined` when the day is not bracketed by the
	 *  same place on both sides, which is honestly unknown rather than a
	 *  failure. */
	bracketPlace?: string;
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

/**
 * Everything a `verified_cli day` request is built FROM — the payload, with no
 * oracle in it.
 *
 * `FoldCaptureFile` below is a superset: more than half of it (`segsSplit`,
 * `segsPre`, `segsIn`, `segsOut`, `statesOut`, `episodesOut`, `sleepPlace`) is
 * what the TS run ANSWERED, read only by `compare-day` to grade a boundary.
 * `buildDayRequest` never touches those, and a serving caller cannot produce
 * them — they are the output of the very cascade the request would replace.
 *
 * Splitting the two is what lets the fold serve. A capture satisfies this
 * interface structurally, so the gate keeps passing its file; `velocity.ts` can
 * satisfy it directly from values already in scope, with no capture at all.
 *
 * `tzAt` / `bestPlace` are the shell ANSWER TABLES, and are the one part a
 * serving caller does not have up front: they start empty and fill over the
 * round loop, because the fold is a pure function of its tables and will name
 * what it wanted (#431 gap 4).
 */
export interface DayRequestInputs {
	/** The SPLIT STAGE's input — `classifySegments`' output. The only segment
	 *  series that crosses; everything downstream of it is Lean's to produce. */
	segsRaw: TrackSegment[];
	/** The mined `mode_biometrics` rows — the corrections' only observation that
	 *  is not already in `obs`. */
	modeStats: ModeStats[];
	obs: FoldObservations;
	/** What the stages after the fold read. Absent only when a caller builds a
	 *  fold-only request; the day chain needs it. */
	tail?: DownstreamInputs;
	tzAt: TzQuery[];
	bestPlace: StayPlaceQuery[];
}

/** What one day's cascade consumed and produced. Merged with the day's
 *  `ClassificationInputs` by `fold-payload.ts` into a `verified_cli day`
 *  request. A superset of {@link DayRequestInputs} — the extra fields are
 *  oracles, and are why this type cannot be what a serving caller builds. */
export interface FoldCaptureFile extends DayRequestInputs {
	date: string;
	user: string;
	/** The split stage's output — `refinedSegments`, what the OSM enrichment loop
	 *  is handed, and the boundary that stage is measured at. */
	segsSplit: TrackSegment[];
	/** The OSM enrichment loop's output — `enriched`, five stages before pass 1.
	 *  An ORACLE only, as of #430 B2: it used to be where the Lean chain started,
	 *  because the enrichment stage between it and `segsSplit` was unported. Now
	 *  `Verified.Geo.EnrichFold` produces it and this grades that. */
	segsPre: EnrichedSegment[];
	/** The cascade's input — `physicallyCorrected`, before pass 1. Recorded
	 *  rather than recomputed, so the Lean corrections are compared against what
	 *  the TS run actually handed the fold (#428). */
	segsIn: EnrichedSegment[];
	/** The cascade's output — what the 38 passes produced. The oracle. */
	segsOut: EnrichedSegment[];
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
