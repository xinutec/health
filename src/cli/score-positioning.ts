/**
 * CLI: score the drawn map line's POSITION accuracy on a captured day —
 * Phase 0 baseline of `docs/proposals/geometry-roadmap.md`.
 *
 * Runs the real pipeline (`computeVelocity`) and scores each road-vehicle
 * episode's drawn geometry with `position-score.ts`:
 *   - cross-track to the reliable-GPS reference (catches the Kalman swing)
 *   - distance to the nearest drivable road (catches off-road drawing)
 * and prints, alongside, the same scores for the RAW fix track, so we can
 * see whether the processing helps or hurts vs drawing the raw fixes.
 *
 * This is the number the map-constrained estimator (Phase 1+) must improve:
 * cross-track should drop without onRoad rising. Run via the DB tunnel:
 *   scripts/prod-db.sh node dist/cli/score-positioning.js 2026-06-21 pippijn Europe/London
 */

import { z } from "zod";
import { initPool, withConnection } from "../db/pool.js";
import { migrate } from "../db/schema.js";
import { type DistStats, type ScoredFix, scorePositioning } from "../eval/position-score.js";
import { drivableRoads } from "../geo/osm.js";
import type { RoadGeometry } from "../geo/road-match.js";
import { dateBoundsUtc } from "../geo/timezone.js";
import { computeVelocity } from "../geo/velocity.js";
import { fetchTrackPoints } from "../nextcloud/phonetrack.js";

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

const [date, userId, tz] = process.argv.slice(2);
if (!date || !userId || !tz) {
	console.error("Usage: node dist/cli/score-positioning.js <date> <user> <tz>");
	process.exit(2);
}

const ROAD_MODES = new Set(["driving", "bus", "cycling"]);

function fmt(s: DistStats): string {
	return `med=${s.median.toFixed(0)} p90=${s.p90.toFixed(0)} max=${s.max.toFixed(0)} (n=${s.n})`;
}
function hh(ts: number): string {
	return new Date(ts * 1000).toISOString().slice(11, 16);
}

initPool(config.db);
await withConnection(migrate);

const nextDay = (() => {
	const d = new Date(date);
	d.setDate(d.getDate() + 1);
	return d.toISOString().slice(0, 10);
})();
const bounds = dateBoundsUtc(date, tz);
const rawFixes: ScoredFix[] = (await fetchTrackPoints(config, userId, date, nextDay))
	.filter((p) => p.ts >= bounds.startUtc && p.ts < bounds.endUtc)
	.map((p) => ({ ts: p.ts, lat: p.lat, lon: p.lon, accuracy: p.accuracy }));

const { episodes } = await computeVelocity(config, userId, date, tz);
const roadEps = episodes.filter((e) => ROAD_MODES.has(e.mode) && e.points.length >= 2);
console.log(`score-positioning ${date} ${userId} — ${roadEps.length} road-vehicle leg(s)\n`);

for (const [i, ep] of roadEps.entries()) {
	const legFixes = rawFixes.filter((f) => f.ts >= ep.startTs && f.ts <= ep.endTs);
	if (legFixes.length === 0) continue;
	let sumLat = 0;
	let sumLon = 0;
	for (const f of legFixes) {
		sumLat += f.lat;
		sumLon += f.lon;
	}
	const cLat = sumLat / legFixes.length;
	const cLon = sumLon / legFixes.length;
	let radius = 0;
	for (const f of legFixes) {
		const d = Math.hypot((f.lat - cLat) * 111_320, (f.lon - cLon) * 111_320 * Math.cos((cLat * Math.PI) / 180));
		if (d > radius) radius = d;
	}
	const roads: RoadGeometry = { ways: await drivableRoads(cLat, cLon, Math.round(radius) + 300) };

	const drawn = ep.points.map((p) => ({ lat: p.lat, lon: p.lon }));
	const rawTrack = legFixes.map((f) => ({ lat: f.lat, lon: f.lon }));
	const drawnScore = scorePositioning(drawn, legFixes, roads);
	const rawScore = scorePositioning(rawTrack, legFixes, roads);

	console.log(`── leg ${i} (${ep.mode}, kind=${ep.kind}) ${hh(ep.startTs)}-${hh(ep.endTs)}  ${legFixes.length} fixes`);
	console.log(`   DRAWN  cross-track: ${fmt(drawnScore.crossTrack)}   on-road: ${fmt(drawnScore.onRoad)}`);
	console.log(`   RAW    cross-track: ${fmt(rawScore.crossTrack)}   on-road: ${fmt(rawScore.onRoad)}`);
}
process.exit(0);
