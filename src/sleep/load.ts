/**
 * Sleep loaders for the DayState pipeline.
 *
 * Two responsibilities:
 *   - `loadDaySleepWindows(userId, date)` — DB-touching query that
 *     fetches the main sleep records bracketing a given day.
 *   - Pure helpers (`derivePlaceForSleep`, `nextDateString`) used
 *     by the loader and by callers to enrich raw windows with a
 *     place from the segments pipeline.
 */

import { db } from "../db/pool.js";
import { fitbitTsToUnix } from "../geo/timezone.js";
import type { EnrichedSegment } from "../geo/velocity.js";
import type { SleepWindow } from "./day-state.js";

/** Next-day calendar date. Uses UTC arithmetic — dates are
 *  calendar concepts, not moment concepts. */
export function nextDateString(date: string): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + 1);
	return d.toISOString().slice(0, 10);
}

/** A raw sleep window pulled from the DB before being enriched
 *  with a `place` from the segments pipeline. The shape matches
 *  `SleepWindow` but `place` is omitted — it's derived later. */
export interface RawSleepWindow {
	startTs: number;
	endTs: number;
	tz: string | null;
	minutesAsleep: number;
}

/** Max time gap (seconds) between a sleep window and the nearest
 *  stationary segment we'll still trust as the sleep location.
 *  Six hours covers the common case where the user wakes at 08:00
 *  but doesn't get a GPS fix until ~midday (phone idle at home):
 *  the noon segment's place is a defensible answer for the sleep.
 *  Beyond six hours, fall through to null — the user may well have
 *  gone somewhere between waking and the next fix, and we don't
 *  want to paint sleep onto an unrelated place. */
const PLACE_FALLBACK_MAX_GAP_SEC = 6 * 3600;

/** Which side of the sleep window a candidate stay sits on, relative to
 *  the act of sleeping. A stay that overlaps the window is the strongest
 *  evidence (you were there as sleep began or ended). */
type SleepSide = "overlap" | "bedtime" | "wake";

/** Tier priority: smaller wins. The ordering encodes the causal model of
 *  sleep below — overlap is direct evidence, the bedtime side is where you
 *  lay down, the wake side is only where you were found afterwards. */
const SIDE_RANK: Record<SleepSide, number> = { overlap: 0, bedtime: 1, wake: 2 };

/**
 * Pick the place attribute of a stationary segment to represent where the
 * sleep happened.
 *
 * The causal model: **you fall asleep where you are at bedtime, and you do
 * not relocate while asleep** — so the sleep location is anchored at sleep
 * *onset* (the bedtime side), and the wake side only confirms it. A stay is
 * ranked first by which side of the window it sits on:
 *
 *   - `overlap` — the stay spans into the window; you were there as sleep
 *     began or ended. Strongest (covers the inpatient case: the hospital
 *     admission stay that runs up to and through bedtime).
 *   - `bedtime` — the stay ends before sleep onset; that is where you lay
 *     down.
 *   - `wake` — the stay starts after wake. Weakest: on a "walked straight
 *     out of home" morning (2026-06-24), the first stationary place after
 *     waking is where you went *to* (a hospital you visited), not where you
 *     slept. A bedtime-side home — even one farther in *time* — must beat it.
 *
 * Within a side, the smallest time gap wins. This replaces the old pure
 * nearest-gap rule, which grabbed the wake-side hospital over a bedtime-side
 * home simply because the hospital was nearer in time. It is *continuity*,
 * not a residential bias: the same rule keeps the inpatient nights at the
 * hospital (their bedtime side IS the hospital) without ever preferring a
 * residence by type.
 *
 * Returns null when no in-range stationary segment carries a place (the
 * sleep was entirely inside moving segments, or no candidate has a place).
 * Pure — the segments pipeline produces the candidates; this only consults
 * them.
 */
export function derivePlaceForSleep(
	window: { startTs: number; endTs: number },
	segments: readonly EnrichedSegment[],
): string | null {
	let best: { place: string; side: SleepSide; gap: number } | null = null;
	for (const s of segments) {
		if ((s.refinedMode ?? s.mode) !== "stationary") continue;
		if (s.place === undefined) continue;
		let side: SleepSide;
		let gap: number;
		if (s.startTs > window.endTs) {
			side = "wake"; // starts after wake
			gap = s.startTs - window.endTs;
		} else if (window.startTs > s.endTs) {
			side = "bedtime"; // ends before sleep onset
			gap = window.startTs - s.endTs;
		} else {
			side = "overlap";
			gap = 0;
		}
		if (gap > PLACE_FALLBACK_MAX_GAP_SEC) continue;
		const better =
			!best || SIDE_RANK[side] < SIDE_RANK[best.side] || (SIDE_RANK[side] === SIDE_RANK[best.side] && gap < best.gap);
		if (better) best = { place: s.place, side, gap };
	}
	return best?.place ?? null;
}

/**
 * Fetch the two main sleep records that touch `date` for `userId`:
 *
 *   - The sleep whose `date` column equals `date` — i.e. the
 *     overnight sleep that ENDED on this day. Provides the morning
 *     wake-up event.
 *   - The sleep whose `date` column equals the next day — i.e.
 *     this evening's bedtime, which ends tomorrow. Provides the
 *     evening fall-asleep event.
 *
 *  Returns 0–2 raw windows. The `tz` column populated by Phase 2
 *  of the per-row-tz convention disambiguates the local DATETIME
 *  values into unix seconds.
 */
export async function loadDaySleepWindows(userId: string, date: string): Promise<RawSleepWindow[]> {
	const morning = await db()
		.selectFrom("sleep")
		.select(["start_time", "end_time", "tz", "minutes_asleep"])
		.where("user_id", "=", userId)
		.where("date", "=", date)
		.where("is_main_sleep", "=", true as never)
		.executeTakeFirst();
	const evening = await db()
		.selectFrom("sleep")
		.select(["start_time", "end_time", "tz", "minutes_asleep"])
		.where("user_id", "=", userId)
		.where("date", "=", nextDateString(date))
		.where("is_main_sleep", "=", true as never)
		.executeTakeFirst();

	const out: RawSleepWindow[] = [];
	for (const row of [morning, evening]) {
		if (!row) continue;
		const tz = row.tz;
		out.push({
			startTs: fitbitTsToUnix(row.start_time, tz ?? undefined),
			endTs: fitbitTsToUnix(row.end_time, tz ?? undefined),
			tz,
			minutesAsleep: row.minutes_asleep ?? 0,
		});
	}
	return out;
}

/** Enrich raw sleep windows with `place` from segments and produce
 *  the full `SleepWindow` shape the day-state converter expects. */
export function enrichSleepWindows(
	raw: readonly RawSleepWindow[],
	segments: readonly EnrichedSegment[],
): SleepWindow[] {
	return raw.map((w) => ({
		startTs: w.startTs,
		endTs: w.endTs,
		tz: w.tz,
		minutesAsleep: w.minutesAsleep,
		place: derivePlaceForSleep(w, segments),
	}));
}
