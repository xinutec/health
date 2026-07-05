/** One-off probe: what weight/body history do we have for a user. */
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

const rows = await db()
	.selectFrom("body")
	.select(["date", "weight_kg", "bmi", "body_fat_pct"])
	.where("user_id", "=", userId)
	.orderBy("date", "asc")
	.execute();

const withWeight = rows.filter((r) => r.weight_kg != null);
console.log(`body rows for ${userId}: ${rows.length} total, ${withWeight.length} with a weight`);
if (withWeight.length > 0) {
	const f = withWeight[0];
	const l = withWeight[withWeight.length - 1];
	console.log(`  range: ${String(f.date).slice(0, 10)} → ${String(l.date).slice(0, 10)}`);
	console.log("  first :", String(f.date).slice(0, 10), `${f.weight_kg} kg  bmi=${f.bmi}  fat%=${f.body_fat_pct}`);
	console.log("  latest:", String(l.date).slice(0, 10), `${l.weight_kg} kg  bmi=${l.bmi}  fat%=${l.body_fat_pct}`);
	const weights = withWeight.map((r) => Number(r.weight_kg));
	console.log(`  min/max weight: ${Math.min(...weights)} / ${Math.max(...weights)} kg`);
}
process.exit(0);
