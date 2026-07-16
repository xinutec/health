/**
 * Production HSMM decoder CLI: decode a (user, date) day and persist
 * the result to `decoded_days`. The output is what `velocity.ts`
 * reads for place-attribution override.
 *
 * Usage (via prod-db.sh):
 *
 *   scripts/prod-db.sh node dist/cli/decode-day.js --date 2026-05-22
 *   scripts/prod-db.sh node dist/cli/decode-day.js --user pippijn --days 14
 *
 * The `--days N` form decodes the last N days for the user. Used by
 * the cron task that keeps the cache warm. Idempotent — re-decoding
 * a day overwrites the existing row (with current classifier version).
 */

import { z } from "zod";
import { initPool, db as kyselyDb, withConnection } from "../db/pool.js";
import { migrate } from "../db/schema.js";
import {
	useCadenceImputation,
	useChainContext,
	useContinuityContinuation,
	useReacquireRobustSpeed,
	useSegmentEvidence,
} from "../geo/factors/feature-flag.js";
import { parseHourProfile } from "../geo/focus-places.js";
import { stationsOnLine } from "../geo/line-stations.js";
import { dbOsmAdapter, type OsmAdapter } from "../geo/osm-adapter.js";
import { computeMinuteProximity } from "../geo/rail-road-proximity.js";
import type { RouteGraph } from "../geo/route-graph.js";
import { bboxFromFixes, loadRouteGraphForBbox } from "../geo/route-graph-loader.js";
import { dateBoundsUtc } from "../geo/timezone.js";
import { computeVelocity, loadBiometrics } from "../geo/velocity.js";
import { loadContinuityContext } from "../hmm/continuity-context.js";
import { decodeHsmm, type HsmmPlace, KNOWN_LINES } from "../hmm/decode.js";
import { dropGpsOutliers } from "../hmm/gps-outliers.js";
import { saveDecode } from "../hmm/persist.js";

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

