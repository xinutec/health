// Pull recent resting-HR / HRV / breathing-rate for the dicom-scan
// Heart Rate Trend page.
//
// Usage (via the prod-db tunnel, from the health repo root):
//   scripts/prod-db.sh node scripts/probe-hr-trend.mjs [SINCE] [--json]
//
//   SINCE        ISO date floor (default 2026-06-03)
//   --json       emit a JSON array [{date,rhr,rmssd,resp}] instead of a table
//   --averages   emit SQL-computed pre-op/post-op window averages as JSON and exit:
//                {preop:{rhr,rmssd,resp}, postop:{rhr,rmssd,resp}, windows:{...}}
//                pre-op window = [2026-04-15, surgery); post-op = [surgery, now).
//                Surgery date = 2026-05-26.
//
// The dicom-scan refresh_hr_data.py tool calls this with --json (rows) and
// --averages (window means). Averages are computed in SQL so they are
// reproducible, not hand-tallied.
import { createConnection } from "mariadb";

const args = process.argv.slice(2);
const json = args.includes("--json");
const averages = args.includes("--averages");
const since = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? "2026-06-03";

const SURGERY = "2026-05-26"; // resection date — the pre/post-op boundary
const PREOP_START = "2026-04-15"; // start of the recent pre-op baseline window

const c = await createConnection({
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: "health",
});

// (table, metric column) — date column auto-detected per table.
const sources = [
	["daily_activity", "resting_heart_rate", "rhr"],
	["hrv_daily", "daily_rmssd", "rmssd"],
	["breathing_rate", "full_sleep_rate", "resp"],
];

if (averages) {
	const win = async (table, metric, lo, hiExcl) => {
		const cols = (await c.query(`SHOW COLUMNS FROM ${table}`)).map((r) => r.Field);
		const dateCol = cols.find((f) => /^date$|day|timestamp|recorded/i.test(f)) ?? cols[0];
		const where = hiExcl
			? `${dateCol} >= ? AND ${dateCol} < ?`
			: `${dateCol} >= ?`;
		const params = hiExcl ? [lo, hiExcl] : [lo];
		const [row] = await c.query(`SELECT AVG(${metric}) AS a, COUNT(${metric}) AS n FROM ${table} WHERE ${where}`, params);
		return { avg: row.a === null ? null : Number(row.a), n: Number(row.n) };
	};
	const grp = async (lo, hiExcl) => {
		const o = {};
		for (const [table, metric, key] of sources) o[key] = await win(table, metric, lo, hiExcl);
		return o;
	};
	const result = {
		windows: { preop: [PREOP_START, SURGERY], postop: [SURGERY, "now"] },
		preop: await grp(PREOP_START, SURGERY),
		postop: await grp(SURGERY, null),
	};
	console.log(JSON.stringify(result));
	await c.end();
	process.exit(0);
}

const byDate = new Map(); // date -> {rhr, rmssd, resp}

for (const [table, metric, key] of sources) {
	const cols = (await c.query(`SHOW COLUMNS FROM ${table}`)).map((r) => r.Field);
	const dateCol = cols.find((f) => /^date$|day|timestamp|recorded/i.test(f)) ?? cols[0];
	const rows = await c.query(
		`SELECT DATE_FORMAT(${dateCol}, '%Y-%m-%d') AS d, ${metric} AS v
		 FROM ${table} WHERE ${dateCol} >= ? ORDER BY d`,
		[since],
	);
	for (const { d, v } of rows) {
		if (!byDate.has(d)) byDate.set(d, { date: d });
		byDate.get(d)[key] = v === null ? null : Number(v);
	}
}

const out = [...byDate.keys()].sort().map((d) => byDate.get(d));

if (json) {
	console.log(JSON.stringify(out));
} else {
	console.log("date        RHR   RMSSD  resp");
	for (const r of out) {
		const f = (x) => (x === undefined || x === null ? "  -  " : String(x).padStart(5));
		console.log(`${r.date}  ${f(r.rhr)} ${f(r.rmssd)} ${f(r.resp)}`);
	}
}

await c.end();
