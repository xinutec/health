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
import { haversineMeters } from "../geo/place-snap.js";
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

/**
 * `--dry-run` mines exactly as a real run does and writes NOTHING, so the
 * effect of a mining change can be measured before it reaches the column the
 * runtime trusts.
 *
 * It exists because golden cannot see this layer: a day replay reads
 * `inputs.knownPlaces` captured out of prod, so the mined `amenity_label`
 * arrives as an INPUT and a change to the miner is invisible to every gate.
 * A dry run of the real cron is the only honest before/after — reimplementing
 * the vote in a probe would measure the reimplementation.
 *
 * It earned itself immediately: it refuted the fix it was built to measure. A
 * robust cluster centre restored no label and dropped two (#789).
 */
const rawArgv = process.argv.slice(2);
const argDryRun = rawArgv.includes("--dry-run");
/** `--explain <lat> <lon>`: dump the whole amenity decision for the cluster
 *  nearest that coordinate — each stay's vote with its distance, the
 *  dwell-weighted tally, and which of the three gates returned NULL.
 *
 *  That last part is the point. A null `amenity_label` looks the same whichever
 *  gate produced it, and #789 was attributed to the wrong one from a measurement
 *  that only proved a DIFFERENT gate would also have blocked it. Naming the gate
 *  that actually fired is what a null label cannot tell you and guessing gets
 *  wrong. */
