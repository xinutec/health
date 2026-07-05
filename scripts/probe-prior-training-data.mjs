#!/usr/bin/env node
// How much history exists to mine venue-type priors from? Read-only.
// GPS itself lives in NC PhoneTrack; focus_places spans the mined history.
//   prod-db.sh node scripts/probe-prior-training-data.mjs
import { createConnection } from "mariadb";

const c = await createConnection({
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: "health",
});

const [span] = await c.query(
	`SELECT FROM_UNIXTIME(MIN(first_seen_ts)) AS first, FROM_UNIXTIME(MAX(last_seen_ts)) AS last,
	        COUNT(*) AS places, SUM(visit_count) AS visits, SUM(unique_days) AS place_days
	   FROM focus_places`,
);
console.log(
	`focus_places history: ${span.first} .. ${span.last}  (${span.places} places, ${span.visits} visits, ${span.place_days} place-days)`,
);

const fp = await c.query(
	`SELECT detected_label, COUNT(*) AS n, SUM(visit_count) AS visits,
	        SUM(amenity_label IS NOT NULL) AS with_amenity
	   FROM focus_places GROUP BY detected_label ORDER BY n DESC`,
);
console.log("\nfocus_places by label:");
for (const r of fp)
	console.log(
		`  ${String(r.detected_label).padEnd(10)} n=${String(r.n).padStart(4)}  visits=${String(r.visits).padStart(5)}  amenity-labelled=${r.with_amenity}`,
	);

const am = await c.query(
	`SELECT amenity_label, visit_count, unique_days, ROUND(total_dwell_sec/3600) AS dwell_h
	   FROM focus_places WHERE amenity_label IS NOT NULL
	  ORDER BY visit_count DESC LIMIT 25`,
);
console.log("\ntop amenity-labelled focus places (label, visits, days, dwell):");
for (const r of am)
	console.log(
		`  ${String(r.amenity_label).slice(0, 40).padEnd(40)} v=${String(r.visit_count).padStart(4)} d=${String(r.unique_days).padStart(3)} ${String(r.dwell_h).padStart(5)}h`,
	);

const dd = await c.query(`SELECT COUNT(*) AS n, MIN(date) AS first, MAX(date) AS last FROM decoded_days`);
console.log(`\ndecoded_days: ${dd[0].n} rows  ${dd[0].first} .. ${dd[0].last}`);
await c.end();
process.exit(0);
