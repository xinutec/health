/**
 * Rebuild the focus_places table for one (or all) users by fetching the
 * user's last LOOKBACK_DAYS of PhoneTrack history and running the focus-
 * places pipeline. Replaces the user's rows in focus_places inside a
 * transaction so the dashboard never sees an empty snapshot mid-refresh.
 *
 * Run manually for now (will become a weekly cron once stable):
 *   node dist/cli/refresh-focus-places.js              # all users with NC linked
 *   node dist/cli/refresh-focus-places.js <user_id>    # one user, default 90d
 *   node dist/cli/refresh-focus-places.js <user_id> 90 # one user, explicit days
 */

import tzLookup from "tz-lookup";
import { z } from "zod";
import { db, destroyPool, initPool, withConnection } from "../db/pool.js";
import { migrate } from "../db/schema.js";
import { setSyncState } from "../db/sync-state.js";
import {
	assignDisplayNames,
	type Cluster,
	classifyCluster,
	detectFocusPlaces,
	type FitbitSleepWindow,
	hourProfileOf,
	pickWinningAmenity,
	type RawPoint,
	serializeHourProfile,
	sleepHoursFromFitbit,
	sleepHoursOf,
	uniqueDayCount,
} from "../geo/focus-places.js";
import { type ExistingPlace, matchClusters } from "../geo/focus-places-identity.js";
import { bestPlace, isLabelWorthyVenue, nearbyLandmarks } from "../geo/osm.js";
import { dbOsmAdapter } from "../geo/osm-adapter.js";
import {
	type AttributedStay,
	attributeStayVenue,
	localHourOf,
	minePriors,
	rankVenues,
	VENUE_RANK_FLOOR_NATS,
} from "../geo/venue-prior.js";
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

const DEFAULT_LOOKBACK_DAYS = 180;
const FETCH_CHUNK_DAYS = 7;

const argUserId = process.argv[2] ?? null;
const argLookbackDays = Number.parseInt(process.argv[3] ?? "", 10) || DEFAULT_LOOKBACK_DAYS;

initPool(config.db);
await withConnection(migrate);

function ymdNDaysAgo(n: number): string {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() - n);
	return d.toISOString().slice(0, 10);
}

async function fetchAllPoints(userId: string, daysBack: number): Promise<RawPoint[]> {
	// Build the Nextcloud client + sessions list once and reuse across all
	// chunks — used to be one DB lookup + one client construction + one
	// sessions-list call per chunk (~26× for the default 180-day backfill).
	const ctx = await openPhoneTrack(config, userId);
	const all: RawPoint[] = [];
	const seen = new Set<string>();
	for (let offset = daysBack; offset > 0; offset -= FETCH_CHUNK_DAYS) {
		const start = ymdNDaysAgo(offset);
		const end = ymdNDaysAgo(Math.max(0, offset - FETCH_CHUNK_DAYS));
		const points = await fetchTrackPointsRange(ctx, start, end);
		for (const p of points) {
			const k = `${p.ts}/${p.lat.toFixed(6)}/${p.lon.toFixed(6)}`;
			if (seen.has(k)) continue;
			seen.add(k);
			all.push({ ts: p.ts, lat: p.lat, lon: p.lon, accuracy: p.accuracy });
		}
	}
	all.sort((a, b) => a.ts - b.ts);
	return all;
}