const explainAt = ((): { lat: number; lon: number } | null => {
	const i = rawArgv.indexOf("--explain");
	if (i === -1) return null;
	const lat = Number(rawArgv[i + 1]);
	const lon = Number(rawArgv[i + 2]);
	return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
})();
const argv = rawArgv.filter(
	(a, i) =>
		a !== "--dry-run" &&
		a !== "--explain" &&
		!(explainAt !== null && (i === rawArgv.indexOf("--explain") + 1 || i === rawArgv.indexOf("--explain") + 2)),
);
const argUserId = argv[0] ?? null;
const argLookbackDays = Number.parseInt(argv[1] ?? "", 10) || DEFAULT_LOOKBACK_DAYS;

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
	// Parallel to amenityLabels: the winning venue's OSM subtype (its kind),
	// kept so consumers can classify a place without parsing its name.
	const amenityKinds = new Map<number, string | null>();
	// Venue-type prior mining (#246): each stay whose venue attribution is
	// geometrically UNAMBIGUOUS (attributeStayVenue's distance+margin
	// gates) contributes one (subtype, dwell, hour) training record. The
	// ambiguous stays are exactly what the scorer must predict, so they
	// never train it — training on the picker's own guesses would launder
	// its mistakes into the prior.
	const attributedStays: AttributedStay[] = [];
	// The cluster `--explain` is about: the one whose centroid is nearest the
	// coordinate. Matching on the STORED centroid rather than on a stay means
	// the same coordinate selects the same cluster a `focus_places` row would.
	const explainId =
		explainAt === null
			? null
			: (result.clusters.reduce<{ id: number; d: number } | null>((best, c) => {
					const d = haversineMeters(explainAt.lat, explainAt.lon, c.centroidLat, c.centroidLon);
					return best === null || d < best.d ? { id: c.id, d } : best;
				}, null)?.id ?? null);

	for (const c of result.clusters) {
		const explain = c.id === explainId;
		if (explain) {
			console.log(`\n[${userId}] === EXPLAIN cluster ${c.id} ===`);
			console.log(`  centroid ${c.centroidLat.toFixed(6)}, ${c.centroidLon.toFixed(6)}`);
			console.log(`  ${c.stays.length} stay(s), total dwell ${(c.totalDwellSec / 60).toFixed(1)} min`);
		}
		const clusterSleepH = hasFitbitSleep ? sleepHoursFromFitbit(c.stays, fitbitSleepWindows) : sleepHoursOf(c);
		if (clusterSleepH >= RESIDENCE_SLEEP_THRESHOLD_H) {
			if (explain)
				console.log(
					`  GATE 0 (residence): sleepH=${clusterSleepH.toFixed(1)} >= ${RESIDENCE_SLEEP_THRESHOLD_H} — label forced NULL`,
				);
			amenityLabels.set(c.id, null);
			continue;
		}
		const votes = new Map<string, number>();
		for (const s of c.stays) {
			const landmarks = await nearbyLandmarks(s.centroidLat, s.centroidLon);
			if (explain) {
				const when = new Date(s.startTs * 1000).toISOString().slice(0, 16).replace("T", " ");
				console.log(`  stay ${when}  ${(s.durationSec / 60).toFixed(1)} min  ${landmarks.length} landmark(s)`);
			}
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
			if (!isLabelWorthyVenue(best) || ranked.total < VENUE_RANK_FLOOR_NATS) {
				if (explain) {
					const why = !isLabelWorthyVenue(best)
						? `not label-worthy (type=${best.type}, ${best.distanceM.toFixed(0)} m — needs amenity/tourism/shop within 50 m)`
						: `below rank floor (${ranked.total.toFixed(2)} < ${VENUE_RANK_FLOOR_NATS} nats)`;
					console.log(`    GATE 2 rejects its vote for "${best.name}": ${why}`);
				}
				continue;
			}
			if (explain)
				console.log(
					`    votes "${best.name}" (${best.subtype}, ${best.distanceM.toFixed(0)} m) with ${(s.durationSec / 60).toFixed(1)} min`,
				);
			votes.set(best.name, (votes.get(best.name) ?? 0) + s.durationSec);
		}
		let winner = pickWinningAmenity(votes, {
			minWeight: 60 * 30, // at least 30 min of total cluster dwell
			minFraction: 0.5, // winner must take majority of the vote
		});
		if (explain) {
			const total = [...votes.values()].reduce((a, b) => a + b, 0);
			console.log(
				`  GATE 1 tally over ${(total / 60).toFixed(1)} min of voting dwell (needs >= 30 min, winner >= 50%):`,
			);
			for (const [name, w] of [...votes].sort((a, b) => b[1] - a[1])) {
				console.log(`    ${((w / total) * 100).toFixed(0).padStart(3)}%  ${(w / 60).toFixed(1)} min  ${name}`);
			}
			console.log(`  GATE 1 winner: ${winner ?? "NULL"}`);
		}
		// Centroid gate: the winning venue must be AT the cluster — within
		// venue range of its *centroid*, not merely near some scattered
		// stays. Two co-located places ~45 m apart (a residence and a
		// café) would otherwise let the residence's evening stays, the
		// ones whose GPS drifts venue-ward, vote the café's name onto the
		// residence — its centroid stays a clear ~70 m off the café.
		//
		// A ROBUST centre (median of the stays' centroids) was measured here on
		// 2026-08-12 and REVERTED. The dwell-weighted mean is not robust — one
		// stay ~200 m out at 20% of the dwell moves it 41 m — and that looked
		// like the cause of #789. It is not: `--dry-run` showed the gate never
		// runs on that cluster, because gate 1 already returned NULL, and across
		// the corpus the median restored nothing and DROPPED two labels the mean
		// kept (48/115 clusters labelled against 50/115). A fix that costs two
		// and buys none. Do not retry it without re-reading #789.
		let winnerKind: string | null = null;
		if (winner !== null) {
			const atCentroid = await nearbyLandmarks(c.centroidLat, c.centroidLon, 100);
			const winnerHere = atCentroid.find((l) => l.name === winner);
			if (winnerHere === undefined || !isLabelWorthyVenue(winnerHere)) winner = null;
			else winnerKind = winnerHere.subtype;
			if (explain) {
				console.log(`  GATE 3 (centroid): ${winner === null ? "NULLS the winner" : `keeps it (${winnerKind})`}`);
			}
		}
		amenityLabels.set(c.id, winner);
		amenityKinds.set(c.id, winnerKind);
	}
	console.log(
		`[${userId}] amenity mining: ${[...amenityLabels.values()].filter((v) => v !== null).length}/${
			result.clusters.length
		} clusters labelled (${Date.now() - tMine}ms)`,
	);

	// Persist the venue-type priors blob — full recompute every run, never
	// incremental, so a re-mine after a code/gate change is reproducible.
	const priors = minePriors(attributedStays);
	if (!argDryRun) {
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
	}
	console.log(
		`[${userId}] venue priors: ${attributedStays.length} attributed stays across ${
			Object.keys(priors.bySubtype).length
		} venue types`,
	);

	if (argDryRun) {
		// Everything below writes. A dry run has already reported what it came
		// for, so it stops here rather than opening a transaction it would only
		// roll back — a rollback still takes the locks, and this runs against
		// prod.
		// Precise about what "dry" means: no user data is written. The OSM
		// mirror IS still filled, because `nearbyLandmarks` runs `ensureCovered`
		// and that is a cache the real run would warm identically — saying
		// "writes nothing" would be the kind of claim this codebase keeps
		// catching.
		console.log(
			`[${userId}] DRY RUN — focus_places, venue_type_priors and sync_state untouched. ` +
				`(The OSM mirror cache is still filled by nearbyLandmarks, as on a real run.)`,
		);
		return;
	}

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
					const amenityKind = amenityKinds.get(c.id) ?? null;
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
								amenity_kind = ?,
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
								amenityKind,
								hourProfile,
								match.oldId,
							],
						);
					} else {
						await conn.query(
							`INSERT INTO focus_places (user_id, centroid_lat, centroid_lon, radius_m, total_dwell_sec, visit_count, unique_days, first_seen_ts, last_seen_ts, detected_label, display_name, sleep_hours, amenity_label, amenity_kind, hour_profile)
							VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
								amenityKind,
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
