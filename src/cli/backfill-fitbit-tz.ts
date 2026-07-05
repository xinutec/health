/**
 * Phase 3 historical backfill for the per-row tz column.
 *
 * Walks all rows in `steps_intraday`, `heart_rate_intraday`,
 * `sleep_stages`, and `sleep` where `tz IS NULL`, infers each row's
 * recording tz from PhoneTrack GPS history, and updates the row.
 *
 * Inference is **per-day majority** (not per-row nearest-fix), because the
 * watch's tz at a moment lags the user's geographic location — on a travel
 * day, the user can be physically in London while the watch is still on
 * Amsterdam tz from yesterday. The day's wall-clocks were therefore
 * recorded in whichever tz the watch was on *for most of that day*, which
 * matches the majority of PhoneTrack fixes for the day.
 *
 * Fallback chain per date:
 *   1. Majority tz of PhoneTrack fixes for that date.
 *   2. Carry-forward from yesterday's resolved tz (bounded to ≤6h gap).
 *   3. `home_tz` from sync_state (residence tz).
 *   4. `Europe/Amsterdam` as the hardcoded final fallback for this
 *      single-user deployment.
 *
 * Idempotent. Only touches rows where `tz IS NULL`. Safe to re-run.
 *
 * Usage:
 *   node dist/cli/backfill-fitbit-tz.js              # all users
 *   node dist/cli/backfill-fitbit-tz.js <user_id>    # one user
 */

import tzLookup from "tz-lookup";
import { z } from "zod";
import { db, destroyPool, initPool, withConnection } from "../db/pool.js";
import { migrate } from "../db/schema.js";
import { getSyncState } from "../db/sync-state.js";
import { fetchTrackPointsRange, openPhoneTrack, type RawTrackPoint } from "../nextcloud/phonetrack.js";

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

const argUserId = process.argv[2] ?? null;
const HARDCODED_FALLBACK_TZ = "Europe/Amsterdam";
const FIX_LOOKUP_RADIUS_HOURS = 6;

initPool(config.db);
await withConnection(migrate);

async function listUsers(): Promise<string[]> {
	if (argUserId) return [argUserId];
	const rows = await db().selectFrom("nc_tokens").select("user_id").execute();
	return rows.map((r) => r.user_id);
}

/** Round to the nearest day in unix seconds (UTC). Returns the date key string. */
function dayKey(unixTs: number): string {
	const d = new Date(unixTs * 1000);
	return d.toISOString().slice(0, 10);
}

/** Pick the most-common tz from a set of fixes via tz-lookup.
 *  Returns null if the array is empty. Stable tie-break: lexicographic
 *  on the tz name (alphabetically first wins ties — deterministic). */
function majorityTz(fixes: RawTrackPoint[], cache: Map<string, string>): string | null {
	if (fixes.length === 0) return null;
	const counts = new Map<string, number>();
	for (const f of fixes) {
		const key = `${f.lat.toFixed(3)},${f.lon.toFixed(3)}`;
		let tz = cache.get(key);
		if (tz === undefined) {
			tz = tzLookup(f.lat, f.lon);
			cache.set(key, tz);
		}
		counts.set(tz, (counts.get(tz) ?? 0) + 1);
	}
	let best: { tz: string; count: number } | null = null;
	for (const [tz, count] of counts) {
		if (best === null || count > best.count || (count === best.count && tz < best.tz)) {
			best = { tz, count };
		}
	}
	return best?.tz ?? null;
}

/** Find the date range that has tz=NULL rows for this user, across all
 *  three intraday tables. Returns `{ min, max }` date strings (YYYY-MM-DD)
 *  or null if no NULL rows exist. */
