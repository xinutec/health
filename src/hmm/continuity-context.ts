/**
 * Load the prior-day end-of-day continuity context for a decode.
 *
 * Reads the previous day's `presence_log` row (where the user ended the
 * day, and how long ago that fix was) so the decoder can seed the start
 * of `date` with "still at the last place" pressure — Phase 3 of
 * `docs/proposals/2026-06-presence-continuity.md`. Returns null at a
 * chain start or when the prior row is absent / incomplete.
 *
 * Shared by the production decode-day CLI and the HSMM fixture-capture
 * CLI so both seed the decoder identically. The flag gate
 * (`useContinuityContinuation`) stays at the call site.
 */

import { db as kyselyDb } from "../db/pool.js";
import type { ContinuityContext } from "./factors/presence-continuity.js";

export async function loadContinuityContext(userId: string, date: string): Promise<ContinuityContext | null> {
	const priorDate = new Date(`${date}T00:00:00Z`);
	priorDate.setUTCDate(priorDate.getUTCDate() - 1);
	const priorDateStr = priorDate.toISOString().slice(0, 10);
	const row = await kyselyDb()
		.selectFrom("presence_log")
		.where("user_id", "=", userId)
		.where("date", "=", priorDateStr)
		.select(["end_of_day_place_id", "end_of_day_ts", "end_of_day_posterior"])
		.executeTakeFirst();
	if (row === undefined || row.end_of_day_place_id === null || row.end_of_day_ts === null) {
		return null;
	}
	const todayStart = new Date(`${date}T00:00:00Z`).getTime();
	const lastFixMs = row.end_of_day_ts.getTime();
	const hoursSinceLastConfirmedFix = Math.max(0, (todayStart - lastFixMs) / 3600_000);
	const placeRow = await kyselyDb()
		.selectFrom("focus_places")
		.where("id", "=", row.end_of_day_place_id)
		.select(["centroid_lat", "centroid_lon"])
		.executeTakeFirst();
	const priorPlaceCoord = placeRow === undefined ? null : { lat: placeRow.centroid_lat, lon: placeRow.centroid_lon };
	return {
		priorPlaceId: row.end_of_day_place_id,
		priorPlaceCoord,
		hoursSinceLastConfirmedFix,
		priorPosterior: row.end_of_day_posterior,
	};
}
