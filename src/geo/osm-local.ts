/**
 * Local OSM feature mirror.
 *
 * # Why this exists
 *
 * The old `osm_cache` table stored Overpass query responses keyed by
 * `(query_type, lat_rounded, lon_rounded)`. That worked but had two
 * structural problems:
 *
 *   1. The cache key was raw coordinates, so GPS jitter at the same
 *      physical place produced different cache keys → repeated
 *      Overpass calls for "the same desk".
 *   2. Cache misses (and the occasional transient Overpass failure)
 *      surfaced as wrong labels in the dashboard until the negative
 *      cache window expired.
 *
 * # What this does
 *
 * Stores OSM features locally with a spatial index, organised by:
 *
 *   - `osm_coverage` — rows describing bounding boxes we've already
 *     fetched, one per feature_type. Boxes grow lazily as the user
 *     travels into uncovered areas.
 *   - `osm_features` — individual OSM nodes/ways we care about, with
 *     `geom GEOMETRY` so both POINTs (stations) and LINESTRINGs
 *     (roads/rail lines) can share the spatial index. Primary key on
 *     `(osm_type, osm_id)` dedupes when overlapping coverage boxes
 *     return the same feature.
 *
 * The query path becomes:
 *
 *   1. Check if (lat, lon, radius) is fully inside any coverage row
 *      for this feature_type. If yes → go straight to step 4.
 *   2. Probe `osm_points`/`osm_lines` for any feature_type row in
 *      the area. If yes (a sibling feature_type's bbox fetch
 *      populated us as overflow), treat as covered → step 4.
 *   3. Fetch a 10 km box around (lat, lon) from Overpass, parse the
 *      features, upsert into `osm_features`, insert a `osm_coverage`
 *      row for the bbox + feature_type.
 *   4. Run a SQL spatial query: `ST_Distance_Sphere(geom, ...) < radius`.
 *
 * Steady-state cost is one indexed SQL query — no network, no
 * transient failures, no negative-cache TTLs. The only Overpass call
 * is on the first visit to a new area that no sibling fetch happened
 * to also cover.
 *
 * # Scope
 *
 * Replaces Overpass usage for:
 *   - `nearbyStations` (railway=station|subway_entrance)
 *   - `nearbyWays` (highway, railway, waterway, aeroway tags)
 *   - `nearbyLandmarks` (amenity, shop, tourism, leisure tags)
 *   - `linesAtPoint` (railway line names within radius)
 *
 * Does NOT replace `reverseGeocode` — Nominatim has place-name and
 * admin-hierarchy semantics that aren't representable as raw OSM
 * features. That path keeps the existing `osm_cache` table.
 */

import { Readable } from "node:stream";
import { sql } from "kysely";
import chain from "stream-chain";
import parser from "stream-json";
import pick from "stream-json/filters/pick.js";
import streamArray from "stream-json/streamers/stream-array.js";
import { db } from "../db/pool.js";
import { overpassFetch } from "./osm-overpass.js";
import type { OsmLine, OsmStation, RailGeometry } from "./rail-snap.js";
import type { OsmRoadWay } from "./road-match.js";

/** A coverage row as read from the DB. */
export interface CoverageRow {
	min_lat: number;
	max_lat: number;
	min_lon: number;
	max_lon: number;
	fetched_at?: Date;
}

/** One degree of latitude is roughly 111 km everywhere. Longitude
 *  varies with latitude — `111 km · cos(lat)`. Good enough for the
 *  small-radius math we do here; we never operate on degrees that
 *  matter at the poles. */
const METERS_PER_DEG_LAT = 111_000;
function metersPerDegLon(lat: number): number {
	return 111_000 * Math.cos((lat * Math.PI) / 180);
}

/**
 * Is the search circle around (lat, lon) with `radiusM` fully inside
 * any of the given coverage rows? Boxes are inclusive on both ends;
 * the search circle is approximated as an axis-aligned bounding box
 * (slightly conservative — at the corners the bbox is bigger than
 * the circle, which is fine for "are we covered" purposes).
 *
 * Returns true if at least one coverage row contains the full search
 * bbox. False otherwise — caller should fetch a new region.
 */
export function isPointCovered(lat: number, lon: number, radiusM: number, coverage: readonly CoverageRow[]): boolean {
	const dLat = radiusM / METERS_PER_DEG_LAT;
	const dLon = radiusM / metersPerDegLon(lat);
	const qMinLat = lat - dLat;
	const qMaxLat = lat + dLat;
	const qMinLon = lon - dLon;
	const qMaxLon = lon + dLon;
	for (const c of coverage) {
		if (c.min_lat <= qMinLat && c.max_lat >= qMaxLat && c.min_lon <= qMinLon && c.max_lon >= qMaxLon) {
			return true;
		}
	}
	return false;
}

/**
 * Compute the bounding box to fetch when (lat, lon) is uncovered.
 * Centres on the query point and extends `halfWidthM` metres in each
 * cardinal direction. 5 km half-width = 10 km box ≈ 100 km² — small
 * enough to keep Overpass payloads modest, big enough that one fetch
 * covers a whole neighbourhood and you don't keep re-fetching every
 * few hundred metres of travel. Safe with streaming JSON parse: a
 * 50 MB response peaks at ~5-10 MB in heap because elements get
 * buffered in fixed-size batches, not the whole tree at once.
 */
export function fetchBboxAround(
	lat: number,
	lon: number,
	halfWidthM = 5000,
): { minLat: number; maxLat: number; minLon: number; maxLon: number } {
	const dLat = halfWidthM / METERS_PER_DEG_LAT;
	const dLon = halfWidthM / metersPerDegLon(lat);
	return {
		minLat: lat - dLat,
		maxLat: lat + dLat,
		minLon: lon - dLon,
		maxLon: lon + dLon,
	};
}

