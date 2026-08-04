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
import type { JitterPlaceQuery } from "../geo/passes/stays.js";

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

/** What one day's cascade consumed and produced. Merged with the day's
 *  `CapturedDay` by `fold-payload.ts` into a `verified_cli day` request. */
export interface FoldCaptureFile {
	date: string;
	user: string;
	/** The cascade's input — `physicallyCorrected`, before pass 1. */
	segsIn: EnrichedSegment[];
	/** The cascade's output — what the 38 passes produced. The oracle. */
	segsOut: EnrichedSegment[];
	obs: FoldObservations;
	tzAt: TzQuery[];
	bestPlace: JitterPlaceQuery[];
}

export interface FoldCapture {
	recordTz: (lat: number, lon: number, tz: string) => void;
	recordBestPlace: (q: JitterPlaceQuery) => void;
	write: (
		date: string,
		user: string,
		segsIn: EnrichedSegment[],
		segsOut: EnrichedSegment[],
		obs: FoldObservations,
	) => void;
}

/** `undefined` unless `FOLD_CAPTURE` names a directory to write into. */
export function foldCaptureFromEnv(): FoldCapture | undefined {
	const dir = process.env.FOLD_CAPTURE;
	if (!dir) return undefined;
	const tzAt: TzQuery[] = [];
	const bestPlace: JitterPlaceQuery[] = [];
	return {
		recordTz: (lat, lon, tz) => {
			tzAt.push({ lat, lon, tz });
		},
		recordBestPlace: (q) => {
			bestPlace.push(q);
		},
		write: (date, user, segsIn, segsOut, obs) => {
			mkdirSync(dir, { recursive: true });
			const file: FoldCaptureFile = { date, user, segsIn, segsOut, obs, tzAt, bestPlace };
			writeFileSync(path.join(dir, `${date}-${user}.json`), JSON.stringify(file));
			console.log(
				`fold-capture ${date}: ${segsIn.length} in, ${segsOut.length} out, ` +
					`${obs.points.length} pts, ${tzAt.length} tz, ${bestPlace.length} place`,
			);
		},
	};
}
