// One-shot: how often is the user near a given (lat, lon) during a
// time range, broken down by date + time-of-day? Used to cross-check
// "is this place where pippijn habitually sleeps / stays?" against
// the GPS history. Reads via the production NC PhoneTrack API
// (scripts/prod-db.sh sets the env).
import { openPhoneTrack, fetchTrackPointsRange } from "../dist/nextcloud/phonetrack.js";
import { initPool, withConnection } from "../dist/db/pool.js";
import { migrate } from "../dist/db/schema.js";

const targetLat = Number(process.argv[2]);
const targetLon = Number(process.argv[3]);
const startDate = process.argv[4];
const endDate = process.argv[5];
const userId = process.argv[6] ?? "pippijn";
const radiusM = Number(process.argv[7] ?? 200);

if (!Number.isFinite(targetLat) || !Number.isFinite(targetLon) || !startDate || !endDate) {
	console.error(
		"usage: check-place-presence.mjs <lat> <lon> <start-date YYYY-MM-DD> <end-date YYYY-MM-DD> [userId=pippijn] [radius-m=200]",
	);
	process.exit(2);
}

const EARTH = 6371000;
const toRad = (d) => (d * Math.PI) / 180;
function distM(lat, lon) {
	const dLat = toRad(lat - targetLat);
	const dLon = toRad(lon - targetLon);
	const la = toRad(targetLat);
	const lb = toRad(lat);
	const x = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLon / 2) ** 2;
	return 2 * EARTH * Math.asin(Math.sqrt(x));
}

const dbConfig = {
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: process.env.DB_NAME,
};
const ncConfig = {
	nextcloud: { baseUrl: process.env.NC_BASE_URL ?? "https://dash.xinutec.org" },
};

initPool(dbConfig);
await withConnection(migrate);

const ctx = await openPhoneTrack(ncConfig, userId);
console.error(`fetching ${startDate} → ${endDate} (radius ${radiusM} m)`);

// Iterate day by day so we can attribute per-night clusters cleanly.
const nights = [];
const cur = new Date(`${startDate}T00:00:00Z`);
const end = new Date(`${endDate}T00:00:00Z`);
while (cur < end) {
	const d = cur.toISOString().slice(0, 10);
	const next = new Date(cur);
	next.setUTCDate(next.getUTCDate() + 1);
	const dn = next.toISOString().slice(0, 10);
	try {
		const fixes = await fetchTrackPointsRange(ctx, d, dn);
		const inRange = fixes.filter((p) => distM(p.lat, p.lon) <= radiusM);
		nights.push({ date: d, totalFixes: fixes.length, inRange });
	} catch (e) {
		nights.push({ date: d, totalFixes: 0, inRange: [], err: String(e) });
	}
	cur.setUTCDate(cur.getUTCDate() + 1);
}

console.log("\n=== presence by date (Europe/Amsterdam wall time) ===");
const fmt = (ts) => new Date(ts * 1000).toLocaleTimeString("en-GB", { timeZone: "Europe/Amsterdam", hour: "2-digit", minute: "2-digit" });
for (const n of nights) {
	if (n.err) {
		console.log(`  ${n.date}: error ${n.err}`);
		continue;
	}
	if (n.inRange.length === 0) {
		console.log(`  ${n.date}: 0 / ${n.totalFixes} fixes near target`);
		continue;
	}
	const first = fmt(n.inRange[0].ts);
	const last = fmt(n.inRange[n.inRange.length - 1].ts);
	const sleepHourCount = n.inRange.filter((p) => {
		const h = new Date(p.ts * 1000).toLocaleString("en-GB", {
			timeZone: "Europe/Amsterdam",
			hour: "2-digit",
			hourCycle: "h23",
		});
		const hr = Number.parseInt(h, 10);
		return hr >= 23 || hr < 7;
	}).length;
	console.log(
		`  ${n.date}: ${n.inRange.length} / ${n.totalFixes} fixes near target | first ${first} last ${last} | overnight(23-07) ${sleepHourCount}`,
	);
}

process.exit(0);