/** Default coverage-box half-width (5 km → 10 km box). */
const DEFAULT_BOX_HALF_WIDTH_M = 5000;
/** Per-feature_type coverage-box half-width overrides. `building` uses a tight
 *  box: building density is huge in a city, so a 10 km box would pull millions
 *  of footprints — a volume bomb (cf. #255). Buildings are only needed in the
 *  immediate vicinity of a walk, so a small box keeps the mirror bounded; the
 *  cost is more frequent re-fetches as the user moves, which is fine because
 *  buildings are fetched only around walk legs, not every segment. */
const BOX_HALF_WIDTH_BY_FEATURE: Record<string, number> = {
	building: 500,
};

/** A parsed OSM feature ready to be inserted into `osm_features`. */
export interface ParsedFeature {
	osm_id: number;
	osm_type: "node" | "way";
	feature_type: string;
	subtype: string | null;
	name: string | null;
	tags: Record<string, string>;
	geom_wkt: string; // POINT(...) or LINESTRING(...)
}

/** Overpass element shape (subset we use). */
interface OverpassElement {
	type: "node" | "way" | "relation";
	id: number;
	lat?: number;
	lon?: number;
	tags?: Record<string, string>;
	geometry?: Array<{ lat: number; lon: number }>;
}

/** Order of tag precedence for the `feature_type` bucket assignment.
 *  An OSM way tagged both `highway=motorway` and `railway=rail` (rare
 *  but possible — pickup trucks on a rail tunnel) gets bucketed under
 *  the first match. railway wins because the rail signal is rarer and
 *  more informative for our classification. */
const FEATURE_TYPE_RULES: Array<{ tag: string; featureType: string }> = [
	{ tag: "aeroway", featureType: "aeroway" },
	{ tag: "railway", featureType: "railway" },
	{ tag: "highway", featureType: "highway" },
	{ tag: "waterway", featureType: "waterway" },
	{ tag: "amenity", featureType: "landmark" },
	{ tag: "shop", featureType: "landmark" },
	{ tag: "tourism", featureType: "landmark" },
	{ tag: "leisure", featureType: "landmark" },
	// A plain building (no amenity/shop/… already matched above) buckets under
	// its own `building` feature_type: the pedestrian smoother's impassable-
	// surface layer. A building that's *also* a venue (e.g. a shop) was already
	// caught by an earlier rule and kept as a landmark.
	{ tag: "building", featureType: "building" },
];

/** Highway-tagged NODES that are transit/road furniture, not roads —
 *  bucketed under their own `transit_stop` feature_type (own coverage
 *  rows, own queries) so road-way lookups never mix with them. Bus
 *  stops vs traffic signals are the location evidence the bus-vs-car
 *  inference reads (task #247): a vehicle dwelling repeatedly AT bus
 *  stops is a bus; dwelling at signals is any road vehicle. */
const TRANSIT_STOP_HIGHWAY_SUBTYPES = new Set(["bus_stop", "traffic_signals"]);

/** Translate an Overpass element into our feature row, or null if it
 *  doesn't carry a tag we care about / lacks geometry. */
export function parseOverpassElement(el: OverpassElement): ParsedFeature | null {
	const tags = el.tags ?? {};
	let featureType: string | null = null;
	let subtype: string | null = null;
	// Transit/road furniture first: these carry `highway=` but must not
	// land in the road bucket (see TRANSIT_STOP_HIGHWAY_SUBTYPES).
	if (el.type === "node" && tags.highway && TRANSIT_STOP_HIGHWAY_SUBTYPES.has(tags.highway)) {
		featureType = "transit_stop";
		subtype = tags.highway;
	} else {
		for (const rule of FEATURE_TYPE_RULES) {
			if (tags[rule.tag]) {
				featureType = rule.featureType;
				subtype = tags[rule.tag];
				break;
			}
		}
	}
	if (featureType === null) return null;

	let geom_wkt: string;
	if (el.type === "node") {
		if (el.lat === undefined || el.lon === undefined) return null;
		geom_wkt = `POINT(${el.lon} ${el.lat})`;
	} else if (el.type === "way") {
		if (!el.geometry || el.geometry.length < 2) return null;
		const coords = el.geometry.map((p) => `${p.lon} ${p.lat}`).join(",");
		geom_wkt = `LINESTRING(${coords})`;
	} else {
		return null; // relations not supported
	}

	return {
		osm_id: el.id,
		osm_type: el.type,
		feature_type: featureType,
		subtype,
		name: tags.name ?? tags.ref ?? null,
		tags,
		geom_wkt,
	};
}

/**
 * Build the Overpass query body for one feature_type over a bbox.
 *
 * The query language uses `(south, west, north, east)` for bbox in
 * `out:json` mode. We ask for nodes AND ways with `out tags geom;`
 * (per-element tags + the way's vertices).
 */
