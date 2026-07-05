import { db } from "../db/pool.js";
import type { DayState } from "../sleep/day-state.js";
import type { EmptyDayBracket } from "./classification-inputs.js";
import { bracketedStayPlaceId, buildInferredStayState } from "./inferred-stay.js";
import { bestPlace, placeLabel } from "./osm.js";
import type { OsmAdapter } from "./osm-adapter.js";
import { dateBoundsUtc } from "./timezone.js";

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
 * sides (then it is genuinely unknown) or the place row is missing. The
 * pure inference (`inferEmptyDayStatesFromBracket`) consumes the centroid
 * and names it through the OSM adapter — no DB.
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

/**
 * Infer the "your day" for a day with no observed data, from a
 * pre-resolved cross-day bracket.
 *
 * A no-data day is not automatically *unknown*: if the previous day
 * ended at place X and the next day's dominant place is also X, the user
 * was at X the whole time in between (the classic multi-day hospital
 * stay). Confidence comes from the day being fully *constrained* on both
 * sides, not from data volume — so this surfaces one stationary stay
 * spanning the local day, named from the bracket's centroid via the OSM
 * adapter, and flagged `inferred: true` so the UI marks it "no data".
 *
 * Returns `[]` when there is no bracket (the day stays blank) or the
 * centroid can't be named. Pure of DB — the bounded reads happen in
 * `loadEmptyDayBracket` on the loader side.
 */
export async function inferEmptyDayStatesFromBracket(
	bracket: EmptyDayBracket | null,
	date: string,
	tz: string | undefined,
	osm: OsmAdapter,
): Promise<DayState[]> {
	if (bracket === null) return [];

	const place = await bestPlace(osm, bracket.centroidLat, bracket.centroidLon, { preferResidential: false });
	if (place === null) return [];

	const bounds = dateBoundsUtc(date, tz);
	return [
		buildInferredStayState({
			place: placeLabel(place),
			tz: tz ?? null,
			startTs: bounds.startUtc,
			endTs: bounds.endUtc,
		}),
	];
}
