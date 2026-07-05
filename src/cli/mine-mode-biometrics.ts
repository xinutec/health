/**
 * Mine per-user mode biometric signatures from historical data.
 *
 * For each user, walks the last N days of (HR, cadence, speed) per minute,
 * labels each minute by heuristic ("definitely walking", "definitely
 * cycling", etc.), aggregates per-mode summary statistics (mean, std,
 * sample count), and writes to `mode_biometrics`.
 *
 * Usage:
 *   node dist/cli/mine-mode-biometrics.js                  # all NC users, default 365 days
 *   node dist/cli/mine-mode-biometrics.js <user_id>        # one user, default 365 days
 *   node dist/cli/mine-mode-biometrics.js <user_id> 730    # one user, 2 years
 */

import { sql } from "kysely";
import { z } from "zod";
import { db, destroyPool, initPool } from "../db/pool.js";
import { migrate } from "../db/schema.js";
import { type FilteredPoint, filterGpsTrack } from "../geo/kalman.js";
import {
	aggregateModeStats,
	labelMinuteByHeuristic,
	type MinuteObservation,
	type ModeStats,
} from "../geo/mode-biometrics.js";
import { fitbitTsToUnix } from "../geo/timezone.js";
import { fetchTrackPointsRange, openPhoneTrack } from "../nextcloud/phonetrack.js";

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

const DEFAULT_LOOKBACK_DAYS = 365;
const CHUNK_DAYS = 7; // process a week at a time to keep memory reasonable

/** Bucket Kalman-filtered points into per-minute average speed. */
function speedPerMinute(points: FilteredPoint[]): Map<number, number> {
	const sums = new Map<number, { total: number; count: number }>();
	for (const p of points) {
		const minute = Math.floor(p.ts / 60) * 60;
		const cur = sums.get(minute) ?? { total: 0, count: 0 };
		cur.total += p.speed_kmh;
		cur.count++;
		sums.set(minute, cur);
	}
	const out = new Map<number, number>();
	for (const [m, { total, count }] of sums) out.set(m, total / count);
	return out;
}

/** Run mining over a [start, end) UTC range, accumulating labeled samples. */
async function mineRange(
	userId: string,
	homeTz: string | undefined,
	ctx: Awaited<ReturnType<typeof openPhoneTrack>>,
	startUtc: number,
	endUtc: number,
): Promise<{ mode: string; obs: MinuteObservation }[]> {
	const padDate = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);
	const startStr = padDate(startUtc);
	const endStr = padDate(endUtc + 86400); // pad

	// HR per minute.
	const hrRows = await db()
		.selectFrom("heart_rate_intraday")
		.select([
			sql<Date>`DATE_FORMAT(MIN(ts), '%Y-%m-%d %H:%i:00')`.as("ts"),
			sql<number>`ROUND(AVG(bpm))`.as("bpm"),
			sql<string | null>`MAX(tz)`.as("tz"),
		])
		.where("user_id", "=", userId)
		.where("ts", ">=", startStr)
		.where("ts", "<", endStr)
		.groupBy(sql`DATE_FORMAT(ts, '%Y-%m-%d %H:%i')`)
		.execute();
	const hrByMinute = new Map<number, number>();
	for (const r of hrRows) {
		const ts = fitbitTsToUnix(r.ts, r.tz ?? homeTz);
		if (Number.isNaN(ts) || ts < startUtc || ts >= endUtc) continue;
		hrByMinute.set(Math.floor(ts / 60) * 60, Number(r.bpm));
	}

	// Steps per minute.
	const stepRows = await db()
		.selectFrom("steps_intraday")
		.select(["ts", "steps", "tz"])
		.where("user_id", "=", userId)
		.where("ts", ">=", startStr)
		.where("ts", "<", endStr)
		.execute();
	const cadenceByMinute = new Map<number, number>();
	for (const r of stepRows) {
		const ts = fitbitTsToUnix(r.ts, r.tz ?? homeTz);
		if (Number.isNaN(ts) || ts < startUtc || ts >= endUtc) continue;
		cadenceByMinute.set(Math.floor(ts / 60) * 60, r.steps);
	}

	// GPS speed per minute. fetchTrackPointsRange wants YYYY-MM-DD strings;
	// pad by a day on each side and trim by ts below.
	const rawPoints = await fetchTrackPointsRange(ctx, padDate(startUtc - 86400), padDate(endUtc + 86400));
	const gpsPoints = rawPoints
		.filter((p) => p.accuracy === null || p.accuracy <= 200)
		.map((p) => ({ ts: p.ts, lat: p.lat, lon: p.lon, accuracy: p.accuracy }));
	const filtered = filterGpsTrack(gpsPoints).filter((p) => p.ts >= startUtc && p.ts < endUtc);
	const speedByMinute = speedPerMinute(filtered);

	// Union of minutes that have any signal — at least one of HR / cadence /
	// speed present. (Pure-null observations are dropped by the labeler.)
	const allMinutes = new Set<number>([...hrByMinute.keys(), ...cadenceByMinute.keys(), ...speedByMinute.keys()]);
	const labeled: { mode: string; obs: MinuteObservation }[] = [];
	for (const m of allMinutes) {
		// Cadence: a minute absent from steps_intraday means "no steps".
		// The table only stores positive-step minutes (see the existing
		// docstring on the table). Treat missing as 0, not as null.
		const obs: MinuteObservation = {
			hr: hrByMinute.get(m) ?? null,
			cadence: cadenceByMinute.get(m) ?? 0,
			speed: speedByMinute.get(m) ?? null,
		};
		const mode = labelMinuteByHeuristic(obs);
		if (mode !== null) labeled.push({ mode, obs });
	}
	return labeled;
}

