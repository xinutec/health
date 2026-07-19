/**
 * refresh-rail-stops — mirror OSM rail route relations
 * (subway/train/light_rail/tram) with their ordered stop-role members
 * into `rail_stops_cache` (#364).
 *
 * # Why this exists
 *
 * "Does line L STOP at station S" is ground truth only a route
 * relation's `stop` members carry — proximity to the line's tracks
 * (`stationsOnLine`, 300 m) cannot express passing-without-stopping
 * (Dollis Hill sits on the Metropolitan's fast tracks; only the Jubilee
 * stops there). Fetching relations from Overpass is far too heavy for
 * the request path — and populating this data from the request path is
 * exactly the osm_way_routes write-storm mistake (twice reverted; see
 * rail-snap.md) — so it is mirrored offline, here, and read back with a
 * single small scan.
 *
 * # Scope discipline
 *
 * Same as refresh-bus-routes: the bbox is the user's home-metro focus
 * region, tiled into small cells so no single Overpass call matches more
 * than a handful of relations (#255's lesson — a London-wide relation
 * query with full member expansion times out). `node(r)` still returns
 * each matched relation's FULL stop list, so a line is mirrored end to
 * end even when only its middle crosses a cell. The whole table is
 * rebuilt transactionally each run — a pure cache, fully recomputable.
 *
 * Run by the data-analysis cron (and manually):
 *   node dist/cli/refresh-rail-stops.js
 */

import { z } from "zod";
import { db, destroyPool, initPool, withConnection } from "../db/pool.js";
import { migrate } from "../db/schema.js";
import { overpassFetch } from "../geo/osm-overpass.js";
import { buildRailStopsOverpassQuery, extractRailStopRelations, type RailStopRelation } from "../geo/osm-rail-stops.js";
import { serializeRailStopRelation } from "../geo/rail-stops-cache.js";
import { type Bbox, bboxFromFixes, clusterIntoRegions, tileBbox } from "../geo/route-graph-loader.js";

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
 *  travel history so the mirror tracks where the user lives now. */
const RECENT_DAYS = 120;
/** Two focus places belong to the same metropolitan region if within
 *  this of each other (see refresh-bus-routes for the rationale). */
const REGION_GAP_KM = 80;

initPool(config.db);
await withConnection(migrate);

/** Bounding box of the user's CURRENT home metro (same clustering as
 *  refresh-bus-routes): recent focus places, clustered into regions,
 *  taking the region with the most places. */
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

// Rail relations are far fewer than bus (~dozens per metro vs ~700), but
// each pulls its full member node list, so the same tiling discipline
// applies — each cell's query stays light and a tile failure skips only
// that cell. Deduped by relation id across cells.
const MIRROR_TILE_DEG = 0.05; // ≈ 3.5 km — proven size from the bus mirror.
const TILE_TIMEOUT_MS = 90_000; // offline budget, well above the 20s request-path cap.
const tiles = tileBbox(bbox, MIRROR_TILE_DEG);
console.log(
	`Mirroring rail route relations across ${tiles.length} tiles of bbox ${bbox.minLat.toFixed(3)},${bbox.minLon.toFixed(3)}→${bbox.maxLat.toFixed(3)},${bbox.maxLon.toFixed(3)}`,
);

const t0 = Date.now();
const byRelation = new Map<number, RailStopRelation>();
let tileFailures = 0;
for (const [i, tile] of tiles.entries()) {
	try {
		const res = await overpassFetch(buildRailStopsOverpassQuery(tile), { timeoutMs: TILE_TIMEOUT_MS });
		if (!res.ok) {
			console.warn(`  tile ${i + 1}/${tiles.length}: Overpass ${res.status} — skipped`);
			tileFailures++;
			continue;
		}
		const data = (await res.json()) as Parameters<typeof extractRailStopRelations>[0];
		const relations = extractRailStopRelations(data);
		for (const r of relations) byRelation.set(r.osmRelationId, r);
		console.log(`  tile ${i + 1}/${tiles.length}: ${relations.length} relations (${byRelation.size} unique so far)`);
	} catch (e) {
		console.warn(`  tile ${i + 1}/${tiles.length}: ${e instanceof Error ? e.message : String(e)} — skipped`);
		tileFailures++;
	}
}

// Refuse to clobber a populated cache with a near-empty rebuild when the
// fetches broadly failed (Overpass down / breaker open) — a partial
// mirror is fine, but an all-failed run must not wipe yesterday's data.
if (byRelation.size === 0 && tileFailures > 0) {
	console.error(`All ${tiles.length} tiles failed — leaving rail_stops_cache untouched.`);
	await destroyPool();
	process.exit(1);
}

const relations = [...byRelation.values()];
console.log(`Parsed ${relations.length} unique rail stop relations from ${tiles.length} tiles (${Date.now() - t0}ms)`);

await withConnection(async (conn) => {
	// Transactional full rebuild — readers see the old snapshot until
	// commit, so a decode never observes an empty cache mid-refresh.
	await conn.beginTransaction();
	try {
		await conn.query("DELETE FROM rail_stops_cache");
		if (relations.length > 0) {
			const rows = relations.map((r) => {
				const s = serializeRailStopRelation(r);
				return [s.osm_relation_id, s.route_type, s.line_ref, s.line_name, s.stops_json];
			});
			await conn.batch(
				"INSERT INTO rail_stops_cache (osm_relation_id, route_type, line_ref, line_name, stops_json) VALUES (?, ?, ?, ?, ?)",
				rows,
			);
		}
		await conn.commit();
	} catch (e) {
		await conn.rollback();
		throw e;
	}
});
console.log(`rail_stops_cache rebuilt: ${relations.length} relations`);

await destroyPool();
process.exit(0);