export function buildOverpassQuery(
	featureType: string,
	bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number },
): string {
	const b = `${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon}`;
	// Per feature_type, the tag filters that should land in this bucket
	// when we'd later parse the result. Multiple node/way queries are
	// combined via Overpass union syntax `(...)`. Each feature_type is
	// the OSM tag-namespace (railway, highway, aeroway, …) so one fetch
	// brings in both stations AND rail lines for "railway", both road
	// ways AND a few road-related nodes for "highway", etc.
	const filterFor: Record<string, string[]> = {
		railway: [
			'node["railway"~"^(station|subway_entrance|halt|stop|tram_stop)$"]',
			'way["railway"~"^(rail|subway|light_rail|tram|narrow_gauge)$"]',
		],
		highway: [
			'way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|service|unclassified|footway|cycleway|path|pedestrian|track)$"]',
		],
		aeroway: ['node["aeroway"]', 'way["aeroway"]'],
		waterway: ['way["waterway"]'],
		transit_stop: ['node["highway"~"^(bus_stop|traffic_signals)$"]'],
		landmark: [
			'node["amenity"]',
			'node["shop"]',
			'node["tourism"]',
			'node["leisure"]',
			'way["amenity"]',
			'way["shop"]',
			'way["tourism"]',
			'way["leisure"]',
		],
		// Building footprints — impassable polygons for the pedestrian smoother.
		// Fetched only in a TIGHT box (see BOX_HALF_WIDTH_BY_FEATURE) because
		// building density is enormous in a city; a 10 km box would be a volume
		// bomb (cf. #255).
		building: ['way["building"]'],
	};
	const filters = filterFor[featureType];
	if (!filters) throw new Error(`No Overpass filter defined for feature_type=${featureType}`);
	const stanzas = filters.map((f) => `  ${f}(${b});`).join("\n");
	return `[out:json][timeout:25];\n(\n${stanzas}\n);\nout tags geom;`;
}

/**
 * Stream-parse an Overpass response. Reads `response.body` as bytes,
 * picks out the `elements` array, and emits each element through the
 * caller's `onBatch` callback in fixed-size groups. The whole point
 * is to never hold the entire response (often 5-50 MB raw JSON) in
 * heap at once — `await res.json()` would peak at ~3× raw size during
 * V8's parse, which is what previously OOM'd the 512 MB pod on dense
 * urban landmark + highway fetches.
 *
 * Elements are bucketed into `points` (POINT WKT) and `lines`
 * (LINESTRING WKT) inside this function so the caller can route them
 * to their respective tables without re-scanning. `batchSize` counts
 * total features (points + lines), so a 500-element batch is the same
 * size whether it's all points or all lines or a mix.
 *
 * Returns the count of features that survived `parseOverpassElement`
 * filtering — i.e. elements that had a tag we care about and valid
 * geometry. Elements with no relevant tags or missing coords are
 * silently skipped (they don't count toward batches or the total).
 */
export async function streamOverpassElements(
	response: Response,
	onBatch: (points: ParsedFeature[], lines: ParsedFeature[]) => Promise<void>,
	batchSize = 500,
): Promise<{ count: number }> {
	if (!response.body) throw new Error("streamOverpassElements: response has no body");
	const nodeStream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
	// stream-chain composes the pipeline as a single Duplex with
	// proper error forwarding between stages. A parse error in any
	// stage propagates to the consumer's `for await` loop as a
	// rejection — vanilla `.pipe()` would let it surface as an
	// uncaught 'error' event instead.
	const pipeline = chain([nodeStream, parser(), pick({ filter: "elements" }), streamArray()]);

	let points: ParsedFeature[] = [];
	let lines: ParsedFeature[] = [];
	let count = 0;

	for await (const item of pipeline) {
		// stream-json's StreamArray emits `{ key, value }` per array element.
		const parsed = parseOverpassElement((item as { value: Parameters<typeof parseOverpassElement>[0] }).value);
		if (!parsed) continue;
		count++;
		if (parsed.geom_wkt.startsWith("POINT(")) points.push(parsed);
		else if (parsed.geom_wkt.startsWith("LINESTRING(")) lines.push(parsed);

		if (points.length + lines.length >= batchSize) {
			await onBatch(points, lines);
			points = [];
			lines = [];
		}
	}

	if (points.length + lines.length > 0) {
		await onBatch(points, lines);
	}

	return { count };
}

// ============================================================================
// DB-touching layer
// ============================================================================

/** How recent a coverage row needs to be before we re-fetch the area.
 *  6 months is conservative — OSM features for stations and major
 *  roads change slowly. New venues are the main churn but they get
 *  picked up the first time the user queries near them after the TTL
 *  expires.
 *
 *  Exported so tests can derive boundary fixtures from the same
 *  source-of-truth constant. */
export const COVERAGE_FRESH_DAYS = 180;

/** Decide whether the local mirror can serve a query for this point,
 *  or whether we need to fetch fresh OSM data via Overpass. Pure
 *  function — `ensureCovered` wraps the IO around it. Stale coverage
 *  rows (older than `COVERAGE_FRESH_DAYS`) are excluded from the
 *  containment check, so a stale row that happens to cover a region
 *  doesn't suppress a refresh. Rows with no `fetched_at` are treated
 *  as fresh (legacy data from before tracking).
 *
 *  `options.hasLocalData` is the local-data fallback: when a sibling
 *  feature_type's bbox fetch happened to populate this feature_type's
 *  rows too (common around city centres where one Overpass query
 *  brings back overflow), the caller can probe the geometry tables
 *  directly and pass true here to skip Overpass entirely. This is
 *  what keeps Sunday-trip-to-Brussels from looping on Overpass
 *  ETIMEDOUT — we already have the highway data from an earlier
 *  visit, we just didn't have a `highway` coverage row for the area.
 *  Returning "covered" in this case explicitly trades "data might be
 *  stale" for "don't query a flaky network when we have the answer
 *  locally" — the right call given OSM features change on month/year
 *  timescales, not within a single trip. */
export function decideCoverage(
	point: { lat: number; lon: number; radiusM: number },
	coverage: readonly CoverageRow[],
	nowMs: number,
	options?: { hasLocalData?: boolean },
): "covered" | "needs-fetch" {
	if (options?.hasLocalData) return "covered";
	const cutoffMs = nowMs - COVERAGE_FRESH_DAYS * 86400_000;
	const fresh = coverage.filter((c) => !c.fetched_at || c.fetched_at.getTime() > cutoffMs);
	return isPointCovered(point.lat, point.lon, point.radiusM, fresh) ? "covered" : "needs-fetch";
}

