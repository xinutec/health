/**
 * Phase B of the UTC three-tier migration. Walks rows in the four
 * Fitbit biometric tables where `ts_utc IS NULL AND tz IS NOT NULL`
 * and fills `ts_utc` via MariaDB's `CONVERT_TZ(ts, tz, 'UTC')`.
 *
 * Also tags `tz_source = 'legacy'` so a future recompute CLI can
 * target historical rows for re-resolution if better tz inference
 * lands. See `docs/design/timezone.md`.
 *
 * Idempotent. Pure SQL — no PhoneTrack / Nextcloud / Fitbit calls.
 * Safe to re-run. Stops when no rows remain to update.
 *
 * Usage:
 *   node dist/cli/backfill-utc.js              # all four tables
 *   node dist/cli/backfill-utc.js heart_rate_intraday  # one table
 */

import { z } from "zod";
import { destroyPool, initPool, withConnection } from "../db/pool.js";

const config = z
	.object({
		db: z.object({
			host: z.string().default("health-db"),
			port: z.coerce.number().default(3306),
			user: z.string(),
			password: z.string(),
			database: z.string().default("health"),
		}),
	})
	.parse({
		db: {
			host: process.env.DB_HOST,
			port: process.env.DB_PORT,
			user: process.env.DB_USER,
			password: process.env.DB_PASSWORD,
			database: process.env.DB_NAME,
		},
	});

initPool(config.db);

const BATCH_SIZE = 100_000;

type IntradayTable = "heart_rate_intraday" | "steps_intraday" | "sleep_stages";

async function backfillIntraday(table: IntradayTable): Promise<void> {
	let totalUpdated = 0;
	while (true) {
		const result = await withConnection(async (conn) => {
			return (await conn.query(
				`UPDATE ${table}
         SET ts_utc = CONVERT_TZ(ts, tz, 'UTC'),
             tz_source = COALESCE(tz_source, 'legacy')
         WHERE ts_utc IS NULL
           AND tz IS NOT NULL
         LIMIT ${BATCH_SIZE}`,
			)) as { affectedRows: number };
		});
		const n = result.affectedRows ?? 0;
		totalUpdated += n;
		console.log(`[${table}] batch updated ${n} rows (total ${totalUpdated})`);
		if (n === 0) break;
	}
	console.log(`[${table}] backfill done: ${totalUpdated} rows`);
}

async function backfillSleep(): Promise<void> {
	let totalUpdated = 0;
	while (true) {
		const result = await withConnection(async (conn) => {
			return (await conn.query(
				`UPDATE sleep
         SET start_time_utc = CONVERT_TZ(start_time, tz, 'UTC'),
             end_time_utc   = CONVERT_TZ(end_time,   tz, 'UTC'),
             tz_source = COALESCE(tz_source, 'legacy')
         WHERE (start_time_utc IS NULL OR end_time_utc IS NULL)
           AND tz IS NOT NULL
         LIMIT ${BATCH_SIZE}`,
			)) as { affectedRows: number };
		});
		const n = result.affectedRows ?? 0;
		totalUpdated += n;
		console.log(`[sleep] batch updated ${n} rows (total ${totalUpdated})`);
		if (n === 0) break;
	}
	console.log(`[sleep] backfill done: ${totalUpdated} rows`);
}

const targetArg = process.argv[2];
const intradayTables: IntradayTable[] = ["heart_rate_intraday", "steps_intraday", "sleep_stages"];

if (targetArg === undefined) {
	for (const table of intradayTables) {
		await backfillIntraday(table);
	}
	await backfillSleep();
} else if (intradayTables.includes(targetArg as IntradayTable)) {
	await backfillIntraday(targetArg as IntradayTable);
} else if (targetArg === "sleep") {
	await backfillSleep();
} else {
	console.error(`Unknown table: ${targetArg}`);
	console.error("Valid targets: heart_rate_intraday, steps_intraday, sleep_stages, sleep");
	await destroyPool();
	process.exit(1);
}

await destroyPool();
process.exit(0);
