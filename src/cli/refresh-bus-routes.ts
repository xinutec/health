/**
 * refresh-bus-routes — mirror OSM `route=bus` relations into
 * `bus_route_cache`.
 *
 * # Why this exists
 *
 * Naming the bus a road-vehicle leg rode (C-bus, the "bus 38" case) needs
 * the route NETWORK: each route's ordered stop list, so a leg that boards
 * near one stop and alights near a later one can be anchored to the route
 * (`bus-route-match.ts`). Fetching that from Overpass is far too heavy for
 * the dashboard request path, so it is mirrored offline, here, into
 * `bus_route_cache` and read back with a single indexed scan.
 *
 * A route's stop sequence is stable, so it is keyed by relation, reused
 * across every day the route appears. A pure cache, fully recomputable, no
 * incremental accumulator (the same discipline as refresh-rail-routes).
 *
 * # The write is per TILE, not whole-table
 *
 * The fetch is tiled and a tile can fail on its own — Overpass 504s are
 * routine, 4 of 18 on a normal run. So the write follows the fetch: a run that
 * loses all its tiles is refused, a COMPLETE run rebuilds the whole table
 * authoritatively, and a PARTIAL run replaces only the tiles that answered and
 * leaves every other tile its rows.
 *
 * That makes a partial run lossless, which is what lets this job run
 * unattended (#255). It replaced a threshold on the route COUNT, which could
 * only choose between overwriting the mirror with a partial fetch and keeping
 * all of it stale — and which measured the wrong thing anyway, since losing
 * 200 routes nobody rides and losing the one bus home score identically.
 *
 * # Scope discipline (the throttling lesson)
 *
 * The bbox is the bounding box of the user's focus places, not all of
 * London — only routes the user could plausibly ride are mirrored. The
 * single Overpass call goes through the shared circuit breaker, and the
 * bbox is hard-capped: a degenerate, country-spanning focus set would
 * otherwise pull tens of thousands of routes. This is the discipline
 * `osm_way_routes` lacked the first time (see `rail-snap.md`).
 *
 * Run by the data-analysis cron (and manually):
 *   node dist/cli/refresh-bus-routes.js
 */

import { z } from "zod";
import { db, destroyPool, initPool, withConnection } from "../db/pool.js";
import { migrate } from "../db/schema.js";
import { rebuildRefusal, serializeBusRoute } from "../geo/bus-route-cache.js";
import type { BusRoute } from "../geo/bus-route-match.js";
import { buildBusRouteOverpassQuery, extractBusRoutes } from "../geo/osm-bus-routes.js";
import { overpassFetch } from "../geo/osm-overpass.js";
import { type Bbox, bboxFromFixes, clusterIntoRegions, tileBbox } from "../geo/route-graph-loader.js";
import { errorText } from "../util/error-text.js";

