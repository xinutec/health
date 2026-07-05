import type * as mariadb from "mariadb";
import type { FitbitClient } from "../client.js";

export async function syncHrv(
	client: FitbitClient,
	conn: mariadb.Connection,
	userId: string,
	startDate: string,
	endDate: string,
): Promise<number> {
	const { hrv } = await client.get<{
		hrv: Array<{ dateTime: string; value: { dailyRmssd: number; deepRmssd: number } }>;
	}>(`/1/user/-/hrv/date/${startDate}/${endDate}.json`);

	for (const e of hrv) {
		await conn.query(
			`INSERT INTO hrv_daily (user_id, date, daily_rmssd, deep_rmssd) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE daily_rmssd=VALUES(daily_rmssd), deep_rmssd=VALUES(deep_rmssd)`,
			[userId, e.dateTime, e.value.dailyRmssd, e.value.deepRmssd],
		);
	}

	console.log(`[${userId}] Synced ${hrv.length} days of HRV`);
	return hrv.length;
}

/** Fitbit intraday-HRV response (`/hrv/date/{date}/all.json`): a 5-minute
 *  series of RMSSD plus the coverage fraction and HF/LF spectral power.
 *  `minute` is a full local-wall-clock ISO timestamp (no zone). */
export interface HrvIntradayResponse {
	hrv: Array<{
		dateTime: string;
		minutes: Array<{
			minute: string;
			value: { rmssd: number; coverage: number; hf: number; lf: number };
		}>;
	}>;
}

/**
 * Pure parser: flatten an intraday-HRV response into rows shaped for
 * `conn.batch(INSERT INTO hrv_intraday ...)`. The `minute` ISO string is
 * stored verbatim as a wall-clock `DATETIME` (`YYYY-MM-DD HH:MM:SS`),
 * mirroring how `heartrate.ts` keeps the raw Fitbit wall-clock as the
 * immutable source of truth.
 */
export function parseHrvIntraday(
	response: HrvIntradayResponse,
	userId: string,
): Array<[string, string, number, number, number, number]> {
	const rows: Array<[string, string, number, number, number, number]> = [];
	for (const day of response.hrv ?? []) {
		for (const m of day.minutes ?? []) {
			const ts = m.minute.replace("T", " ").slice(0, 19);
			rows.push([userId, ts, m.value.rmssd, m.value.coverage, m.value.hf, m.value.lf]);
		}
	}
	return rows;
}

/**
 * Sync intraday (5-minute) HRV for a date range. The Fitbit intraday
 * endpoint is single-date, so this loops day-by-day like
 * `syncHeartRateIntraday`, and stops if the rate limit runs low. A day with
 * no HRV (no main-sleep period) simply returns no rows.
 */
export async function syncHrvIntraday(
	client: FitbitClient,
	conn: mariadb.Connection,
	userId: string,
	startDate: string,
	endDate: string,
): Promise<number> {
	let totalSynced = 0;
	for (let d = new Date(startDate); d <= new Date(endDate); d.setDate(d.getDate() + 1)) {
		if (client.rateLimitRemaining <= 10) {
			console.log(`[${userId}] HRV intraday paused, rate limit low`);
			break;
		}
		const date = d.toISOString().slice(0, 10);
		const data = await client.get<HrvIntradayResponse>(`/1/user/-/hrv/date/${date}/all.json`);
		const rows = parseHrvIntraday(data, userId);
		if (rows.length === 0) continue;

		await conn.batch(
			`INSERT INTO hrv_intraday (user_id, ts, rmssd, coverage, hf, lf) VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         rmssd=VALUES(rmssd), coverage=VALUES(coverage), hf=VALUES(hf), lf=VALUES(lf)`,
			rows,
		);
		totalSynced += rows.length;
		console.log(`[${userId}] Synced ${rows.length} HRV intraday points for ${date}`);
	}
	return totalSynced;
}
