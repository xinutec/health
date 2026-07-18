// Side-effect import: makes BigInt JSON-serialisable (Fitbit sleep
// log IDs are now bigint). Must be the first thing this process
// pulls in.
import "./bigint-json.js";
import {
	backfillStreamDay,
	type IntradayStream,
	prevDayBounded,
	prevWindowBounded,
	type RangeStream,
	shouldAdvanceEmptyStreak,
	sortStreamsByCursorRecency,
} from "./backfill.js";
import { loadSyncConfig } from "./config.js";
import { db, destroyPool, initPool, withConnection } from "./db/pool.js";
import { migrate } from "./db/schema.js";
import { getSyncState, setSyncState } from "./db/sync-state.js";
import { FitbitClient } from "./fitbit/client.js";
import { RateLimitExhaustedError } from "./fitbit/rate-limit.js";
import { syncActivity } from "./fitbit/sync/activity.js";
import { syncBreathingRate } from "./fitbit/sync/breathing.js";
import { syncDevices } from "./fitbit/sync/devices.js";
import { syncHeartRateIntraday, syncHeartRateZones } from "./fitbit/sync/heartrate.js";
import { syncHrv, syncHrvIntraday } from "./fitbit/sync/hrv.js";
import { syncSleep } from "./fitbit/sync/sleep.js";
import { syncSpO2Daily } from "./fitbit/sync/spo2.js";
import { syncStepsIntraday } from "./fitbit/sync/steps.js";
import { syncTemperature } from "./fitbit/sync/temperature.js";
import { buildForwardTzSource, NULL_TZ_SOURCE, type TzSource } from "./geo/fitbit-tz.js";
import { runGoogleWeightSync } from "./google/body.js";
import { googleCredsFromEnv } from "./google/oauth.js";
import { fetchTrackPointsRange, openPhoneTrack, type RawTrackPoint } from "./nextcloud/phonetrack.js";

function formatDate(d: Date): string {
	return d.toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
	const d = new Date();
	d.setDate(d.getDate() - n);
	return formatDate(d);
}

/** Forward sync always re-queries at least the last this-many days, even
 *  once the stored cursor has advanced past them. Fitbit only finalizes a
 *  day's sleep / biometrics after you wake, and can revise a recent day,
 *  so a window of just [cursor, today] would permanently miss anything
 *  Fitbit completed after the cursor moved past that date (e.g. last
 *  night's sleep, if every sync that day ran while you were still
 *  asleep). Re-fetch is idempotent (upsert / delete-then-insert per log),
 *  so the overlap is safe; 2 days back ≈ a few extra cheap calls per run. */
const SYNC_OVERLAP_DAYS = 2;

/** Earliest date the backfill is allowed to consider. Fitbit's first
 *  consumer tracker shipped in 2008; before 2010 the API has no data for
 *  anyone. Without this floor a stuck loop can walk into negative years
 *  and produce malformed cursor strings (the bug fix this constant is
 *  part of). */
const BACKFILL_FLOOR_DATE = "2010-01-01";

/** One-time, idempotent: migrate the pre-2026-05-10 single-stream
 *  backfill keys (`backfill_cursor`, `backfill_complete`) into the
 *  per-stream namespace under the `hr_intraday` stream — that's what
 *  the legacy keys actually drove. Steps and future streams start
 *  fresh under their own keys. */
async function migrateLegacyBackfillKeys(userId: string): Promise<void> {
	const legacyCursor = await getSyncState(userId, "backfill_cursor");
	const legacyComplete = await getSyncState(userId, "backfill_complete");
	if (legacyCursor !== null) {
		const newCursor = await getSyncState(userId, "backfill_hr_intraday_cursor");
		if (newCursor === null) {
			await setSyncState(userId, "backfill_hr_intraday_cursor", legacyCursor);
		}
	}
	if (legacyComplete !== null) {
		const newComplete = await getSyncState(userId, "backfill_hr_intraday_complete");
		if (newComplete === null) {
			await setSyncState(userId, "backfill_hr_intraday_complete", legacyComplete);
		}
	}
}

/** Wrapper around the pure sortStreamsByCursorRecency helper: fetches each
 *  stream's stored cursor from sync_state and feeds it into the sort. */