async function loadFocusPlacesForUser(userId: string): Promise<HsmmPlace[]> {
	const rows = await kyselyDb()
		.selectFrom("focus_places")
		.where("user_id", "=", userId)
		.select(["id", "display_name", "centroid_lat", "centroid_lon", "hour_profile", "total_dwell_sec"])
		.execute();
	return rows.map((r) => ({
		id: r.id,
		displayName: r.display_name,
		lat: Number(r.centroid_lat),
		lon: Number(r.centroid_lon),
		hourProfile: parseHourProfile(r.hour_profile),
		totalDwellSec: Number(r.total_dwell_sec),
	}));
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
	const R = 6_371_000;
	const dLat = ((lat2 - lat1) * Math.PI) / 180;
	const dLon = ((lon2 - lon1) * Math.PI) / 180;
	const a =
		Math.sin(dLat / 2) ** 2 +
		Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function buildPlaceNearLine(places: readonly HsmmPlace[], lines: readonly string[]): Promise<Set<string>> {
	const WALK_DIST_M = 400;
	const placeNearLine = new Set<string>();
	for (const line of lines) {
		const stations = await stationsOnLine(line);
		if (stations.length === 0) continue;
		for (const p of places) {
			for (const s of stations) {
				if (haversineMeters(p.lat, p.lon, s.lat, s.lon) <= WALK_DIST_M) {
					placeNearLine.add(`${p.id}|${line}`);
					break;
				}
			}
		}
	}
	return placeNearLine;
}

async function decodeAndPersist(
	userId: string,
	date: string,
	tz: string,
	places: readonly HsmmPlace[],
	placeNearLine: Set<string>,
	routeGraph: RouteGraph,
	osm: OsmAdapter,
	dry: boolean,
): Promise<{ segmentCount: number; minuteCount: number; durationMs: number }> {
	const t0 = Date.now();
	const velResult = await computeVelocity(config, userId, date, tz);
	const bounds = dateBoundsUtc(date, tz);
	const biom = await loadBiometrics(userId, bounds.startUtc, bounds.endUtc, tz);
	// Per-minute rail/road proximity (#238): one nearbyWays lookup per
	// distinct ~11 m minute-median location, classified rail-vs-road, so
	// the line-proximity factor can keep a road-following taxi off a
	// parallel tube line. Outlier-dropped to match the fixes the decode
	// actually observes.
	const proximityByMinute = await computeMinuteProximity(osm, date, tz, dropGpsOutliers(velResult.points));
	// Presence-continuity seed (Phase 3 of
	// docs/proposals/2026-06-presence-continuity.md): when the flag is
	// on, read the prior day's presence_log row to set the
	// continuation context. Silent fallback if the row doesn't exist
	// (chain start) or the flag is off. The flag gate lives here in the
	// loader; `decodeHsmm` purely consumes whatever context it is given.
	const continuityContext = useContinuityContinuation() ? await loadContinuityContext(userId, date) : null;
	const segments = decodeHsmm({
		date,
		tz,
		points: velResult.points,
		hr: biom.hr,
		steps: biom.steps,
		sleep: biom.sleep,
		places,
		placeNearLine,
		routeGraph,
		continuityContext,
		proximityByMinute,
		imputeCadence: useCadenceImputation(),
		segmentEvidence: useSegmentEvidence(),
		chainContext: useChainContext(),
		reacquireRobustSpeed: useReacquireRobustSpeed(),
	});
	if (dry) {
		const fmt = (ts: number): string =>
			new Date(ts * 1000).toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
		console.error(`# DRY RUN ${date} — ${segments.length} segments (not persisted):`);
		for (const s of segments) {
			const line = s.lineName ? ` @ ${s.lineName}` : "";
			const place = s.placeId !== null ? ` place=${s.placeId}` : "";
			console.error(`    ${fmt(s.startTs)}-${fmt(s.endTs)}  ${s.mode}${line}${place}`);
		}
	} else {
		await saveDecode(kyselyDb(), userId, date, segments);
	}
	// Per-minute count is purely diagnostic. Segments tile the day's
	// observed minutes contiguously (each `endTs` = last minute + 60),
	// so total minutes = Σ (endTs − startTs) / 60.
	const minuteCount = segments.reduce((n, s) => n + (s.endTs - s.startTs) / 60, 0);
	return {
		segmentCount: segments.length,
		minuteCount,
		durationMs: Date.now() - t0,
	};
}

interface CliArgs {
	userId: string;
	tz: string;
	dates: string[];
	/** Decode and print the segments without writing `decoded_days`.
	 *  For inspecting a decode against prod data without mutating the
	 *  cache. */
	dry: boolean;
}

function parseArgs(): CliArgs {
	const args = process.argv.slice(2);
	let userId = "pippijn";
	let tz = "Europe/London";
	let days = 1;
	let explicitDate: string | null = null;
	let dry = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--user") userId = args[++i] ?? userId;
		else if (a === "--tz") tz = args[++i] ?? tz;
		else if (a === "--days") days = Number(args[++i] ?? days) || days;
		else if (a === "--date") explicitDate = args[++i] ?? null;
		else if (a === "--dry" || a === "--dry-run") dry = true;
	}
	let dates: string[];
	if (explicitDate) {
		dates = [explicitDate];
	} else {
		dates = [];
		const now = new Date();
		for (let d = 1; d <= days; d++) {
			const date = new Date(now);
			date.setUTCDate(now.getUTCDate() - d);
			dates.push(date.toISOString().slice(0, 10));
		}
	}
	return { userId, tz, dates, dry };
}

async function main(): Promise<void> {
	const { userId, tz, dates, dry } = parseArgs();
	initPool(config.db);
	await withConnection(migrate);

	console.error(`# decode-day — user=${userId} tz=${tz} dates=${dates.join(",")}`);
	const places = await loadFocusPlacesForUser(userId);
	const placeNearLine = await buildPlaceNearLine(places, KNOWN_LINES);

	// Load the user's lifetime route graph (bbox derived from
	// focus_places). Used by route-rail-evidence and reused across
	// every date in this run.
	const bbox = bboxFromFixes(places.map((p) => ({ lat: p.lat, lon: p.lon })));
	if (bbox === null) {
		console.error("# no focus places — cannot build route graph");
		process.exit(1);
	}
	const t0Graph = Date.now();
	const routeGraph = await loadRouteGraphForBbox(bbox, { featureTypes: ["railway"] });
	console.error(
		`# loaded ${places.length} focus_places, ${placeNearLine.size} place-line pairs, ${routeGraph.edges.size} rail edges in ${Date.now() - t0Graph}ms`,
	);

	for (const date of dates) {
		try {
			const result = await decodeAndPersist(userId, date, tz, places, placeNearLine, routeGraph, dbOsmAdapter, dry);
			console.log(
				`  ${date}: ${result.segmentCount} segments / ${result.minuteCount} minutes in ${result.durationMs}ms`,
			);
		} catch (e) {
			console.error(`  ${date} FAILED: ${e instanceof Error ? e.message : e}`);
		}
	}
	process.exit(0);
}

/** Load the continuity seed for `userId` on `date`: returns the
 *  context derived from `presence_log[date - 1]`, or null when no
 *  prior-day record exists (chain start, or yesterday was a travel
 *  day with no end-of-day stay). Phase 3 of
 *  `docs/proposals/2026-06-presence-continuity.md`. */
await main();
