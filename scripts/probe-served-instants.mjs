// Do the repaired-instant reads actually come back as DATETIMEs — and is the
// repair ever needed? (#1532)
//
// Usage (from the health repo root):
//   scripts/prod-db.sh node scripts/probe-served-instants.mjs
//
// `/sleep`, `/sleep/stages` and `/heartrate/intraday` stopped serving the Fitbit
// wall clock and now serve `COALESCE(<col>_utc, CONVERT_TZ(<col>, tz, 'UTC'))`.
// Two things about that are assumptions until something looks:
//
//  1. ⚠ THE COLUMN TYPE OF AN EXPRESSION. `row_json` dispatches on the SQL TYPE
//     the driver reports, so if MariaDB typed the COALESCE as anything but
//     DATETIME the rendering would change shape — and a test cannot see this,
//     because a `MySqlRow` needs a server. This prints the reported type per
//     column rather than the value, which is the thing in question.
//
//  2. ⚠ HOW OFTEN THE REPAIR FIRES, and whether it can fail. A row with no
//     stored `_utc` AND no `tz` converts to NULL and is dropped by the route
//     (or, for `sleep`, served null) — so the counts below say how much data
//     that costs today, rather than leaving it as a handled-in-principle case.
import { createConnection } from "mariadb";

const c = await createConnection({
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: "health",
});

// The served column lists, verbatim from `routes/tables.rs`. LIMIT 1 because
// this asks about the SHAPE; the counts below ask about the data.
const served = {
	"/sleep": `SELECT log_id, date,
		COALESCE(start_time_utc, CONVERT_TZ(start_time, tz, 'UTC')) AS start_time_utc,
		COALESCE(end_time_utc, CONVERT_TZ(end_time, tz, 'UTC')) AS end_time_utc,
		duration_ms, efficiency, minutes_asleep, minutes_awake, minutes_deep,
		minutes_light, minutes_rem, minutes_wake, is_main_sleep, tz
		FROM sleep LIMIT 1`,
	"/sleep/stages": `SELECT COALESCE(ts_utc, CONVERT_TZ(ts, tz, 'UTC')) AS ts_utc, stage,
		duration_seconds, tz FROM sleep_stages LIMIT 1`,
	"/heartrate/intraday": `SELECT COALESCE(ts_utc, CONVERT_TZ(ts, tz, 'UTC')) AS ts_utc, bpm, tz
		FROM heart_rate_intraday LIMIT 1`,
};

for (const [name, sql] of Object.entries(served)) {
	const rows = await c.query(sql);
	const meta = rows.meta.map((m) => `${m.name()}:${m.type}`);
	console.log(`${name}\n  ${meta.join("  ")}`);
}

// How much the repair matters, per table: rows with a stored instant, rows the
// zone can still rescue, and rows nothing can place.
const tables = [
	["sleep", "start_time", "start_time_utc"],
	["sleep", "end_time", "end_time_utc"],
	["sleep_stages", "ts", "ts_utc"],
	["heart_rate_intraday", "ts", "ts_utc"],
	["steps_intraday", "ts", "ts_utc"],
];
console.log("\ntable / column            stored   repairable   UNPLACEABLE");
for (const [t, wall, utc] of tables) {
	const [r] = await c.query(
		`SELECT COUNT(*) AS total,
			SUM(${utc} IS NOT NULL) AS stored,
			SUM(${utc} IS NULL AND CONVERT_TZ(${wall}, tz, 'UTC') IS NOT NULL) AS repairable,
			SUM(${utc} IS NULL AND CONVERT_TZ(${wall}, tz, 'UTC') IS NULL) AS lost
		 FROM ${t}`,
	);
	const n = (v) => String(v ?? 0).padStart(9);
	console.log(`${`${t}.${wall}`.padEnd(24)} ${n(r.stored)} ${n(r.repairable)} ${n(r.lost)}   of ${r.total}`);
}

await c.end();
