// Measure WHERE the interchangeSplit wall-clock goes for the Victoria →
// Wembley Park leg (2026-06-09). Fresh process = cold stationsOnLine
// cache, so this reproduces the first-load cost. Run via prod-db.sh.
import { sql } from "kysely";
import { db, initPool } from "../dist/db/pool.js";
import { linesAtPoint } from "../dist/geo/osm.js";
import { stationsOnLine } from "../dist/geo/line-stations.js";

initPool({
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: "health",
});

const ms = (t) => `${Math.round(t)}ms`;
const now = () => Number(process.hrtime.bigint() / 1_000_000n);

// Table sizes
const t0 = now();
const total = await db().selectFrom("osm_lines").select(sql`COUNT(*)`.as("n")).executeTakeFirst();
const rail = await db()
	.selectFrom("osm_lines")
	.where("feature_type", "=", "railway")
	.select(sql`COUNT(*)`.as("n"))
	.executeTakeFirst();
console.log(`osm_lines: ${total.n} rows total, ${rail.n} railway rows  (${ms(now() - t0)})`);

// Time one representative leading-wildcard LIKE scan (what stationsOnLine does)
const t1 = now();
const likeRows = await db()
	.selectFrom("osm_lines")
	.where("feature_type", "=", "railway")
	.where("name", "like", "%Victoria%")
	.select([sql`ST_AsText(geom)`.as("wkt")])
	.execute();
console.log(`one LIKE '%Victoria%' scan: ${likeRows.length} ways  (${ms(now() - t1)})`);

// The real fan-out: lines near both endpoints of the qualifying leg.
const VICTORIA = { lat: 51.4952, lon: -0.1441 };
const WEMBLEY_PARK = { lat: 51.5635, lon: -0.2795 };
const R = 300;

const ta = now();
const linesA = await linesAtPoint(VICTORIA.lat, VICTORIA.lon, R);
console.log(`linesAtPoint(Victoria, ${R}m): ${linesA.size} lines  (${ms(now() - ta)})`);
const tb = now();
const linesB = await linesAtPoint(WEMBLEY_PARK.lat, WEMBLEY_PARK.lon, R);
console.log(`linesAtPoint(Wembley Park, ${R}m): ${linesB.size} lines  (${ms(now() - tb)})`);

const union = [...new Set([...linesA, ...linesB])];
console.log(`\nunion = ${union.length} unique line names. stationsOnLine() per line (sequential, as prod does):`);
let sum = 0;
for (const line of union) {
	const t = now();
	const stns = await stationsOnLine(line);
	const dt = now() - t;
	sum += dt;
	console.log(`  ${ms(dt).padStart(8)}  ${stns.length.toString().padStart(4)} stns  ${line}`);
}
console.log(`\nfan-out total: ${ms(sum)}  over ${union.length} lines`);
process.exit(0);
