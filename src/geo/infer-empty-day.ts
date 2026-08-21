import { db } from "../db/pool.js";
import type { EmptyDayBracket } from "./classification-inputs.js";
import { bracketedStayPlaceId } from "./inferred-stay.js";

function shiftDay(date: string, days: number): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

/**
 * Load the cross-day bracket for the empty-day inference — the bounded
 * DB reads that belong on the loader side of the classification-input
 * boundary (deterministic-fixtures proposal). Reads the prior day's
 * end-of-day place and the next day's dominant place from
 * `presence_log`; when they agree (`bracketedStayPlaceId`), resolves
 * that focus place's centroid.
 *
 * Returns `null` when the day isn't bracketed by the same place on both
 * sides (then it is genuinely unknown) or the place row is missing.
 *
 * ⚠ THE INFERENCE ITSELF IS NO LONGER HERE. `inferEmptyDayStatesFromBracket`
 * lived beside this and was deleted 2026-08-21: `1128b8e` removed its only
 * caller when the TS cascade went, and the decision moved to Lean
 * (`Verified.Geo.DayChain.inferredEmptyDay`, pinned by five `#guard`s including
 * an observed-day control). This function is the DB read that feeds it, and the
 * centroid now crosses the wire as `env.bracketPlace` (#1055).
 */
export async function loadEmptyDayBracket(userId: string, date: string): Promise<EmptyDayBracket | null> {
	const [prev, next] = await Promise.all([
		db()
			.selectFrom("presence_log")
			.where("user_id", "=", userId)
			.where("date", "=", shiftDay(date, -1))
			.select(["end_of_day_place_id"])
			.executeTakeFirst(),
		db()
			.selectFrom("presence_log")
			.where("user_id", "=", userId)
			.where("date", "=", shiftDay(date, +1))
			.select(["dominant_place_id"])
			.executeTakeFirst(),
	]);

	const placeId = bracketedStayPlaceId(prev?.end_of_day_place_id ?? null, next?.dominant_place_id ?? null);
	if (placeId === null) return null;

	const fp = await db()
		.selectFrom("focus_places")
		.where("id", "=", placeId)
		.select(["centroid_lat", "centroid_lon"])
		.executeTakeFirst();
	if (fp === undefined) return null;

	return { centroidLat: Number(fp.centroid_lat), centroidLon: Number(fp.centroid_lon) };
}
