// Invariant: sleep.date must be the civil date the sleep ENDED.
//   Usage: scripts/prod-db.sh node scripts/probe-sleep-date-invariant.mjs
//
// Both writers derive `date` from `end_time` but omit it from their
// ON DUPLICATE KEY UPDATE list, so a night first written while still in
// progress keeps the start day's date after the end is revised across midnight.
import { createConnection } from "mariadb";
const c = await createConnection({
	host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
	user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: "health",
});
const j = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? String(x) : x));
const [tot] = await c.query("SELECT COUNT(*) n FROM sleep");
const [bad] = await c.query("SELECT COUNT(*) n FROM sleep WHERE DATE(end_time) <> date");
console.log(`sleep rows: ${j(tot.n)}   date <> DATE(end_time): ${j(bad.n)}`);
console.log("\nviolations (most recent 20):");
for (const r of await c.query(
	`SELECT user_id, date, start_time, end_time, is_main_sleep, tz, minutes_asleep
	   FROM sleep WHERE DATE(end_time) <> date ORDER BY end_time DESC LIMIT 20`,
)) console.log("  ", j(r));
await c.end();
