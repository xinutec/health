#!/usr/bin/env node
// The TypeScript half of the row-rendering parity check (#982).
//
// Usage: scripts/prod-db.sh node scripts/rows-check-ts.mjs <user> <since> <date>
//
// Prints exactly what `src/routes/api.ts` would put on the wire for the ten
// table endpoints, in the same `<name>\t<json>` line format as
// `backend rows-check`, so the two can be diffed directly. Neither output is
// evidence on its own — the DIFF is the check.
//
// ⚠ Both driver options below are copied from `src/db/pool.ts` deliberately:
// without `bigIntAsNumber: false` a 64-bit sleep log id silently rounds, and
// without the `toJSON` patch `JSON.stringify` throws on the bigint that
// produces. A probe missing either would report a shape production never emits.
import * as mariadb from "mariadb";

BigInt.prototype.toJSON = function () {
	return this.toString();
};

const [, , user, since, date] = process.argv;
if (!user || !since || !date) {
	console.error("usage: rows-check-ts.mjs <user> <since> <date>");
	process.exit(1);
}

// The same queries `rust/backend/src/routes/tables.rs` serves, in the same
// order, with `?` placeholders bound the same way. Kysely builds these from
// `selectAll()`; written out here so the two sides are visibly the same read.
const DAYS_BACK = [
	["activity", "SELECT * FROM daily_activity WHERE user_id = ? AND date >= ? ORDER BY date"],
	["sleep", "SELECT * FROM sleep WHERE user_id = ? AND date >= ? ORDER BY date"],
	["heartrate/zones", "SELECT * FROM heart_rate_zones WHERE user_id = ? AND date >= ? ORDER BY date, zone_name"],
	["body", "SELECT * FROM body WHERE user_id = ? AND date >= ? ORDER BY date"],
	["spo2", "SELECT * FROM spo2_daily WHERE user_id = ? AND date >= ? ORDER BY date"],
	["hrv", "SELECT * FROM hrv_daily WHERE user_id = ? AND date >= ? ORDER BY date"],
	["breathing", "SELECT * FROM breathing_rate WHERE user_id = ? AND date >= ? ORDER BY date"],
	["temperature", "SELECT * FROM skin_temperature WHERE user_id = ? AND date >= ? ORDER BY date"],
];

function nextDay(d) {
	const t = new Date(d);
	t.setDate(t.getDate() + 1);
	return t.toISOString().slice(0, 10);
}

const pool = mariadb.createPool({
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: process.env.DB_NAME,
	connectionLimit: 1,
	bigIntAsNumber: false,
});
const conn = await pool.getConnection();

for (const [name, sql] of DAYS_BACK) {
	const rows = await conn.query(sql, [user, since]);
	// `conn.query` decorates the array with `meta`; JSON.stringify of an array
	// ignores non-index properties, so this is the same text `c.json(rows)`
	// produces.
	console.log(`${name}\t${JSON.stringify(rows)}`);
}

for (const [name, sql] of [
	["devices", "SELECT * FROM devices WHERE user_id = ?"],
	["sync-state", "SELECT * FROM sync_state WHERE user_id = ?"],
]) {
	const rows = await conn.query(sql, [user]);
	console.log(`${name}\t${JSON.stringify(rows)}`);
}

const log = await conn.query(
	"SELECT log_id FROM sleep WHERE user_id = ? AND date = ? AND is_main_sleep = 1 LIMIT 1",
	[user, date],
);
const stages = log.length
	? await conn.query("SELECT * FROM sleep_stages WHERE user_id = ? AND sleep_log_id = ? ORDER BY ts", [
			user,
			log[0].log_id,
		])
	: [];
console.log(`sleep/stages\t${JSON.stringify(stages)}`);

const hr = await conn.query(
	"SELECT * FROM heart_rate_intraday WHERE user_id = ? AND ts >= ? AND ts < ? ORDER BY ts",
	[user, date, nextDay(date)],
);
console.log(`heartrate/intraday\t${JSON.stringify(hr)}`);

await conn.end();
await pool.end();
