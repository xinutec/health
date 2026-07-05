/**
 * One-off probe: dump raw PhoneTrack fixes with their reported GPS accuracy
 * for a time window, to diagnose underground/coarse-fix classification.
 *
 * Usage: node dist/cli/probe-accuracy.js <date> <user> <fromHHMM> <toHHMM> <tz>
 */

import { z } from "zod";
import { initPool } from "../db/pool.js";
import { fetchTrackPoints } from "../nextcloud/phonetrack.js";

const parsed = z
	.object({
		db: z.object({
			host: z.string().default("health-db"),
			port: z.coerce.number().default(3306),
			user: z.string(),
			password: z.string(),
			database: z.string().default("health"),
		}),
		nextcloud: z.object({
			baseUrl: z.string().url().default("https://dash.xinutec.org"),
			clientId: z.string().min(1),
			clientSecret: z.string().min(1),
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
		nextcloud: {
			baseUrl: process.env.NC_BASE_URL,
			clientId: process.env.NC_CLIENT_ID,
			clientSecret: process.env.NC_CLIENT_SECRET,
		},
	});

initPool(parsed.db);
const config = parsed.nextcloud;

const date = process.argv[2];
const userId = process.argv[3] ?? "pippijn";
const fromHHMM = process.argv[4] ?? "00:00";
const toHHMM = process.argv[5] ?? "23:59";
const tz = process.argv[6] ?? "Europe/London";

const nextDay = new Date(new Date(date).getTime() + 86400000).toISOString().slice(0, 10);
const points = await fetchTrackPoints({ nextcloud: config } as never, userId, date, nextDay);

const hhmm = (ts: number) =>
	new Date(ts * 1000).toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" });

console.log(`raw fixes ${date} ${fromHHMM}-${toHHMM} (${tz}), accuracy in metres:`);
for (const p of points) {
	const t = hhmm(p.ts);
	if (t < fromHHMM || t > toHHMM) continue;
	const acc = p.accuracy == null ? "  null" : `${p.accuracy.toFixed(0).padStart(5)}m`;
	const spd = p.speed == null ? "  ?" : `${(p.speed * 3.6).toFixed(1).padStart(5)}`;
	console.log(`  ${t} lat:${p.lat.toFixed(5)} lon:${p.lon.toFixed(5)} acc:${acc} spd:${spd}km/h`);
}
