// Does the OSM mirror hold BUILDING outlines, and near where it holds roads?
// (#1627)
//
// Usage (from the health repo root):
//   scripts/prod-db.sh node scripts/probe-mirror-buildings.mjs
//
// ⚠ Written because a test found the gap, not the other way round.
// `tests/mirror_rows_come_back.rs` asks the three OSM callbacks for rows 250 m
// around a public central-London square. `walkable_roads` and `drivable_roads`
// answer; `buildings_near` answers NOTHING. That is precisely the shape #1627
// says the refusal counters cannot see: a query that runs, succeeds, and
// returns zero rows counts no refusal and no failure, and reads as perfect.
//
// A missing building outline is not cosmetic — `offPathBuildingCrossingM` is
// the walk referee's "true defect" metric and #1501's building ground both ask
// whether a drawn line goes through a wall. With no footprints, both answer
// "no walls here" everywhere the mirror is blank.
//
// This asks which of the two it is: no building rows AT ALL, no building rows
// in that bbox, or rows excluded by the callback's own subtype predicate.
import { createConnection } from "mariadb";

const c = await createConnection({
	host: process.env.DB_HOST,
	port: +(process.env.DB_PORT || 3306),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: process.env.DB_NAME,
});
// ⚠ Counts arrive as BigInt and JSON.stringify throws on them.
const j = (v) => (typeof v === "bigint" ? Number(v) : v);
const q = async (sql, p = []) =>
	(await c.query(sql, p)).map((r) =>
		Object.fromEntries(Object.entries(r).map(([k, v]) => [k, j(v)])),
	);

console.log("feature_type census in osm_lines:");
for (const r of await q(
	"SELECT feature_type ft, COUNT(*) n FROM osm_lines GROUP BY feature_type ORDER BY n DESC LIMIT 15"
))
	console.log(`   ${String(r.n).padStart(9)}  ${r.ft}`);

console.log("\nbuilding subtypes (top 12):");
for (const r of await q(
	"SELECT subtype st, COUNT(*) n FROM osm_lines WHERE feature_type='building' GROUP BY subtype ORDER BY n DESC LIMIT 12"
))
	console.log(`   ${String(r.n).padStart(9)}  ${r.st === null ? "(NULL)" : r.st}`);

// The same bbox the callback builds: the radius plus its building margin.
const lat = 51.508,
	lon = -0.1281,
	m = 250 + 30;
const dLat = m / 111320,
	dLon = m / (111320 * Math.cos((lat * Math.PI) / 180));
const poly = `POLYGON((${lon - dLon} ${lat - dLat},${lon + dLon} ${lat - dLat},${lon + dLon} ${lat + dLat},${lon - dLon} ${lat + dLat},${lon - dLon} ${lat - dLat}))`;
for (const [label, sql] of [
	[
		"buildings in the bbox (NO subtype filter, so the predicate cannot hide them)",
		"SELECT COUNT(*) n FROM osm_lines WHERE feature_type='building' AND MBRIntersects(geom, ST_GeomFromText(?,4326))",
	],
	[
		"ANY feature in the bbox (the control: is the mirror blank here at all?)",
		"SELECT COUNT(*) n FROM osm_lines WHERE MBRIntersects(geom, ST_GeomFromText(?,4326))",
	],
])
	console.log(`\n${label}:\n   ${(await q(sql, [poly]))[0].n}`);

await c.end();
