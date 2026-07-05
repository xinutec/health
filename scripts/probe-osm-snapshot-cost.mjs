// One-shot diagnostic for Phase 6c design: measure the actual cost of
// the three OSM-snapshot loading strategies against prod data.
//
// Strategies compared:
//   - "day-bbox" (current Phase 6b dead code): one ST_Buffer query per
//     feature_type at day-scale radius. The hypothesis: this is the
//     36×-slower path because the MBR result set is huge.
//   - "tile-aligned": query each unique osm_coverage tile the day's
//     fixes touch, one per feature_type. Tile = the 10km bbox the
//     coverage row already encodes.
//   - "per-fix": one tiny MBR query per fix per feature_type. Many
//     small queries, each indexed-fast.
//
// Sample geography: a central London point (King's Cross) plus a
// synthetic travel day (London → Paris) to put both regimes on the
// same chart.
//
// Run via:  scripts/prod-db.sh node scripts/probe-osm-snapshot-cost.mjs

import { createConnection } from "mariadb";

const c = await createConnection({
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: "health",
});

const FEATURE_TYPES = ["highway", "railway", "waterway", "aeroway", "landmark"];
const M_PER_DEG_LAT = 111_000;
const mPerDegLon = (lat) => 111_000 * Math.cos((lat * Math.PI) / 180);

function header(s) {
	console.log(`\n=== ${s} ===`);
}

// ----- 1. osm_coverage state -----
header("osm_coverage state");
const covByType = await c.query(
	`SELECT feature_type,
	        COUNT(*) AS n,
	        MIN(min_lat) AS min_lat, MAX(max_lat) AS max_lat,
	        MIN(min_lon) AS min_lon, MAX(max_lon) AS max_lon,
	        MIN(fetched_at) AS oldest, MAX(fetched_at) AS newest
	 FROM osm_coverage
	 GROUP BY feature_type
	 ORDER BY feature_type`,
);
for (const r of covByType) {
	console.log(
		`  ${r.feature_type.padEnd(10)} n=${String(r.n).padStart(4)} ` +
			`lat=[${Number(r.min_lat).toFixed(2)},${Number(r.max_lat).toFixed(2)}] ` +
			`lon=[${Number(r.min_lon).toFixed(2)},${Number(r.max_lon).toFixed(2)}] ` +
			`oldest=${r.oldest?.toISOString?.().slice(0, 10) ?? "n/a"} newest=${r.newest?.toISOString?.().slice(0, 10) ?? "n/a"}`,
	);
}

const totalCov = covByType.reduce((s, r) => s + Number(r.n), 0);
console.log(`  TOTAL coverage rows: ${totalCov}`);

// ----- 2. osm_lines / osm_points totals -----
header("osm_lines / osm_points totals");
const lineCounts = await c.query(
	`SELECT feature_type, COUNT(*) AS n FROM osm_lines GROUP BY feature_type ORDER BY feature_type`,
);
const pointCounts = await c.query(
	`SELECT feature_type, COUNT(*) AS n FROM osm_points GROUP BY feature_type ORDER BY feature_type`,
);
console.log("  lines:  ", lineCounts.map((r) => `${r.feature_type}=${Number(r.n)}`).join(" "));
console.log("  points: ", pointCounts.map((r) => `${r.feature_type}=${Number(r.n)}`).join(" "));

// ----- 3. Strategy timing at one central London point (synthetic London-day) -----
// King's Cross is a reasonable "London-day centroid" proxy.
const KX_LAT = 51.531;
const KX_LON = -0.124;

async function timeIt(label, fn) {
	const t0 = Date.now();
	const result = await fn();
	const ms = Date.now() - t0;
	console.log(`  ${label.padEnd(40)} ${String(ms).padStart(5)}ms  rows=${result}`);
	return { ms, rows: result };
}

async function dayBboxQuery(lat, lon, radiusM, featureType, table) {
	const mPerDeg = Math.min(M_PER_DEG_LAT, mPerDegLon(lat));
	const dDeg = radiusM / mPerDeg;
	const point = `POINT(${lon} ${lat})`;
	// Same shape as loadOsmLinesWithGeom / loadOsmPointsWithGeom in
	// src/geo/load-classification-inputs.ts. We're counting rows + a
	// stub of WKT serialisation cost; ST_AsText is what makes the
	// payload heavy.
	const distPred =
		table === "osm_points"
			? `ST_Distance_Sphere(geom, ST_GeomFromText(?)) < ?`
			: `ST_Distance(geom, ST_GeomFromText(?)) < ?`;
	const distArg = table === "osm_points" ? radiusM : dDeg;
	const rows = await c.query(
		`SELECT subtype, name, ST_AsText(geom) AS geom_wkt FROM ${table}
		 WHERE feature_type = ?
		   AND MBRIntersects(geom, ST_Buffer(ST_GeomFromText(?), ?))
		   AND ${distPred}`,
		[featureType, point, dDeg, point, distArg],
	);
	return rows.length;
}

