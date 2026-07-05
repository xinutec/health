/**
 * CLI tool: capture a day as a self-contained rail-snap test fixture.
 *
 * # Why this exists
 *
 * The rail-snap feature shipped three times and failed three times —
 * its unit tests passed throughout, because they ran on tidy synthetic
 * routes with evenly-spread fixes. Real GPS is not tidy: platform
 * dwell-clumps, fixes that claim 5 m accuracy but sit a kilometre off,
 * coarse cell-tower scatter. The synthetic tests could not see any of
 * that, so "tests pass" told us nothing.
 *
 * This tool freezes one real day into a fixture an offline test can
 * run the (next, redesigned) rail-snap algorithm against. The fixture
 * is *self-contained*: raw fixes, the classified segments, AND the OSM
 * rail geometry (lines, route-relation membership, stations) for every
 * train corridor — so the test needs no database and no network, yet
 * exercises the exact pathologies that broke production.
 *
 * # Output
 *
 * Writes `tests/fixtures/railsnap/<date>-<user>.json` by default. That
 * directory is gitignored — the fixture contains real coordinates and
 * journeys (same policy as `tests/fixtures/days/` and `tests/golden/`).
 * The fixture FORMAT is generic; only the captured file is private.
 *
 * Usage (via scripts/prod-db.sh, or in-pod with DB env set):
 *   node dist/cli/capture-railsnap-fixture.js <date> <user> <tz> [--out <path>]
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "kysely";
import { z } from "zod";
import { db, initPool, withConnection } from "../db/pool.js";
import { migrate } from "../db/schema.js";
import { dateBoundsUtc } from "../geo/timezone.js";
import { computeVelocity } from "../geo/velocity.js";
import { fetchTrackPoints } from "../nextcloud/phonetrack.js";

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

const args = process.argv.slice(2);
if (args.length < 3) {
	console.error("Usage: node dist/cli/capture-railsnap-fixture.js <date> <user> <tz> [--out <path>]");
	process.exit(2);
}
const date = args[0];
const userId = args[1];
const tz = args[2];
const outIdx = args.indexOf("--out");
const outPath = outIdx >= 0 ? args[outIdx + 1] : path.join("tests/fixtures/railsnap", `${date}-${userId}.json`);

/** Margin (m) added around a train run's fixes when capturing the
 *  corridor's OSM geometry — wide enough that the full rail line and
 *  both stations are inside the box even where fixes scatter. */
const CORRIDOR_MARGIN_M = 1500;
const M_PER_DEG_LAT = 111_000;

interface Bbox {
	minLat: number;
	maxLat: number;
	minLon: number;
	maxLon: number;
}

/** A {lat,lon} bounding box around `pts`, expanded by `marginM`. */
function bboxAround(pts: Array<{ lat: number; lon: number }>, marginM: number): Bbox | null {
	if (pts.length === 0) return null;
	let minLat = Infinity;
	let maxLat = -Infinity;
	let minLon = Infinity;
	let maxLon = -Infinity;
	for (const p of pts) {
		minLat = Math.min(minLat, p.lat);
		maxLat = Math.max(maxLat, p.lat);
		minLon = Math.min(minLon, p.lon);
		maxLon = Math.max(maxLon, p.lon);
	}
	const dLat = marginM / M_PER_DEG_LAT;
	const dLon = marginM / (M_PER_DEG_LAT * Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180));
	return { minLat: minLat - dLat, maxLat: maxLat + dLat, minLon: minLon - dLon, maxLon: maxLon + dLon };
}

function bboxPolygonWkt(b: Bbox): string {
	return `POLYGON((${b.minLon} ${b.minLat},${b.maxLon} ${b.minLat},${b.maxLon} ${b.maxLat},${b.minLon} ${b.maxLat},${b.minLon} ${b.minLat}))`;
}

/** Parse `LINESTRING(lon lat,...)` WKT into [lat,lon] pairs. */
function parseLineString(wkt: string): Array<[number, number]> {
	const m = wkt.trim().match(/^LINESTRING\s*\((.+)\)$/i);
	if (!m) return [];
	const out: Array<[number, number]> = [];
	for (const pair of m[1].split(",")) {
		const [lon, lat] = pair.trim().split(/\s+/).map(Number);
		if (Number.isFinite(lat) && Number.isFinite(lon)) out.push([lat, lon]);
	}
	return out;
}

/** Parse `POINT(lon lat)` WKT into {lat,lon}. */
function parsePoint(wkt: string): { lat: number; lon: number } | null {
	const m = wkt.trim().match(/^POINT\s*\(([^)]+)\)$/i);
	if (!m) return null;
	const [lon, lat] = m[1].trim().split(/\s+/).map(Number);
	return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