/** Read all coverage rows for one feature_type. Cheap (~tens of rows
 *  across a personal user's whole travel history). */
async function readCoverage(featureType: string): Promise<CoverageRow[]> {
	const rows = await db()
		.selectFrom("osm_coverage")
		.select(["min_lat", "max_lat", "min_lon", "max_lon", "fetched_at"])
		.where("feature_type", "=", featureType)
		.execute();
	return rows.map((r) => ({
		min_lat: Number(r.min_lat),
		max_lat: Number(r.max_lat),
		min_lon: Number(r.min_lon),
		max_lon: Number(r.max_lon),
		fetched_at: r.fetched_at,
	}));
}

/** Run an Overpass fetch for one feature_type over a bbox, parse the
 *  response, upsert features, and record the coverage row. Streaming
 *  parse keeps peak heap bounded regardless of response size — see
 *  `streamOverpassElements`. Caller is responsible for deciding when
 *  to call this — see `ensureCovered`. */
async function fetchAndStore(
	featureType: string,
	bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number },
): Promise<void> {
	const t0 = Date.now();
	const query = buildOverpassQuery(featureType, bbox);
	const res = await overpassFetch(query);
	const fetchStartMs = Date.now() - t0;
	if (!res.ok) {
		console.warn(`osm-local fetch for ${featureType} bbox ${JSON.stringify(bbox)} returned ${res.status}`);
		return;
	}

	let pointsTotal = 0;
	let linesTotal = 0;
	const { count } = await streamOverpassElements(res, async (points, lines) => {
		pointsTotal += points.length;
		linesTotal += lines.length;
		await upsertFeatures("osm_points", points);
		await upsertFeatures("osm_lines", lines);
	});

	await db()
		.insertInto("osm_coverage")
		.values({
			min_lat: bbox.minLat,
			max_lat: bbox.maxLat,
			min_lon: bbox.minLon,
			max_lon: bbox.maxLon,
			feature_type: featureType,
		})
		.execute();

	const totalMs = Date.now() - t0;
	console.log(
		`osm-local fetched ${featureType} bbox=${bbox.minLat.toFixed(3)},${bbox.minLon.toFixed(3)}→${bbox.maxLat.toFixed(3)},${bbox.maxLon.toFixed(3)} elements=${count} points=${pointsTotal} lines=${linesTotal} ttfb=${fetchStartMs}ms total=${totalMs}ms`,
	);
}

/** Bulk-upsert a batch of features into one of the geometry tables.
 *  Kysely doesn't expose `ST_GeomFromText` so we build the VALUES
 *  list with raw SQL fragments. */
async function upsertFeatures(table: "osm_points" | "osm_lines", features: ParsedFeature[]): Promise<void> {
	if (features.length === 0) return;
	const BATCH = 500;
	for (let i = 0; i < features.length; i += BATCH) {
		const slice = features.slice(i, i + BATCH);
		const valuesList = slice
			.map(
				(f) =>
					sql`(${f.osm_id}, ${f.osm_type}, ${f.feature_type}, ${f.subtype}, ${f.name}, ${JSON.stringify(f.tags)}, ST_GeomFromText(${f.geom_wkt}, 4326))`,
			)
			.reduce((acc, frag, i) => (i === 0 ? frag : sql`${acc}, ${frag}`));
		await sql`
			INSERT INTO ${sql.raw(table)} (osm_id, osm_type, feature_type, subtype, name, tags_json, geom)
			VALUES ${valuesList}
			ON DUPLICATE KEY UPDATE
				subtype = VALUES(subtype),
				name = VALUES(name),
				tags_json = VALUES(tags_json),
				geom = VALUES(geom)
		`.execute(db());
	}
}

/**
 * Ensure the area within `radiusM` of (lat, lon) is covered by a
 * stored coverage box for the given feature_type. If it isn't,
 * fetches a 10 km box around the query and stores it.
 *
 * Stale coverage (older than `COVERAGE_FRESH_DAYS`) is treated as
 * uncovered and re-fetched lazily on next query.
 */
/** In-flight fetch dedup, keyed by `featureType + bbox`. Multiple
 *  ensureCovered callers for the same featureType + bbox share one
 *  fetch instead of each firing their own. Without this, the
 *  velocity pipeline processes many segments in parallel and each
 *  segment's first-bucket lookup independently triggers an Overpass
 *  call → memory pressure + thundering herd. */
const inFlightFetches = new Map<string, Promise<void>>();

/** Cheapest possible "do we have ANY data here for this feature_type?"
 *  query. Used by `ensureCovered` as a fallback when osm_coverage has
 *  no row for the area: a sibling feature_type's bbox fetch may have
 *  populated this feature_type's rows anyway. `LIMIT 1` lets the
 *  spatial index stop scanning at the first hit. */
export function buildLocalDataProbeQuery(
	k: typeof db extends () => infer K ? K : never,
	table: "osm_points" | "osm_lines",
	lat: number,
	lon: number,
	radiusM: number,
	featureType: string,
) {
	const point = sql`ST_GeomFromText(${`POINT(${lon} ${lat})`}, 4326)`;
	const mPerDeg = Math.min(METERS_PER_DEG_LAT, metersPerDegLon(lat));
	const dDeg = radiusM / mPerDeg;
	return k
		.selectFrom(table)
		.select(sql<number>`1`.as("exists_marker"))
		.where("feature_type", "=", featureType)
		.where(sql<boolean>`MBRIntersects(geom, ST_Buffer(${point}, ${dDeg}))`)
		.limit(1);
}

