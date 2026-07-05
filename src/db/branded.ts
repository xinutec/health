/**
 * Branded types for DB ID columns where precision must be preserved.
 *
 * `bigint` is sufficient at runtime, but a bare `bigint` doesn't stop
 * a contributor from writing `Number(id)` or using an ID as a count.
 * Brand types make the cast explicit: assigning a `bigint` to a
 * `FitbitSleepLogId` only works through `asFitbitSleepLogId(...)`,
 * which serves as a deliberate barrier and a place to put a comment
 * about *why* the precision matters.
 *
 * Erasing the brand (e.g. via `Number(id as bigint)`) compiles too —
 * the goal isn't a hard enforcement, it's that the *easy* path is
 * the correct one and the lossy path requires deliberate code.
 */

/**
 * Fitbit's 64-bit sleep log id. Exceeds 2^53, so it cannot survive a
 * `Number` round-trip without rounding. Keep it as a branded bigint
 * everywhere it lives, including in DB query parameters.
 */
export type FitbitSleepLogId = bigint & { readonly __brand: "FitbitSleepLogId" };

/** Promote a raw bigint to a FitbitSleepLogId. The cast is here so
 *  ad-hoc `(x as FitbitSleepLogId)` casts can be grepped against. */
export function asFitbitSleepLogId(id: bigint): FitbitSleepLogId {
	return id as FitbitSleepLogId;
}