async function findNullRange(userId: string): Promise<{ min: string; max: string } | null> {
	const ranges = await Promise.all([
		db()
			.selectFrom("steps_intraday")
			.select((eb) => [eb.fn.min("ts").as("min"), eb.fn.max("ts").as("max")])
			.where("user_id", "=", userId)
			.where("tz", "is", null)
			.executeTakeFirst(),
		db()
			.selectFrom("heart_rate_intraday")
			.select((eb) => [eb.fn.min("ts").as("min"), eb.fn.max("ts").as("max")])
			.where("user_id", "=", userId)
			.where("tz", "is", null)
			.executeTakeFirst(),
		db()
			.selectFrom("sleep_stages")
			.select((eb) => [eb.fn.min("ts").as("min"), eb.fn.max("ts").as("max")])
			.where("user_id", "=", userId)
			.where("tz", "is", null)
			.executeTakeFirst(),
		// sleep is date-keyed, not ts-keyed; the date column holds
		// Fitbit's dateOfSleep (the wake-up day's date). Cast to a
		// pseudo-ts range so we can include it in the same MIN/MAX
		// reduction as the other tables.
		db()
			.selectFrom("sleep")
			.select((eb) => [eb.fn.min("date").as("min"), eb.fn.max("date").as("max")])
			.where("user_id", "=", userId)
			.where("tz", "is", null)
			.executeTakeFirst(),
	]);
	const mins: string[] = [];
	const maxs: string[] = [];
	for (const r of ranges) {
		if (r?.min) mins.push(typeof r.min === "string" ? r.min : (r.min as Date).toISOString());
		if (r?.max) maxs.push(typeof r.max === "string" ? r.max : (r.max as Date).toISOString());
	}
	if (mins.length === 0) return null;
	mins.sort();
	maxs.sort();
	return { min: mins[0].slice(0, 10), max: maxs[maxs.length - 1].slice(0, 10) };
}

/** Fetch all PhoneTrack fixes for a user spanning [startDate, endDateExclusive].
 *  Uses the existing weekly-chunked pattern from refresh-focus-places.ts. */
async function fetchAllFixes(userId: string, startDate: string, endDateExclusive: string): Promise<RawTrackPoint[]> {
	const ctx = await openPhoneTrack({ nextcloud: config.nextcloud }, userId);
	const fixes: RawTrackPoint[] = [];
	const start = new Date(startDate);
	const end = new Date(endDateExclusive);
	for (let chunkStart = new Date(start); chunkStart <= end; chunkStart.setDate(chunkStart.getDate() + 7)) {
		const chunkEnd = new Date(chunkStart);
		chunkEnd.setDate(chunkEnd.getDate() + 7);
		const startStr = chunkStart.toISOString().slice(0, 10);
		const endStr = (chunkEnd > end ? end : chunkEnd).toISOString().slice(0, 10);
		const chunk = await fetchTrackPointsRange(ctx, startStr, endStr);
		fixes.push(...chunk);
	}
	fixes.sort((a, b) => a.ts - b.ts);
	return fixes;
}

/** Group fixes by their UTC date (YYYY-MM-DD). Returns map of date → fix[]. */
function groupByDate(fixes: RawTrackPoint[]): Map<string, RawTrackPoint[]> {
	const groups = new Map<string, RawTrackPoint[]>();
	for (const f of fixes) {
		const date = dayKey(f.ts);
		let arr = groups.get(date);
		if (arr === undefined) {
			arr = [];
			groups.set(date, arr);
		}
		arr.push(f);
	}
	return groups;
}

