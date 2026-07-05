/**
 * One-off probe: list OSM landmarks near a coordinate, ranked by distance,
 * to sanity-check which venue a stay most likely was.
 *
 * Usage: node dist/cli/probe-landmarks.js <lat> <lon> [radiusM]
 */

import { z } from "zod";
import { initPool } from "../db/pool.js";
import { dbOsmAdapter } from "../geo/osm-adapter.js";

const db = z
	.object({
		host: z.string().default("health-db"),
		port: z.coerce.number().default(3306),
		user: z.string(),
		password: z.string(),
		database: z.string().default("health"),
	})
	.parse({
		host: process.env.DB_HOST,
		port: process.env.DB_PORT,
		user: process.env.DB_USER,
		password: process.env.DB_PASSWORD,
		database: process.env.DB_NAME,
	});
initPool(db);

const lat = Number(process.argv[2]);
const lon = Number(process.argv[3]);
const radius = Number(process.argv[4] ?? "80");

const landmarks = await dbOsmAdapter.nearbyLandmarks(lat, lon, radius);
landmarks.sort((a, b) => a.distanceM - b.distanceM);

console.log(`OSM landmarks within ${radius} m of ${lat},${lon} (nearest first):`);
for (const l of landmarks) {
	const hrs = l.openingHours ? ` hrs="${l.openingHours}"` : "";
	const enc = l.enclosing ? " [ENCLOSING]" : "";
	console.log(`  ${l.distanceM.toFixed(0).padStart(4)}m  ${l.type}/${l.subtype.padEnd(14)} ${l.name}${enc}${hrs}`);
}
console.log(`(${landmarks.length} landmarks)`);