async function orderStreamsByCursorRecency<T extends { name: string }>(
	userId: string,
	streams: T[],
	defaultStartDate: string,
): Promise<T[]> {
	const cursors = new Map<string, string>();
	for (const s of streams) {
		const stored = await getSyncState(userId, `backfill_${s.name}_cursor`);
		if (stored !== null) cursors.set(s.name, stored);
	}
	return sortStreamsByCursorRecency(streams, cursors, defaultStartDate);
}

/** Walk one stream backwards from its stored cursor, fetching one day per
 *  iteration, until the rate-limit budget is gone or we hit the empty-day
 *  threshold (stream complete). Each stream is independent — HR's
 *  cursor + complete flag are unrelated to Steps's, and so on. */
async function runIntradayBackfill(
	client: FitbitClient,
	userId: string,
	stream: IntradayStream,
	defaultStartDate: string,
): Promise<void> {
	const completeKey = `backfill_${stream.name}_complete`;
	const cursorKey = `backfill_${stream.name}_cursor`;
	const maxEmpty = stream.maxEmptyDays ?? 14;

	if ((await getSyncState(userId, completeKey)) === "true") {
		console.log(`[${userId}] ${stream.name}: backfill already complete`);
		return;
	}
	if (client.rateLimitRemaining <= 15) {
		console.log(`[${userId}] ${stream.name}: rate limit low (${client.rateLimitRemaining}), skipping`);
		return;
	}

	const cursor = (await getSyncState(userId, cursorKey)) ?? defaultStartDate;
	console.log(`[${userId}] ${stream.name}: backfill from ${cursor} going backwards...`);

	let currentDate = prevDayBounded(cursor, BACKFILL_FLOOR_DATE);
	if (currentDate === null) {
		// Cursor is malformed or already at/before the floor. Either we've
		// genuinely backfilled as far as possible, or a prior bug pushed
		// the cursor into the negative-year zone. Mark complete — without
		// this guard the loop spins forever.
		console.log(`[${userId}] ${stream.name}: cursor at floor or malformed (${cursor}), marking complete`);
		await setSyncState(userId, completeKey, "true");
		return;
	}
	let emptyStreak = 0;

	while (client.rateLimitRemaining > 15 && emptyStreak < maxEmpty) {
		// skipIf: bypass days that another stream's data tells us are
		// empty (cheap DB lookup, no API call). Count toward the empty
		// streak — a long run of skipped days terminates the loop just
		// like a long run of empty fetches. Without this, a permanently-
		// true skipIf walks the cursor backward indefinitely (the steps-
		// backfill bug fixed alongside this code change).
		if (stream.skipIf && (await stream.skipIf(currentDate))) {
			await setSyncState(userId, cursorKey, currentDate);
			emptyStreak++;
			const next = prevDayBounded(currentDate, BACKFILL_FLOOR_DATE);
			if (next === null) break;
			currentDate = next;
			continue;
		}

		const result = await backfillStreamDay(stream.sync, currentDate);
		if (!result.ok) {
			console.error(`[${userId}] ${stream.name} ${currentDate} failed: ${result.error}`);
		}
		if (shouldAdvanceEmptyStreak(result)) {
			emptyStreak++;
		} else if (result.ok) {
			emptyStreak = 0;
		}
		// !ok: leave emptyStreak unchanged so transient errors don't
		// silently terminate this stream's backfill.

		await setSyncState(userId, cursorKey, currentDate);
		const next = prevDayBounded(currentDate, BACKFILL_FLOOR_DATE);
		if (next === null) {
			console.log(`[${userId}] ${stream.name}: reached backfill floor ${BACKFILL_FLOOR_DATE}`);
			await setSyncState(userId, completeKey, "true");
			return;
		}
		currentDate = next;
	}

	if (emptyStreak >= maxEmpty) {
		console.log(`[${userId}] ${stream.name}: backfill complete — ${maxEmpty} consecutive empty/skipped days`);
		await setSyncState(userId, completeKey, "true");
	} else {
		console.log(`[${userId}] ${stream.name}: paused at ${currentDate}. Rate limit: ${client.rateLimitRemaining}`);
	}
}

