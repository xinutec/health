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
		const uid = parsed.data;
		const since = sinceDate(28);

		const hrvRows = await db()
			.selectFrom("hrv_daily")
			.select(["date", "daily_rmssd"])
			.where("user_id", "=", uid)
			.where("date", ">=", since)
			.execute();
		const rhrRows = await db()
			.selectFrom("daily_activity")
			.select(["date", "resting_heart_rate"])
			.where("user_id", "=", uid)
			.where("date", ">=", since)
			.execute();
		const sleepRows = await db()
			.selectFrom("sleep")
			.select(["date", "minutes_asleep", "is_main_sleep"])
			.where("user_id", "=", uid)
			.where("date", ">=", since)
			.where("is_main_sleep", "=", true)
			.execute();

		const hrv = latestAndBaseline(
			hrvRows.map((r) => ({ date: r.date, value: r.daily_rmssd == null ? null : Number(r.daily_rmssd) })),
		);
		const restingHr = latestAndBaseline(rhrRows.map((r) => ({ date: r.date, value: r.resting_heart_rate ?? null })));

		// Last night's main sleep (newest by date), in hours.
		const mains = sleepRows
			.filter((r) => r.is_main_sleep && r.minutes_asleep != null)
			.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
		const lastSleep = mains.at(-1);
		const sleepHours = lastSleep ? Number(lastSleep.minutes_asleep) / 60 : null;

		return c.json({
			asOf: new Date().toISOString().slice(0, 10),
			sleepHours,
			hrv,
			restingHr,
		});
	});

	return app;
}
