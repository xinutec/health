// How often is a main overnight sleep stored with is_main_sleep = 0?
//
// Usage (from the health repo root):
//   scripts/prod-db.sh node scripts/probe-sleep-main-flag.mjs
//
// Written to check whether the 7->8 Sep 2026 record (10h42 in bed, flagged
// is_main_sleep = 0 and dated to the day it STARTED rather than the day it
// ended) is an anomaly or the normal shape for a freshly-synced night. The
// answer decides how much weight that record's efficiency figure can carry.
import { createConnection } from "mariadb";

const c = await createConnection({
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: "health",
});

const [{ n }] = await c.query("SELECT COUNT(*) n FROM sleep WHERE user_id='pippijn'");
const [{ n0 }] = await c.query(
	"SELECT COUNT(*) n0 FROM sleep WHERE user_id='pippijn' AND is_main_sleep=0",
);
console.log(`rows: ${n}   is_main_sleep=0: ${n0}`);

// A long sleep flagged not-main is the specific shape in question.
console.log("\nlong (>6h asleep) but is_main_sleep=0:");
for (const r of await c.query(
	`SELECT date, start_time, end_time, minutes_asleep, efficiency
	   FROM sleep WHERE user_id='pippijn' AND is_main_sleep=0 AND minutes_asleep > 360
	  ORDER BY date DESC LIMIT 15`,
)) console.log("  ", JSON.stringify(r));

// Two rows sharing a `date` means one of them is dated to its start day.
console.log("\ndates carrying more than one sleep row (last 10):");
for (const r of await c.query(
	`SELECT date, COUNT(*) n FROM sleep WHERE user_id='pippijn'
	  GROUP BY date HAVING n > 1 ORDER BY date DESC LIMIT 10`,
)) console.log("  ", JSON.stringify(r, (_k, x) => (typeof x === "bigint" ? String(x) : x)));

await c.end();
