#!/usr/bin/env node
// Quick diagnostic: dump HR, steps, cadence for a time window.
// Usage: scripts/prod-db.sh node scripts/dump-biometrics-window.mjs <user> <start_utc_iso> <end_utc_iso>
import * as mariadb from "mariadb";

const [, , user, startIso, endIso] = process.argv;
if (!user || !startIso || !endIso) {
	console.error("usage: dump-biometrics-window.mjs <user> <start_utc> <end_utc>");
	process.exit(1);
}

const pool = mariadb.createPool({
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: process.env.DB_NAME,
	connectionLimit: 1,
});
const conn = await pool.getConnection();
// `ts` columns are DATETIME in UTC; bind as ISO strings.
const startSql = startIso.replace("T", " ").replace("Z", "");
const endSql = endIso.replace("T", " ").replace("Z", "");
const startTs = Math.floor(new Date(startIso).getTime() / 1000);
const endTs = Math.floor(new Date(endIso).getTime() / 1000);

const hr = await conn.query(
	"SELECT UNIX_TIMESTAMP(ts) AS ts, bpm FROM heart_rate_intraday WHERE user_id = ? AND ts >= ? AND ts <= ? ORDER BY ts",
	[user, startSql, endSql],
);
const steps = await conn.query(
	"SELECT UNIX_TIMESTAMP(ts) AS ts, steps FROM steps_intraday WHERE user_id = ? AND ts >= ? AND ts <= ? ORDER BY ts",
	[user, startSql, endSql],
);

// Build per-minute view
const minutes = new Map();
for (let t = startTs; t < endTs; t += 60) minutes.set(t, { hr: [], steps: 0 });
for (const r of hr) {
	const m = minutes.get(Math.floor(Number(r.ts) / 60) * 60);
	if (m) m.hr.push(Number(r.bpm));
}
for (const r of steps) {
	const m = minutes.get(Math.floor(Number(r.ts) / 60) * 60);
	if (m) m.steps += Number(r.steps);
}

console.log("minute_utc  hr_n  hr_mean  steps");
for (const [ts, m] of [...minutes].sort((a, b) => a[0] - b[0])) {
	const t = new Date(ts * 1000).toISOString().slice(11, 16);
	const hrMean = m.hr.length > 0 ? (m.hr.reduce((a, b) => a + b, 0) / m.hr.length).toFixed(0) : "  -";
	console.log(`${t}      ${String(m.hr.length).padStart(2)}    ${String(hrMean).padStart(3)}    ${String(m.steps).padStart(3)}`);
}

await conn.end();
await pool.end();
