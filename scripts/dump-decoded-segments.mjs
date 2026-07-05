#!/usr/bin/env node
// Dump HSMM decoded segments for a user/date. Reads decoded_days.
// Usage:  scripts/prod-db.sh node scripts/dump-decoded-segments.mjs <date> [user]
import { db, initPool } from "../dist/db/pool.js";

const date = process.argv[2] ?? "2026-06-02";
const user = process.argv[3] ?? "pippijn";

initPool({
	host: process.env.DB_HOST,
	port: process.env.DB_PORT,
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: process.env.DB_NAME,
});

const row = await db()
	.selectFrom("decoded_days")
	.where("date", "=", date)
	.where("user_id", "=", user)
	.select(["segments_json"])
	.executeTakeFirst();

if (!row) {
	console.error(`no decoded_days row for ${user}/${date}`);
	process.exit(1);
}

const segs = JSON.parse(row.segments_json);
console.log(`# HSMM decoded ${user}/${date} — ${segs.length} segments`);
if (segs.length) console.log(`# field-keys: ${Object.keys(segs[0]).join(",")}`);
for (const s of segs) {
	console.log(JSON.stringify(s));
}
process.exit(0);
