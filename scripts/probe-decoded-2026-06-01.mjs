import { createConnection } from "mariadb";

const c = await createConnection({
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: "health",
});

const USER = "pippijn";

// decoded_days for the week of June 1
const dd = await c.query(
	`SELECT date, length(segments_json) AS n_bytes
	 FROM decoded_days
	 WHERE user_id=? AND date BETWEEN '2026-05-28' AND '2026-06-04'
	 ORDER BY date`,
	[USER],
);
console.log("decoded_days rows around 2026-06-01:");
for (const r of dd) console.log(`  ${r.date}  ${r.n_bytes} bytes`);

// Show the actual segments for 2026-06-01 if present
const [row] = await c.query(`SELECT segments_json FROM decoded_days WHERE user_id=? AND date='2026-06-01'`, [USER]);
if (row) {
	const segs = JSON.parse(row.segments_json);
	console.log(`\n2026-06-01 decoded segments (${segs.length}):`);
	for (const s of segs) {
		const t1 = new Date(s.startTs * 1000).toISOString().slice(11, 19);
		const t2 = new Date(s.endTs * 1000).toISOString().slice(11, 19);
		console.log(`  ${t1}–${t2}  mode=${s.mode}  placeId=${s.placeId ?? "—"}  lineName=${s.lineName ?? "—"}`);
	}
}

// Also: what are the Owntracks/Phone fix counts per day around 2026-06-01?
// (May reveal that 2026-06-01 had very sparse history that didn't trigger
// a re-decode after the focus_places mining for Cleveland Clinic ran.)
console.log(`\nfocus_places refreshed_at for Cleveland Clinic and Home:`);
const fp = await c.query(
	`SELECT id, display_name, detected_label, sleep_hours, unique_days
	 FROM focus_places WHERE user_id=? AND id IN (6023, 6046)`,
	[USER],
);
for (const r of fp)
	console.log(`  id=${r.id} display_name=${r.display_name} detected_label=${r.detected_label} sleep_hours=${r.sleep_hours} unique_days=${r.unique_days}`);

await c.end();
