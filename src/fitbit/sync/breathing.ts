import type * as mariadb from "mariadb";
import type { FitbitClient } from "../client.js";

export async function syncBreathingRate(
	client: FitbitClient,
	conn: mariadb.Connection,
	userId: string,
	startDate: string,
	endDate: string,
): Promise<number> {
	const { br } = await client.get<{
		br: Array<{
			dateTime: string;
			value: {
				breathingRate: number;
				fullSleepSummary?: { breathingRate: number };
				deepSleepSummary?: { breathingRate: number };
				lightSleepSummary?: { breathingRate: number };
				remSleepSummary?: { breathingRate: number };
			};
		}>;
	}>(`/1/user/-/br/date/${startDate}/${endDate}.json`);

	for (const e of br) {
		const v = e.value;
		await conn.query(
			`INSERT INTO breathing_rate (user_id, date, full_sleep_rate, deep_sleep_rate, light_sleep_rate, rem_sleep_rate)
       VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE
       full_sleep_rate=VALUES(full_sleep_rate), deep_sleep_rate=VALUES(deep_sleep_rate),
       light_sleep_rate=VALUES(light_sleep_rate), rem_sleep_rate=VALUES(rem_sleep_rate)`,
			[
				userId,
				e.dateTime,
				v.fullSleepSummary?.breathingRate ?? v.breathingRate,
				v.deepSleepSummary?.breathingRate ?? null,
				v.lightSleepSummary?.breathingRate ?? null,
				v.remSleepSummary?.breathingRate ?? null,
			],
		);
	}

	console.log(`[${userId}] Synced ${br.length} days of breathing rate`);
	return br.length;
}
