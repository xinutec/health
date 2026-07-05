#!/usr/bin/env node
// List named OSM POIs near a coordinate, nearest first. Read-only.
//   prod-db.sh node scripts/probe-poi.mjs <lat> <lon> [radiusM]
import { createConnection } from "mariadb";

const c = await createConnection({
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: "health",
});

const lat = Number(process.argv[2]);
const lon = Number(process.argv[3]);
const radius = Number(process.argv[4] ?? 200);
const pt = `POINT(${lon} ${lat})`;

const rows = await c.query(
	`SELECT name, feature_type, subtype,
	        JSON_UNQUOTE(JSON_EXTRACT(tags_json,'$.cuisine'))       AS cuisine,
	        JSON_UNQUOTE(JSON_EXTRACT(tags_json,'$.opening_hours')) AS hours,
	        ROUND(ST_Distance_Sphere(geom, ST_GeomFromText(?,4326))) AS dist_m
	   FROM osm_points
	  WHERE name IS NOT NULL
	    AND ST_Distance_Sphere(geom, ST_GeomFromText(?,4326)) < ?
	  ORDER BY dist_m
	  LIMIT 40`,
	[pt, pt, radius],
);

console.log(`POIs within ${radius}m of ${lat},${lon}:`);
for (const r of rows) {
	const tag = [r.feature_type, r.subtype].filter(Boolean).join("/");
	const extra = [r.cuisine && `cuisine=${r.cuisine}`, r.hours && `hrs=${r.hours}`].filter(Boolean).join(" ");
	console.log(`  ${String(r.dist_m).padStart(4)}m  ${(r.name ?? "").padEnd(34)}  ${tag.padEnd(22)}  ${extra}`);
}
await c.end();
process.exit(0);