async function backfillUser(userId: string): Promise<void> {
	const range = await findNullRange(userId);
	if (range === null) {
		console.log(`[${userId}] no tz=NULL rows; nothing to backfill`);
		return;
	}
	console.log(`[${userId}] tz=NULL range: ${range.min} → ${range.max}`);

	const homeTz = (await getSyncState(userId, "home_tz")) ?? HARDCODED_FALLBACK_TZ;
	console.log(`[${userId}] home_tz fallback: ${homeTz}`);

	const t0 = Date.now();
	// Fetch one day past the end to cover wall-clock-rolls-over-midnight cases.
	const endExclusive = new Date(`${range.max}T00:00:00Z`);
	endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
	const fixes = await fetchAllFixes(userId, range.min, endExclusive.toISOString().slice(0, 10));
	const fetchMs = Date.now() - t0;
	console.log(`[${userId}] fetched ${fixes.length} PhoneTrack fixes (${fetchMs}ms)`);

	const byDate = groupByDate(fixes);
	const tzLookupCache = new Map<string, string>();

	// Build the date sequence covering the NULL range (inclusive both ends).
	const startDate = new Date(`${range.min}T00:00:00Z`);
	const endDate = new Date(`${range.max}T00:00:00Z`);
	const dates: string[] = [];
	for (let d = new Date(startDate); d <= endDate; d.setUTCDate(d.getUTCDate() + 1)) {
		dates.push(d.toISOString().slice(0, 10));
	}

	// Resolve tz per date, with carry-forward for empty days.
	const dateTz = new Map<string, string>();
	let lastResolved: { date: string; tz: string } | null = null;
	for (const date of dates) {
		const dayFixes = byDate.get(date) ?? [];
		let resolved = majorityTz(dayFixes, tzLookupCache);
		if (resolved === null) {
			// Carry-forward if last-resolved is within ≤6h of the day's
			// midnight (the user-day's natural start).
			const dayStartUnix = new Date(`${date}T00:00:00Z`).getTime() / 1000;
			if (lastResolved !== null) {
				const lastEndUnix = new Date(`${lastResolved.date}T23:59:59Z`).getTime() / 1000;
				const gapH = (dayStartUnix - lastEndUnix) / 3600;
				if (gapH <= FIX_LOOKUP_RADIUS_HOURS) {
					resolved = lastResolved.tz;
				}
			}
			if (resolved === null) resolved = homeTz;
		}
		dateTz.set(date, resolved);
		lastResolved = { date, tz: resolved };
	}

	// Group dates by tz to issue one UPDATE per (table, tz) batch.
	const tzToDates = new Map<string, string[]>();
	for (const [date, tz] of dateTz) {
		let arr = tzToDates.get(tz);
		if (arr === undefined) {
			arr = [];
			tzToDates.set(tz, arr);
		}
		arr.push(date);
	}

	let totalUpdated = 0;
	await withConnection(async (conn) => {
		for (const [tz, datesForTz] of tzToDates) {
			for (const table of ["steps_intraday", "heart_rate_intraday", "sleep_stages"] as const) {
				let perTableUpdated = 0;
				for (const date of datesForTz) {
					const start = `${date} 00:00:00`;
					const end = `${date} 23:59:59`;
					const result = (await conn.query(
						`UPDATE ${table} SET tz = ? WHERE user_id = ? AND tz IS NULL AND ts >= ? AND ts <= ?`,
						[tz, userId, start, end],
					)) as { affectedRows: number };
					perTableUpdated += result.affectedRows ?? 0;
				}
				if (perTableUpdated > 0) {
					console.log(`[${userId}] ${table}: tagged ${perTableUpdated} rows with ${tz}`);
					totalUpdated += perTableUpdated;
				}
			}
			// sleep is date-keyed (the `date` column is Fitbit's
			// dateOfSleep / wake-up-day). Update via that column rather
			// than a ts range.
			let sleepUpdated = 0;
			for (const date of datesForTz) {
				const result = (await conn.query(`UPDATE sleep SET tz = ? WHERE user_id = ? AND tz IS NULL AND date = ?`, [
					tz,
					userId,
					date,
				])) as { affectedRows: number };
				sleepUpdated += result.affectedRows ?? 0;
			}
			if (sleepUpdated > 0) {
				console.log(`[${userId}] sleep: tagged ${sleepUpdated} rows with ${tz}`);
				totalUpdated += sleepUpdated;
			}
		}
	});
	console.log(`[${userId}] backfill complete: ${totalUpdated} rows updated`);
}

const users = await listUsers();
for (const userId of users) {
	try {
		await backfillUser(userId);
	} catch (e) {
		console.error(`[${userId}] backfill failed:`, e);
	}
}

await destroyPool();
process.exit(0);
