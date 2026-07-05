/**
 * CLI: score the drawn walking lines on a captured day — Phase 0 of
 * `docs/design/episode-geometry.md`.
 *
 * Runs the real pipeline and scores each walking episode's drawn geometry
 * (`walk-score.ts`): tortuosity, step-distance error (vs the pedometer), and
 * mean off-walkable. Prints the same for the RAW fix track alongside, so we can
 * see whether the smoother helps. Run via the DB tunnel:
 *   scripts/prod-db.sh node dist/cli/score-walk.js 2026-06-21 pippijn Europe/London
 */

import { z } from "zod";
import { initPool, withConnection } from "../db/pool.js";
import { migrate } from "../db/schema.js";
import { scoreWalk } from "../eval/walk-score.js";
import { walkableRoads } from "../geo/osm.js";
import { matchWalkSegment } from "../geo/pedestrian-match.js";
import { fractionOffRoad, type RoadGeometry } from "../geo/road-match.js";
import { dateBoundsUtc } from "../geo/timezone.js";
import { computeVelocity, loadBiometrics } from "../geo/velocity.js";
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
	console.error("Usage: node dist/cli/score-walk.js <date> <user> <tz>");
	process.exit(2);
}

function hh(ts: number): string {
	return new Date(ts * 1000).toISOString().slice(11, 16);
}

initPool(config.db);
await withConnection(migrate);

const bounds = dateBoundsUtc(date, tz);
const nextDay = (() => {
	const d = new Date(date);
	d.setDate(d.getDate() + 1);
	return d.toISOString().slice(0, 10);
})();
const rawFixes = (await fetchTrackPoints(config, userId, date, nextDay))
	.filter((p) => p.ts >= bounds.startUtc && p.ts < bounds.endUtc)
	.map((p) => ({ ts: p.ts, lat: p.lat, lon: p.lon, accuracy: p.accuracy }));
const steps = (await loadBiometrics(userId, bounds.startUtc, bounds.endUtc, tz)).steps;

const { episodes } = await computeVelocity(config, userId, date, tz);
const walks = episodes.filter((e) => e.mode === "walking" && e.points.length >= 2);
console.log(`score-walk ${date} ${userId} — ${walks.length} walking leg(s)\n`);

for (const ep of walks) {
	let sumLat = 0;
	let sumLon = 0;
	for (const p of ep.points) {
		sumLat += p.lat;
		sumLon += p.lon;
	}
	const cLat = sumLat / ep.points.length;
	const cLon = sumLon / ep.points.length;
	const roads: RoadGeometry = { ways: await walkableRoads(cLat, cLon, 400) };

	const drawn = ep.points.map((p) => ({ lat: p.lat, lon: p.lon }));
	const rawWin = rawFixes.filter((f) => f.ts >= ep.startTs && f.ts <= ep.endTs);
	const raw = rawWin.map((f) => ({ lat: f.lat, lon: f.lon }));
	const d = scoreWalk(drawn, ep.startTs, ep.endTs, steps, roads);
	const r = scoreWalk(raw, ep.startTs, ep.endTs, steps, roads);
	// Candidate: the pedestrian map-matcher (the proposed replacement for the
	// smoother on on-network legs). null = bailed → smoother/raw stays.
	// WMR env overrides the candidate radius for tuning sweeps.
	const wmr = process.env.WMR ? Number(process.env.WMR) : undefined;
	const matched = matchWalkSegment(rawWin, roads, wmr !== undefined ? { matchRadiusM: wmr } : {});
	const m = matched ? scoreWalk(matched.path, ep.startTs, ep.endTs, steps, roads) : null;
	const off20 = fractionOffRoad(rawWin, roads, 20);

	const fmt = (s: ReturnType<typeof scoreWalk>): string =>
		`tortuosity=${s.tortuosity.toFixed(2)}x len=${s.drawnLengthM.toFixed(0)}m ped=${s.pedometerM?.toFixed(0) ?? "-"}m stepErr=${s.stepDistanceError !== null ? `${(s.stepDistanceError * 100).toFixed(0)}%` : "-"} offWalkMean=${s.offWalkableMeanM?.toFixed(0) ?? "-"}m offWalkP90=${s.offWalkableP90M?.toFixed(0) ?? "-"}m`;
	console.log(
		`── walk ${hh(ep.startTs)}-${hh(ep.endTs)}  kind=${ep.kind}  pts=${ep.points.length}  rawFix>20m=${(off20 * 100).toFixed(0)}%`,
	);
	console.log(`   DRAWN ${fmt(d)}`);
	console.log(`   RAW   ${fmt(r)}`);
	console.log(`   MATCH ${m ? fmt(m) : "(bailed → smoother)"}`);
}
process.exit(0);
