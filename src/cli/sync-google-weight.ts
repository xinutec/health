/**
 * Sync weight from the Google Health API into the `body` table (#260).
 *
 * Dry-run by default — prints what it would change. Pass `--apply` to write.
 *
 * Usage:
 *   GH_CLIENT_ID / GH_CLIENT_SECRET / GH_REFRESH_TOKEN  (Google OAuth)
 *   DB_* via prod-db.sh
 *   node dist/cli/sync-google-weight.js [user] [--apply]
 */
import { z } from "zod";
import { initPool, withConnection } from "../db/pool.js";
import { runGoogleWeightSync } from "../google/body.js";
import { googleCredsFromEnv } from "../google/oauth.js";

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

const creds = googleCredsFromEnv();
if (!creds) {
	console.error("Set GH_CLIENT_ID / GH_CLIENT_SECRET / GH_REFRESH_TOKEN.");
	process.exit(2);
}

const userId =
	process.argv.find((a) => !a.startsWith("-") && a !== process.argv[0] && a !== process.argv[1]) ?? "pippijn";
const apply = process.argv.includes("--apply");

const result = await withConnection((conn) => runGoogleWeightSync(conn, creds, userId, apply));

console.log(`Google Health weight for ${userId}:`);
console.log(`  fetched ${result.fetched} data points → ${result.days} distinct days`);
console.log(`  range: ${result.earliest} → ${result.latest}`);
if (apply) {
	console.log(
		`  APPLIED: deleted ${result.deletedStale} stale rows (>= ${result.earliest}), upserted ${result.upserted} real weigh-ins`,
	);
} else {
	console.log(
		`  DRY RUN — would delete stale body rows >= ${result.earliest} and insert ${result.days} real weigh-ins.`,
	);
	console.log("  Re-run with --apply to write.");
}
process.exit(0);
