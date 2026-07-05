/**
 * Backfill helpers for per-day intraday sync streams.
 *
 * Each Fitbit intraday data type (HR, steps, future: HRV, …) tracks its
 * own historical coverage independently. A stream is a small descriptor
 * that names the data type, knows how to fetch one day, optionally knows
 * how to skip days quickly, and an orchestrator (`sync.ts`) walks the
 * stream backwards day-by-day, persisting per-stream cursor and
 * completion state in `sync_state`.
 *
 * Why per-stream and not one shared cursor:
 *   - Adding a new stream (today: steps; tomorrow: HRV intraday) doesn't
 *     require rewinding everything else.
 *   - Each stream may have a different historical depth — Fitbit kept
 *     HR longer than steps for some users.
 *   - Completion is well-defined per type: HR-empty for 14 days doesn't
 *     mean steps are done, and vice versa.
 *
 * The two helpers below are the *day-level* primitives. The stream-level
 * orchestration (cursor, empty-day streak, completion flag) lives in
 * `sync.ts` because it needs the runtime FitbitClient + DB connection.
 *
 * Day-level: distinguish three outcomes:
 *   - "ok, this day really has no data" → advance the empty-day streak;
 *     after enough consecutive empty days the stream is marked complete.
 *   - "ok, this day has N>0 data points" → reset the streak.
 *   - "the call threw" → do NOT advance the streak. A transient Fitbit
 *     5xx, network blip, or auth-refresh hiccup is a retry opportunity,
 *     not evidence that the day is empty. Conflating the two used to
 *     silently truncate history after 14 consecutive failures.
 */

import { RateLimitExhaustedError } from "./fitbit/rate-limit.js";

export type BackfillDayResult = { ok: true; points: number } | { ok: false; error: unknown };

/**
 * Function shape for a single-day intraday sync. Whatever the caller binds
 * here (typically `syncHeartRateIntraday(client, conn, userId, d, d)` or
 * `syncStepsIntraday(client, conn, userId, d, d)`) must resolve to the
 * number of points written, or throw on transient failure.
 */
export type DaySyncFn = (date: string) => Promise<number>;

export async function backfillStreamDay(syncFn: DaySyncFn, date: string): Promise<BackfillDayResult> {
	try {
		const points = await syncFn(date);
		return { ok: true, points };
	} catch (error) {
		// Rate-limit exhaustion is "stop the run", not "this day failed":
		// re-throw so the caller bails out *before* advancing the cursor
		// past a day that was never actually fetched. Every other error is
		// a transient per-day failure the loop absorbs (cursor advances,
		// empty streak left untouched).
		if (error instanceof RateLimitExhaustedError) throw error;
		return { ok: false, error };
	}
}

export function shouldAdvanceEmptyStreak(result: BackfillDayResult): boolean {
	return result.ok && result.points === 0;
}

/**
 * Decrement a `YYYY-MM-DD` cursor by one day, refusing to go past `floor`.
 *
 * Returns `null` when:
 *   - input is not a parseable date in `YYYY-MM-DD` form
 *   - the previous day is `<= floor` (we treat `floor` as the earliest
 *     date the backfill should ever consider, exclusive)
 *
 * Backfill loops MUST stop when this returns null. Without the floor
 * guard, a skip-if-condition that always fires can walk the cursor
 * indefinitely backward, eventually crossing year 0 and producing
 * malformed strings like `-000026-02` (the bug we hit on pippijn's
 * steps backfill before this helper existed).
 */
export function prevDayBounded(date: string, floor: string): string | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
	const d = new Date(`${date}T00:00:00Z`);
	if (Number.isNaN(d.getTime())) return null;
	d.setUTCDate(d.getUTCDate() - 1);
	const prev = d.toISOString().slice(0, 10);
	if (prev <= floor) return null;
	return prev;
}

/**
 * Descriptor for a per-day backfillable stream. The orchestrator iterates
 * backwards from the stream's stored cursor, calling `sync(date)` on each
 * day (unless `skipIf` returns true) and using `shouldAdvanceEmptyStreak`
 * + `maxEmptyDays` to decide when the stream is complete.
 */
