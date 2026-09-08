// Would narrowing uniq_sleep_user_start_main to (user_id, start_time) collide?
//   Usage: scripts/prod-db.sh node scripts/probe-sleep-start-dupes.mjs
import { createConnection } from "mariadb";
const c = await createConnection({
	host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
	user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: "health",
});
const j = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? String(x) : x));
const dupes = await c.query(
	`SELECT user_id, start_time, COUNT(*) n, GROUP_CONCAT(is_main_sleep) mains
	   FROM sleep GROUP BY user_id, start_time HAVING n > 1 ORDER BY start_time DESC`);
console.log(`start instants carrying more than one row: ${dupes.length}`);
for (const r of dupes.slice(0, 20)) console.log("  ", j(r));
await c.end();
