/**
 * One-off probe: what does the pipeline's own reverseGeocode return for a
 * coordinate — the candidate that competes at distance 0 in bestPlace.
 *
 * Usage: node dist/cli/probe-reverse.js <lat> <lon> [zoom]
 */

import { z } from "zod";
import { initPool } from "../db/pool.js";
import { dbOsmAdapter } from "../geo/osm-adapter.js";

const dbCfg = z
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
initPool(dbCfg);

const lat = Number(process.argv[2]);
const lon = Number(process.argv[3]);
const zoom = Number(process.argv[4] ?? "18");

const r = await dbOsmAdapter.reverseGeocode(lat, lon, zoom);
console.log(`reverseGeocode(${lat}, ${lon}, zoom=${zoom}):`);
console.log(JSON.stringify(r, null, 2));
process.exit(0);
