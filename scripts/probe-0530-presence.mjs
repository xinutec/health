// One-off: does the HSMM decode (decoded_days / presence_log) hold any
// inference for the fully-empty 2026-05-30, and what do the neighbouring
// inpatient days resolve to? Settles "are we inferring the hospital from
// before/after for a no-data day?"
import { createConnection } from "mariadb";

const c = await createConnection({
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: process.env.DB_NAME ?? "health",
});
const USER = "pippijn";

console.log("=== presence_log 2026-05-27 .. 2026-06-02 (place_id → name) ===");
const pl = await c.query(
	`SELECT p.date, p.dominant_place_id, fd.display_name AS dominant,
	        p.end_of_day_place_id, fe.display_name AS eod
	   FROM presence_log p
	   LEFT JOIN focus_places fd ON fd.id = p.dominant_place_id
	   LEFT JOIN focus_places fe ON fe.id = p.end_of_day_place_id
	  WHERE p.user_id=? AND p.date BETWEEN '2026-05-27' AND '2026-06-02'
	  ORDER BY p.date`,
	[USER],
);
for (const r of pl) {
	const d = new Date(r.date).toISOString().slice(0, 10);
	console.log(`  ${d}  dominant=${r.dominant ?? "(" + r.dominant_place_id + ")"}  eod=${r.eod ?? "(" + r.end_of_day_place_id + ")"}`);
}
if (pl.length === 0) console.log("  (no presence_log rows in window)");

console.log("\n=== decoded_days rows present in window? ===");
const dd = await c.query(
	`SELECT date, LENGTH(segments_json) AS json_len FROM decoded_days
	  WHERE user_id=? AND date BETWEEN '2026-05-27' AND '2026-06-02' ORDER BY date`,
	[USER],
);
for (const r of dd) {
	const d = new Date(r.date).toISOString().slice(0, 10);
	console.log(`  ${d}  segments_json bytes=${r.json_len}`);
}
if (dd.length === 0) console.log("  (no decoded_days rows in window)");

console.log("\n=== is 2026-05-30 specifically present in either table? ===");
const a = await c.query(`SELECT 1 FROM presence_log WHERE user_id=? AND date='2026-05-30'`, [USER]);
const b = await c.query(`SELECT 1 FROM decoded_days WHERE user_id=? AND date='2026-05-30'`, [USER]);
console.log(`  presence_log[05-30]: ${a.length ? "PRESENT" : "ABSENT"}   decoded_days[05-30]: ${b.length ? "PRESENT" : "ABSENT"}`);

await c.end();
process.exit(0);