/** Existence-only probe across both geometry tables. Returns true if
 *  either osm_points or osm_lines has a row for this feature_type
 *  within `radiusM` of (lat, lon). The two queries run sequentially
 *  rather than in parallel because the spatial index makes them each
 *  effectively free (<10ms) and the sequential form lets us short-
 *  circuit on the first hit. */
async function hasLocalData(lat: number, lon: number, radiusM: number, featureType: string): Promise<boolean> {
	const inLines = await buildLocalDataProbeQuery(db(), "osm_lines", lat, lon, radiusM, featureType).executeTakeFirst();
	if (inLines) return true;
	const inPoints = await buildLocalDataProbeQuery(
		db(),
		"osm_points",
		lat,
		lon,
		radiusM,
		featureType,
	).executeTakeFirst();
	return inPoints !== undefined;
}

export async function ensureCovered(lat: number, lon: number, radiusM: number, featureType: string): Promise<void> {
	const coverage = await readCoverage(featureType);
	if (decideCoverage({ lat, lon, radiusM }, coverage, Date.now()) === "covered") return;

	// Local-data fallback. A previous overlapping fetch (e.g. an
	// `aeroway` bbox over Brussels) may have populated this
	// feature_type's rows without leaving a matching coverage row.
	// Re-asking Overpass is wasteful — and on Sunday May 10 it
	// looped on ETIMEDOUT for several minutes per request. The
	// probe is one indexed query each against osm_lines and
	// osm_points, both <10ms.
	if (await hasLocalData(lat, lon, radiusM, featureType)) {
		return;
	}

	const bbox = fetchBboxAround(lat, lon, BOX_HALF_WIDTH_BY_FEATURE[featureType] ?? DEFAULT_BOX_HALF_WIDTH_M);

	// Dedup: key includes the bbox so distant lookups in the same
	// featureType don't block each other. The bbox is determined by
	// the centre point + fixed half-width, so two callers near the
	// same point produce the same key.
	const key = `${featureType}:${bbox.minLat.toFixed(3)},${bbox.minLon.toFixed(3)}`;
	const existing = inFlightFetches.get(key);
	if (existing) {
		try {
			await existing;
		} catch {
			/* outer handler already logged */
		}
		return;
	}

	const promise = fetchAndStore(featureType, bbox).finally(() => inFlightFetches.delete(key));
	inFlightFetches.set(key, promise);

	// Soft-fail the fetch: if Overpass times out or rejects, log and
	// continue. The query against local osm_points/osm_lines will then
	// just return whatever's already there (often empty for this new
	// area). Matches the negative-cache behaviour of the old withCache
	// path. A later request retries because we didn't record a
	// coverage row.
	try {
		await promise;
	} catch (e) {
		console.warn(`ensureCovered ${featureType} fetch failed at ${lat.toFixed(4)},${lon.toFixed(4)}:`, e);
	}
}

export interface LocalFeatureResult {
	osm_id: number;
	osm_type: string;
	subtype: string | null;
	name: string | null;
	distance_m: number;
	tags: Record<string, string>;
	/** True when the query point lies inside this feature's geometry
	 *  bounding box. Only meaningful for line/area features (a stay
	 *  inside a building footprint); always false for point features. */
	encloses: boolean;
}

/**
 * Run a POINT spatial query against `osm_points`. Returns matches
 * within `radiusM` (great-circle metres) ordered by distance,
 * optionally filtered by an allow-list of subtype values. Used for
 * station-like queries — anywhere we want the closest physical
 * point of interest.
 */
/** Build the Kysely query for `queryPoints`. Exported for tests
 *  that compile the SQL and assert it uses the spatial index;
 *  callers in production go through `queryPoints` below. */
export function buildPointsQuery(
	k: typeof db extends () => infer K ? K : never,
	lat: number,
	lon: number,
	radiusM: number,
	featureType: string,
	subtypes?: string[],
) {
	const point = sql`ST_GeomFromText(${`POINT(${lon} ${lat})`}, 4326)`;
	// Convert radius to degrees for the MBR pre-filter. MBR
	// operators on the spatial index expect a geometry as the
	// second argument, so we buffer the point to a circle of
	// roughly the right size. ST_Buffer takes a length in the SRS
	// of the input — for SRID 4326 that's degrees, hence the
	// conversion. Use the smaller of the two scale factors so the
	// degree-circle fully contains the metre-circle (no missed
	// candidates).
	const mPerDeg = Math.min(METERS_PER_DEG_LAT, metersPerDegLon(lat));
	const dDeg = radiusM / mPerDeg;
	let q = k
		.selectFrom("osm_points")
		.select([
			"osm_id",
			"osm_type",
			"subtype",
			"name",
			"tags_json",
			sql<number>`ST_Distance_Sphere(geom, ${point})`.as("distance_m"),
		])
		.where("feature_type", "=", featureType)
		// MBR pre-filter first — index-accelerated, drops from 5k
		// rows to a few candidates. The exact distance check after
		// keeps the great-circle accuracy.
		.where(sql<boolean>`MBRIntersects(geom, ST_Buffer(${point}, ${dDeg}))`)
		.where(sql<boolean>`ST_Distance_Sphere(geom, ${point}) < ${radiusM}`);
	if (subtypes && subtypes.length > 0) {
		q = q.where("subtype", "in", subtypes);
	}
	return q.orderBy("distance_m" as never).limit(50);
}

