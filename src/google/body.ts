/**
 * Persist Google Health weigh-ins into the `body` table (#260).
 *
 * Google gives real, sparse, timestamped weigh-ins. The legacy Fitbit feed
 * gave a forward-filled daily series — which froze at 67.5 kg in Apr 2026 when
 * the Hume → Fitbit path died, hiding the true 64.7–68.3 range. So for the
 * window Google covers we REPLACE the stale Fitbit rows with the real
 * measurements: delete body rows on/after the earliest Google weigh-in, then
 * insert the deduped real values. Rows before that window (older Fitbit
 * history) are left untouched.
 */

import type * as mariadb from "mariadb";
import { fetchAllWeight, type WeightMeasurement } from "./health.js";
import { type GoogleCreds, googleAccessToken } from "./oauth.js";

/** Collapse to one weigh-in per local date, keeping the latest measurement. */
export function dedupeByDate(measurements: readonly WeightMeasurement[]): WeightMeasurement[] {
	const byDate = new Map<string, WeightMeasurement>();
	for (const m of measurements) {
		const cur = byDate.get(m.date);
		if (!cur || m.ts > cur.ts) byDate.set(m.date, m);
	}
	return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export interface WeightSyncResult {
	fetched: number;
	days: number;
	deletedStale: number;
	upserted: number;
	earliest: string | null;
	latest: string | null;
}

/**
 * Replace the body table's weight for the Google-covered window with the real
 * measurements. `apply=false` reports what it would do without writing.
 */
export async function syncGoogleWeight(
	conn: mariadb.Connection,
	userId: string,
	measurements: readonly WeightMeasurement[],
	apply: boolean,
): Promise<WeightSyncResult> {
	const deduped = dedupeByDate(measurements);
	const earliest = deduped[0]?.date ?? null;
	const latest = deduped[deduped.length - 1]?.date ?? null;

	let deletedStale = 0;
	let upserted = 0;

	if (apply && earliest !== null) {
		// Drop the stale forward-filled rows in the covered window first.
		const del = await conn.query("DELETE FROM body WHERE user_id = ? AND date >= ?", [userId, earliest]);
		deletedStale = Number((del as { affectedRows?: number }).affectedRows ?? 0);

		for (const m of deduped) {
			await conn.query(
				`INSERT INTO body (user_id, date, weight_kg) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE weight_kg = VALUES(weight_kg)`,
				[userId, m.date, m.kg],
			);
			upserted++;
		}
	}

	return {
		fetched: measurements.length,
		days: deduped.length,
		deletedStale,
		upserted,
		earliest,
		latest,
	};
}

/**
 * Full Google-weight sync round: mint an access token, fetch every weigh-in,
 * and reconcile the `body` table. Shared by the sync-google-weight CLI and the
 * health-sync cron (#260).
 */
export async function runGoogleWeightSync(
	conn: mariadb.Connection,
	creds: GoogleCreds,
	userId: string,
	apply: boolean,
): Promise<WeightSyncResult> {
	const token = await googleAccessToken(creds);
	const weight = await fetchAllWeight(token);
	return syncGoogleWeight(conn, userId, weight, apply);
}