async function writeStats(userId: string, stats: ModeStats[]): Promise<void> {
	// Replace-in-place: delete prior rows for this user, insert fresh.
	await db().deleteFrom("mode_biometrics").where("user_id", "=", userId).execute();
	if (stats.length === 0) return;
	await db()
		.insertInto("mode_biometrics")
		.values(
			stats.map((s) => ({
				user_id: userId,
				mode: s.mode,
				hr_mean: s.hrMean,
				hr_std: s.hrStd,
				hr_sample_count: s.hrSampleCount,
				cadence_mean: s.cadenceMean,
				cadence_std: s.cadenceStd,
				cadence_sample_count: s.cadenceSampleCount,
				speed_mean: s.speedMean,
				speed_std: s.speedStd,
				speed_sample_count: s.speedSampleCount,
				sample_count: s.sampleCount,
			})),
		)
		.execute();
}

async function mineUser(userId: string, days: number): Promise<void> {
	const ctx = await openPhoneTrack({ nextcloud: config.nextcloud }, userId);
	const homeRow = await db()
		.selectFrom("sync_state")
		.select("value")
		.where("user_id", "=", userId)
		.where("key_name", "=", "home_tz")
		.executeTakeFirst();
	const homeTz = homeRow?.value;

	const now = Math.floor(Date.now() / 1000);
	const start = now - days * 86400;
	const allLabeled: { mode: string; obs: MinuteObservation }[] = [];

	for (let chunkStart = start; chunkStart < now; chunkStart += CHUNK_DAYS * 86400) {
		const chunkEnd = Math.min(chunkStart + CHUNK_DAYS * 86400, now);
		try {
			const labeled = await mineRange(userId, homeTz, ctx, chunkStart, chunkEnd);
			allLabeled.push(...labeled);
			console.log(
				`  ${new Date(chunkStart * 1000).toISOString().slice(0, 10)} → ${new Date(chunkEnd * 1000).toISOString().slice(0, 10)}: +${labeled.length} labeled minutes (running ${allLabeled.length})`,
			);
		} catch (e) {
			console.warn(`  chunk ${chunkStart}-${chunkEnd} failed: ${e}`);
		}
	}

	// Exclude cycling from the mined signatures. The user cycles only
	// rarely, so almost every minute the heuristic labels "cycling" is a
	// mislabelled slow drive or brisk walk. A cycling row would let the
	// re-classifier flip yet more segments into phantom cycling — a
	// feedback loop. Genuine cycling is recognised by positive evidence
	// (gateCycling), not by a mined signature.
	const stats = aggregateModeStats(allLabeled).filter((s) => s.mode !== "cycling");
	stats.sort((a, b) => b.sampleCount - a.sampleCount);
	console.log(`\nUser ${userId}:`);
	for (const s of stats) {
		const hr = s.hrMean !== null && s.hrStd !== null ? `HR ${s.hrMean.toFixed(1)}±${s.hrStd.toFixed(1)}` : "HR -";
		const cad =
			s.cadenceMean !== null && s.cadenceStd !== null
				? `cad ${s.cadenceMean.toFixed(1)}±${s.cadenceStd.toFixed(1)}`
				: "cad -";
		const spd =
			s.speedMean !== null && s.speedStd !== null ? `spd ${s.speedMean.toFixed(1)}±${s.speedStd.toFixed(1)}` : "spd -";
		console.log(`  ${s.mode.padEnd(11)} n=${s.sampleCount.toString().padStart(6)}  ${hr}  ${cad}  ${spd}`);
	}

	await writeStats(userId, stats);
	console.log(`  → wrote ${stats.length} mode rows to mode_biometrics`);
}

async function main(): Promise<void> {
	const arg1 = process.argv[2];
	const arg2 = process.argv[3];
	const userId = arg1;
	const days = arg2 ? Number.parseInt(arg2, 10) : DEFAULT_LOOKBACK_DAYS;

	await initPool(config.db);
	const { withConnection } = await import("../db/pool.js");
	await withConnection(migrate);

	try {
		if (userId) {
			await mineUser(userId, days);
		} else {
			const users = await db().selectFrom("nc_tokens").select("user_id").execute();
			for (const u of users) {
				await mineUser(u.user_id, days);
			}
		}
	} finally {
		await destroyPool();
	}
}

await main();
