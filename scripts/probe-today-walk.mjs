import { createConnection } from "mariadb";

const c = await createConnection({
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: "health",
});
const USER = "pippijn";

// Step buckets across the whole 16:00-23:00 UTC window — that's afternoon
// to evening local time in Europe/London.
const st = await c.query(
	`SELECT ts_utc, steps FROM steps_intraday
	 WHERE user_id=? AND ts_utc >= '2026-06-05T15:00:00Z' AND ts_utc < '2026-06-05T23:30:00Z'
	 ORDER BY ts_utc`,
	[USER],
);
console.log(`=== Steps per minute (15:00–23:30 UTC, n=${st.length}) ===`);
let walking = 0;
let walkMinutes = 0;
for (const r of st) {
	const t = new Date(r.ts_utc).toISOString().slice(11, 16);
	const isWalking = r.steps >= 20;
	if (isWalking) {
		walking += r.steps;
		walkMinutes++;
	}
	if (r.steps > 0) console.log(`  ${t}  ${r.steps}${isWalking ? "  ←walking-pace" : ""}`);
}
console.log(`\nMinutes with ≥20 steps (sustained-walking): ${walkMinutes}`);
console.log(`Total steps in walking minutes: ${walking}`);

// HR pattern same window
const hr = await c.query(
	`SELECT ts_utc, bpm FROM heart_rate_intraday
	 WHERE user_id=? AND ts_utc >= '2026-06-05T15:00:00Z' AND ts_utc < '2026-06-05T23:30:00Z'
	 ORDER BY ts_utc`,
	[USER],
);
console.log(`\n=== HR samples (15:00–23:30 UTC, n=${hr.length}) — every ~5min ===`);
let lastBucket = "";
for (const r of hr) {
	const t = new Date(r.ts_utc).toISOString().slice(11, 16);
	const bucket = t.slice(0, 4);
	if (bucket !== lastBucket && t.endsWith("0") || (t.endsWith("5") && bucket.endsWith(":"))) {
		console.log(`  ${t}  ${r.bpm}`);
		lastBucket = bucket;
	}
}

await c.end();
