// Recent sleep records for one user — is last night in the database yet?
//
// Usage (from the health repo root):
//   scripts/prod-db.sh node scripts/probe-sleep-recent.mjs [DAYS]
//
// Prints the most recent sleep logs with their stage totals, so a question
// like "can you see last night's sleep?" is answered from the data rather
// than from when the sync last ran.
import { createConnection } from "mariadb";

const days = Number(process.argv[2] ?? 10);

const c = await createConnection({
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: "health",
});

const j = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? String(x) : x));

const tables = (await c.query("SHOW TABLES LIKE '%sleep%'")).map((r) => Object.values(r)[0]);
console.log("sleep tables:", tables.join(", "));

for (const t of tables) {
	const cols = (await c.query(`SHOW COLUMNS FROM ${t}`)).map((r) => r.Field);
	const dateCol = cols.find((f) => /date_of_sleep|^date$|start_time|^ts$/i.test(f)) ?? cols[0];
	const [{ n, lo, hi }] = await c.query(
		`SELECT COUNT(*) n, MIN(${dateCol}) lo, MAX(${dateCol}) hi FROM ${t}`,
	);
	console.log(`\n== ${t} — ${n} rows, ${dateCol} spans ${lo} .. ${hi}`);
	console.log(`   cols: ${cols.join(", ")}`);
	const rows = await c.query(
		`SELECT * FROM ${t} ORDER BY ${dateCol} DESC LIMIT ?`,
		[t === "sleep_stages" ? 5 : days],
	);
	for (const r of rows) console.log("  ", j(r).slice(0, 400));
}

await c.end();
