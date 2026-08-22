#!/usr/bin/env node
// What does `selectAll()` + `c.json(rows)` actually put on the wire?
//
// Usage: scripts/prod-db.sh node scripts/probe-row-shapes.mjs
//
// The Rust/Lean port has to reproduce the TypeScript backend's JSON byte
// for byte, and the TS *type declarations are not evidence*: `tables.ts`
// declares `daily_rmssd: number | null` while its own comment says DECIMAL
// comes back as a string. So this asks the driver instead of the source.
//
// Two driver options are load-bearing and are copied from `src/db/pool.ts`
// deliberately rather than defaulted:
//   - `bigIntAsNumber: false`, so BIGINT arrives as a native bigint
//   - `BigInt.prototype.toJSON`, the patch `src/bigint-json.ts` installs at
//     every process entry point, without which JSON.stringify THROWS
// A probe that omitted either would report a shape production never emits.
//
// Prints, per column: the SQL type, the JS runtime type, and the literal
// JSON rendering. Values are elided except for dates/times, where the
// rendering IS the question (a DATE becomes a JS Date, and JSON.stringify
// renders that in UTC — under a non-UTC process TZ it would move a day).
import * as mariadb from "mariadb";

// Exactly the patch src/bigint-json.ts installs. Without it, a row holding a
// BIGINT throws on serialise rather than rendering as a string.
BigInt.prototype.toJSON = function () {
	return this.toString();
};

// table -> ORDER BY that reaches a recent, well-populated row.
const TABLES = [
	["daily_activity", "date DESC"],
	["sleep", "date DESC"],
	["sleep_stages", "ts DESC"],
	["heart_rate_zones", "date DESC"],
	["heart_rate_intraday", "ts DESC"],
	["body", "date DESC"],
	["spo2_daily", "date DESC"],
	["hrv_daily", "date DESC"],
	["breathing_rate", "date DESC"],
	["skin_temperature", "date DESC"],
];

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

console.log(`process TZ: ${process.env.TZ ?? "(unset)"}  Date().toString(): ${new Date(0).toString()}`);

for (const [table, order] of TABLES) {
	// SQL types from the server, not from schema.ts — schema.ts is the
	// migrator's intent and prod is what actually ran.
	const cols = await conn.query(
		"SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS " +
			"WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
		[table],
	);

	// One query per table, then the first non-null value per column across
	// the window: a single sampled row leaves every NULL column unprobed,
	// and "unprobed" would silently read as "no such shape".
	const rows = await conn.query(`SELECT * FROM ${table} ORDER BY ${order} LIMIT 200`);

	console.log(`\n=== ${table} (${rows.length} rows sampled) ===`);
	for (const c of cols) {
		const name = c.COLUMN_NAME;
		const row = rows.find((r) => r[name] !== null && r[name] !== undefined);
		if (row === undefined) {
			console.log(`  ${name.padEnd(18)} ${c.COLUMN_TYPE.padEnd(14)} ALL-NULL in sample — shape unknown`);
			continue;
		}
		const v = row[name];
		const js = v instanceof Date ? "Date" : typeof v;
		const json = JSON.stringify(v);
		// A date/time's rendering is the finding. Everything else is the
		// user's biometrics, and the shape is what is being asked, not the value.
		const shown = v instanceof Date || /date|time|^ts/.test(name) ? json : `<${js}>`;
		console.log(`  ${name.padEnd(18)} ${c.COLUMN_TYPE.padEnd(14)} js=${js.padEnd(7)} json=${shown}`);
	}
}

await conn.end();
await pool.end();
