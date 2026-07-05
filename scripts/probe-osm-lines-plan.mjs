// Why is one stationsOnLine lookup 27s? Show the indexes on osm_lines
// and the planner's choice for the leading-wildcard LIKE scan.
import { sql } from "kysely";
import { db, initPool } from "../dist/db/pool.js";

initPool({
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: "health",
});

const rows = async (q) => (await sql.raw(q).execute(db())).rows;

console.log("=== indexes on osm_lines ===");
for (const r of await rows("SHOW INDEX FROM osm_lines")) {
	console.log(`  ${r.Key_name}  col=${r.Column_name}  type=${r.Index_type}  cardinality=${r.Cardinality}`);
}

console.log("\n=== row counts ===");
for (const r of await rows(
	"SELECT feature_type, COUNT(*) n FROM osm_lines GROUP BY feature_type ORDER BY n DESC LIMIT 8",
)) {
	console.log(`  ${String(r.feature_type).padEnd(12)} ${r.n}`);
}

console.log("\n=== EXPLAIN: the stationsOnLine query ===");
for (const r of await rows(
	"EXPLAIN SELECT ST_AsText(geom) FROM osm_lines WHERE feature_type='railway' AND name LIKE '%Victoria%'",
)) {
	console.log(JSON.stringify({ type: r.type, key: r.key, rows: r.rows, Extra: r.Extra }));
}

console.log("\n=== EXPLAIN: same but exact-name (index-friendly) ===");
for (const r of await rows(
	"EXPLAIN SELECT ST_AsText(geom) FROM osm_lines WHERE feature_type='railway' AND name = 'Victoria Line'",
)) {
	console.log(JSON.stringify({ type: r.type, key: r.key, rows: r.rows, Extra: r.Extra }));
}

console.log("\n=== timing: filter on feature_type alone (how many railway rows to scan) ===");
const t = Number(process.hrtime.bigint() / 1_000_000n);
const n = await rows("SELECT COUNT(*) n FROM osm_lines WHERE feature_type='railway' AND name LIKE '%Victoria%'");
console.log(`  matched ${n[0].n} rows in ${Number(process.hrtime.bigint() / 1_000_000n) - t}ms`);
process.exit(0);
