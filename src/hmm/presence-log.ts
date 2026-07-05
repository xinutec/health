/**
 * Roll-up: a day's HSMM-decoded segment array → one `presence_log`
 * row. Phase 1 of `docs/proposals/2026-06-presence-continuity.md`.
 *
 * Pure module — the function takes the decoded segments + a tz and
 * returns the row to insert. DB I/O lives in the calling CLI.
 *
 * The HSMM output is per-minute and was previously compacted into
 * `HmmSegment[]` for storage (see `src/hmm/persist.ts`). This module
 * re-expands those segments to per-minute attribution to compute the
 * day's summary. Single pass; no allocation beyond the segment array.
 */

import type { HmmSegment } from "./persist.js";

/** Shape inserted into `presence_log`. The DB types add `computed_at`
 *  as `Generated<Date>` — this shape is what the rollup produces, the
 *  caller adapts to the DB row type. */
export interface PresenceLogRow {
	user_id: string;
	date: string;
	tz: string;
	dominant_place_id: number | null;
	dominant_fraction: number;
	end_of_day_place_id: number | null;
	end_of_day_ts: Date | null;
	end_of_day_posterior: number;
}

/** Posterior assigned to the end-of-day state when it carries a
 *  focus_place id. The HSMM doesn't currently emit per-segment
 *  posteriors, so the rollup uses a conservative baseline: 0.95 for
 *  a stay at a known place that consumed the day's final minute,
 *  matching the magnitude the design's worked example assumes. When
 *  the HSMM gains per-segment posteriors (a future change),
 *  `computeRow` switches to reading them directly. */
const END_OF_DAY_BASELINE_POSTERIOR = 0.95;

export interface ComputeRowInput {
	user_id: string;
	date: string;
	tz: string;
	segments: readonly HmmSegment[];
}

/** Compute the rollup row for one day's decoded segments. Returns
 *  `null` when the day produced no decoded segments at all (a
 *  no-data day before continuation is wired in — the row is omitted
 *  rather than fabricated). */
export function computeRow(input: ComputeRowInput): PresenceLogRow | null {
	if (input.segments.length === 0) return null;

	// Bucket per-minute attribution by placeId. A null placeId (any
	// non-stationary mode, or stationary-without-known-place) counts as
	// its own bucket so the dominant_fraction is honest about how much
	// of the day was at a known place vs anything else.
	const minutesByPlace = new Map<number | null, number>();
	let totalMinutes = 0;
	for (const seg of input.segments) {
		const minutes = Math.max(0, Math.round((seg.endTs - seg.startTs) / 60));
		if (minutes === 0) continue;
		totalMinutes += minutes;
		const key = seg.mode === "stationary" ? seg.placeId : null;
		minutesByPlace.set(key, (minutesByPlace.get(key) ?? 0) + minutes);
	}
	if (totalMinutes === 0) return null;

	// Pick the dominant focus_place by accumulated minutes. A null key
	// (non-stationary minutes) never wins — null in the table means "no
	// focus_place dominated", which only makes sense when a real
	// focus_place exists with > 0 minutes.
	let dominantPlaceId: number | null = null;
	let dominantMinutes = 0;
	for (const [placeId, minutes] of minutesByPlace) {
		if (placeId === null) continue;
		if (minutes > dominantMinutes) {
			dominantPlaceId = placeId;
			dominantMinutes = minutes;
		}
	}
	const dominantFraction = dominantPlaceId !== null ? dominantMinutes / totalMinutes : 0;

	// End-of-day state: the last segment's mode+placeId. Only carry an
	// end_of_day_place_id when that last segment is stationary at a
	// known place — otherwise downstream consumers (the next day's
	// continuation seed) get null and skip.
	const last = input.segments[input.segments.length - 1];
	const endOfDayPlaceId = last.mode === "stationary" ? last.placeId : null;
	const endOfDayTs = endOfDayPlaceId !== null ? new Date(last.endTs * 1000) : null;
	const endOfDayPosterior = endOfDayPlaceId !== null ? END_OF_DAY_BASELINE_POSTERIOR : 0;

	return {
		user_id: input.user_id,
		date: input.date,
		tz: input.tz,
		dominant_place_id: dominantPlaceId,
		dominant_fraction: dominantFraction,
		end_of_day_place_id: endOfDayPlaceId,
		end_of_day_ts: endOfDayTs,
		end_of_day_posterior: endOfDayPosterior,
	};
}