async function refreshOne(userId: string): Promise<void> {
	const t0 = Date.now();
	const points = await fetchAllPoints(userId, argLookbackDays);
	const fetchMs = Date.now() - t0;
	if (points.length === 0) {
		console.log(`[${userId}] no PhoneTrack history in last ${argLookbackDays}d, skipping`);
		return;
	}

	const t1 = Date.now();
	const result = detectFocusPlaces(points);
	console.log(
		`[${userId}] ${points.length} points (fetch ${fetchMs}ms) → ${result.stays.length} stays → ${result.clusters.length} clusters (${Date.now() - t1}ms)`,
	);

	// Load Fitbit sleep windows covering the same lookback period so
	// `sleepHoursFromFitbit` can compute per-cluster actual-sleep hours
	// instead of the local-clock 02:00–06:00 heuristic. Falls back to
	// the old heuristic for users without Fitbit data.
	const sleepRows = await db()
		.selectFrom("sleep")
		.select(["start_time", "end_time"])
		.where("user_id", "=", userId)
		.where("is_main_sleep", "=", true)
		.execute();
	const fitbitSleepWindows: FitbitSleepWindow[] = sleepRows.map((r) => ({
		startTs: Math.floor(new Date(r.start_time).getTime() / 1000),
		endTs: Math.floor(new Date(r.end_time).getTime() / 1000),
	}));
	const hasFitbitSleep = fitbitSleepWindows.length > 0;
	console.log(`[${userId}] loaded ${fitbitSleepWindows.length} Fitbit sleep windows for mining`);

	// Mine per-cluster amenity label by aggregating OSM picks across all
	// the cluster's stays (time-weighted). A cluster the user has visited
	// many times converges on the true venue even when single-visit GPS
	// noise would have flipped the picker to an adjacent venue.
	//
	// Skip mining for clusters that look residential (Fitbit-confirmed
	// sleep_hours above the residency threshold). For those, the
	// runtime labeller falls through to the OSM residential-address
	// lookup, and `amenity_label` is unused — populating it would just
	// be dead data that an old code path could mis-pick up.
	const RESIDENCE_SLEEP_THRESHOLD_H = 5;
	const tMine = Date.now();
	const amenityLabels = new Map<number, string | null>();
	// Venue-type prior mining (#246): each stay whose venue attribution is
	// geometrically UNAMBIGUOUS (attributeStayVenue's distance+margin
	// gates) contributes one (subtype, dwell, hour) training record. The
	// ambiguous stays are exactly what the scorer must predict, so they
	// never train it — training on the picker's own guesses would launder
	// its mistakes into the prior.
	const attributedStays: AttributedStay[] = [];
	for (const c of result.clusters) {
		const clusterSleepH = hasFitbitSleep ? sleepHoursFromFitbit(c.stays, fitbitSleepWindows) : sleepHoursOf(c);
		if (clusterSleepH >= RESIDENCE_SLEEP_THRESHOLD_H) {
			amenityLabels.set(c.id, null);
			continue;
		}
		const votes = new Map<string, number>();
		for (const s of c.stays) {
			const landmarks = await nearbyLandmarks(s.centroidLat, s.centroidLon);
			if (landmarks.length === 0) continue;
			const attributed = attributeStayVenue(landmarks);
			if (attributed !== null) {
				const midTs = Math.floor((s.startTs + s.endTs) / 2);
				attributedStays.push({
					subtype: attributed.subtype,
					durationSec: s.durationSec,
					localHour: localHourOf(midTs, tzLookup(s.centroidLat, s.centroidLon)),
				});
			}
			// Shape-aware vote (#246): rank candidates with the stay's own
			// window so opening-hours evidence weighs in — a pharmacy 17 m
			// from a smeared dinner centroid must not out-vote the open
			// restaurant at 31 m (the 2026-06-09 Olivomare case: the old
			// context-free pick laundered exactly that error into
			// amenity_label, which the runtime then trusts). Priors stay
			// null here: this same pass rebuilds the priors blob, and
			// voting with the previous run's blob would let one bad label
			// echo into the next.
			const ranked = rankVenues(
				landmarks,
				{ startUnix: s.startTs, endUnix: s.endTs, tz: tzLookup(s.centroidLat, s.centroidLon) },
				null,
			)[0];
			const best = ranked.landmark;
			// Confidence gate: only a real venue type (amenity / tourism /
			// shop) that is close enough to be the place the stay is *at*
			// may cast a vote. A park the stay sits near, a pedestrian way,
			// or a café 80 m off are all rejected — they name an area, not
			// the venue, and would otherwise mislabel the cluster. The
			// plausibility floor additionally drops votes where even the
			// best candidate is implausible (closed + far).
			if (!isLabelWorthyVenue(best) || ranked.total < VENUE_RANK_FLOOR_NATS) continue;
			votes.set(best.name, (votes.get(best.name) ?? 0) + s.durationSec);
		}
		let winner = pickWinningAmenity(votes, {
			minWeight: 60 * 30, // at least 30 min of total cluster dwell
			minFraction: 0.5, // winner must take majority of the vote
		});
		// Centroid gate: the winning venue must be AT the cluster — within
		// venue range of its *centroid*, not merely near some scattered
		// stays. Two co-located places ~45 m apart (a residence and a
		// café) would otherwise let the residence's evening stays, the
		// ones whose GPS drifts venue-ward, vote the café's name onto the
		// residence — its centroid stays a clear ~70 m off the café.
		if (winner !== null) {
			const atCentroid = await nearbyLandmarks(c.centroidLat, c.centroidLon, 100);
			const winnerHere = atCentroid.find((l) => l.name === winner);
			if (winnerHere === undefined || !isLabelWorthyVenue(winnerHere)) winner = null;
		}
		amenityLabels.set(c.id, winner);
	}
	console.log(
		`[${userId}] amenity mining: ${[...amenityLabels.values()].filter((v) => v !== null).length}/${
			result.clusters.length
		} clusters labelled (${Date.now() - tMine}ms)`,
	);

	// Persist the venue-type priors blob — full recompute every run, never
	// incremental, so a re-mine after a code/gate change is reproducible.
	const priors = minePriors(attributedStays);
	await db()
		.insertInto("venue_type_priors")
		.values({
			user_id: userId,
			priors_json: JSON.stringify(priors),
			mined_stays: attributedStays.length,
		})
		.onDuplicateKeyUpdate({
			priors_json: JSON.stringify(priors),
			mined_stays: attributedStays.length,
		})
		.execute();
	console.log(
		`[${userId}] venue priors: ${attributedStays.length} attributed stays across ${
			Object.keys(priors.bySubtype).length
		} venue types`,
	);

	await withConnection(async (conn) => {
		await conn.beginTransaction();
		try {
			// Identity matching: keep focus_places.id stable across re-mining
			// runs so downstream consumers (HMM model_states, etc.) can hold
			// a foreign-key reference. Match new clusters to existing rows
			// by centroid proximity; unmatched existing rows are deleted,
			// unmatched new clusters get fresh ids.
			const existingRows = (await conn.query(
				"SELECT id, centroid_lat, centroid_lon, first_seen_ts FROM focus_places WHERE user_id = ?",
				[userId],
			)) as Array<{
				id: number;
				centroid_lat: number;
				centroid_lon: number;
				first_seen_ts: number;
			}>;
			const existing: ExistingPlace[] = existingRows.map((r) => ({
				id: r.id,
				centroidLat: Number(r.centroid_lat),
				centroidLon: Number(r.centroid_lon),
				firstSeenTs: Number(r.first_seen_ts),
			}));
			const newForMatch = result.clusters.map((c) => ({ centroidLat: c.centroidLat, centroidLon: c.centroidLon }));
			const { matches, deletedOldIds } = matchClusters(existing, newForMatch);

			if (deletedOldIds.length > 0) {
				await conn.query(
					`DELETE FROM focus_places WHERE id IN (${deletedOldIds.map(() => "?").join(",")})`,
					deletedOldIds,
				);
			}

			if (result.clusters.length > 0) {
				const displayNames = assignDisplayNames(result.clusters);
				for (let i = 0; i < result.clusters.length; i++) {
					const c = result.clusters[i];
					const match = matches[i];
					const sortedStays = [...c.stays].sort((a, b) => a.startTs - b.startTs);
					const cls = classifyCluster(c);
					// Prefer Fitbit-confirmed sleep hours when available;
					// fall back to the local-clock 02-06 heuristic for
					// users without Fitbit data.
					const sleepH = hasFitbitSleep ? sleepHoursFromFitbit(c.stays, fitbitSleepWindows) : sleepHoursOf(c);
					const detectedLabel = cls.label;
					const displayName = displayNames.get(c.id) ?? null;
					const amenityLabel = amenityLabels.get(c.id) ?? null;
					const hourProfile = serializeHourProfile(hourProfileOf(c));

					if (match.oldId !== null) {
						// UPDATE preserving id and first_seen_ts (the original
						// "first time we observed this place"). All other
						// fields refresh from the new mining run.
						await conn.query(
							`UPDATE focus_places SET
								centroid_lat = ?,
								centroid_lon = ?,
								radius_m = ?,
								total_dwell_sec = ?,
								visit_count = ?,
								unique_days = ?,
								last_seen_ts = ?,
								detected_label = ?,
								display_name = ?,
								sleep_hours = ?,
								amenity_label = ?,
								hour_profile = ?,
								refreshed_at = CURRENT_TIMESTAMP
							WHERE id = ?`,
							[
								c.centroidLat,
								c.centroidLon,
								25,
								c.totalDwellSec,
								c.stays.length,
								uniqueDayCount(c.stays, c.centroidLon),
								sortedStays[sortedStays.length - 1].endTs,
								detectedLabel,
								displayName,
								Math.round(sleepH),
								amenityLabel,
								hourProfile,
								match.oldId,
							],
						);
					} else {
						await conn.query(
							`INSERT INTO focus_places (user_id, centroid_lat, centroid_lon, radius_m, total_dwell_sec, visit_count, unique_days, first_seen_ts, last_seen_ts, detected_label, display_name, sleep_hours, amenity_label, hour_profile)
							VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
							[
								userId,
								c.centroidLat,
								c.centroidLon,
								25,
								c.totalDwellSec,
								c.stays.length,
								uniqueDayCount(c.stays, c.centroidLon),
								sortedStays[0].startTs,
								sortedStays[sortedStays.length - 1].endTs,
								detectedLabel,
								displayName,
								Math.round(sleepH),
								amenityLabel,
								hourProfile,
							],
						);
					}
				}

				// Identify the Home cluster (if any) and write the residence tz
				// to sync_state for use as a fallback at read time. Passing `conn`
				// makes this part of the transaction — a half-failed refresh
				// rolls back the home_tz update along with the focus_places rows.
				// If no Home cluster qualifies this run, leave sync_state.home_tz
				// untouched (don't clobber a previously-good value).
				for (const c of result.clusters) {
					if (displayNames.get(c.id) === "Home") {
						const homeTz = tzLookup(c.centroidLat, c.centroidLon);
						await setSyncState(userId, "home_tz", homeTz, conn);
						console.log(`[${userId}] home_tz = ${homeTz}`);
						break;
					}
				}
			}
			await conn.commit();
		} catch (e) {
			await conn.rollback();
			throw e;
		}
	});
	console.log(`[${userId}] focus_places refreshed (${result.clusters.length} rows)`);

	// Proactive OSM cache warming: pre-fetch the place name + nearby
	// landmarks for each focus_place's centroid. Live dashboard requests
	// then hit the cache, and we snapshot the OSM data while connectivity
	// is good — so a future Overpass outage doesn't blank labels for
	// places we already know about. Failures are non-fatal (negative cache
	// will TTL out and we'll try again on the next refresh).
	await warmOsmCache(result.clusters);
}

async function warmOsmCache(clusters: Cluster[]): Promise<void> {
	const ordered = [...clusters].sort((a, b) => b.totalDwellSec - a.totalDwellSec);
	let warmed = 0;
	let failed = 0;
	for (const c of ordered) {
		try {
			await Promise.all([
				bestPlace(dbOsmAdapter, c.centroidLat, c.centroidLon, { preferResidential: true }),
				nearbyLandmarks(c.centroidLat, c.centroidLon, 100),
			]);
			warmed++;
		} catch {
			failed++;
		}
	}
	console.log(`Warmed OSM cache for ${warmed} focus_places (${failed} failed)`);
}

if (argUserId) {
	await refreshOne(argUserId);
} else {
	const users = await db().selectFrom("nc_tokens").select("user_id").execute();
	if (users.length === 0) {
		console.log("No users with Nextcloud linked.");
	}
	for (const u of users) {
		try {
			await refreshOne(u.user_id);
		} catch (e) {
			console.error(`[${u.user_id}] refresh failed:`, e);
		}
	}
}

await destroyPool();
process.exit(0);
