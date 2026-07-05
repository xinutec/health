/**
 * One-off probe: run the real venue ranker on a stay and dump the per-candidate
 * log-evidence breakdown, to see exactly why one venue out-scores another.
 *
 * Usage: node dist/cli/probe-rank.js <user> <lat> <lon> <startISO> <endISO> <tz>
 */

import { z } from "zod";
import { db, initPool } from "../db/pool.js";
import { dbOsmAdapter } from "../geo/osm-adapter.js";
import { rankVenues, type VenuePriors } from "../geo/venue-prior.js";

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

const userId = process.argv[2] ?? "pippijn";
const lat = Number(process.argv[3]);
const lon = Number(process.argv[4]);
const startUnix = Math.floor(new Date(process.argv[5]).getTime() / 1000);
const endUnix = Math.floor(new Date(process.argv[6]).getTime() / 1000);
const tz = process.argv[7] ?? "Europe/London";

let priors: VenuePriors | null = null;
const row = await db()
	.selectFrom("venue_type_priors")
	.select("priors_json")
	.where("user_id", "=", userId)
	.executeTakeFirst();
if (row) priors = JSON.parse(row.priors_json) as VenuePriors;

const landmarks = await dbOsmAdapter.nearbyLandmarks(lat, lon, 100);
const ranked = rankVenues(landmarks, { startUnix, endUnix, tz }, priors);

console.log(`venue ranking at ${lat},${lon}  (priors: ${priors ? "loaded" : "NONE"})`);
console.log("  total   dist   venue  shape  hours   dist(m)  subtype          name");
for (const r of ranked) {
	const p = r.parts;
	const f = (n: number | null) => (n === null ? "  -  " : n.toFixed(2).padStart(5));
	console.log(
		`  ${r.total.toFixed(2).padStart(5)}  ${f(p.distance)}  ${f(p.venue)}  ${f(p.shape)}  ${f(p.hours)}   ` +
			`${r.landmark.distanceM.toFixed(0).padStart(4)}m   ${r.landmark.subtype.padEnd(15)} ${r.landmark.name}`,
	);
}
process.exit(0);