export async function queryPoints(
	lat: number,
	lon: number,
	radiusM: number,
	featureType: string,
	subtypes?: string[],
): Promise<LocalFeatureResult[]> {
	const rows = await buildPointsQuery(db(), lat, lon, radiusM, featureType, subtypes).execute();
	return rows.map((r) => ({
		osm_id: Number(r.osm_id),
		osm_type: r.osm_type,
		subtype: r.subtype,
		name: r.name,
		distance_m: Number(r.distance_m),
		// A point feature has no interior — it never encloses a stay.
		encloses: false,
		// MariaDB's JSON column type may return either a string (legacy
		// driver) or a parsed object (driver auto-parses). Handle both.
		tags: (r.tags_json ? (typeof r.tags_json === "string" ? JSON.parse(r.tags_json) : r.tags_json) : {}) as Record<
			string,
			string
		>,
	}));
}

/**
 * Run a LINESTRING spatial query against `osm_lines`. MariaDB's
 * `ST_Distance_Sphere` is POINT-POINT only, so for line distance we
 * use `ST_Distance` (planar, in degrees) with a degree-to-metre
 * conversion in JS. The error is sub-percent at city-scale
 * distances, which is the only regime we use these distances for.
 *
 * Used by `nearbyWays` (roads, rail lines, waterways) and
 * `linesAtPoint` (rail line names within radius).
 */
/** Build the Kysely query for `queryLines`. Exported for tests
 *  that compile the SQL and assert it uses the spatial index. */
export function buildLinesQuery(
	k: typeof db extends () => infer K ? K : never,
	lat: number,
	lon: number,
	radiusM: number,
	featureType: string,
	subtypes?: string[],
) {
	const point = sql`ST_GeomFromText(${`POINT(${lon} ${lat})`}, 4326)`;
	// Convert radius-metres to a degree budget for the SQL filter.
	// We use the smaller of the two scale factors so the degree
	// circle fully contains the metre circle. Conversion back to
	// metres uses the same scale.
	const mPerDeg = Math.min(METERS_PER_DEG_LAT, metersPerDegLon(lat));
	const dDeg = radiusM / mPerDeg;
	let q = k
		.selectFrom("osm_lines")
		.select([
			"osm_id",
			"osm_type",
			"subtype",
			"name",
			"tags_json",
			sql<number>`ST_Distance(geom, ${point})`.as("distance_deg"),
			// Whether the query point sits inside this way's bounding
			// box — a cheap "is the stay inside this footprint" test,
			// computed on the rows the MBR pre-filter already narrowed.
			sql<number>`MBRContains(geom, ${point})`.as("encloses"),
		])
		.where("feature_type", "=", featureType)
		// MBR pre-filter — without this, ST_Distance is computed
		// per row and the optimiser falls back to a 240k-row scan
		// via idx_feature_type (verified via EXPLAIN on 2026-05-13).
		// MBRIntersects uses the SPATIAL index and drops the
		// candidate set to a few rows before the distance check.
		.where(sql<boolean>`MBRIntersects(geom, ST_Buffer(${point}, ${dDeg}))`)
		.where(sql<boolean>`ST_Distance(geom, ${point}) < ${dDeg}`);
	if (subtypes && subtypes.length > 0) {
		q = q.where("subtype", "in", subtypes);
	}
	return q.orderBy("distance_deg" as never).limit(50);
}

export async function queryLines(
	lat: number,
	lon: number,
	radiusM: number,
	featureType: string,
	subtypes?: string[],
): Promise<LocalFeatureResult[]> {
	const mPerDeg = Math.min(METERS_PER_DEG_LAT, metersPerDegLon(lat));
	const rows = await buildLinesQuery(db(), lat, lon, radiusM, featureType, subtypes).execute();
	return rows.map((r) => ({
		osm_id: Number(r.osm_id),
		osm_type: r.osm_type,
		subtype: r.subtype,
		name: r.name,
		distance_m: Number(r.distance_deg) * mPerDeg,
		encloses: Number(r.encloses) === 1,
		// MariaDB's JSON column type may return either a string (legacy
		// driver) or a parsed object (driver auto-parses). Handle both.
		tags: (r.tags_json ? (typeof r.tags_json === "string" ? JSON.parse(r.tags_json) : r.tags_json) : {}) as Record<
			string,
			string
		>,
	}));
}

// ============================================================================
// Rail corridor — the self-contained geometry bundle the rail-snap
// algorithm runs on. The same query backs both the live velocity
// pipeline and `capture-railsnap-fixture`, so a captured test fixture
// is exactly what production sees — no drift between test and reality.
// ============================================================================

/** An axis-aligned lat/lon bounding box. */
export interface CorridorBbox {
	minLat: number;
	maxLat: number;
	minLon: number;
	maxLon: number;
}

/** Parse a `LINESTRING(lon lat,...)` WKT string — the form
 *  `ST_AsText(geom)` returns — into an ordered `[lat, lon]` list. WKT
 *  coordinate order is `x y` = `lon lat`. Non-LINESTRING input yields
 *  an empty array rather than throwing. */
export function parseLineStringWkt(wkt: string): Array<[number, number]> {
	const m = wkt.trim().match(/^LINESTRING\s*\((.+)\)$/i);
	if (!m) return [];
	const out: Array<[number, number]> = [];
	for (const pair of m[1].split(",")) {
		const [lon, lat] = pair.trim().split(/\s+/).map(Number);
		if (Number.isFinite(lat) && Number.isFinite(lon)) out.push([lat, lon]);
	}
	return out;
}

/** Parse a `POINT(lon lat)` WKT string into `{lat, lon}`, or null. */
export function parsePointWkt(wkt: string): { lat: number; lon: number } | null {
	const m = wkt.trim().match(/^POINT\s*\(([^)]+)\)$/i);
	if (!m) return null;
	const [lon, lat] = m[1].trim().split(/\s+/).map(Number);
	return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

