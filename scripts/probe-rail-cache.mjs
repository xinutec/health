// List rail_route_cache rows matching a LIKE pattern — the quick check when a
// train leg draws raw: is its exact `<board> → <alight> · <line>` key cached?
// Usage: scripts/prod-db.sh node scripts/probe-rail-cache.mjs '%Finchley%'
import { z } from "zod";
import { db, initPool, withConnection } from "../dist/db/pool.js";
import { migrate } from "../dist/db/schema.js";

const pattern = process.argv[2] ?? "%";
const config = z
	.object({
		host: z.string(),
		port: z.coerce.number().default(3306),
		user: z.string(),
		password: z.string(),
		database: z.string(),
	})
	.parse({
		host: process.env.DB_HOST,
		port: process.env.DB_PORT,
		user: process.env.DB_USER,
		password: process.env.DB_PASSWORD,
		database: process.env.DB_NAME,
	});
initPool(config);
await withConnection(migrate);
const rows = await db()
	.selectFrom("rail_route_cache")
	.select(["route_key", "computed_at"])
	.where("route_key", "like", pattern)
	.orderBy("route_key")
	.execute();
for (const r of rows) console.log(`${r.computed_at?.toISOString?.() ?? r.computed_at}  ${r.route_key}`);
console.log(`${rows.length} row(s) for ${pattern}`);
process.exit(0);
