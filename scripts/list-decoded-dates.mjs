#!/usr/bin/env node
// List dates pippijn has decoded_days rows for, in chronological order.
import { db, initPool } from "../dist/db/pool.js";

initPool({
	host: process.env.DB_HOST,
	port: process.env.DB_PORT,
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: process.env.DB_NAME,
});

const rows = await db()
	.selectFrom("decoded_days")
	.where("user_id", "=", "pippijn")
	.orderBy("date")
	.select(["date"])
	.execute();
for (const r of rows) console.log(r.date);
process.exit(0);
