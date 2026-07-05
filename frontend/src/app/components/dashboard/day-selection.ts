import type { ActivityDay, SleepLog } from "../../services/health.service";

/**
 * Pick the entry belonging to `date` out of a rolling window of days.
 *
 * The activity / sleep endpoints return the last N days in one payload;
 * the dashboard shows exactly the selected day — never a silent fallback
 * to "the latest". An absent entry yields `null` so the card renders
 * empty, which is the correct state when a day hasn't synced yet.
 *
 * `date` is a `YYYY-MM-DD` string; the API's `date` field may carry a
 * time/zone suffix (a serialised DATE column), so we match by prefix.
 */
export function selectDayActivity(activity: readonly ActivityDay[], date: string): ActivityDay | null {
	return activity.find((a) => a.date.startsWith(date)) ?? null;
}

/**
 * The day's main sleep, or `null`. Naps (`is_main_sleep === false`) are
 * never promoted to the summary card — only the night's main sleep
 * counts, so a day with just a nap logged shows no sleep yet.
 */
export function selectDayMainSleep(sleep: readonly SleepLog[], date: string): SleepLog | null {
	return sleep.find((s) => s.is_main_sleep && s.date.startsWith(date)) ?? null;
}