/** A 30-day inclusive window is the largest range Fitbit's daily-summary
 *  endpoints (HRV, breathing, SpO2, skin temp) accept in one call, so it's
 *  the cheapest unit of backward progress for the range backfill. */
const RANGE_BACKFILL_WINDOW_DAYS = 30;

/** Walk one daily-summary stream backwards from its stored cursor, fetching
 *  one ~30-day window per iteration (a single Fitbit range call), until the
 *  rate-limit budget is gone or we hit the empty-window threshold (stream
 *  complete). This is how the daily metrics that never rode along HR's deep
 *  backfill — HRV, breathing, SpO2, temperature, body, HR zones — reach the
 *  same historical depth as the rest, ~30× cheaper than day-by-day. Each
 *  stream is independent: its cursor + complete flag are its own, so a metric
 *  whose history ends earlier stops without holding up the others. Mirrors
 *  runIntradayBackfill's safety semantics (cursor always advances so a
 *  persistently-failing window can't spin forever; transient errors leave the
 *  empty streak untouched so they don't silently mark the stream complete). */
async function runRangeBackfill(
	client: FitbitClient,
	userId: string,
	stream: RangeStream,
	defaultStartDate: string,
): Promise<void> {
	const completeKey = `backfill_${stream.name}_complete`;
	const cursorKey = `backfill_${stream.name}_cursor`;
	const maxEmpty = stream.maxEmptyWindows ?? 3;

	if ((await getSyncState(userId, completeKey)) === "true") {
		console.log(`[${userId}] ${stream.name}: backfill already complete`);
		return;
	}
	if (client.rateLimitRemaining <= 15) {
		console.log(`[${userId}] ${stream.name}: rate limit low (${client.rateLimitRemaining}), skipping`);
		return;
	}

	const cursor = (await getSyncState(userId, cursorKey)) ?? defaultStartDate;
	console.log(`[${userId}] ${stream.name}: range backfill from ${cursor} going backwards...`);

	// The next window ends the day before the cursor (the oldest date already
	// covered); prevWindowBounded expands that into a [start, end] span.
	let windowEnd = prevDayBounded(cursor, BACKFILL_FLOOR_DATE);
	if (windowEnd === null) {
		console.log(`[${userId}] ${stream.name}: cursor at floor or malformed (${cursor}), marking complete`);
		await setSyncState(userId, completeKey, "true");
		return;
	}
	let emptyStreak = 0;

	while (client.rateLimitRemaining > 15 && emptyStreak < maxEmpty) {
		const window = prevWindowBounded(windowEnd, RANGE_BACKFILL_WINDOW_DAYS, BACKFILL_FLOOR_DATE);
		if (window === null) {
			console.log(`[${userId}] ${stream.name}: reached backfill floor ${BACKFILL_FLOOR_DATE}`);
			await setSyncState(userId, completeKey, "true");
			return;
		}

		const result = await backfillStreamDay(() => stream.sync(window.start, window.end), window.end);
		if (!result.ok) {
			console.error(`[${userId}] ${stream.name} ${window.start}..${window.end} failed: ${result.error}`);
		}
		if (shouldAdvanceEmptyStreak(result)) {
			emptyStreak++;
		} else if (result.ok) {
			emptyStreak = 0;
		}
		// !ok: leave emptyStreak unchanged so a transient error doesn't
		// silently terminate this stream's backfill.

		// Advance the cursor past this window unconditionally (as the intraday
		// backfill does): a persistently-failing window must not loop forever.
		await setSyncState(userId, cursorKey, window.start);
		const next = prevDayBounded(window.start, BACKFILL_FLOOR_DATE);
		if (next === null) {
			console.log(`[${userId}] ${stream.name}: reached backfill floor ${BACKFILL_FLOOR_DATE}`);
			await setSyncState(userId, completeKey, "true");
			return;
		}
		windowEnd = next;
	}

	if (emptyStreak >= maxEmpty) {
		console.log(`[${userId}] ${stream.name}: backfill complete — ${maxEmpty} consecutive empty windows`);
		await setSyncState(userId, completeKey, "true");
	} else {
		console.log(`[${userId}] ${stream.name}: paused at ${windowEnd}. Rate limit: ${client.rateLimitRemaining}`);
	}
}