/** The bbox as a closed-ring POLYGON WKT for an MBR spatial filter. */
function bboxPolygonWkt(b: CorridorBbox): string {
	return `POLYGON((${b.minLon} ${b.minLat},${b.maxLon} ${b.minLat},${b.maxLon} ${b.maxLat},${b.minLon} ${b.maxLat},${b.minLon} ${b.minLat}))`;
}

/** Margin (m) added around a train run's fixes when reading its rail
 *  corridor — wide enough that the line and both stations fall inside
 *  the box even where the fixes scatter off the track. */
const RAIL_CORRIDOR_MARGIN_M = 1500;

/** A {lat,lon} box around `fixes`, expanded by RAIL_CORRIDOR_MARGIN_M.
 *  Null when `fixes` is empty. */
function corridorBox(fixes: Array<{ lat: number; lon: number }>): CorridorBbox | null {
	if (fixes.length === 0) return null;
	let minLat = Number.POSITIVE_INFINITY;
	let maxLat = Number.NEGATIVE_INFINITY;
	let minLon = Number.POSITIVE_INFINITY;
	let maxLon = Number.NEGATIVE_INFINITY;
	for (const f of fixes) {
		minLat = Math.min(minLat, f.lat);
		maxLat = Math.max(maxLat, f.lat);
		minLon = Math.min(minLon, f.lon);
		maxLon = Math.max(maxLon, f.lon);
	}
	const dLat = RAIL_CORRIDOR_MARGIN_M / 111_320;
	const dLon = RAIL_CORRIDOR_MARGIN_M / (111_320 * Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180));
	return { minLat: minLat - dLat, maxLat: maxLat + dLat, minLon: minLon - dLon, maxLon: maxLon + dLon };
}

/**
 * Read the rail geometry — rail ways and stations — covering a fix
 * track straight from the local OSM mirror.
 *
 * Returns the self-contained {@link RailGeometry} the station-anchored
 * rail-snap algorithm consumes. This is a heavy spatial scan of the
 * ~1M-row osm_lines table (~10-15 s) and is run **offline only** — by
 * the refresh-rail-routes CLI, never on the request path. No network:
 * the mirror is already populated for travelled areas by the
 * classification pipeline.
 *
 * `wayRoutes` is returned empty: the snapper does not consume route
 * membership. When line disambiguation is built it will need its own
 * name-bounded query.
 */
export async function queryRailCorridor(fixes: Array<{ lat: number; lon: number }>): Promise<RailGeometry> {
	const bbox = corridorBox(fixes);
	if (!bbox) return { lines: [], wayRoutes: [], stations: [] };
	const poly = bboxPolygonWkt(bbox);

	const lineRows = (
		await sql<{ osm_id: bigint; name: string | null; subtype: string | null; wkt: string }>`
			SELECT osm_id, name, subtype, ST_AsText(geom) AS wkt
			FROM osm_lines
			WHERE feature_type = 'railway'
			  AND MBRIntersects(geom, ST_GeomFromText(${poly}, 4326))
			LIMIT 12000
		`.execute(db())
	).rows;
	const lines: OsmLine[] = [];
	for (const r of lineRows) {
		const coords = parseLineStringWkt(r.wkt);
		if (coords.length >= 2) lines.push({ osmId: Number(r.osm_id), name: r.name, subtype: r.subtype, coords });
	}

	const stationRows = (
		await sql<{ name: string | null; subtype: string | null; wkt: string }>`
			SELECT name, subtype, ST_AsText(geom) AS wkt
			FROM osm_points
			WHERE feature_type = 'railway'
			  AND subtype IN ('station', 'halt', 'stop', 'subway_entrance', 'tram_stop')
			  AND MBRIntersects(geom, ST_GeomFromText(${poly}, 4326))
			LIMIT 4000
		`.execute(db())
	).rows;
	const stations: OsmStation[] = [];
	for (const r of stationRows) {
		const p = parsePointWkt(r.wkt);
		if (p) stations.push({ name: r.name, subtype: r.subtype, lat: p.lat, lon: p.lon });
	}

	return { lines, wayRoutes: [], stations };
}

/** Drivable highway subtypes the road map-matcher routes over. Kept in
 *  sync with `DRIVABLE_HIGHWAY_SUBTYPES` in `rail-road-proximity.ts` — a
 *  local copy avoids an import cycle (rail-road-proximity → osm → osm-local).
 *  Pedestrian / cycleway are excluded; a car / bus did not drive them. */
const DRIVABLE_ROAD_SUBTYPES = [
	"motorway",
	"trunk",
	"primary",
	"secondary",
	"tertiary",
	"residential",
	"service",
	"unclassified",
	"track",
	"living_street",
];

/** Margin (m) around a road leg's fixes when reading its street network —
 *  enough that the carriageway and the streets either side of a scattered
 *  fix fall inside the box. Tighter than the rail corridor (roads are
 *  dense and a road leg is local, not a cross-city rail run). */
const ROAD_CORRIDOR_MARGIN_M = 400;

/**
 * Read the drivable street geometry around a point from the local OSM
 * mirror — the self-contained {@link OsmRoadWay} bundle the road
 * map-matcher (`road-match.ts`) routes a driving / bus leg onto.
 *
 * A box of `radiusM` (+ {@link ROAD_CORRIDOR_MARGIN_M}) around the point is
 * MBR-filtered against the spatial index, so this is a local query (a leg
 * spans ~1–2 km), not the heavy cross-city scan `queryRailCorridor` warns
 * about. No network: the mirror is already populated for travelled areas by
 * the classification pipeline.
 */
