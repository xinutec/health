// Hit the LIVE /api/velocity exactly as the browser does: mint a valid
// session cookie (sign an existing session id with SESSION_SECRET, the same
// HMAC scheme as middleware/session.ts), fetch the public endpoint, and dump
// the road-vehicle episodes' geometry. This is the authoritative check of
// what the API actually serves — past the in-memory cache, the real ingress.
//
// Usage (DB tunnel + creds from prod-db.sh, SESSION_SECRET passed in env):
//   SESSION_SECRET=... scripts/prod-db.sh node scripts/probe-live-velocity.mjs 2026-06-21

import * as crypto from "node:crypto";
import { z } from "zod";
import { db, initPool, withConnection } from "../dist/db/pool.js";
import { migrate } from "../dist/db/schema.js";

const date = process.argv[2] ?? "2026-06-21";
const BASE = process.env.HEALTH_BASE_URL ?? "https://health.xinutec.org";
const secret = process.env.SESSION_SECRET;
if (!secret) {
	console.error("SESSION_SECRET not set");
	process.exit(2);
}

const config = z
	.object({ host: z.string(), port: z.coerce.number().default(3306), user: z.string(), password: z.string(), database: z.string() })
	.parse({
		host: process.env.DB_HOST,
		port: process.env.DB_PORT,
		user: process.env.DB_USER,
		password: process.env.DB_PASSWORD,
		database: process.env.DB_NAME,
	});

initPool(config);
await withConnection(migrate);

// An existing, non-expired session — sign its id like middleware/session.ts.
const row = await db()
	.selectFrom("sessions")
	.select(["id", "user_id"])
	.where("expires_at", ">", new Date())
	.orderBy("created_at", "desc")
	.executeTakeFirst();
if (!row) {
	console.error("no active session found");
	process.exit(1);
}
const sig = crypto.createHmac("sha256", secret).update(row.id).digest("base64url");
const cookie = `session=${row.id}.${sig}`;

const url = `${BASE}/api/velocity?date=${date}&tz=Europe/London`;
const res = await fetch(url, { headers: { cookie } });
console.log(`GET ${url} -> ${res.status} (user ${row.user_id})`);
if (!res.ok) {
	console.log((await res.text()).slice(0, 300));
	process.exit(1);
}
const body = await res.json();
const eps = body.episodes ?? [];
const hist = {};
for (const e of eps) hist[e.kind] = (hist[e.kind] ?? 0) + 1;
console.log(`episodes: ${eps.length}  kinds=${JSON.stringify(hist)}`);
const ROAD = new Set(["driving", "bus", "cycling"]);
const hh = (ts) => new Date(ts * 1000).toISOString().slice(11, 16);
for (const e of eps) {
	if (!ROAD.has(e.mode)) continue;
	console.log(`  ${hh(e.startTs)}-${hh(e.endTs)} ${e.mode} kind=${e.kind} ${e.points.length} pts`);
	// Print the path so we can see any in-and-out vertices.
	console.log(`    ${e.points.map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join(" ")}`);
}
process.exit(0);
