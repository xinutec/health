/**
 * Diagnostic: compare the two resting-heart-rate values Fitbit exposes for
 * a date range —
 *   - `activities/date/{d}.json`        → summary.restingHeartRate   (what
 *     we currently store in daily_activity)
 *   - `activities/heart/date/{a}/{b}.json` → value.restingHeartRate  (what
 *     we already fetch for HR zones but discard; likely what the app shows)
 *
 * Use it to settle an app-vs-web-app RHR mismatch without changing prod:
 *   scripts/prod-db.sh node dist/cli/probe-rhr.js 2026-06-12 2026-06-16
 */

import { loadSyncConfig } from "../config.js";
import { destroyPool, initPool } from "../db/pool.js";
import { FitbitClient } from "../fitbit/client.js";

interface HeartRangeResponse {
	"activities-heart": Array<{ dateTime: string; value: { restingHeartRate?: number } }>;
}
interface ActivitySummaryResponse {
	summary: { restingHeartRate?: number };
}

const config = loadSyncConfig();
initPool(config.db);

const start = process.argv[2] ?? "2026-06-12";
const end = process.argv[3] ?? "2026-06-16";
const userId = process.argv[4] ?? "pippijn";

function eachDay(a: string, b: string): string[] {
	const out: string[] = [];
	for (let d = new Date(a); d <= new Date(b); d.setDate(d.getDate() + 1)) out.push(d.toISOString().slice(0, 10));
	return out;
}

try {
	const client = new FitbitClient(userId, {
		clientId: config.fitbit.clientId,
		clientSecret: config.fitbit.clientSecret,
	});

	const heart = await client.get<HeartRangeResponse>(`/1/user/-/activities/heart/date/${start}/${end}.json`);
	const heartRhr = new Map<string, number | undefined>();
	for (const d of heart["activities-heart"]) heartRhr.set(d.dateTime, d.value.restingHeartRate);

	console.log(`date        activities/heart   activities/date(summary)`);
	for (const date of eachDay(start, end)) {
		const summary = await client.get<ActivitySummaryResponse>(`/1/user/-/activities/date/${date}.json`);
		const h = heartRhr.get(date);
		const s = summary.summary.restingHeartRate;
		console.log(`${date}  ${String(h ?? "—").padStart(10)}   ${String(s ?? "—").padStart(18)}`);
	}
} finally {
	await destroyPool();
}
