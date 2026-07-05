#!/usr/bin/env node
// Fuse location + steps + heart-rate for one window so a human can read
// walking-vs-sitting and the path directly. Read-only.
//
//   prod-db.sh node scripts/probe-day-fusion.mjs 2026-06-09T15:30:00Z 2026-06-09T21:10:00Z
import { initPool, db } from "../dist/db/pool.js";
import { fetchTrackPointsRange, openPhoneTrack } from "../dist/nextcloud/phonetrack.js";

const USER = "pippijn";
const LO = process.argv[2];
const HI = process.argv[3];
const loTs = new Date(LO).getTime() / 1000;
const hiTs = new Date(HI).getTime() / 1000;

const config = {
	db: {
		host: process.env.DB_HOST,
		port: Number(process.env.DB_PORT),
		user: process.env.DB_USER,
		password: process.env.DB_PASSWORD,
		database: "health",
	},
	nextcloud: {
		baseUrl: process.env.NC_BASE_URL ?? "https://dash.xinutec.org",
		clientId: process.env.NC_CLIENT_ID,
		clientSecret: process.env.NC_CLIENT_SECRET,
	},
};
initPool(config.db);

const local = (unix) =>
	new Date(unix * 1000).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour12: false });
const haversine = (a, b) => {
	const R = 6371000;
	const dLat = ((b.lat - a.lat) * Math.PI) / 180;
	const dLon = ((b.lon - a.lon) * Math.PI) / 180;
	const la1 = (a.lat * Math.PI) / 180;
	const la2 = (b.lat * Math.PI) / 180;
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(h));
};

// --- steps + HR per minute -----------------------------------------------
const steps = await db()
	.selectFrom("steps_intraday")
	.where("user_id", "=", USER)
	.where("ts_utc", ">=", new Date(LO))
	.where("ts_utc", "<", new Date(HI))
	.select(["ts_utc", "steps"])
	.orderBy("ts_utc")
	.execute();
const hr = await db()
	.selectFrom("heart_rate_intraday")
	.where("user_id", "=", USER)
	.where("ts_utc", ">=", new Date(LO))
	.where("ts_utc", "<", new Date(HI))
	.select(["ts_utc", "bpm"])
	.orderBy("ts_utc")
	.execute();
const stepByMin = new Map();
for (const r of steps) stepByMin.set(new Date(r.ts_utc).toISOString().slice(0, 16), r.steps);
const hrByMin = new Map();
for (const r of hr) {
	const k = new Date(r.ts_utc).toISOString().slice(0, 16);
	(hrByMin.get(k) ?? hrByMin.set(k, []).get(k)).push(r.bpm);
}

console.log("=== per-minute steps + HR (only minutes with steps>0 or an HR sample) ===");
console.log("time   steps  hr   note");
const mins = new Set([...stepByMin.keys(), ...hrByMin.keys()].sort());
for (const k of mins) {
	const s = stepByMin.get(k) ?? 0;
	const hrs = hrByMin.get(k) ?? [];
	const meanHr = hrs.length ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : "";
	const t = new Date(`${k}:00Z`).toLocaleTimeString("en-GB", { timeZone: "Europe/London", hour12: false }).slice(0, 5);
	if (s === 0 && hrs.length === 0) continue;
	const note = s >= 30 ? "WALK" : s >= 8 ? "steps" : "";
	console.log(`${t}  ${String(s).padStart(4)}  ${String(meanHr).padStart(3)}  ${note}`);
}

// --- location fixes ------------------------------------------------------
const ctx = await openPhoneTrack(config, USER);
const pts = (await fetchTrackPointsRange(ctx, LO, HI))
	.filter((p) => p.ts >= loTs && p.ts <= hiTs)
	.sort((a, b) => a.ts - b.ts);
console.log(`\n=== location fixes (n=${pts.length}) — gaps >3min and jumps >300m flagged ===`);
console.log("time   lat       lon       acc   Δt     Δm");
let prev = null;
for (const p of pts) {
	const dt = prev ? Math.round((p.ts - prev.ts) / 60) : 0;
	const dm = prev ? Math.round(haversine(prev, p)) : 0;
	const flag = prev && (p.ts - prev.ts > 180 || dm > 300) ? "  ◄gap/jump" : "";
	console.log(
		`${local(p.ts).slice(0, 5)}  ${p.lat.toFixed(5)}  ${p.lon.toFixed(5)}  ${String(Math.round(p.accuracy ?? 0)).padStart(4)}  ${String(dt).padStart(3)}m  ${String(dm).padStart(5)}${flag}`,
	);
	prev = p;
}
process.exit(0);
