/**
 * One-off probe: which named stations does a rail line serve, per the route
 * graph / osm_lines membership the decoder uses. Diagnoses line-attribution
 * bugs (e.g. a journey credited to a line that does not serve its boarding
 * station).
 *
 * Usage: node dist/cli/probe-line-stations.js "<Line Name>" [substr]
 */

import { z } from "zod";
import { initPool } from "../db/pool.js";
import { stationsOnLine } from "../geo/line-stations.js";

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

const line = process.argv[2];
const filter = (process.argv[3] ?? "").toLowerCase();

const stations = await stationsOnLine(line);
const names = stations
	.map((s) => s.name)
	.filter((n) => !filter || n.toLowerCase().includes(filter))
	.sort();
console.log(`${line}: ${stations.length} stations${filter ? ` (filter "${filter}")` : ""}`);
for (const n of names) console.log(`  ${n}`);
process.exit(0);
