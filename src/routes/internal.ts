/**
 * Internal service-to-service endpoints (`/internal/*`), gated by the
 * `X-Service-Token` shared secret (see `middleware/service-auth.ts`). NOT part
 * of the user-facing `/api` group — no session, no cookie; the caller (coach)
 * passes the target `?user=<uid>` (the Nextcloud user id, the same string in
 * both apps).
 *
 * Exposes the user's mined places so coach can (a) let the user link a training
 * location to a detected place, and (b) auto-select the location for wherever
 * they are right now.
 */

import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/pool.js";
import type { AppEnv } from "../env.js";
import { type FocusPlaceForPresence, isNamedPlace, pickCurrentPlace, placeLabel } from "../geo/current-place.js";
import { categoryOfSubtype } from "../geo/venue-prior.js";
import { serviceAuth } from "../middleware/service-auth.js";
import { fetchTrackPoints, NextcloudNotLinkedError, NextcloudReauthRequiredError } from "../nextcloud/phonetrack.js";
import { latestAndBaseline } from "../stats.js";

/** Config the internal routes need: the Nextcloud base (for the latest fix) +
 *  the service-token allowlist. */
export interface InternalRoutesConfig {
	nextcloud: { baseUrl: string };
	publicBaseUrl: string;
	serviceTokens: readonly string[];
}

const userParam = z.string().min(1).max(64);
const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/** Days of trailing history a metric's baseline is drawn from. */
const BASELINE_DAYS = 28;
/** Widest range `/recovery/history` will answer in one call. */
const MAX_SPAN_DAYS = 400;

function nextDay(date: string): string {
	const d = new Date(date);
	d.setDate(d.getDate() + 1);
	return d.toISOString().slice(0, 10);
}

function sinceDate(days: number): string {
	const d = new Date();
	d.setDate(d.getDate() - days);
	return d.toISOString().slice(0, 10);
}

/** Shift a YYYY-MM-DD date by `n` days. UTC throughout, so it can't wander across a
 *  DST boundary and land a day out. */
function shiftDays(date: string, n: number): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
}

/** Inclusive, ascending list of dates from `from` to `to`. */
function dateRange(from: string, to: string): string[] {
	const out: string[] = [];
	for (let d = from; d <= to; d = shiftDays(d, 1)) out.push(d);
	return out;
}

/** One daily metric, nulls (no-wear nights) included — `latestAndBaseline` drops them. */
interface DailyValue {
	date: string;
	value: number | null;
}

interface RecoveryRows {
	hrv: DailyValue[];
	rhr: DailyValue[];
	/** Main sleep only, already in hours. */
	sleep: DailyValue[];
}

/** Every recovery stream from `since` to now, normalised to plain daily values.
 *  Shared by both recovery endpoints so they can't drift into disagreeing about
 *  what the raw data says. */
async function loadRecoveryRows(userId: string, since: string): Promise<RecoveryRows> {
	const hrvRows = await db()
		.selectFrom("hrv_daily")
		.select(["date", "daily_rmssd"])
		.where("user_id", "=", userId)
		.where("date", ">=", since)
		.execute();
	const rhrRows = await db()
		.selectFrom("daily_activity")
		.select(["date", "resting_heart_rate"])
		.where("user_id", "=", userId)
		.where("date", ">=", since)
		.execute();
	const sleepRows = await db()
		.selectFrom("sleep")
		.select(["date", "minutes_asleep", "is_main_sleep"])
		.where("user_id", "=", userId)
		.where("date", ">=", since)
		.where("is_main_sleep", "=", true)
		.execute();
	return {
		hrv: hrvRows.map((r) => ({ date: r.date, value: r.daily_rmssd == null ? null : Number(r.daily_rmssd) })),
		rhr: rhrRows.map((r) => ({ date: r.date, value: r.resting_heart_rate ?? null })),
		sleep: sleepRows
			.filter((r) => r.is_main_sleep)
			.map((r) => ({ date: r.date, value: r.minutes_asleep == null ? null : Number(r.minutes_asleep) / 60 })),
	};
}

/** The raw recovery picture **as of** `day`: each metric's freshest value on or
 *  before it, judged against the baseline of the days behind it. For today this is
 *  exactly what `/recovery` has always reported; the point of naming the day is that
 *  a caller can ask the same question about a past morning. */
function recoveryAsOf(rows: RecoveryRows, day: string) {
	const floor = shiftDays(day, -BASELINE_DAYS);
	const upto = (xs: DailyValue[]) => xs.filter((r) => r.date >= floor && r.date <= day);
	const sleep = upto(rows.sleep)
		.filter((r) => r.value != null)
		.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
		.at(-1);
	return {
		asOf: day,
		sleepHours: sleep?.value ?? null,
		hrv: latestAndBaseline(upto(rows.hrv)),
		restingHr: latestAndBaseline(upto(rows.rhr)),
	};
}

/** Load a user's focus places projected for both endpoints. Coerces the DECIMAL
 *  centroid + BIGINT dwell columns to numbers at the boundary. */
