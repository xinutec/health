// Dump a live train leg's per-fix speed/dwell profile — the stopping-pattern
// evidence that separates a stopping service from an express on shared track
// (e.g. Jubilee vs Met between Wembley Park and Finchley Road).
// Usage: SESSION_SECRET=... scripts/prod-db.sh node scripts/probe-leg-stops.mjs <date> <HH:MM> <HH:MM>
import * as crypto from "node:crypto";
import { z } from "zod";
import { db, initPool, withConnection } from "../dist/db/pool.js";
import { migrate } from "../dist/db/schema.js";

const [date, from, to] = process.argv.slice(2);
const secret = process.env.SESSION_SECRET;
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
const sig = crypto.createHmac("sha256", secret).update(row.id).digest("base64url");
const res = await fetch(`https://health.xinutec.org/api/velocity?date=${date}&tz=Europe/London`, {
	headers: { cookie: `session=${row.id}.${sig}` },
});
const body = await res.json();
const t0 = Math.floor(Date.parse(`${date}T${from}:00Z`) / 1000);
const t1 = Math.floor(Date.parse(`${date}T${to}:00Z`) / 1000);
const pts = (body.points ?? []).filter((p) => p.ts >= t0 && p.ts <= t1);
const hh = (ts) => new Date(ts * 1000).toISOString().slice(11, 19);
console.log(`${pts.length} fixes in window`);
let dwell = null;
for (const p of pts) {
	const v = p.speed_kmh ?? 0;
	const slow = v < 8;
	if (slow && !dwell) dwell = { start: p.ts, lat: p.lat, lon: p.lon };
	if (!slow && dwell) {
		console.log(`  DWELL ${hh(dwell.start)}-${hh(p.ts)} (${p.ts - dwell.start}s) at ${dwell.lat.toFixed(4)},${dwell.lon.toFixed(4)}`);
		dwell = null;
	}
}
if (dwell) console.log(`  DWELL ${hh(dwell.start)}-end at ${dwell.lat.toFixed(4)},${dwell.lon.toFixed(4)}`);
process.exit(0);
