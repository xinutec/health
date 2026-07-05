// Run the full velocity pipeline for a day and print the episode-kind
// histogram + each road-vehicle leg's kind — confirms road map-matching
// (#261) flows end-to-end through the live OsmAdapter (drivableRoads →
// annotateRoadMatches → episode kind:"matched"), not just in isolation.
//
// Usage (via prod tunnel):
//   scripts/prod-db.sh node scripts/check-episodes.mjs 2026-06-21 pippijn Europe/London

import { z } from "zod";
import { initPool, withConnection } from "../dist/db/pool.js";
import { migrate } from "../dist/db/schema.js";
import { computeVelocity } from "../dist/geo/velocity.js";

const [date, userId, tz] = process.argv.slice(2);
const config = z
	.object({
		db: z.object({
			host: z.string().default("health-db"),
			port: z.coerce.number().default(3306),
			user: z.string(),
			password: z.string(),
			database: z.string().default("health"),
		}),
		nextcloud: z.object({
			baseUrl: z.string().url().default("https://dash.xinutec.org"),
			clientId: z.string().min(1),
			clientSecret: z.string().min(1),
		}),
	})
	.parse({
		db: {
			host: process.env.DB_HOST,
			port: process.env.DB_PORT,
			user: process.env.DB_USER,
			password: process.env.DB_PASSWORD,
			database: process.env.DB_NAME,
		},
		nextcloud: {
			baseUrl: process.env.NC_BASE_URL,
			clientId: process.env.NC_CLIENT_ID,
			clientSecret: process.env.NC_CLIENT_SECRET,
		},
	});

initPool(config.db);
await withConnection(migrate);

const { episodes } = await computeVelocity(config, userId, date, tz);
const road = new Set(["driving", "bus", "cycling"]);
const hist = {};
for (const ep of episodes) hist[ep.kind] = (hist[ep.kind] ?? 0) + 1;
console.log(`episode kinds: ${JSON.stringify(hist)}`);
for (const ep of episodes) {
	if (!road.has(ep.mode)) continue;
	const hhmm = (ts) => new Date(ts * 1000).toISOString().slice(11, 16);
	console.log(`  ${hhmm(ep.startTs)}–${hhmm(ep.endTs)}  ${ep.mode.padEnd(8)} kind=${ep.kind}  ${ep.points.length} pts`);
}
process.exit(0);
