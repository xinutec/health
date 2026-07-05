// 2026-05-22 19:00–23:00 UTC diagnostic — wider window, HR/steps,
// and OSM rail/highway proximity per sampled fix.

import { createConnection } from "mariadb";
import { initPool } from "../dist/db/pool.js";
import { fetchTrackPointsRange, openPhoneTrack } from "../dist/nextcloud/phonetrack.js";

const USER = "pippijn";
const LO = "2026-05-22T19:00:00Z";
const HI = "2026-05-22T23:00:00Z";
const LO_TS = new Date(LO).getTime() / 1000;
const HI_TS = new Date(HI).getTime() / 1000;

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

const c = await createConnection(config.db);
const hhmmss = (t) => new Date(t).toISOString().slice(11, 19);

const hr = await c.query(
	`SELECT ts_utc, bpm FROM heart_rate_intraday
	 WHERE user_id=? AND ts_utc>=? AND ts_utc<? ORDER BY ts_utc`,
	[USER, LO, HI],
);
console.log(`\n=== HR ${LO}–${HI} (n=${hr.length}) ===`);
for (const r of hr) console.log(`  ${hhmmss(r.ts_utc)}  ${r.bpm}`);

const st = await c.query(
	`SELECT ts_utc, steps FROM steps_intraday
	 WHERE user_id=? AND ts_utc>=? AND ts_utc<? ORDER BY ts_utc`,
	[USER, LO, HI],
);
console.log(`\n=== Steps per minute (n=${st.length}) ===`);
for (const r of st) console.log(`  ${hhmmss(r.ts_utc)}  ${r.steps}`);

console.log(`\n=== PhoneTrack GPS fixes ${LO}–${HI} ===`);
const ctx = await openPhoneTrack(config, USER);
const fixes = (await fetchTrackPointsRange(ctx, "2026-05-22", "2026-05-23")).filter(
	(f) => f.ts >= LO_TS && f.ts < HI_TS,
);
for (const f of fixes)
	console.log(
		`  ${hhmmss(f.ts * 1000)}  ${f.lat.toFixed(6)},${f.lon.toFixed(6)}  acc=${f.accuracy ?? "?"}m`,
	);

// nearest rail / highway via point-only distance (skip ST_Buffer)
console.log(`\n=== Nearest rail/highway at sampled fixes ===`);
const samples = fixes.filter((_, i) => i === 0 || i % Math.max(1, Math.floor(fixes.length / 6)) === 0);
for (const f of samples) {
	const point = `POINT(${f.lon} ${f.lat})`;
	const dDeg = 0.005;
	const [r] = await c.query(
		`SELECT name, subtype, ST_AsText(geom) AS wkt, ST_Distance(geom, ST_GeomFromText(?, 4326)) AS d_deg
		 FROM osm_lines WHERE feature_type='railway'
		   AND MBRIntersects(geom, ST_Envelope(ST_GeomFromText(
		     CONCAT('LINESTRING(', ?-?, ' ', ?-?, ',', ?+?, ' ', ?+?, ')'), 4326)))
		 ORDER BY d_deg LIMIT 1`,
		[point, f.lon, dDeg, f.lat, dDeg, f.lon, dDeg, f.lat, dDeg],
	);
	const [hwy] = await c.query(
		`SELECT name, subtype, ST_Distance(geom, ST_GeomFromText(?, 4326)) AS d_deg
		 FROM osm_lines WHERE feature_type='highway'
		   AND MBRIntersects(geom, ST_Envelope(ST_GeomFromText(
		     CONCAT('LINESTRING(', ?-?, ' ', ?-?, ',', ?+?, ' ', ?+?, ')'), 4326)))
		 ORDER BY d_deg LIMIT 1`,
		[point, f.lon, dDeg, f.lat, dDeg, f.lon, dDeg, f.lat, dDeg],
	);
	const mPerDegLat = 111_000;
	const mPerDegLon = 111_000 * Math.cos((f.lat * Math.PI) / 180);
	const railM = r ? Math.round(Number(r.d_deg) * Math.min(mPerDegLat, mPerDegLon)) : null;
	const hwyM = hwy ? Math.round(Number(hwy.d_deg) * Math.min(mPerDegLat, mPerDegLon)) : null;
	console.log(
		`  ${hhmmss(f.ts * 1000)}  @ ${f.lat.toFixed(5)},${f.lon.toFixed(5)}` +
			`  rail: ${r?.name ?? "—"} (${r?.subtype ?? "—"}) @ ~${railM ?? "—"}m` +
			`  hwy: ${hwy?.name ?? "—"} (${hwy?.subtype ?? "—"}) @ ~${hwyM ?? "—"}m`,
	);
}

await c.end();
process.exit(0);
