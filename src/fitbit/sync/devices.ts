import type * as mariadb from "mariadb";
import type { FitbitDevice } from "../../types.js";
import type { FitbitClient } from "../client.js";

export async function syncDevices(client: FitbitClient, conn: mariadb.Connection, userId: string): Promise<number> {
	const devices = await client.get<FitbitDevice[]>(`/1/user/-/devices.json`);

	for (const d of devices) {
		const level = typeof d.batteryLevel === "number" ? d.batteryLevel : null;
		await conn.query(
			`INSERT INTO devices (user_id, device_id, device_version, type, battery, battery_level, last_sync_time)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE
       device_version=VALUES(device_version), type=VALUES(type),
       battery=VALUES(battery), battery_level=VALUES(battery_level), last_sync_time=VALUES(last_sync_time)`,
			[userId, d.id, d.deviceVersion, d.type, d.battery, level, d.lastSyncTime],
		);

		// Append this sync's reading to the watch-battery history. Keyed by
		// last_sync_time so re-syncing the same reading is idempotent and a
		// genuinely new sync adds one point. Only logged when Fitbit gave a
		// numeric level and a sync time (older devices / responses omit both).
		if (level !== null && d.lastSyncTime) {
			await conn.query(
				`INSERT INTO device_battery_log (user_id, device_id, last_sync_time, battery_level, device_version)
         VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE battery_level=VALUES(battery_level)`,
				[userId, d.id, d.lastSyncTime, level, d.deviceVersion],
			);
		}
	}

	console.log(`[${userId}] Synced ${devices.length} devices`);
	return devices.length;
}