async function loadFocusPlaces(userId: string) {
	const rows = await db()
		.selectFrom("focus_places")
		.select([
			"id",
			"centroid_lat",
			"centroid_lon",
			"display_name",
			"amenity_label",
			"amenity_kind",
			"total_dwell_sec",
			"visit_count",
			"unique_days",
			"last_seen_ts",
		])
		.where("user_id", "=", userId)
		.execute();
	return rows.map((r) => ({
		id: r.id,
		displayName: r.display_name,
		amenityLabel: r.amenity_label,
		amenityKind: r.amenity_kind,
		centroidLat: Number(r.centroid_lat),
		centroidLon: Number(r.centroid_lon),
		avgDwellSec: r.visit_count > 0 ? Number(r.total_dwell_sec) / r.visit_count : 0,
		uniqueDays: r.unique_days,
		lastSeenTs: r.last_seen_ts,
	}));
}

export function internalRoutes(config: InternalRoutesConfig): Hono<AppEnv> {
	const app = new Hono<AppEnv>();
	app.use("/*", serviceAuth(config.serviceTokens));

	// GET /internal/places?user= → the user's detected places, for the link picker.
	app.get("/places", async (c) => {
		const parsed = userParam.safeParse(c.req.query("user"));
		if (!parsed.success) return c.json({ error: "user required" }, 400);
		const places = await loadFocusPlaces(parsed.data);
		return c.json(
			places.map((p) => ({
				id: p.id,
				label: placeLabel(p.displayName, p.amenityLabel),
				displayName: p.displayName,
				amenityLabel: p.amenityLabel,
				// Recognisable in a picker (specific name, not a bare "Stay").
				named: isNamedPlace(p.displayName, p.amenityLabel),
				// Coarse venue class from the mined OSM subtype (food / leisure
				// / errand / …), or null when unmined. Lets coach filter
				// non-training venues without knowing the OSM taxonomy.
				category: p.amenityKind ? categoryOfSubtype(p.amenityKind) : null,
				centroid: { lat: p.centroidLat, lon: p.centroidLon },
				avgDwellSec: Math.round(p.avgDwellSec),
				uniqueDays: p.uniqueDays,
				lastSeenTs: p.lastSeenTs,
			})),
		);
	});

	// GET /internal/place/current?user= → the place the user is in now, or null.
	app.get("/place/current", async (c) => {
		const parsed = userParam.safeParse(c.req.query("user"));
		if (!parsed.success) return c.json({ error: "user required" }, 400);
		const uid = parsed.data;
		try {
			// Freshest fix — same source + window as GET /api/location/latest.
			const today = new Date().toISOString().slice(0, 10);
			const y = new Date();
			y.setDate(y.getDate() - 1);
			const yesterday = y.toISOString().slice(0, 10);
			const points = await fetchTrackPoints(config, uid, yesterday, nextDay(today));
			const last = points.at(-1);
			if (!last) return c.json(null);
			const candidates: FocusPlaceForPresence[] = await loadFocusPlaces(uid);
			return c.json(pickCurrentPlace({ lat: last.lat, lon: last.lon }, candidates));
		} catch (e) {
			if (e instanceof NextcloudNotLinkedError) return c.json(null);
			if (e instanceof NextcloudReauthRequiredError) return c.json({ error: "nextcloud_reauth_required" }, 409);
			console.error(`/internal/place/current failed for user=${uid}:`, e);
			return c.json({ error: "current place fetch failed" }, 400);
		}
	});

	// GET /internal/recovery?user= → raw recovery data (latest + trailing baseline
	// per metric). UNOPINIONATED: coach composes the readiness score + decides how
	// to modulate training. Missing stream → that field is null.
	app.get("/recovery", async (c) => {
		const parsed = userParam.safeParse(c.req.query("user"));
		if (!parsed.success) return c.json({ error: "user required" }, 400);
		const rows = await loadRecoveryRows(parsed.data, sinceDate(BASELINE_DAYS));
		return c.json(recoveryAsOf(rows, new Date().toISOString().slice(0, 10)));
	});

	// GET /internal/recovery/history?user=&from=&to= → the same raw recovery, as of
	// each day in the range, oldest first.
	//
	// Why a *past* morning's recovery is anyone's business: coach's prediction-error
	// ledger judges each logged session against what it asked that day, and it asks
	// for less when the athlete was under-recovered. Without knowing that, it reads
	// full compliance with an eased ask as a failure — a badly-slept night recorded
	// as the athlete falling short, which then holds their progression back. So the
	// ledger has to be able to ask what the coach knew that morning.
	//
	// This is `/recovery` projected over a range, not a new measurement: same
	// streams, same trailing baseline, same unopinionated numbers. Deliberately raw
	// — health does not know what readiness means, and coach must keep owning that
	// judgment, or the two would drift on what a "bad day" is.
	app.get("/recovery/history", async (c) => {
		const user = userParam.safeParse(c.req.query("user"));
		if (!user.success) return c.json({ error: "user required" }, 400);
		const from = dateParam.safeParse(c.req.query("from"));
		const to = dateParam.safeParse(c.req.query("to"));
		if (!from.success || !to.success) {
			return c.json({ error: "from and to required (YYYY-MM-DD)" }, 400);
		}
		if (from.data > to.data) return c.json({ error: "from must not be after to" }, 400);
		const days = dateRange(from.data, to.data);
		if (days.length > MAX_SPAN_DAYS) {
			return c.json({ error: `range too wide (max ${MAX_SPAN_DAYS} days)` }, 400);
		}
		// Every day in the range needs a full baseline behind it, so the query reaches
		// BASELINE_DAYS further back than the range does.
		const rows = await loadRecoveryRows(user.data, shiftDays(from.data, -BASELINE_DAYS));
		return c.json(days.map((d) => recoveryAsOf(rows, d)));
	});

	return app;
}
