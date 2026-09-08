// Every sleep row whose start_time falls in a window — the raw table, no filtering.
//   Usage: scripts/prod-db.sh node scripts/probe-sleep-window-rows.mjs 2026-09-06 2026-09-09
//
// Written to settle whether a night that looks mis-dated has a SECOND, correct
// row beside it (the unique key includes is_main_sleep, so a revision that flips
// that flag inserts rather than updates) or whether the bad row is the only one.
import { createConnection } from "mariadb";
const [, , from, to] = process.argv;
const c = await createConnection({
	host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
	user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: "health",
});
const rows = await c.query(
	`SELECT log_id, date, start_time, end_time, minutes_asleep, efficiency, is_main_sleep, tz
	   FROM sleep WHERE user_id='pippijn' AND start_time >= ? AND start_time < ?
	  ORDER BY start_time`, [from, to]);
for (const r of rows) console.log(" ", JSON.stringify(r, (_k, x) => (typeof x === "bigint" ? String(x) : x)));
console.log(`(${rows.length} rows)`);
await c.end();
