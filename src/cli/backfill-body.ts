/**
 * One-off backfill: pull a user's full weight / BMI / body-fat history from
 * Fitbit's body time-series into the `body` table. The nightly sync now reads
 * the same endpoint; this seeds the years that predate the fix.
 *
 * Usage: node dist/cli/backfill-body.js <user> <startDate> [endDate]
 *   FITBIT_CLIENT_ID / FITBIT_CLIENT_SECRET must be set; DB_* via prod-db.sh.
 */
import { z } from "zod";
import { initPool, withConnection } from "../db/pool.js";
import { FitbitClient } from "../fitbit/client.js";
import { syncBody } from "../fitbit/sync/body.js";

const dbCfg = z
	.object({
		host: z.string().default("health-db"),
		port: z.coerce.number().default(3306),
		user: z.string(),
		password: z.string(),
		database: z.string().default("health"),
	})
	.parse({
		host: process.env.DB_HOST,
		port: process.env.DB_PORT,
		user: process.env.DB_USER,
		password: process.env.DB_PASSWORD,
		database: process.env.DB_NAME,
	});
initPool(dbCfg);

const clientId = process.env.FITBIT_CLIENT_ID;
const clientSecret = process.env.FITBIT_CLIENT_SECRET;
if (!clientId || !clientSecret) {
	console.error("FITBIT_CLIENT_ID / FITBIT_CLIENT_SECRET not set");
	process.exit(2);
}

const userId = process.argv[2] ?? "pippijn";
const startDate = process.argv[3];
const endDate = process.argv[4] ?? new Date().toISOString().slice(0, 10);
if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
	console.error("usage: backfill-body <user> <startDate YYYY-MM-DD> [endDate]");
	process.exit(2);
}

const DAY = 86_400_000;
const WINDOW_DAYS = 30; // Fitbit body time-series date-range cap is ~31 days.
const client = new FitbitClient(userId, { clientId, clientSecret });

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const endMs = new Date(endDate).getTime();
let total = 0;

await withConnection(async (conn) => {
	let cursor = new Date(startDate).getTime();
	while (cursor <= endMs) {
		const windowEnd = Math.min(cursor + (WINDOW_DAYS - 1) * DAY, endMs);
		total += await syncBody(client, conn, userId, iso(cursor), iso(windowEnd));
		cursor = windowEnd + DAY;
	}
});

console.log(`backfilled ${total} body rows for ${userId} (${startDate}..${endDate})`);
process.exit(0);
