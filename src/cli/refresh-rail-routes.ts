/**
 * refresh-rail-routes — precompute snapped rail-track geometry.
 *
 * # Why this exists
 *
 * The rail-snap feature draws a train journey on the OSM rail track
 * instead of the raw GPS zigzag. Computing that geometry means a heavy
 * spatial scan of the ~1M-row osm_lines mirror — far too slow to run on
 * the dashboard request path.
 *
 * So it is computed offline, here. For every distinct train route in a
 * recent window of days this resolves the route's snapped geometry and
 * stores it in `rail_route_cache`, keyed by the run's
 * `<board> → <alight>` station-pair label. The velocity pipeline then
 * attaches the geometry to a train segment with a single indexed
 * lookup (see `annotateSnappedPaths`).
 *
 * A rail route's drawn geometry is the same every time it is travelled,
 * so it is keyed by route, not by day — the work is reused across every
 * day that route appears. Rows are UPSERTED, never wiped: keys outside
 * the scan window must survive (their days are still browsable), and the
 * serving path's miss-driven fill (rail-route-fill.ts, #363) inserts
 * first-seen keys the same day it serves them. This job remains
 * authoritative for every key it covers — its pooled-cloud geometry
 * overwrites a single-day fill.
 *
 * Run by the data-analysis cron (and manually):
 *   node dist/cli/refresh-rail-routes.js        # default 180-day window
 *   node dist/cli/refresh-rail-routes.js 90     # explicit window
 */

import { z } from "zod";
import { db, destroyPool, initPool, withConnection } from "../db/pool.js";
import { migrate } from "../db/schema.js";
import { getSyncState } from "../db/sync-state.js";
import { computeRailRoute } from "../geo/rail-route-fill.js";
import { computeVelocity } from "../geo/velocity.js";

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

/**
 * Days back to scan. Deliberately short.
 *
 * Each day is processed by `computeVelocity`, whose classification
 * lazily fetches OSM geometry for any area not yet in the local mirror.
 * Recent days are in already-travelled, already-covered areas, so they
 * are cheap; reaching months back hits old trips to uncovered cities,
 * and a single dense-city Overpass fetch can take 10+ minutes. A short
 * window keeps the nightly job to a few minutes and still catches every
 * regularly-travelled route (a commute recurs well within three weeks).
 * Tunable via argv — but widening it past recent history reintroduces
 * the OSM-backfill cost.
 */
const DEFAULT_WINDOW_DAYS = 21;
const windowDays = Number.parseInt(process.argv[2] ?? "", 10) || DEFAULT_WINDOW_DAYS;

initPool(config.db);
await withConnection(migrate);

function ymdNDaysAgo(n: number): string {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() - n);
	return d.toISOString().slice(0, 10);
}

type Geometry = Array<{ lat: number; lon: number }>;

/** A route's accumulated historic data: the pooled GPS fixes from
 *  every journey on it, plus a representative segment for the snap
 *  call (the stored geometry carries no timestamps, so any instance's
 *  segment will do). */
interface RouteAccumulator {
	fixes: Array<{ lat: number; lon: number }>;
	seg: { startTs: number; endTs: number; wayName: string };
}

/**
 * Pass 1 — walk a user's window day by day and pool, per route, the
 * union of GPS fixes across every journey on that route. That pooled
 * cloud is the historic corridor the snapper weights its path onto, so
 * the drawn line follows the route actually ridden.
 */
async function collectRouteFixes(userId: string, tz: string, byRoute: Map<string, RouteAccumulator>): Promise<void> {
	for (let offset = 0; offset <= windowDays; offset++) {
		const date = ymdNDaysAgo(offset);
		let result: Awaited<ReturnType<typeof computeVelocity>>;
		try {
			result = await computeVelocity(config, userId, date, tz);
		} catch (e) {
			console.warn(`[${userId} ${date}] computeVelocity failed:`, e);
			continue;
		}
		for (const seg of result.segments) {
			if ((seg.refinedMode ?? seg.mode) !== "train" || !seg.wayName) continue;
			const inWin = result.points.filter((p) => p.ts >= seg.startTs && p.ts <= seg.endTs);
			if (inWin.length === 0) continue;
			const fixes = inWin.map((p) => ({ lat: p.lat, lon: p.lon }));
			const acc = byRoute.get(seg.wayName);
			if (acc) {
				acc.fixes.push(...fixes);
			} else {
				byRoute.set(seg.wayName, {
					fixes,
					seg: { startTs: seg.startTs, endTs: seg.endTs, wayName: seg.wayName },
				});
			}
		}
	}
}

const users = await db().selectFrom("nc_tokens").select("user_id").execute();
if (users.length === 0) {
	console.log("No users with Nextcloud linked.");
}

// Pass 1: pool the historic fix cloud for every route.
const byRoute = new Map<string, RouteAccumulator>();
for (const u of users) {
	const tz = (await getSyncState(u.user_id, "home_tz")) ?? "Europe/London";
	console.log(`[${u.user_id}] scanning ${windowDays}-day window (tz=${tz})`);
	try {
		await collectRouteFixes(u.user_id, tz, byRoute);
	} catch (e) {
		console.error(`[${u.user_id}] route scan failed:`, e);
	}
}

// Pass 2: snap each route along its pooled historic corridor, falling back
// to the known-line route for thin / one-off rides. `computeRailRoute` is
// the shared composite the serving path's miss-driven fill also uses
// (rail-route-fill.ts) — same algorithm, richer (pooled) corridor evidence.
const routes = new Map<string, Geometry>();
for (const [key, acc] of byRoute) {
	const geom = await computeRailRoute({ key, seg: acc.seg, fixes: acc.fixes });
	if (geom && geom.length >= 2) {
		routes.set(key, geom);
		console.log(`  resolved route → ${geom.length} pts (${acc.fixes.length} historic fixes)`);
	} else {
		console.log(`  route left un-snapped (${acc.fixes.length} historic fixes — thin or disconnected)`);
	}
}

console.log(`Computed ${routes.size} route geometries; upserting into rail_route_cache`);
await withConnection(async (conn) => {
	// UPSERT, not a wipe-and-rebuild: a DELETE-all here silently dropped
	// every route key not ridden inside the scan window, so browsing an
	// older day drew its rides raw forever — and it would also discard the
	// serving path's miss-driven fills for routes that never recur. The
	// pooled recompute stays authoritative for every key it covers
	// (overwriting any single-day fill); keys outside the window persist.
	// Stale-on-OSM-edit is accepted until the route is ridden again.
	await conn.beginTransaction();
	try {
		if (routes.size > 0) {
			const rows = [...routes.entries()].map(([key, geom]) => [key, JSON.stringify(geom)]);
			await conn.batch(
				`INSERT INTO rail_route_cache (route_key, geometry_json) VALUES (?, ?)
				 ON DUPLICATE KEY UPDATE geometry_json = VALUES(geometry_json), computed_at = CURRENT_TIMESTAMP`,
				rows,
			);
		}
		await conn.commit();
	} catch (e) {
		await conn.rollback();
		throw e;
	}
});
console.log(`rail_route_cache upserted: ${routes.size} routes`);

await destroyPool();
process.exit(0);
