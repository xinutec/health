#!/usr/bin/env node
/**
 * Is #343's headline still true? It says the mined visit-shape prior is trained
 * on 40 visits TOTAL, with cafe at 3 and none in the 40-150 min dwell bucket.
 * Those numbers date from 2026-07-12 and the table has been mined since.
 * Read-only.
 */
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
const cols = await conn.query("SHOW COLUMNS FROM venue_type_priors");
console.log("columns:", cols.map((c) => c.Field).join(", "));
const rows = await conn.query("SELECT * FROM venue_type_priors ORDER BY 1, 2");
console.log(`venue_type_priors rows: ${rows.length}`);
let total = 0;
for (const r of rows) {
	const n = Number(r.visit_count ?? r.n ?? r.count ?? 0);
	total += n;
	console.log("  " + Object.entries(r).map(([k, v]) => `${k}=${v}`).join("  "));
}
console.log(`summed visit count across rows: ${total}`);
await conn.release();
await pool.end();
