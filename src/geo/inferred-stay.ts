import type { DayState } from "../sleep/day-state.js";

/**
 * Cross-day continuity for fully-unobserved days.
 *
 * A day with no GPS/biometric data is not necessarily an *unknown* day —
 * if you ended the previous day at place X and the next day's dominant
 * place is also X, you were at X the whole time in between. Confidence
 * comes from how *constrained* the day is (bracketed on both sides by the
 * same place), not from how much data it has: a static hospital day needs
 * almost no data to be certain, where a day full of movement needs a lot.
 *
 * This is the surfaced, first-class form of the HSMM's continuity prior:
 * instead of the inference living only inside the decode (and the day
 * showing blank), it becomes a visible — if honestly caveated — stay.
 */

/**
 * The place a no-data day should be attributed to, or null when it isn't
 * bracketed by the same place on both sides (then the day is genuinely
 * unknown, not inferable).
 *
 * @param prevEndOfDayPlaceId  where the previous day ended
 * @param nextDominantPlaceId  the next day's dominant place
 */
export function bracketedStayPlaceId(
	prevEndOfDayPlaceId: number | null,
	nextDominantPlaceId: number | null,
): number | null {
	if (prevEndOfDayPlaceId === null || nextDominantPlaceId === null) return null;
	return prevEndOfDayPlaceId === nextDominantPlaceId ? prevEndOfDayPlaceId : null;
}

/**
 * Build the single inferred DayState that spans a no-data day, once the
 * bracketing place has been resolved to a name. Pure — the caller does
 * the DB / OSM resolution and supplies the resolved `place`, `tz`, and
 * the day's local bounds.
 */
export function buildInferredStayState(opts: {
	place: string;
	tz: string | null;
	startTs: number;
	endTs: number;
}): DayState {
	return {
		startTs: opts.startTs,
		endTs: opts.endTs,
		mode: "stationary",
		place: opts.place,
		inferred: true,
		...(opts.tz ? { tz: opts.tz } : {}),
	};
}
