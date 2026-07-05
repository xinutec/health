#!/usr/bin/env node
// Coverage of opening_hours in the OSM mirror, by landmark subtype. Read-only.
//   prod-db.sh node scripts/probe-opening-hours-coverage.mjs
import { createConnection } from "mariadb";

const c = await createConnection({
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: "health",
});

const rows = await c.query(
	`SELECT subtype,
	        COUNT(*) AS total,
	        SUM(JSON_EXTRACT(tags_json,'$.opening_hours') IS NOT NULL) AS with_hours
	   FROM osm_points
	  WHERE feature_type = 'landmark' AND name IS NOT NULL
	  GROUP BY subtype
	 HAVING total >= 10
	  ORDER BY total DESC
	  LIMIT 40`,
);

let total = 0n;
let withHours = 0n;
console.log("opening_hours coverage by landmark subtype (named, n>=10):");
for (const r of rows) {
	const t = BigInt(r.total);
	const w = BigInt(r.with_hours ?? 0);
	total += t;
	withHours += w;
	const pct = Number((w * 1000n) / t) / 10;
	console.log(
		`  ${String(r.subtype ?? "?").padEnd(24)} ${String(t).padStart(6)}  ${String(w).padStart(6)}  ${String(pct).padStart(5)}%`,
	);
}
const pct = total > 0n ? Number((withHours * 1000n) / total) / 10 : 0;
console.log(`  ${"TOTAL".padEnd(24)} ${String(total).padStart(6)}  ${String(withHours).padStart(6)}  ${String(pct).padStart(5)}%`);
await c.end();
process.exit(0);
