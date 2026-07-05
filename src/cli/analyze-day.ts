/**
 * CLI tool: analyze a day's GPS data through the Kalman filter + segment classifier.
 *
 * Usage (from inside the health pod or locally with DB access):
 *   node dist/cli/analyze-day.js [date] [user] [timezone]
 *
 * Default date: yesterday. Default user: pippijn. Default timezone: UTC.
 */

import { z } from "zod";
import { initPool, withConnection } from "../db/pool.js";
import { migrate } from "../db/schema.js";
import { computeVelocity } from "../geo/velocity.js";
import { clipInferredFuture } from "../sleep/day-state.js";

const config = z
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

const date =
	process.argv[2] ??
	(() => {
		const d = new Date();
		d.setDate(d.getDate() - 1);
		return d.toISOString().slice(0, 10);
	})();

const userId = process.argv[3] ?? "pippijn";
const tz = process.argv[4]; // optional timezone, e.g. "Europe/Amsterdam"

initPool(config.db);
await withConnection(migrate);

console.log(`Analyzing ${date} for user ${userId}${tz ? ` (${tz})` : ""}\n`);

const { points, segments, states: rawStates, episodes, battery } = await computeVelocity(config, userId, date, tz);
// Mirror the API: clip inferred continuations to now (no future assertions).
const states = clipInferredFuture(rawStates, Math.floor(Date.now() / 1000));

console.log(`Filtered points: ${points.length}`);
console.log(`\n=== Segments (${segments.length}) ===`);
const fmt = (ts: number): string => {
	if (tz) {
		return new Date(ts * 1000).toLocaleTimeString("en-GB", {
			timeZone: tz,
			hour: "2-digit",
			minute: "2-digit",
		});
	}
	return new Date(ts * 1000).toISOString().slice(11, 16);
};
for (const s of segments) {
	const dur = Math.round((s.endTs - s.startTs) / 60);
	const finalMode = s.refinedMode ?? s.mode;
	const changed = s.refinedMode && s.refinedMode !== s.mode ? ` (was ${s.mode})` : "";
	let ctx = "";
	if (s.place) ctx = ` @ ${s.place}`;
	else if (s.wayName) ctx = ` on ${s.wayName}`;
	if (s.city) ctx += ` (${s.city})`;
	if (s.refinedReason) ctx += ` [${s.refinedReason}]`;
	const marginStr = s.confidenceMargin >= 100 ? "∞" : s.confidenceMargin.toFixed(1);
	console.log(
		`  ${fmt(s.startTs)}-${fmt(s.endTs)} (${dur.toString().padStart(3)}m) ${finalMode.padEnd(11)}${changed} avg:${s.avgSpeed.toString().padStart(5)}km/h max:${s.maxSpeed.toString().padStart(5)}km/h lin:${s.linearity} conf:${s.confidence} marg:${marginStr}${ctx}`,
	);
	const b = s.biometrics;
	if (b && (b.sampleCount > 0 || b.overlapsSleep || b.stepsTotal !== null)) {
		const parts: string[] = [];
		if (b.sampleCount > 0) parts.push(`HR ${b.hrMean} (min ${b.hrMin} max ${b.hrMax}, n=${b.sampleCount})`);
		if (b.overlapsSleep) parts.push(`sleep ${(b.sleepFraction * 100).toFixed(0)}%`);
		if (b.stepsTotal !== null) parts.push(`${b.stepsTotal} steps`);
		console.log(`              ${parts.join("  ")}`);
	}
}

// DayState rendering — the non-overlapping state sequence with sleep
// folded in as a first-class mode. This is what the "your day" UI
// should eventually consume; printed here alongside segments so the
// CLI mirrors the UI affordance (see CLI-mirrors-UI feedback memory).
console.log(`\n=== States (${states.length}) ===`);
for (const s of states) {
	const dur = Math.round((s.endTs - s.startTs) / 60);
	let ctx = "";
	if (s.place) ctx = ` @ ${s.place}`;
	else if (s.wayName) ctx = ` on ${s.wayName}`;
	if (s.asleep) ctx += " · asleep";
	if (s.inferred) ctx += " · inferred";
	// For sleeping states, show wall-clock minutes "in bed" and the
	// Fitbit minutes_asleep "actual" — same split the dashboard does.
	const durLabel =
		s.mode === "sleeping" && s.minutesAsleep !== undefined && s.minutesAsleep > 0
			? `${dur.toString().padStart(3)}m / ${s.minutesAsleep.toString().padStart(3)}m asleep`
			: `${dur.toString().padStart(3)}m`;
	console.log(`  ${fmt(s.startTs)}-${fmt(s.endTs)} (${durLabel}) ${s.mode.padEnd(11)}${ctx}`);
}

// Episode geometry — what the Map tab draws, 1:1 with the states above.
// `kind` is the geometry provenance; `n` is how many vertices were drawn
// after the per-mode speed filter (a `raw` moving episode that shed fixes
// over its mode ceiling shows fewer than its window held). See
// src/geo/episode-geometry.ts.
console.log(`\n=== Episodes (${episodes.length}) ===`);
for (const e of episodes) {
	const dur = Math.round((e.endTs - e.startTs) / 60);
	const ctx = e.place ? ` @ ${e.place}` : "";
	console.log(
		`  ${fmt(e.startTs)}-${fmt(e.endTs)} (${dur.toString().padStart(3)}m) ${e.mode.padEnd(11)} ${e.kind.padEnd(9)} n=${String(e.points.length).padStart(3)}${ctx}`,
	);
}

// Battery trace — the phone-charge series the Day view's battery
// chart renders, summarised here so the CLI mirrors that affordance.
console.log(`\n=== Battery (${battery.length} samples) ===`);
if (battery.length === 0) {
	console.log(`  no battery readings`);
} else {
	const levels = battery.map((s) => s.level);
	const first = battery[0];
	const last = battery[battery.length - 1];
	const net = last.level - first.level;
	console.log(
		`  ${fmt(first.ts)} ${first.level}%  →  ${fmt(last.ts)} ${last.level}%  (net ${net >= 0 ? "+" : ""}${net}%)`,
	);
	console.log(`  range ${Math.min(...levels)}%–${Math.max(...levels)}%`);
}

console.log(`\n=== Points (sampled every ~2 min) ===`);
const sampleInterval = Math.max(1, Math.floor(points.length / 60));
for (let i = 0; i < points.length; i += sampleInterval) {
	const p = points[i];
	const time = fmt(p.ts);
	const seg = segments.find((s) => p.ts >= s.startTs && p.ts <= s.endTs);
	console.log(
		`  ${time} lat:${p.lat.toFixed(5)} lon:${p.lon.toFixed(5)} spd:${p.speed_kmh.toFixed(1).padStart(5)}km/h brg:${Math.round(p.bearing).toString().padStart(3)} [${seg?.mode ?? "?"}]`,
	);
}

process.exit(0);