export interface IntradayStream {
	/** Stable name used for sync_state keys: `backfill_${name}_cursor` etc. */
	name: string;
	/** Fetch one day. Throws on transient failure (treated as "retry next time"). */
	sync: DaySyncFn;
	/** Optional: return true to skip this date without spending an API call.
	 *  Use this when another stream'\''s stored data implies this date is empty
	 *  (e.g. steps skips a date with no HR row → Fitbit was off that day). */
	skipIf?: (date: string) => Promise<boolean>;
	/** Consecutive empty days that mark the stream complete. Default 14. */
	maxEmptyDays?: number;
}

/**
 * Sort streams by cursor recency descending: a brand-new stream (cursor
 * absent → uses fallback, typically today) goes first, followed by the
 * stream whose cursor is most recently dated. Lets a newly-deployed
 * stream catch up to the rest of the fleet before the deeper-backfilling
 * streams resume — otherwise HR mid-2024-backfill could starve Steps for
 * many cron runs.
 *
 * Pure: the caller passes in already-resolved cursors as a map keyed by
 * `stream.name`. Stable: streams with the same effective cursor preserve
 * their input order.
 *
 * Date strings are compared lexicographically — works because the
 * format is YYYY-MM-DD throughout the codebase.
 */
export function sortStreamsByCursorRecency<T extends { name: string }>(
	streams: T[],
	cursors: Map<string, string>,
	fallback: string,
): T[] {
	return [...streams].sort((a, b) => {
		const ca = cursors.get(a.name) ?? fallback;
		const cb = cursors.get(b.name) ?? fallback;
		return cb.localeCompare(ca);
	});
}

/**
 * Compute the next OLDER fetch window `[start, end]` of `windowDays`
 * inclusive days, ending at `end`. The range-based daily-summary backfill
 * walks backward a window at a time — one Fitbit range call per step (the
 * HRV / breathing / SpO2 / temperature / body / HR-zone endpoints all accept
 * a date range), which is ~30× cheaper than the day-by-day intraday backfill.
 *
 * `start` is clamped UP to `floor`, so a window never reaches before the
 * earliest date the backfill should consider. Returns null when:
 *   - `windowDays` < 1
 *   - `end` is not a parseable `YYYY-MM-DD` date
 *   - `end` is at or before `floor` (nothing older left to fetch)
 *
 * Same guard discipline as `prevDayBounded`: callers MUST stop when this
 * returns null, so a loop bug can't walk the cursor into negative years.
 */
export function prevWindowBounded(
	end: string,
	windowDays: number,
	floor: string,
): { start: string; end: string } | null {
	if (windowDays < 1) return null;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
	const e = new Date(`${end}T00:00:00Z`);
	if (Number.isNaN(e.getTime())) return null;
	if (end <= floor) return null;
	const s = new Date(e);
	s.setUTCDate(s.getUTCDate() - (windowDays - 1));
	const start = s.toISOString().slice(0, 10);
	return { start: start < floor ? floor : start, end };
}

/**
 * Function shape for a date-range sync (one Fitbit range call). Whatever the
 * caller binds here — e.g. `(s, e) => syncHrv(client, conn, userId, s, e)` —
 * must resolve to the number of rows written across the range, or throw on
 * transient failure.
 */
export type RangeSyncFn = (startDate: string, endDate: string) => Promise<number>;

/**
 * Descriptor for a range-backfillable daily-summary stream. The orchestrator
 * walks backward one window at a time from the stream's stored cursor,
 * calling `sync(start, end)` and using the same empty-streak completion logic
 * as the intraday backfill — but counted in windows, not days.
 */
export interface RangeStream {
	/** Stable name used for sync_state keys: `backfill_${name}_cursor` etc. */
	name: string;
	/** Fetch one window. Throws on transient failure (retried next run). */
	sync: RangeSyncFn;
	/** Consecutive empty windows that mark the stream complete. Default 3. */
	maxEmptyWindows?: number;
}
