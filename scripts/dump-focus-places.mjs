#!/usr/bin/env node
// Dump focus_places for pippijn with their visit weights, hour-profile
// non-null flag, and total dwell. Used to ground-truth what each
// numeric placeId is in the HSMM output.
import { db, initPool } from "../dist/db/pool.js";

initPool({
	host: process.env.DB_HOST,
	port: process.env.DB_PORT,
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: process.env.DB_NAME,
});

const rows = await db()
	.selectFrom("focus_places")
	.where("user_id", "=", "pippijn")
	.orderBy("total_dwell_sec", "desc")
	.select(["id", "display_name", "centroid_lat", "centroid_lon", "total_dwell_sec"])
	.execute();

console.log(`# id     dwell_hours   lat      lon       name`);
for (const r of rows) {
	const hours = (Number(r.total_dwell_sec) / 3600).toFixed(1);
	console.log(
		`  ${String(r.id).padEnd(6)} ${hours.padStart(8)}      ${Number(r.centroid_lat).toFixed(4)}   ${Number(r.centroid_lon).toFixed(4)}    ${r.display_name ?? "<null>"}`,
	);
}
process.exit(0);