const config = loadSyncConfig();
initPool(config.db);

await withConnection(migrate);

// --- Google Health weight (#260) ---
// Weight lives only on the Google side (Hume scale → Health Connect →
// Google Health); the legacy Fitbit feed froze in Apr 2026. Runs before and
// independently of the Fitbit passes: no Fitbit token or rate budget
// involved, and the full-history fetch is one page + ~150 idempotent row
// writes. Inert unless the GH_* creds and GH_USER_ID (the user the Google
// account belongs to) are configured.
{
	const googleCreds = googleCredsFromEnv();
	const googleUserId = process.env.GH_USER_ID;
	if (googleCreds && googleUserId) {
		try {
			const result = await withConnection((conn) => runGoogleWeightSync(conn, googleCreds, googleUserId, true));
			console.log(`[${googleUserId}] google weight: ${result.days} weigh-in(s), ${result.earliest} → ${result.latest}`);
		} catch (e) {
			console.error(`[${googleUserId}] google weight sync failed: ${e}`);
		}
	}
}

const users = await db()
	.selectFrom("tokens")
	.select(["user_id", "access_token", "refresh_token", "expires_at"])
	.execute();

if (users.length === 0) {
	console.log("No users with Fitbit tokens. Each user must authorize via /fitbit/auth first.");
	await destroyPool();
	process.exit(0);
}

console.log(`Found ${users.length} user(s) with Fitbit tokens`);

const trySync = async (userId: string, name: string, fn: () => Promise<unknown>) => {
	try {
		await fn();
	} catch (e) {
		// Rate-limit exhaustion is not a per-stream failure to swallow — it
		// means the budget for this whole run is spent. Re-throw so it
		// short-circuits the remaining streams (which would all hit the same
		// wall) and the run ends cleanly; the per-user handler logs it and
		// the next cron tick resumes. Everything else is a real per-stream
		// hiccup we log and move past.
		if (e instanceof RateLimitExhaustedError) throw e;
		console.error(`[${userId}] ${name} sync failed: ${e}`);
	}
};

/** Build the TzSource for the forward-sync window. Fetches PhoneTrack
 *  fixes (chunked weekly so a 30-day first-sync doesn't slam Nextcloud)
 *  and Fitbit profile.timezone, then constructs a TzSource that prefers
 *  PhoneTrack-derived tz over profile. Returns NULL_TZ_SOURCE if neither
 *  signal is available — sync continues, rows go in with tz=NULL. */
async function buildSyncTzSource(
	userId: string,
	fitbitClient: FitbitClient,
	startDate: string,
	endDate: string,
): Promise<TzSource> {
	const fixes: RawTrackPoint[] = [];
	if (config.nextcloud !== null) {
		try {
			const ctx = await openPhoneTrack({ nextcloud: config.nextcloud }, userId);
			// Chunk per week to match the established pattern in refresh-focus-places.
			const start = new Date(startDate);
			const end = new Date(endDate);
			for (let chunkStart = new Date(start); chunkStart <= end; chunkStart.setDate(chunkStart.getDate() + 7)) {
				const chunkEnd = new Date(chunkStart);
				chunkEnd.setDate(chunkEnd.getDate() + 7);
				const startStr = chunkStart.toISOString().slice(0, 10);
				const endStr = (chunkEnd > end ? end : chunkEnd).toISOString().slice(0, 10);
				const chunk = await fetchTrackPointsRange(ctx, startStr, endStr);
				fixes.push(...chunk);
			}
		} catch (e) {
			console.warn(`[${userId}] PhoneTrack fetch for tz inference failed: ${e}. Falling back to profile.tz.`);
		}
	}
	let profileTz: string | null = null;
	try {
		const profile = await fitbitClient.get<{ user: { timezone?: string } }>("/1/user/-/profile.json");
		profileTz = profile.user.timezone ?? null;
	} catch (e) {
		console.warn(`[${userId}] Fitbit profile fetch failed: ${e}. Forward-sync rows may get tz=NULL.`);
	}
	if (fixes.length === 0 && profileTz === null) {
		return NULL_TZ_SOURCE;
	}
	return buildForwardTzSource({ fixes, profileTz });
}

