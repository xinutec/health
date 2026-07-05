/** One-off probe: presence_log bracket for a date range — end-of-day vs
 *  next-day dominant place, to check the trailing-stay continuation (#258). */
import { z } from "zod";
import { db, initPool } from "../db/pool.js";

const cfg = z
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
initPool(cfg);

const userId = process.argv[2] ?? "pippijn";
const from = process.argv[3] ?? "2026-06-15";
const to = process.argv[4] ?? "2026-06-20";

const rows = await db()
	.selectFrom("presence_log")
	.select(["date", "dominant_place_id", "end_of_day_place_id"])
	.where("user_id", "=", userId)
	.where("date", ">=", from)
	.where("date", "<=", to)
	.orderBy("date", "asc")
	.execute();

for (const r of rows) {
	console.log(`${String(r.date).slice(0, 10)}  dominant=${r.dominant_place_id}  end_of_day=${r.end_of_day_place_id}`);
}
console.log(`(${rows.length} rows)`);
process.exit(0);
