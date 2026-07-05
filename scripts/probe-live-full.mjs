// Dump the LIVE /api/velocity full episode sequence (mode, kind, endpoints,
// point count) so we can see how the drawn line is assembled near home —
// in particular whether a visual "step" is the GPS itself or a connector
// between two episodes (the map bridges each episode to the previous one's
// last drawn point).

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
	.parse({ host: process.env.DB_HOST, port: process.env.DB_PORT, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
initPool(config);
await withConnection(migrate);

const row = await db().selectFrom("sessions").select(["id"]).where("expires_at", ">", new Date()).orderBy("created_at", "desc").executeTakeFirst();
const sig = crypto.createHmac("sha256", secret).update(row.id).digest("base64url");
const res = await fetch(`${BASE}/api/velocity?date=${date}&tz=Europe/London`, { headers: { cookie: `session=${row.id}.${sig}` } });
const body = await res.json();
const hh = (ts) => new Date(ts * 1000).toISOString().slice(11, 16);
const fmt = (p) => (p ? `${p.lat.toFixed(5)},${p.lon.toFixed(5)}` : "—");
function m(a, b) {
	if (!a || !b) return 0;
	const dl = (b.lat - a.lat) * 111320, dn = (b.lon - a.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180);
	return Math.hypot(dl, dn);
}
let prevLast = null;
for (const e of body.episodes ?? []) {
	const first = e.points[0];
	const last = e.points[e.points.length - 1];
	const gap = prevLast && first ? m(prevLast, first) : 0;
	console.log(`${hh(e.startTs)}-${hh(e.endTs)} ${e.mode.padEnd(10)} ${e.kind.padEnd(9)} pts=${String(e.points.length).padStart(2)}  first=${fmt(first)} last=${fmt(last)}  ${gap > 25 ? `CONNECTOR-GAP=${gap.toFixed(0)}m <<<` : ""}`);
	if (e.points.length > 0) prevLast = last;
}
process.exit(0);