initPool(config.db);
await withConnection(migrate);

console.log(`Capturing rail-snap fixture — ${date} / ${userId} (${tz})`);

// --- raw fixes ----------------------------------------------------------
const nextDay = (() => {
	const d = new Date(date);
	d.setDate(d.getDate() + 1);
	return d.toISOString().slice(0, 10);
})();
const bounds = dateBoundsUtc(date, tz);
const rawFixes = (await fetchTrackPoints(config, userId, date, nextDay))
	.filter((p) => p.ts >= bounds.startUtc && p.ts < bounds.endUtc)
	.map((p) => ({ ts: p.ts, lat: p.lat, lon: p.lon, accuracy: p.accuracy }));
console.log(`  raw fixes: ${rawFixes.length}`);

// --- classified segments ------------------------------------------------
const { segments } = await computeVelocity(config, userId, date, tz);
const segOut = segments.map((s) => ({
	startTs: s.startTs,
	endTs: s.endTs,
	mode: s.mode,
	refinedMode: s.refinedMode ?? null,
	wayName: s.wayName ?? null,
	place: s.place ?? null,
}));
const trainSegs = segOut.filter((s) => (s.refinedMode ?? s.mode) === "train");
console.log(`  segments: ${segOut.length} (${trainSegs.length} train)`);

// --- OSM geometry for every train corridor ------------------------------
// One bbox per train run; the geometry of all corridors is unioned and
// de-duplicated. Read straight from the local OSM mirror tables.
const corridors: Bbox[] = [];
for (const s of trainSegs) {
	const inWin = rawFixes.filter((f) => f.ts >= s.startTs && f.ts <= s.endTs);
	const b = bboxAround(inWin, CORRIDOR_MARGIN_M);
	if (b) corridors.push(b);
}

const lineById = new Map<
	number,
	{ osmId: number; name: string | null; subtype: string | null; coords: Array<[number, number]> }
>();
const stationByKey = new Map<string, { name: string | null; subtype: string | null; lat: number; lon: number }>();

for (const b of corridors) {
	const poly = bboxPolygonWkt(b);
	const lineRows = (
		await sql<{ osm_id: bigint; name: string | null; subtype: string | null; wkt: string }>`
			SELECT osm_id, name, subtype, ST_AsText(geom) AS wkt
			FROM osm_lines
			WHERE feature_type = 'railway'
			  AND MBRIntersects(geom, ST_GeomFromText(${poly}, 4326))
			LIMIT 8000
		`.execute(db())
	).rows;
	for (const r of lineRows) {
		const id = Number(r.osm_id);
		if (!lineById.has(id)) {
			lineById.set(id, { osmId: id, name: r.name, subtype: r.subtype, coords: parseLineString(r.wkt) });
		}
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
	for (const r of stationRows) {
		const p = parsePoint(r.wkt);
		if (!p) continue;
		stationByKey.set(`${r.name}|${p.lat.toFixed(6)}|${p.lon.toFixed(6)}`, {
			name: r.name,
			subtype: r.subtype,
			lat: p.lat,
			lon: p.lon,
		});
	}
}

const osmLines = [...lineById.values()].filter((l) => l.coords.length >= 2);
const osmStations = [...stationByKey.values()];

// --- route-relation membership for the captured ways --------------------
// osm_way_routes maps a track way to the rail line(s) it belongs to —
// the signal that makes a line's geometry complete (a way often carries
// the line name only on the relation). Capture the rows for the ways we
// captured above.
const wayIds = osmLines.map((l) => l.osmId);
let osmWayRoutes: Array<{ wayId: number; routeName: string; routeType: string }> = [];
if (wayIds.length > 0) {
	const routeRows = (
		await sql<{ osm_way_id: bigint; route_name: string; route_type: string }>`
			SELECT osm_way_id, route_name, route_type
			FROM osm_way_routes
			WHERE osm_way_id IN (${sql.join(wayIds)})
		`.execute(db())
	).rows;
	osmWayRoutes = routeRows.map((r) => ({
		wayId: Number(r.osm_way_id),
		routeName: r.route_name,
		routeType: r.route_type,
	}));
}
console.log(
	`  OSM: ${osmLines.length} rail ways, ${osmWayRoutes.length} route memberships, ${osmStations.length} stations`,
);

// --- write --------------------------------------------------------------
const fixture = {
	schema: "railsnap-fixture/1",
	date,
	user: userId,
	tz,
	capturedAt: new Date().toISOString(),
	rawFixes,
	segments: segOut,
	osmLines,
	osmWayRoutes,
	osmStations,
};

await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(fixture));
console.log(`Wrote ${outPath}`);
process.exit(0);
