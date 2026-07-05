// Throwaway map-QA diagnostic: dump a day's EpisodeGeometry (what the Map tab
// draws) as GeoJSON so we can render it on a basemap and judge the actual map.
// Run via prod-db.sh (needs DB + NC env), e.g.:
//   scripts/prod-db.sh node scripts/dump-episodes-geojson.mjs 2026-06-24 pippijn Europe/London > /tmp/ep.geojson
import { z } from "zod";
import { initPool, withConnection } from "../dist/db/pool.js";
import { migrate } from "../dist/db/schema.js";
import { computeVelocity } from "../dist/geo/velocity.js";

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

const date = process.argv[2] ?? new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const userId = process.argv[3] ?? "pippijn";
const tz = process.argv[4];

initPool(config.db);
await withConnection(migrate);

const { episodes } = await computeVelocity(config, userId, date, tz);

const features = [];
for (let i = 0; i < episodes.length; i++) {
	const e = episodes[i];
	const props = { idx: i, mode: e.mode, kind: e.kind, place: e.place ?? null, startTs: e.startTs, endTs: e.endTs };
	const pts = (e.points ?? []).map((p) => [p.lon, p.lat]);
	if (pts.length >= 2) {
		features.push({ type: "Feature", properties: props, geometry: { type: "LineString", coordinates: pts } });
	} else if (pts.length === 1) {
		features.push({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: pts[0] } });
	}
}
process.stdout.write(JSON.stringify({ type: "FeatureCollection", features }) + "\n");
process.exit(0);
