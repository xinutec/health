// When did the sleep table stop recording a timezone?
//   Usage: scripts/prod-db.sh node scripts/probe-sleep-tz-gap.mjs
import { createConnection } from "mariadb";
const c = await createConnection({
	host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
	user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: "health",
});
const j = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? String(x) : x));
console.log("last row WITH a tz:");
console.log(" ", j((await c.query(
  "SELECT date, tz, tz_source FROM sleep WHERE user_id='pippijn' AND tz IS NOT NULL ORDER BY date DESC LIMIT 1"))[0]));
console.log("first row WITHOUT a tz, after that:");
console.log(" ", j((await c.query(
  "SELECT date, tz, tz_source FROM sleep WHERE user_id='pippijn' AND tz IS NULL AND date > '2026-01-01' ORDER BY date ASC LIMIT 1"))[0]));
console.log("null-tz rows since 2026-08-01:", j((await c.query(
  "SELECT COUNT(*) n FROM sleep WHERE user_id='pippijn' AND tz IS NULL AND date >= '2026-08-01'"))[0]));
console.log("non-null-tz rows since 2026-08-01:", j((await c.query(
  "SELECT COUNT(*) n FROM sleep WHERE user_id='pippijn' AND tz IS NOT NULL AND date >= '2026-08-01'"))[0]));
await c.end();
