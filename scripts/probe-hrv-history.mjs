// Export the FULL Fitbit HRV + resting-HR history as CSV for the dicom-scan
// long-term HRV chart (heart-rate-trend.md → gen_hrv_chart.py).
//
// Usage (via the prod-db tunnel, from the health repo root):
//   scripts/prod-db.sh node scripts/probe-hrv-history.mjs > hrv-data.csv
//
// Emits `date,hrv,rhr` rows (header included), one per day, for every date
// present in hrv_daily OR daily_activity, ascending. Missing metric = empty
// cell (gen_hrv_chart.py reads empty as NaN). This is the full-history
// counterpart to probe-hr-trend.mjs (which is recent-window only).
import { createConnection } from "mariadb";

const c = await createConnection({
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: "health",
});

const byDate = new Map(); // date -> {hrv, rhr}

// (table, metric column, key) — date column auto-detected per table,
// matching probe-hr-trend.mjs.
const sources = [
	["hrv_daily", "daily_rmssd", "hrv"],
	["daily_activity", "resting_heart_rate", "rhr"],
];

for (const [table, metric, key] of sources) {
	const cols = (await c.query(`SHOW COLUMNS FROM ${table}`)).map((r) => r.Field);
	const dateCol = cols.find((f) => /^date$|day|timestamp|recorded/i.test(f)) ?? cols[0];
	const rows = await c.query(
		`SELECT DATE_FORMAT(${dateCol}, '%Y-%m-%d') AS d, ${metric} AS v
		 FROM ${table} ORDER BY d`,
	);
	for (const { d, v } of rows) {
		if (!byDate.has(d)) byDate.set(d, {});
		if (v !== null) byDate.get(d)[key] = Number(v);
	}
}

console.log("date,hrv,rhr");
for (const d of [...byDate.keys()].sort()) {
	const { hrv, rhr } = byDate.get(d);
	console.log(`${d},${hrv ?? ""},${rhr ?? ""}`);
}

await c.end();
process.exit(0);
