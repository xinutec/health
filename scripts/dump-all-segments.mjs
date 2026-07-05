#!/usr/bin/env node
// Dump segments_json for every pippijn decoded day as a single JSON map
// keyed by date. Used by validate-continuity-flag.sh for A/B comparison.
import { db, initPool } from "../dist/db/pool.js";

initPool({
	host: process.env.DB_HOST,
	port: process.env.DB_PORT,
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: process.env.DB_NAME,
});

const rows = await db()
	.selectFrom("decoded_days")
	.where("user_id", "=", "pippijn")
	.orderBy("date")
	.select(["date", "segments_json"])
	.execute();

const out = {};
for (const r of rows) {
	const dateKey = r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10);
	out[dateKey] = JSON.parse(r.segments_json);
}
console.log(JSON.stringify(out, null, 2));
process.exit(0);
