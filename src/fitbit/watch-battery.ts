/**
 * Watch (Fitbit device) battery trace for one day, read back from the
 * `device_battery_log` history table and shaped to match the phone-battery
 * `BatterySample[]` so the day-view chart can plot both on one axis.
 *
 * The history is sparse: Fitbit's devices endpoint reports only the CURRENT
 * level at each device sync, so there's one point per sync (a handful a day).
 */
import { db } from "../db/pool.js";
import { fitbitTsToUnix } from "../geo/timezone.js";
import type { BatterySample } from "../geo/velocity.js";

/** Fitbit's pseudo-name for phone-based step tracking — not a real wearable.
 *  It reports battery 0/Empty, so it must never appear on the watch series. */
const PHONE_PSEUDO_DEVICE = "MobileTrack";

/** Generous prefilter margin for the wall-clock DATETIME query: any tz offset
 *  is < 14 h, so ±1 day guarantees no in-window reading is missed before the
 *  exact epoch filter in `watchBatterySeries`. */
const QUERY_MARGIN_S = 86_400;

export interface WatchBatteryRow {
	lastSyncTime: string | Date;
	batteryLevel: number;
	deviceVersion: string | null;
}

/**
 * Reduce raw history rows to the watch series for one day: drop the phone
 * pseudo-tracker, convert each Fitbit wall-clock to epoch seconds in `tz`, keep
 * readings inside `[startUtc, endUtc)`, sort by time, and collapse runs of
 * equal level to their first reading (a flat step needs only its start point —
 * the same shaping the phone series gets server-side).
 */
export function watchBatterySeries(
	rows: readonly WatchBatteryRow[],
	tz: string,
	startUtc: number,
	endUtc: number,
): BatterySample[] {
	const inWindow: BatterySample[] = [];
	for (const r of rows) {
		if (r.deviceVersion === PHONE_PSEUDO_DEVICE) continue;
		const ts = fitbitTsToUnix(r.lastSyncTime, tz);
		if (!Number.isFinite(ts) || ts < startUtc || ts >= endUtc) continue;
		inWindow.push({ ts, level: r.batteryLevel });
	}
	inWindow.sort((a, b) => a.ts - b.ts);

	const series: BatterySample[] = [];
	for (const s of inWindow) {
		const prev = series[series.length - 1];
		// Two devices reporting at the same instant: keep the later row.
		if (prev && prev.ts === s.ts) {
			series[series.length - 1] = s;
			continue;
		}
		// Unchanged level: the step is already drawn from the previous point.
		if (prev && prev.level === s.level) continue;
		series.push(s);
	}
	return series;
}

/** Format an epoch instant as a `YYYY-MM-DD HH:MM:SS` (UTC) string for a
 *  MariaDB DATETIME comparison. */
function toSqlDatetime(unixS: number): string {
	return new Date(unixS * 1000).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Load the day's watch-battery readings for `userId`. `last_sync_time` is a
 * Fitbit wall-clock (no offset), so we prefilter the DATETIME with a ±1-day
 * margin and let `watchBatterySeries` do the exact epoch-window filtering.
 */
export async function loadWatchBattery(
	userId: string,
	tz: string,
	startUtc: number,
	endUtc: number,
): Promise<BatterySample[]> {
	const rows = await db()
		.selectFrom("device_battery_log")
		.select(["last_sync_time", "battery_level", "device_version"])
		.where("user_id", "=", userId)
		.where("last_sync_time", ">=", toSqlDatetime(startUtc - QUERY_MARGIN_S))
		.where("last_sync_time", "<", toSqlDatetime(endUtc + QUERY_MARGIN_S))
		.execute();
	return watchBatterySeries(
		rows.map((r) => ({
			lastSyncTime: r.last_sync_time,
			batteryLevel: r.battery_level,
			deviceVersion: r.device_version,
		})),
		tz,
		startUtc,
		endUtc,
	);
}
