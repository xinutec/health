import { createConnection } from "mariadb";

const c = await createConnection({
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: "health",
});
const USER = "pippijn";

const days = ["2026-05-25", "2026-05-26", "2026-05-27", "2026-05-28", "2026-05-29", "2026-05-30", "2026-05-31", "2026-06-01", "2026-06-02"];
for (const d of days) {
	const [row] = await c.query(`SELECT segments_json FROM decoded_days WHERE user_id=? AND date=?`, [USER, d]);
	if (!row) {
		console.log(`${d}  (no decoded_days row)`);
		continue;
	}
	const segs = JSON.parse(row.segments_json);
	const summary = segs
		.filter((s) => s.mode === "stationary")
		.map((s) => {
			const t1 = new Date(s.startTs * 1000).toISOString().slice(11, 13);
			const t2 = new Date(s.endTs * 1000).toISOString().slice(11, 13);
			return `${t1}-${t2}#${s.placeId ?? "?"}`;
		})
		.join(" ");
	console.log(`${d}  ${segs.length}seg  stationary: ${summary}`);
}

// presence_log around 06-01
console.log(`\n=== presence_log ===`);
const cols = await c.query(`SHOW COLUMNS FROM presence_log`);
console.log(`presence_log columns: ${cols.map((c) => c.Field).join(", ")}`);
const pl = await c.query(
	`SELECT * FROM presence_log WHERE user_id=? AND date BETWEEN '2026-05-25' AND '2026-06-04' ORDER BY date`,
	[USER],
);
for (const r of pl) console.log(`  ${r.date}  ${JSON.stringify(r).slice(0, 200)}`);

await c.end();
