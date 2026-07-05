/** One-off probe: hit the Fitbit weight endpoints directly to see whether the
 *  account actually has weigh-ins (vs an empty `body` table from a silent sync
 *  failure). Distinguishes data / no-data / scope-or-token error. */
import { z } from "zod";
import { initPool } from "../db/pool.js";
import { FitbitClient } from "../fitbit/client.js";

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
const endDate = process.argv[3] ?? "2026-06-19";
const client = new FitbitClient(userId, { clientId, clientSecret });

try {
	const ts = await client.get<{ "body-weight": Array<{ dateTime: string; value: string }> }>(
		`/1/user/-/body/weight/date/${endDate}/max.json`,
	);
	const series = ts["body-weight"] ?? [];
	console.log(`weight time-series (max): ${series.length} points`);
	if (series.length > 0) {
		console.log("  first:", series[0]);
		console.log("  last :", series[series.length - 1]);
	}
} catch (e) {
	console.error("weight time-series ERROR:", e instanceof Error ? e.message : e);
}

try {
	const log = await client.get<{ weight: Array<{ date: string; weight: number; bmi: number; source?: string }> }>(
		`/1/user/-/body/log/weight/date/${endDate}/1m.json`,
	);
	console.log(`weight log (last month): ${log.weight?.length ?? 0} entries`);
	for (const e of log.weight ?? []) console.log("  ", e);
} catch (e) {
	console.error("weight log ERROR:", e instanceof Error ? e.message : e);
}
process.exit(0);
