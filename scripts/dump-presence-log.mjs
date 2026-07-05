#!/usr/bin/env node
import * as mariadb from "mariadb";
const pool = mariadb.createPool({
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: process.env.DB_NAME,
	connectionLimit: 1,
});
const conn = await pool.getConnection();
const rows = await conn.query(
	"SELECT date, dominant_place_id, dominant_fraction, end_of_day_place_id, end_of_day_posterior FROM presence_log ORDER BY date",
);
console.log("date         dom_pid  dom_frac  eod_pid  eod_post");
for (const r of rows) {
	const d = String(r.date).slice(0, 10);
	console.log(
		`${d}   ${String(r.dominant_place_id ?? "-").padStart(5)}   ${(r.dominant_fraction).toFixed(3)}   ${String(r.end_of_day_place_id ?? "-").padStart(5)}   ${(r.end_of_day_posterior).toFixed(3)}`,
	);
}
await conn.end();
await pool.end();
