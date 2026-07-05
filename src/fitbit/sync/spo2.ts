import type * as mariadb from "mariadb";
import type { FitbitClient } from "../client.js";

export async function syncSpO2Daily(
	client: FitbitClient,
	conn: mariadb.Connection,
	userId: string,
	startDate: string,
	endDate: string,
): Promise<number> {
	const data = await client.get<Array<{ dateTime: string; value: { avg: number; min: number; max: number } }>>(
		`/1/user/-/spo2/date/${startDate}/${endDate}.json`,
	);

	for (const e of data) {
		await conn.query(
			`INSERT INTO spo2_daily (user_id, date, avg_value, min_value, max_value) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE avg_value=VALUES(avg_value), min_value=VALUES(min_value), max_value=VALUES(max_value)`,
			[userId, e.dateTime, e.value.avg, e.value.min, e.value.max],
		);
	}

	console.log(`[${userId}] Synced ${data.length} days of SpO2`);
	return data.length;
}
