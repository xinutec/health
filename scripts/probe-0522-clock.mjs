// One-off: lay PhoneTrack GPS fixes and Fitbit intraday (steps/HR) for
// the 2026-05-22 evening on a single explicit timeline, to settle #185 —
// is there a real GPS-vs-Fitbit clock offset (a true time-shift), or was
// the apparent "~50-min shift" just UTC-vs-BST confusion in the prior
// analysis?
//
// Run: scripts/prod-db.sh node scripts/probe-0522-clock.mjs
import { createConnection } from "mariadb";
import { fetchTrackPointsRange, openPhoneTrack } from "../dist/nextcloud/phonetrack.js";
import { initPool } from "../dist/db/pool.js";

const USER = "pippijn";
// 2026-05-22 evening window in UTC epoch seconds. BST = UTC+1, so this
// covers 19:00–22:00 local.
const LO = Date.parse("2026-05-22T18:00:00Z") / 1000;
const HI = Date.parse("2026-05-22T21:00:00Z") / 1000;

// Royal Free Hospital footprint (from the narrative) — to flag the
// arrival fix.
const RF_LAT = 51.5535;
const RF_LON = -0.1662;
const near = (lat, lon, a, b) => Math.abs(lat - a) < 0.0025 && Math.abs(lon - b) < 0.0025;

const utc = (epochS) => new Date(epochS * 1000).toISOString().slice(11, 19);
const bst = (epochS) => new Date(epochS * 1000 + 3600_000).toISOString().slice(11, 19); // +1h

const config = {
	db: {
		host: process.env.DB_HOST,
		port: Number(process.env.DB_PORT),
		user: process.env.DB_USER,
		password: process.env.DB_PASSWORD,
		database: process.env.DB_NAME ?? "health",
	},
	nextcloud: {
		baseUrl: process.env.NC_BASE_URL ?? "https://dash.xinutec.org",
		clientId: process.env.NC_CLIENT_ID,
		clientSecret: process.env.NC_CLIENT_SECRET,
	},
};
initPool(config.db);

const ctx = await openPhoneTrack(config, USER);
const fixes = (await fetchTrackPointsRange(ctx, "2026-05-22", "2026-05-23")).filter((f) => f.ts >= LO && f.ts < HI);

console.log("=== PhoneTrack GPS fixes (UTC | BST) — evening 2026-05-22 ===");
let firstRF = null;
let prev = null;
for (const f of fixes) {
	const atRF = near(f.lat, f.lon, RF_LAT, RF_LON);
	if (atRF && firstRF === null) firstRF = f.ts;
	// only print movement boundaries + the RF arrival to keep it short
	const moved = prev === null || Math.abs(f.lat - prev.lat) > 0.002 || Math.abs(f.lon - prev.lon) > 0.002;
	if (moved || atRF) {
		console.log(`  ${utc(f.ts)}Z | ${bst(f.ts)} BST  ${f.lat.toFixed(4)},${f.lon.toFixed(4)}${atRF ? "  <-- Royal Free" : ""}`);
	}
	prev = f;
}
if (firstRF !== null) {
	console.log(`\n  >>> First Royal Free fix:  ${utc(firstRF)}Z  =  ${bst(firstRF)} BST`);
}

const c = await createConnection(config.db);
const fmtRows = async (table, col) => {
	const rows = await c.query(
		`SELECT ts_utc, ${col} AS v FROM ${table}
		 WHERE user_id=? AND ts_utc >= '2026-05-22T18:00:00Z' AND ts_utc < '2026-05-22T21:00:00Z' AND ${col} > 0
		 ORDER BY ts_utc`,
		[USER],
	);
	return rows;
};
const steps = await fmtRows("steps_intraday", "steps");
console.log(`\n=== Fitbit steps_intraday (ts_utc as stored) — non-zero, evening ===`);
for (const r of steps) {
	const t = new Date(r.ts_utc).toISOString().slice(11, 19);
	console.log(`  ${t}  steps=${r.v}`);
}
await c.end();
process.exit(0);
