import type * as mariadb from "mariadb";
import type { FitbitClient } from "../client.js";

export async function syncTemperature(
	client: FitbitClient,
	conn: mariadb.Connection,
	userId: string,
	startDate: string,
	endDate: string,
): Promise<number> {
	const { tempSkin } = await client.get<{
		tempSkin: Array<{ dateTime: string; value: { nightlyRelative: number } }>;
	}>(`/1/user/-/temp/skin/date/${startDate}/${endDate}.json`);

	for (const e of tempSkin) {
		await conn.query(
			`INSERT INTO skin_temperature (user_id, date, relative_deviation) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE relative_deviation=VALUES(relative_deviation)`,
			[userId, e.dateTime, e.value.nightlyRelative],
		);
	}

	console.log(`[${userId}] Synced ${tempSkin.length} days of temperature`);
	return tempSkin.length;
}