const config = z
	.object({
		db: z.object({
			host: z.string().default("health-db"),
			port: z.coerce.number().default(3306),
			user: z.string(),
			password: z.string(),
			database: z.string().default("health"),
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
	});

/** Only mirror around focus places seen within this window — drops stale
 *  travel history (a user's old San Francisco / Toronto clusters) so the
 *  mirror tracks where they live now. */
const RECENT_DAYS = 120;

/** Two focus places belong to the same metropolitan region if within this
 *  of each other. Comfortably larger than a city's diameter, far smaller
 *  than the gap between cities — cleanly separates London from Amsterdam. */
const REGION_GAP_KM = 80;

initPool(config.db);
await withConnection(migrate);

/** Bounding box of the user's CURRENT home metro: the focus places seen in
 *  the last `RECENT_DAYS`, clustered into regions, taking the region with
 *  the most places (the home metro). Robust to a focus set that spans
 *  continents of travel history — one global bbox would be useless. */
async function focusPlacesBbox(): Promise<Bbox | null> {
	const cutoff = Math.floor(Date.now() / 1000) - RECENT_DAYS * 86400;
	const places = await db()
		.selectFrom("focus_places")
		.select(["centroid_lat", "centroid_lon"])
		.where("last_seen_ts", ">=", cutoff)
		.execute();
	const fixes = places.map((p) => ({ lat: Number(p.centroid_lat), lon: Number(p.centroid_lon) }));
	if (fixes.length === 0) return null;
	const regions = clusterIntoRegions(fixes, REGION_GAP_KM);
	const home = regions.reduce((a, b) => (b.length > a.length ? b : a));
	console.log(
		`Recent focus places: ${fixes.length} in ${regions.length} region(s); mirroring the home region (${home.length} places)`,
	);
	return bboxFromFixes(home, 1500);
}

const bbox = await focusPlacesBbox();
if (!bbox) {
	console.log("No recent focus places — nothing to mirror.");
	await destroyPool();
	process.exit(0);
}

// A single whole-bbox `relation[route=bus]` query over greater London
// matches ~700 routes and pulls every member node of each — far too big
// for one Overpass fetch (it timed out on first run). Tile the bbox into
// small cells and union the routes across cells (deduped by relation id):
// each cell matches only the routes touching it, so each query is light.
// `node(r)` still returns each matched route's FULL stop list, so a route
// is mirrored end-to-end even when only its middle crosses a cell.
const MIRROR_TILE_DEG = 0.05; // ≈ 3.5 km — keeps each cell's route set small.
const TILE_TIMEOUT_MS = 90_000; // offline budget, well above the 20s request-path cap.
const tiles = tileBbox(bbox, MIRROR_TILE_DEG);
console.log(
	`Mirroring route=bus relations across ${tiles.length} tiles of bbox ${bbox.minLat.toFixed(3)},${bbox.minLon.toFixed(3)}→${bbox.maxLat.toFixed(3)},${bbox.maxLon.toFixed(3)}`,
);

/** A tile's stable identity, stored on every row it yielded. Rounded to the
 *  tiling grid so the same cell keys identically run to run. */
const tileKey = (t: Bbox): string => `${t.minLat.toFixed(4)},${t.minLon.toFixed(4)}`;

const t0 = Date.now();
const byRelation = new Map<number, { route: BusRoute; tile: string }>();
/** Tiles that ANSWERED. Each is authoritative for its own rows; the rest keep
 *  theirs untouched, which is what makes a partial run lossless. */
const succeededTiles: string[] = [];
let tileFailures = 0;
for (const [i, tile] of tiles.entries()) {
	const key = tileKey(tile);
	try {
		const res = await overpassFetch(buildBusRouteOverpassQuery(tile), { timeoutMs: TILE_TIMEOUT_MS });
		if (!res.ok) {
			console.warn(`  tile ${i + 1}/${tiles.length}: Overpass ${res.status} — skipped`);
			tileFailures++;
			continue;
		}
		const data = (await res.json()) as Parameters<typeof extractBusRoutes>[0];
		const routes = extractBusRoutes(data);
		// First tile to yield a route owns it. `node(r)` returns the route's FULL
		// stop list from any cell it touches, so whichever answered first has the
		// complete route — there is nothing to merge across tiles.
		for (const r of routes)
			if (!byRelation.has(r.osmRelationId)) byRelation.set(r.osmRelationId, { route: r, tile: key });
		succeededTiles.push(key);
		console.log(`  tile ${i + 1}/${tiles.length}: ${routes.length} routes (${byRelation.size} unique so far)`);
	} catch (e) {
		console.warn(`  tile ${i + 1}/${tiles.length}: ${errorText(e)} — skipped`);
		tileFailures++;
	}
}

const existing = Number(
	(
		await db()
			.selectFrom("bus_route_cache")
			.select((eb) => eb.fn.countAll().as("n"))
			.executeTakeFirstOrThrow()
	).n,
);
const refusal = rebuildRefusal(existing, tileFailures, tiles.length);
if (refusal !== null) {
	console.error(`${refusal} — leaving bus_route_cache untouched.`);
	await destroyPool();
	process.exit(1);
}

const fetched = [...byRelation.values()];
console.log(`Parsed ${fetched.length} unique bus routes from ${tiles.length} tiles (${Date.now() - t0}ms)`);

await withConnection(async (conn) => {
	// Transactional — readers see the old snapshot until commit, so the
	// dashboard never observes an empty cache mid-refresh.
	await conn.beginTransaction();
	try {
		if (tileFailures === 0) {
			// A complete run is authoritative for the whole bbox: anything absent
			// is absent from OSM. This is also what retires `tile_key IS NULL`
			// rows written before the column existed.
			await conn.query("DELETE FROM bus_route_cache");
		} else {
			// A partial run is authoritative ONLY for the tiles that answered.
			// Drop just those rows; every other tile keeps what it had, so the
			// mirror cannot shrink because Overpass 504'd somewhere.
			const placeholders = succeededTiles.map(() => "?").join(",");
			await conn.query(`DELETE FROM bus_route_cache WHERE tile_key IN (${placeholders})`, succeededTiles);
		}
		if (fetched.length > 0) {
			const rows = fetched.map(({ route, tile }) => {
				const s = serializeBusRoute(route);
				return [s.osm_relation_id, s.route_ref, s.route_name, s.stops_json, tile];
			});
			// Upsert, not plain insert: a route can survive the delete above under a
			// FAILED tile's key and still be re-fetched from one that answered.
			await conn.batch(
				`INSERT INTO bus_route_cache (osm_relation_id, route_ref, route_name, stops_json, tile_key)
				 VALUES (?, ?, ?, ?, ?)
				 ON DUPLICATE KEY UPDATE route_ref = VALUES(route_ref), route_name = VALUES(route_name),
				   stops_json = VALUES(stops_json), tile_key = VALUES(tile_key), computed_at = CURRENT_TIMESTAMP`,
				rows,
			);
		}
		await conn.commit();
	} catch (e) {
		await conn.rollback();
		throw e;
	}
});
const [{ n: after }] = (await db()
	.selectFrom("bus_route_cache")
	.select((eb) => eb.fn.countAll().as("n"))
	.execute()) as unknown as [{ n: number }];
console.log(
	tileFailures === 0
		? `bus_route_cache rebuilt in full: ${fetched.length} routes`
		: `bus_route_cache merged: ${succeededTiles.length}/${tiles.length} tiles replaced, ` +
				`${tileFailures} kept their existing rows — ${existing} -> ${Number(after)} routes`,
);

await destroyPool();
process.exit(0);
