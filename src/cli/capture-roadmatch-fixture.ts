/**
 * CLI tool: capture a day as a self-contained road map-match test fixture.
 *
 * # Why this exists
 *
 * The map draws driving / road-vehicle legs as the raw GPS polyline, which
 * cuts through buildings and short-cuts corners. `road-match.ts` snaps a leg
 * onto the street network, but — exactly as the rail-snap saga taught us —
 * synthetic unit tests cannot reproduce the GPS pathologies that decide
 * whether a map-matcher works in production. This tool freezes one real day
 * (its raw fixes, classified road-vehicle segments, and the OSM road
 * geometry around them) into a fixture the offline `road-match-e2e` test runs
 * the matcher against, with no DB and no network.
 *
 * # Output
 *
 * Writes `tests/fixtures/roadmatch/<date>-<user>.json` by default. That
 * directory is gitignored — the fixture holds real coordinates and journeys
 * (same policy as `tests/fixtures/railsnap/` and `tests/golden/`). The
 * fixture FORMAT is generic; only the captured file is private.
 *
 * Usage (via scripts/prod-db.sh, or in-pod with DB env set):
 *   node dist/cli/capture-roadmatch-fixture.js <date> <user> <tz> [--out <path>]
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "kysely";
import { z } from "zod";
import { db, initPool, withConnection } from "../db/pool.js";
import { migrate } from "../db/schema.js";
import { DRIVABLE_HIGHWAY_SUBTYPES } from "../geo/rail-road-proximity.js";
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
	console.error("Usage: node dist/cli/capture-roadmatch-fixture.js <date> <user> <tz> [--out <path>]");
	process.exit(2);
}
const date = args[0];
const userId = args[1];
const tz = args[2];
const outIdx = args.indexOf("--out");
const outPath = outIdx >= 0 ? args[outIdx + 1] : path.join("tests/fixtures/roadmatch", `${date}-${userId}.json`);

/** Margin (m) around a road leg's fixes when capturing its OSM geometry.
 *  Roads are dense, so a tighter box than the rail corridor suffices, but
 *  wide enough that the streets either side of a scattered fix are in. */
const ROAD_MARGIN_M = 400;
const M_PER_DEG_LAT = 111_000;

/** Effective modes that draw as a raw road polyline today (episode-geometry
 *  `MOVING_MODES` minus rail/air): the legs road map-matching targets. */
const ROAD_MODES = new Set(["driving", "bus", "cycling"]);

interface Bbox {
	minLat: number;
	maxLat: number;
	minLon: number;
	maxLon: number;
}

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

initPool(config.db);
await withConnection(migrate);

console.log(`Capturing road-match fixture — ${date} / ${userId} (${tz})`);

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
const roadSegs = segOut.filter((s) => ROAD_MODES.has(s.refinedMode ?? s.mode));
console.log(`  segments: ${segOut.length} (${roadSegs.length} road-vehicle)`);

// --- OSM drivable-road geometry around every road leg -------------------
// One bbox per road leg; geometry unioned and de-duplicated. Read straight
// from the local OSM mirror, filtered to the drivable highway subtypes the
// matcher routes over (footways / cycleways excluded).
const legs: Bbox[] = [];
for (const s of roadSegs) {
	const inWin = rawFixes.filter((f) => f.ts >= s.startTs && f.ts <= s.endTs);
	const b = bboxAround(inWin, ROAD_MARGIN_M);
	if (b) legs.push(b);
}

const drivable = [...DRIVABLE_HIGHWAY_SUBTYPES];
const wayById = new Map<
	number,
	{ osmId: number; name: string | null; subtype: string | null; coords: Array<[number, number]> }
>();

for (const b of legs) {
	const poly = bboxPolygonWkt(b);
	const rows = (
		await sql<{ osm_id: bigint; name: string | null; subtype: string | null; wkt: string }>`
			SELECT osm_id, name, subtype, ST_AsText(geom) AS wkt
			FROM osm_lines
			WHERE feature_type = 'highway'
			  AND subtype IN (${sql.join(drivable)})
			  AND MBRIntersects(geom, ST_GeomFromText(${poly}, 4326))
			LIMIT 20000
		`.execute(db())
	).rows;
	for (const r of rows) {
		const id = Number(r.osm_id);
		if (!wayById.has(id)) {
			wayById.set(id, { osmId: id, name: r.name, subtype: r.subtype, coords: parseLineString(r.wkt) });
		}
	}
}

const osmRoadWays = [...wayById.values()].filter((w) => w.coords.length >= 2);
console.log(`  OSM: ${osmRoadWays.length} drivable road ways`);

// --- write --------------------------------------------------------------
const fixture = {
	schema: "roadmatch-fixture/1",
	date,
	user: userId,
	tz,
	capturedAt: new Date().toISOString(),
	rawFixes,
	segments: segOut,
	osmRoadWays,
};

await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(fixture));
console.log(`Wrote ${outPath}`);
process.exit(0);
