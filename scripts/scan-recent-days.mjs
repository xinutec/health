#!/usr/bin/env node
// Scan recent decoded_days for pippijn: one line per day summarising the
// stored HSMM mode sequence, so the loop can eyeball many days at once for
// mode-structure anomalies — phantom train/cycling, surprising segment
// counts — without re-decoding each day. Read-only.
//
// NOTE: decoded_days.segments_json holds the RAW HSMM mode segments only.
// OSM place/way/line labels are enriched downstream in the velocity
// pipeline and are NOT stored here, so this scan sees mode structure, not
// place quality. To audit a flagged day's place naming, run
// `analyze-day.js <date>` against prod for the enriched output.
import { db, initPool } from "../dist/db/pool.js";

initPool({
	host: process.env.DB_HOST,
	port: process.env.DB_PORT,
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: process.env.DB_NAME,
});

const days = Number(process.argv[2] ?? 14);
const rows = await db()
	.selectFrom("decoded_days")
	.where("user_id", "=", "pippijn")
	.orderBy("date", "desc")
	.limit(days)
	.select(["date", "segments_json"])
	.execute();

for (const r of rows.reverse()) {
	let segs = [];
	try {
		segs = typeof r.segments_json === "string" ? JSON.parse(r.segments_json) : (r.segments_json ?? []);
	} catch {
		segs = [];
	}
	const modes = segs.map((s) => s.mode);
	const counts = modes.reduce((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});
	const modeSummary = Object.entries(counts)
		.map(([k, n]) => `${k}×${n}`)
		.join(" ");
	// Flag motorised/rail modes — the classes most prone to phantom
	// classification (train over-credit #238, phantom cycling). A quiet
	// home day is stationary/walking/unknown only and stays unflagged.
	const flag = segs.some((s) => s.mode === "cycling" || s.mode === "train" || s.mode === "plane") ? " ⚑" : "";
	const date = typeof r.date === "string" ? r.date : new Date(r.date).toISOString().slice(0, 10);
	console.log(`${date}  [${segs.length}]  ${modeSummary}${flag}`);
}
process.exit(0);
