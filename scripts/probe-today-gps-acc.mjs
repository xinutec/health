import { initPool } from "../dist/db/pool.js";
import { fetchTrackPointsRange, openPhoneTrack } from "../dist/nextcloud/phonetrack.js";

const USER = "pippijn";
const LO = "2026-06-05T15:00:00Z"; // 16:00 local
const HI = "2026-06-05T17:00:00Z"; // 18:00 local
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
const ctx = await openPhoneTrack(config, USER);
const fixes = (await fetchTrackPointsRange(ctx, "2026-06-05", "2026-06-06")).filter(
	(f) => f.ts >= LO_TS && f.ts < HI_TS,
);
const hhmmss = (t) => new Date(t).toISOString().slice(11, 19);

console.log(`Total fixes in window: ${fixes.length}`);
const accs = fixes.map((f) => f.accuracy ?? null).filter((a) => a !== null);
accs.sort((a, b) => a - b);
const pct = (p) => accs[Math.floor(accs.length * p)];
console.log(`Accuracy (m):  min=${accs[0]}  p25=${pct(0.25)}  p50=${pct(0.5)}  p75=${pct(0.75)}  p90=${pct(0.9)}  max=${accs[accs.length - 1]}`);
console.log(`Mean accuracy: ${(accs.reduce((s, a) => s + a, 0) / accs.length).toFixed(1)}m`);

// Bin by accuracy bracket
const buckets = { "≤5m": 0, "6–10m": 0, "11–20m": 0, "21–50m": 0, "51–100m": 0, ">100m": 0 };
for (const a of accs) {
	if (a <= 5) buckets["≤5m"]++;
	else if (a <= 10) buckets["6–10m"]++;
	else if (a <= 20) buckets["11–20m"]++;
	else if (a <= 50) buckets["21–50m"]++;
	else if (a <= 100) buckets["51–100m"]++;
	else buckets[">100m"]++;
}
console.log(`\nAccuracy distribution:`);
for (const [k, v] of Object.entries(buckets)) console.log(`  ${k.padEnd(10)} ${String(v).padStart(3)}  (${((100 * v) / accs.length).toFixed(0)}%)`);

console.log(`\nFix cadence (samples every N seconds, by 30s bucket):`);
let prev = null;
const gaps = [];
for (const f of fixes) {
	if (prev !== null) gaps.push(f.ts - prev);
	prev = f.ts;
}
gaps.sort((a, b) => a - b);
console.log(`Gap (s): min=${gaps[0]}  p25=${gaps[Math.floor(gaps.length * 0.25)]}  p50=${gaps[Math.floor(gaps.length * 0.5)]}  p75=${gaps[Math.floor(gaps.length * 0.75)]}  max=${gaps[gaps.length - 1]}`);
console.log(`Mean gap: ${(gaps.reduce((s, g) => s + g, 0) / gaps.length).toFixed(1)}s`);

process.exit(0);