for (const user of users) {
	try {
		console.log(`\n=== Syncing: ${user.user_id} ===`);

		const client = new FitbitClient(user.user_id, {
			clientId: config.fitbit.clientId,
			clientSecret: config.fitbit.clientSecret,
		});

		// --- Pass 1: Forward sync (new data) ---
		// Start from the stored cursor, but never later than the overlap
		// window — so recently-finalized days (last night's sleep, a revised
		// yesterday) are always re-fetched, not just whatever is newer than
		// the cursor. ISO date strings compare lexicographically.
		const storedCursor = (await getSyncState(user.user_id, "last_sync_date")) ?? daysAgo(30);
		const overlapStart = daysAgo(SYNC_OVERLAP_DAYS);
		const lastSyncDate = storedCursor < overlapStart ? storedCursor : overlapStart;
		const today = formatDate(new Date());

		console.log(`[${user.user_id}] Forward sync: ${lastSyncDate} → ${today}`);

		// Build the TzSource for any Fitbit rows that need per-row tz tagging.
		// Forward sync gets a real source (PhoneTrack fixes + profile.tz);
		// backward backfill below uses NULL_TZ_SOURCE so rows go in with
		// tz=NULL, leaving inference to the Phase 3 backfill CLI.
		const forwardTzSource = await buildSyncTzSource(user.user_id, client, lastSyncDate, today);

		await withConnection(async (conn) => {
			await trySync(user.user_id, "devices", () => syncDevices(client, conn, user.user_id));
			await trySync(user.user_id, "activity", () => syncActivity(client, conn, user.user_id, lastSyncDate, today));
			await trySync(user.user_id, "sleep", () =>
				syncSleep(client, conn, user.user_id, lastSyncDate, today, forwardTzSource),
			);
			await trySync(user.user_id, "HR zones", () =>
				syncHeartRateZones(client, conn, user.user_id, lastSyncDate, today),
			);
			// Weight/body is NOT synced from Fitbit: the Fitbit Web API weight feed
			// is forward-filled and froze in Apr 2026 (Hume scale → Health Connect →
			// Google, not Fitbit). It now comes from the Google Health API
			// (sync-google-weight, #260). Re-adding it here re-clobbers the real
			// values nightly.
			await trySync(user.user_id, "HR intraday", () =>
				syncHeartRateIntraday(client, conn, user.user_id, lastSyncDate, today, forwardTzSource),
			);
			await trySync(user.user_id, "steps intraday", () =>
				syncStepsIntraday(client, conn, user.user_id, lastSyncDate, today, forwardTzSource),
			);
			await trySync(user.user_id, "SpO2", () => syncSpO2Daily(client, conn, user.user_id, lastSyncDate, today));
			await trySync(user.user_id, "HRV", () => syncHrv(client, conn, user.user_id, lastSyncDate, today));
			await trySync(user.user_id, "HRV intraday", () =>
				syncHrvIntraday(client, conn, user.user_id, lastSyncDate, today),
			);
			await trySync(user.user_id, "breathing", () =>
				syncBreathingRate(client, conn, user.user_id, lastSyncDate, today),
			);
			await trySync(user.user_id, "temperature", () =>
				syncTemperature(client, conn, user.user_id, lastSyncDate, today),
			);
		});

		await setSyncState(user.user_id, "last_sync_date", today);
		console.log(`[${user.user_id}] Forward sync done. Rate limit: ${client.rateLimitRemaining}`);

		// --- Pass 2: Backward backfill (historical data) ---
		// Each intraday stream tracks its own cursor + complete flag. New
		// streams (e.g. steps added 2026-05-10) start fresh from today and
		// walk back independently; previously-complete streams stay complete.
		await migrateLegacyBackfillKeys(user.user_id);

		await withConnection(async (conn) => {
			const hrStream: IntradayStream = {
				name: "hr_intraday",
				sync: async (date: string) => {
					const points = await syncHeartRateIntraday(client, conn, user.user_id, date, date);
					// Daily summaries ride along on HR's coverage. Their per-day
					// fetch is cheap and they only have meaningful empty/non-empty
					// at the daily level, which HR's streak already captures.
					await trySync(user.user_id, `backfill activity ${date}`, () =>
						syncActivity(client, conn, user.user_id, date, date),
					);
					await trySync(user.user_id, `backfill sleep ${date}`, () =>
						syncSleep(client, conn, user.user_id, date, date),
					);
					return points;
				},
			};

			const stepsStream: IntradayStream = {
				name: "steps_intraday",
				sync: (date: string) => syncStepsIntraday(client, conn, user.user_id, date, date),
				// Skip days where we already know Fitbit was off (no HR row stored).
				// Saves rate limit; data integrity is preserved because if HR ever
				// gets backfilled later, we'll re-evaluate (skipIf is checked each run).
				skipIf: async (date: string) => {
					const start = `${date} 00:00:00`;
					const end = `${date} 23:59:59`;
					const row = await db()
						.selectFrom("heart_rate_intraday")
						.select("ts")
						.where("user_id", "=", user.user_id)
						.where("ts", ">=", start)
						.where("ts", "<=", end)
						.limit(1)
						.executeTakeFirst();
					return !row;
				},
			};

			// Priority: stream with the most recent cursor goes first. A
			// freshly-deployed stream (cursor still at today) gets the rate
			// budget before an older stream that has been digging through 2024
			// — otherwise HR's deep backfill could starve Steps for hours.
			const hrvIntradayStream: IntradayStream = {
				name: "hrv_intraday",
				sync: (date: string) => syncHrvIntraday(client, conn, user.user_id, date, date),
				// HRV only exists on days with a main-sleep period, which always
				// have an HR row — so skip HR-less days to save rate limit, the
				// same guard steps_intraday uses.
				skipIf: async (date: string) => {
					const start = `${date} 00:00:00`;
					const end = `${date} 23:59:59`;
					const row = await db()
						.selectFrom("heart_rate_intraday")
						.select("ts")
						.where("user_id", "=", user.user_id)
						.where("ts", ">=", start)
						.where("ts", "<=", end)
						.limit(1)
						.executeTakeFirst();
					return !row;
				},
			};
			const ordered = await orderStreamsByCursorRecency(
				user.user_id,
				[hrStream, stepsStream, hrvIntradayStream],
				lastSyncDate,
			);
			for (const stream of ordered) {
				await runIntradayBackfill(client, user.user_id, stream, lastSyncDate);
			}

			// Daily-summary backfill. Unlike activity + sleep (which ride along
			// HR's deep backfill above), these six metrics were only ever
			// forward-synced, so their history starts at the first forward sync.
			// Walk each backward in 30-day range windows — one cheap Fitbit
			// range call per window — to the same historical depth as the rest.
			// Independent cursors so each stops at its own earliest data.
			const rangeStreams: RangeStream[] = [
				{ name: "hrv", sync: (s, e) => syncHrv(client, conn, user.user_id, s, e) },
				{ name: "breathing", sync: (s, e) => syncBreathingRate(client, conn, user.user_id, s, e) },
				{ name: "spo2", sync: (s, e) => syncSpO2Daily(client, conn, user.user_id, s, e) },
				{ name: "temperature", sync: (s, e) => syncTemperature(client, conn, user.user_id, s, e) },
				// body/weight intentionally omitted — see the forward-sync note above (#260).
				{ name: "hr_zones", sync: (s, e) => syncHeartRateZones(client, conn, user.user_id, s, e) },
			];
			const orderedRange = await orderStreamsByCursorRecency(user.user_id, rangeStreams, lastSyncDate);
			for (const stream of orderedRange) {
				await runRangeBackfill(client, user.user_id, stream, lastSyncDate);
			}
		});

		console.log(`[${user.user_id}] Done. Rate limit remaining: ${client.rateLimitRemaining}`);
	} catch (e) {
		if (e instanceof RateLimitExhaustedError) {
			// Expected, not an error: the budget ran out mid-run. Whatever was
			// fetched is committed; each stream's cursor is parked where it
			// stopped, so the next cron tick picks up exactly there. Log it
			// plainly and move to the next user (the process then exits 0).
			console.log(`[${user.user_id}] Rate budget spent for this run; resumes next run (resets in ~${e.resumeInSec}s)`);
			continue;
		}
		console.error(`[${user.user_id}] Sync failed:`, e);
	}
}

await destroyPool();
