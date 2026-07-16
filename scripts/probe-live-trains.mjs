// Dump the LIVE /api/velocity segment list with rail-relevant detail: mode,
// snappedPath presence, wayName (the board → alight · line label railSnap
// needs), and each train leg's refinedReason. The first stop when a ride on
// the map is not tied to known rails: is the label missing, the triple
// unroutable, or the rail_route_cache row absent?
//
// Usage (DB tunnel + creds from prod-db.sh, SESSION_SECRET passed in env):
//   SESSION_SECRET=... scripts/prod-db.sh node scripts/probe-live-trains.mjs 2026-07-16

import * as crypto from "node:crypto";
import { z } from "zod";
import { db, initPool, withConnection } from "../dist/db/pool.js";
import { migrate } from "../dist/db/schema.js";

const date = process.argv[2];
const BASE = process.env.HEALTH_BASE_URL ?? "https://health.xinutec.org";
const secret = process.env.SESSION_SECRET;
if (!secret || !date) {
	console.error("usage: SESSION_SECRET=... scripts/prod-db.sh node scripts/probe-live-trains.mjs <date>");
	process.exit(2);
}
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

const row = await db()
	.selectFrom("sessions")
	.select(["id"])
	.where("expires_at", ">", new Date())
	.orderBy("created_at", "desc")
	.executeTakeFirst();
if (!row) {
	console.error("no active session found");
	process.exit(1);
}
const sig = crypto.createHmac("sha256", secret).update(row.id).digest("base64url");
const res = await fetch(`${BASE}/api/velocity?date=${date}&tz=Europe/London`, {
	headers: { cookie: `session=${row.id}.${sig}` },
});
console.log(`GET /api/velocity?date=${date} -> ${res.status}`);
const body = await res.json();
const hh = (ts) => new Date(ts * 1000).toISOString().slice(11, 16);
for (const s of body.segments ?? []) {
	const mode = s.refinedMode ?? s.mode;
	if (mode === "sleeping") continue;
	console.log(
		`${hh(s.startTs)}-${hh(s.endTs)} ${mode.padEnd(10)} snap=${s.snappedPath ? "Y" : "·"} | ${s.wayName ?? "·"}`,
	);
	if (mode === "train") console.log(`    reason: ${(s.refinedReason ?? "·").slice(0, 500)}`);
}
process.exit(0);
