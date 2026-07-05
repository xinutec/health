/**
 * Diagnostic: dump a user's focus_places sorted by total_dwell_sec.
 * Used during the Phase 1.7 HMM audit to verify initial-state priors
 * weight the right places (Home should be the top by a wide margin).
 */
import { z } from "zod";
import { db, initPool, withConnection } from "../db/pool.js";
import { migrate } from "../db/schema.js";

const config = z
	.object({
		db: z.object({
			host: z.string(),
			port: z.coerce.number(),
			user: z.string(),
			password: z.string(),
			database: z.string(),
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
	});

initPool(config.db);
await withConnection(migrate);

const userId = process.argv[2] ?? "pippijn";
const limit = Number(process.argv[3] ?? 20);

const rows = await db()
	.selectFrom("focus_places")
	.where("user_id", "=", userId)
	.select(["id", "display_name", "centroid_lat", "centroid_lon", "total_dwell_sec"])
	.orderBy("total_dwell_sec", "desc")
	.limit(limit)
	.execute();

const total = rows.reduce((s, r) => s + Number(r.total_dwell_sec), 0);
console.log(`# focus_places for user=${userId} — top ${rows.length} by dwell (total=${(total / 3600).toFixed(0)}h)`);
for (const r of rows) {
	const w = Number(r.total_dwell_sec) / total;
	console.log(
		`  #${r.id.toString().padEnd(5)} ${(r.display_name ?? "(no name)").padEnd(36)}  dwell=${(Number(r.total_dwell_sec) / 3600).toFixed(1).padStart(7)}h  frac=${(w * 100).toFixed(2).padStart(6)}%  centroid=(${r.centroid_lat}, ${r.centroid_lon})`,
	);
}
process.exit(0);