async function smallMbrCount(lat, lon, radiusM, featureType, table) {
	const mPerDeg = Math.min(M_PER_DEG_LAT, mPerDegLon(lat));
	const dDeg = radiusM / mPerDeg;
	const point = `POINT(${lon} ${lat})`;
	const rows = await c.query(
		`SELECT 1 FROM ${table}
		 WHERE feature_type = ?
		   AND MBRIntersects(geom, ST_Buffer(ST_GeomFromText(?), ?))`,
		[featureType, point, dDeg],
	);
	return rows.length;
}

header("Strategy A: day-bbox load — single London-radius query per feature_type");
// London-only day: bbox radius ~10-16 km. Use 12.
for (const t of FEATURE_TYPES) {
	await timeIt(`lines  type=${t}`, () => dayBboxQuery(KX_LAT, KX_LON, 12_000, t, "osm_lines"));
	await timeIt(`points type=${t}`, () => dayBboxQuery(KX_LAT, KX_LON, 12_000, t, "osm_points"));
}

header("Strategy B: tile-aligned load — query each touched osm_coverage tile");
// Find which tiles the point lies in (or near), per feature_type.
for (const t of FEATURE_TYPES) {
	const tiles = await c.query(
		`SELECT min_lat, max_lat, min_lon, max_lon FROM osm_coverage
		 WHERE feature_type = ?
		   AND min_lat <= ? AND max_lat >= ? AND min_lon <= ? AND max_lon >= ?`,
		[t, KX_LAT, KX_LAT, KX_LON, KX_LON],
	);
	console.log(`  ${t}: ${tiles.length} tile(s) cover King's Cross`);
	if (tiles.length === 0) continue;
	const tile = tiles[0];
	for (const table of ["osm_lines", "osm_points"]) {
		await timeIt(`  ${table} type=${t} tile`, async () => {
			const poly = `POLYGON((${tile.min_lon} ${tile.min_lat},${tile.max_lon} ${tile.min_lat},${tile.max_lon} ${tile.max_lat},${tile.min_lon} ${tile.max_lat},${tile.min_lon} ${tile.min_lat}))`;
			const rows = await c.query(
				`SELECT subtype, name, ST_AsText(geom) AS geom_wkt FROM ${table}
				 WHERE feature_type = ?
				   AND MBRIntersects(geom, ST_GeomFromText(?))`,
				[t, poly],
			);
			return rows.length;
		});
	}
}

header("Strategy C: per-fix load — 200 fixes × 4 feature_types, count rows only");
// Synthesize 200 fixes scattered ±5km around King's Cross. Time the
// total cost of doing a small MBR per fix per feature_type per table.
const fixes = Array.from({ length: 200 }, (_, i) => {
	// Spiral the fixes around the centroid so they land in different
	// neighbourhoods (some indoors, some at major intersections).
	const r = (i / 199) * (5000 / M_PER_DEG_LAT);
	const a = i * 0.31;
	return { lat: KX_LAT + r * Math.cos(a), lon: KX_LON + r * Math.sin(a) };
});
const t0 = Date.now();
let totalRows = 0;
for (const f of fixes) {
	for (const t of FEATURE_TYPES) {
		totalRows += await smallMbrCount(f.lat, f.lon, 100, t, "osm_lines");
		totalRows += await smallMbrCount(f.lat, f.lon, 100, t, "osm_points");
	}
}
const perFixMs = Date.now() - t0;
console.log(`  total fixes=${fixes.length} queries=${fixes.length * FEATURE_TYPES.length * 2} rows_hit=${totalRows} ${perFixMs}ms`);

// ----- 4. Strategy A again but for a travel day (London → Paris bbox) -----
header("Strategy A: day-bbox load — synthetic London→Paris travel-day bbox");
// Midpoint between KX and Paris Gare du Nord (48.880, 2.355): ~50.2, 1.11
// Radius is half the haversine distance + buffer: ~210 km
const TR_LAT = 50.2;
const TR_LON = 1.11;
for (const t of FEATURE_TYPES) {
	await timeIt(`lines  type=${t} (210km)`, () => dayBboxQuery(TR_LAT, TR_LON, 210_000, t, "osm_lines"));
	await timeIt(`points type=${t} (210km)`, () => dayBboxQuery(TR_LAT, TR_LON, 210_000, t, "osm_points"));
}

await c.end();
