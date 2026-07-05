import type * as mariadb from "mariadb";
import { NULL_TZ_SOURCE, type TzSource } from "../../geo/fitbit-tz.js";
import { wallClockToUtcString } from "../../geo/timezone.js";
import type { FitbitClient } from "../client.js";

export interface HRResponse {
	"activities-heart": Array<{
		dateTime: string;
		value: { heartRateZones: Array<{ name: string; min: number; max: number; minutes: number; caloriesOut: number }> };
	}>;
	"activities-heart-intraday"?: { dataset: Array<{ time: string; value: number }> };
}

/**
 * Pure parser: take a Fitbit intraday-heart-rate response, return rows shaped
 * for `conn.batch(INSERT INTO heart_rate_intraday ...)`. The trailing slots
 * are the IANA tz the wall-clock was recorded in (see TIMEZONE.md) and the
 * derived UTC DATETIME (see docs/design/timezone.md);
 * `ts_utc` is null when `tz` is null.
 */
export function parseHRDataset(
	response: HRResponse,
	userId: string,
	date: string,
	tzSource: TzSource = NULL_TZ_SOURCE,
): Array<[string, string, number, string | null, string | null]> {
	const dataset = response["activities-heart-intraday"]?.dataset;
	if (!dataset?.length) return [];
	return dataset.map((d) => {
		const ts = `${date} ${d.time}`;
		const tz = tzSource.forWallClock(date, d.time);
		return [userId, ts, d.value, tz, wallClockToUtcString(ts, tz)];
	});
}

export async function syncHeartRateZones(
	client: FitbitClient,
	conn: mariadb.Connection,
	userId: string,
	startDate: string,
	endDate: string,
): Promise<number> {
	const data = await client.get<HRResponse>(`/1/user/-/activities/heart/date/${startDate}/${endDate}.json`);
	let synced = 0;

	for (const day of data["activities-heart"]) {
		for (const z of day.value.heartRateZones) {
			await conn.query(
				`INSERT INTO heart_rate_zones (user_id, date, zone_name, minutes, calories, min_bpm, max_bpm)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE
         minutes=VALUES(minutes), calories=VALUES(calories), min_bpm=VALUES(min_bpm), max_bpm=VALUES(max_bpm)`,
				[userId, day.dateTime, z.name, z.minutes, z.caloriesOut, z.min, z.max],
			);
		}
		synced++;
	}

	console.log(`[${userId}] Synced ${synced} days of HR zones`);
	return synced;
}

/**
 * Sync intraday heart rate for a date range.
 * The Fitbit API only allows 24h per request, so this loops day-by-day.
 * Respects rate limits — stops if remaining calls drop below 10.
 *
 * Forward sync passes a real `tzSource` derived from PhoneTrack + profile.tz.
 * Backward backfill leaves it at default (NULL_TZ_SOURCE), which writes
 * `tz=NULL` rows for the Phase 3 backfill CLI to fill in later.
 */
export async function syncHeartRateIntraday(
	client: FitbitClient,
	conn: mariadb.Connection,
	userId: string,
	startDate: string,
	endDate: string,
	tzSource: TzSource = NULL_TZ_SOURCE,
): Promise<number> {
	let totalSynced = 0;

	for (let d = new Date(startDate); d <= new Date(endDate); d.setDate(d.getDate() + 1)) {
		if (client.rateLimitRemaining <= 10) {
			console.log(`[${userId}] HR intraday paused, rate limit low`);
			break;
		}

		const date = d.toISOString().slice(0, 10);
		const data = await client.get<HRResponse>(`/1/user/-/activities/heart/date/${date}/1d/1sec.json`);
		const rows = parseHRDataset(data, userId, date, tzSource);
		if (rows.length === 0) continue;

		await conn.batch(
			// COALESCE-preserve `tz` and `ts_utc` so the backfill CLI can later
			// upgrade NULL → value but a normal re-sync doesn't overwrite a
			// known tz.
			`INSERT INTO heart_rate_intraday (user_id, ts, bpm, tz, ts_utc) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         bpm    = VALUES(bpm),
         tz     = COALESCE(tz, VALUES(tz)),
         ts_utc = COALESCE(ts_utc, VALUES(ts_utc))`,
			rows,
		);

		totalSynced += rows.length;
		console.log(`[${userId}] Synced ${rows.length} HR intraday points for ${date}`);
	}

	return totalSynced;
}
