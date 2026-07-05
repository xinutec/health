/**
 * One-off probe: list focus_places clusters near a coordinate with their
 * visit history, to see whether the user's mined history has a real dwell
 * cluster at a spot (separate from how it gets named at render time).
 *
 * Usage: node dist/cli/probe-focus.js <user> <lat> <lon> [radiusM]
 */

import { z } from "zod";
import { db, initPool } from "../db/pool.js";

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
const radius = Number(process.argv[5] ?? "120");

const rows = await db()
	.selectFrom("focus_places")
	.selectAll()
	.where("user_id", "=", userId)
	.where("centroid_lat", ">", lat - 0.003)
	.where("centroid_lat", "<", lat + 0.003)
	.where("centroid_lon", ">", lon - 0.004)
	.where("centroid_lon", "<", lon + 0.004)
	.execute();

const m = (la: number, lo: number) => 111320 * Math.hypot(la - lat, (lo - lon) * Math.cos((lat * Math.PI) / 180));

const near = rows
	.map((r) => ({ ...r, distM: m(Number(r.centroid_lat), Number(r.centroid_lon)) }))
	.filter((r) => r.distM <= radius)
	.sort((a, b) => a.distM - b.distM);

console.log(`focus_places within ${radius} m of ${lat},${lon} for ${userId}:`);
for (const r of near) {
	const first = new Date(r.first_seen_ts * 1000).toISOString().slice(0, 10);
	const last = new Date(r.last_seen_ts * 1000).toISOString().slice(0, 10);
	console.log(
		`  id=${r.id}  ${r.distM.toFixed(0)}m  visits=${r.visit_count} days=${r.unique_days} ` +
			`radius=${r.radius_m}m  label=${r.detected_label ?? r.display_name ?? "(none)"}  ${first}..${last}`,
	);
}
console.log(`(${near.length} clusters)`);
process.exit(0);