export async function queryDrivableRoads(lat: number, lon: number, radiusM: number): Promise<OsmRoadWay[]> {
	const dLat = (radiusM + ROAD_CORRIDOR_MARGIN_M) / 111_320;
	const dLon = (radiusM + ROAD_CORRIDOR_MARGIN_M) / (111_320 * Math.cos((lat * Math.PI) / 180));
	const bbox: CorridorBbox = { minLat: lat - dLat, maxLat: lat + dLat, minLon: lon - dLon, maxLon: lon + dLon };
	const poly = bboxPolygonWkt(bbox);

	const rows = (
		await sql<{ osm_id: bigint; name: string | null; subtype: string | null; wkt: string }>`
			SELECT osm_id, name, subtype, ST_AsText(geom) AS wkt
			FROM osm_lines
			WHERE feature_type = 'highway'
			  AND subtype IN (${sql.join(DRIVABLE_ROAD_SUBTYPES)})
			  AND MBRIntersects(geom, ST_GeomFromText(${poly}, 4326))
			LIMIT 20000
		`.execute(db())
	).rows;

	const ways: OsmRoadWay[] = [];
	for (const r of rows) {
		const coords = parseLineStringWkt(r.wkt);
		if (coords.length >= 2) ways.push({ osmId: Number(r.osm_id), name: r.name, subtype: r.subtype, coords });
	}
	return ways;
}

/** Highway subtypes a person on foot can plausibly be on — the soft surface
 *  prior for the pedestrian trajectory smoother. Pedestrian-only ways
 *  (footway/path/pedestrian/steps/cycleway/bridleway) PLUS every road class
 *  people walk along on the pavement — including urban main roads
 *  (tertiary/secondary/primary), whose centrelines are the pavement proxy just
 *  as `residential` is: OSM rarely maps their footways separately, and
 *  excluding them left HOLES in the pedestrian graph at every main road
 *  (measured, 2026-07-01 Bridge Road: the matcher could not follow the
 *  pavement and invented a service-alley + block-cut diagonal; the corrector
 *  could not route around the block either — its shortest "walkable" detour
 *  was a dishonest 1.6 km loop). Only motorway/trunk stay excluded: genuinely
 *  unwalkable. */
const WALKABLE_ROAD_SUBTYPES = [
	"footway",
	"path",
	"pedestrian",
	"steps",
	"cycleway",
	"bridleway",
	"living_street",
	"residential",
	"service",
	"unclassified",
	"track",
	"tertiary",
	"tertiary_link",
	"secondary",
	"secondary_link",
	"primary",
	"primary_link",
];

/**
 * Read the walkable way geometry around a point from the local OSM mirror —
 * the network the pedestrian map-matcher (`pedestrian-match.ts`) snaps a foot
 * leg onto. Mirrors {@link queryDrivableRoads} exactly with the walkable subtype
 * set: same local MBR query, no network.
 */
export async function queryWalkableRoads(lat: number, lon: number, radiusM: number): Promise<OsmRoadWay[]> {
	const dLat = (radiusM + ROAD_CORRIDOR_MARGIN_M) / 111_320;
	const dLon = (radiusM + ROAD_CORRIDOR_MARGIN_M) / (111_320 * Math.cos((lat * Math.PI) / 180));
	const bbox: CorridorBbox = { minLat: lat - dLat, maxLat: lat + dLat, minLon: lon - dLon, maxLon: lon + dLon };
	const poly = bboxPolygonWkt(bbox);

	const rows = (
		await sql<{ osm_id: bigint; name: string | null; subtype: string | null; wkt: string }>`
			SELECT osm_id, name, subtype, ST_AsText(geom) AS wkt
			FROM osm_lines
			WHERE feature_type = 'highway'
			  AND subtype IN (${sql.join(WALKABLE_ROAD_SUBTYPES)})
			  AND MBRIntersects(geom, ST_GeomFromText(${poly}, 4326))
			LIMIT 20000
		`.execute(db())
	).rows;

	const ways: OsmRoadWay[] = [];
	for (const r of rows) {
		const coords = parseLineStringWkt(r.wkt);
		if (coords.length >= 2) ways.push({ osmId: Number(r.osm_id), name: r.name, subtype: r.subtype, coords });
	}
	return ways;
}

/** A building footprint as a closed lat/lon ring. */
export type BuildingFootprint = Array<{ lat: number; lon: number }>;

/** Query-bbox margin (m) around a building lookup. Small — buildings only
 *  matter right next to the walk. */
const BUILDING_QUERY_MARGIN_M = 100;

/**
 * Building footprint rings within `radiusM` of a point — the impassable-surface
 * layer for the pedestrian smoother. Buildings are closed OSM ways, stored as
 * LINESTRING outlines in `osm_lines` under `feature_type = 'building'`. A ring
 * with fewer than 3 points isn't a polygon and is dropped.
 */
export async function queryBuildingsNear(lat: number, lon: number, radiusM: number): Promise<BuildingFootprint[]> {
	const dLat = (radiusM + BUILDING_QUERY_MARGIN_M) / 111_320;
	const dLon = (radiusM + BUILDING_QUERY_MARGIN_M) / (111_320 * Math.cos((lat * Math.PI) / 180));
	const bbox: CorridorBbox = { minLat: lat - dLat, maxLat: lat + dLat, minLon: lon - dLon, maxLon: lon + dLon };
	const poly = bboxPolygonWkt(bbox);

	const rows = (
		await sql<{ wkt: string }>`
			SELECT ST_AsText(geom) AS wkt
			FROM osm_lines
			WHERE feature_type = 'building'
			  AND MBRIntersects(geom, ST_GeomFromText(${poly}, 4326))
			LIMIT 20000
		`.execute(db())
	).rows;

	const rings: BuildingFootprint[] = [];
	for (const r of rows) {
		const coords = parseLineStringWkt(r.wkt);
		if (coords.length >= 3) rings.push(coords.map(([la, lo]) => ({ lat: la, lon: lo })));
	}
	return rings;
}
