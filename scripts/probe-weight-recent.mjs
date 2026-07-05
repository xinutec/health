// Recent weight rows from the body table, to sanity-check the trend chart.
// Usage (via the prod-db tunnel, from the health repo root):
//   scripts/prod-db.sh node scripts/probe-weight-recent.mjs [DAYS]
import { createConnection } from "mariadb";

const days = Number(process.argv[2] ?? 21);
const c = await createConnection({
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: process.env.DB_NAME,
});

const rows = await c.query(
	`SELECT date, weight_kg, bmi, body_fat_pct FROM body
	 WHERE user_id = 'pippijn'
	 ORDER BY date DESC LIMIT ?`,
	[days],
);

let prev = null;
for (const r of rows.reverse()) {
	const d = String(r.date).slice(0, 10);
	const w = r.weight_kg == null ? "—" : Number(r.weight_kg).toFixed(2);
	const changed = prev != null && Number(r.weight_kg) !== prev ? "  <-- changed" : "";
	console.log(`${d}  ${w} kg   bmi=${r.bmi ?? "—"}  fat%=${r.body_fat_pct ?? "—"}${changed}`);
	prev = r.weight_kg == null ? prev : Number(r.weight_kg);
}

// How many DISTINCT weight values in the window — flat = forward-filled.
const distinct = new Set(rows.map((r) => (r.weight_kg == null ? null : Number(r.weight_kg))));
console.log(`\n${days}-day window: ${distinct.size} distinct weight value(s)`);
await c.end();
process.exit(0);
