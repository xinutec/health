// Can the sleep loader trust start_time_utc/end_time_utc?
//   Usage: scripts/prod-db.sh node scripts/probe-sleep-utc-coverage.mjs
//
// The loader reconstructs a window from WALL CLOCK plus `tz`, and `tz` has been
// NULL since the Google cutover — so it reads local time as UTC. The converted
// value is already stored beside it. This asks whether that column is populated
// far enough back to be read unconditionally, or needs a fallback.
import { createConnection } from "mariadb";
const c = await createConnection({
	host: process.env.DB_HOST, port: Number(process.env.DB_PORT),
	user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: "health",
});
const j = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? String(x) : x));
for (const [label, sql] of [
	["rows total", "SELECT COUNT(*) n FROM sleep WHERE user_id='pippijn'"],
	["start_time_utc NULL", "SELECT COUNT(*) n FROM sleep WHERE user_id='pippijn' AND start_time_utc IS NULL"],
	["end_time_utc NULL", "SELECT COUNT(*) n FROM sleep WHERE user_id='pippijn' AND end_time_utc IS NULL"],
	["tz NULL", "SELECT COUNT(*) n FROM sleep WHERE user_id='pippijn' AND tz IS NULL"],
	["BOTH tz and end_time_utc NULL (unfixable)", "SELECT COUNT(*) n FROM sleep WHERE user_id='pippijn' AND tz IS NULL AND end_time_utc IS NULL"],
	["earliest row WITH end_time_utc", "SELECT MIN(date) d FROM sleep WHERE user_id='pippijn' AND end_time_utc IS NOT NULL"],
])
	console.log(label.padEnd(42), j((await c.query(sql))[0]));


// ⚠ Switching the loader to the _utc columns must not MOVE a row that is
// currently read correctly. For every row that still has a tz, the stored
// offset must be the one that tz implies — 0 or 60 minutes for London.
console.log("\noffset (minutes) between wall clock and stored UTC, by tz:");
for (const r of await c.query(
  `SELECT COALESCE(tz,'<null>') tz,
          TIMESTAMPDIFF(MINUTE, start_time_utc, start_time) off,
          COUNT(*) n, MIN(date) first, MAX(date) last
     FROM sleep WHERE user_id='pippijn'
    GROUP BY tz, off ORDER BY tz, off`))
  console.log("  ", j(r));


// ⚠ #340 repaired end_time_utc only. Its twin start_time_utc was never in that
// UPDATE, so ask both columns the same question with the same oracle.
console.log("\ncontradicting rows, by column (oracle: CONVERT_TZ, not an offset guess):");
const probe = (await c.query("SELECT CONVERT_TZ('2026-08-05 12:00:00','Europe/London','UTC') p"))[0].p;
if (probe === null) { console.log("  ⚠ CONVERT_TZ returned NULL — zone tables absent, this census is VOID"); }
else for (const [col, wall] of [["start_time_utc","start_time"], ["end_time_utc","end_time"]])
  console.log("  ", col.padEnd(16), j((await c.query(
    `SELECT COUNT(*) n, MIN(date) first, MAX(date) last FROM sleep
      WHERE user_id='pippijn' AND tz IS NOT NULL AND ${col} IS NOT NULL
        AND CONVERT_TZ(${wall}, tz, 'UTC') IS NOT NULL
        AND ${col} <> CONVERT_TZ(${wall}, tz, 'UTC')`))[0]));
await c.end();
