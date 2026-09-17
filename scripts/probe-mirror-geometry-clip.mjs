// How much of the WKT the road callbacks hand back lies OUTSIDE the bbox that
// asked for it? (#1071)
//
// Usage (from the health repo root):
//   scripts/prod-db.sh node scripts/probe-mirror-geometry-clip.mjs
//
// ⚠ READ-ONLY. Every statement is a SELECT. It is still a production actor when
// pointed at production: it takes a connection and a read lock like any client.
//
// WHY THIS QUANTITY. #1071 has killed six explanations, every one of them built
// from quantities that were already instrumented. The counter added last time —
// what the callbacks HAND BACK — found 250,616 rows and 29 MB of WKT for 38,254
// distinct ways. This asks the next question down: of those 29 MB, how many
// bytes are geometry the asking bbox does not even cover?
//
// `query_ways` selects `ST_AsText(geom)` for every way that MBRIntersects the
// bbox. A way is a whole OSM line — a road that clips the corner of the box
// arrives in full, however far it runs beyond it. If most bytes are outside,
// then "ask for less geometry" has a mechanical form (clip server-side) that
// changes no predicate and drops no way.
//
// ⚠ THIS MEASURES THE LEVER, NOT THE FIX. A clipped LINESTRING can come back as
// a MULTILINESTRING when a road leaves the box and re-enters, and
// `parse_linestring_wkt` DROPS anything that is not a bare LINESTRING — silently,
// to an empty way. The multipart count below is what says whether that is rare
// or ruinous, and no clip ships until it is answered.
import { createConnection } from "mariadb";

// Public central-London landmarks, deliberately not places the user goes (#860).
// The mirror is built around where he moves; these sit inside that area without
// naming anywhere of his. The clip ratio is a property of OSM road geometry in a
// dense city, not of any particular location.
const POINTS = [
	["Trafalgar Square", 51.508, -0.1281],
	["St Paul's", 51.5138, -0.0984],
	["Regent's Park", 51.5313, -0.1570],
];

// `mirror.rs`: ROAD_CORRIDOR_MARGIN_M, and a disc radius from WalkAnnotate's
// own #guard (231 m for the pinned leg).
const ROAD_CORRIDOR_MARGIN_M = 400;
const RADIUS_M = 231;

// ⚠ COPIED FROM `mirror.rs`, in its order and its entirety. A probe that
// guesses this list measures a different query than the one under study —
// motorway and trunk are the only two highway classes NOT here.
const WALKABLE = ["footway", "path", "pedestrian", "steps", "cycleway",
	"bridleway", "living_street", "residential", "service", "unclassified",
	"track", "tertiary", "tertiary_link", "secondary", "secondary_link",
	"primary", "primary_link"];

// `bbox_polygon_wkt` — the same arithmetic, so the box is the one the callback
// would actually send.
const bboxWkt = (lat, lon, radiusM, marginM) => {
	const dLat = (radiusM + marginM) / 111320;
	const dLon = (radiusM + marginM) / (111320 * Math.cos((lat * Math.PI) / 180));
	const [a, b] = [lat - dLat, lat + dLat];
	const [c, d] = [lon - dLon, lon + dLon];
	return `POLYGON((${c} ${a},${d} ${a},${d} ${b},${c} ${b},${c} ${a}))`;
};

const conn = await createConnection({
	host: process.env.DB_HOST,
	port: +(process.env.DB_PORT || 3306),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: process.env.DB_NAME,
});
// ⚠ THREE WIRE TYPES FOR A NUMBER, and only one of them is a number. COUNT(*)
// arrives as BigInt; SUM() of an integer expression arrives as a DECIMAL, which
// this driver hands back as a STRING. A `+=` onto a string CONCATENATES, and the
// first run of this probe printed a 15-digit KiB total for exactly that reason —
// while the per-point ratios were right, because `/` coerces and `+` does not.
const n = (v) => (v === null ? 0 : Number(v));

const ph = WALKABLE.map(() => "?").join(",");

console.log(`margin ${ROAD_CORRIDOR_MARGIN_M} m · radius ${RADIUS_M} m · ` +
	`walkable subtypes ${WALKABLE.length}\n`);

let totFull = 0, totClip = 0, totRows = 0, totMulti = 0, totEmpty = 0;

for (const [name, lat, lon] of POINTS) {
	const poly = bboxWkt(lat, lon, RADIUS_M, ROAD_CORRIDOR_MARGIN_M);
	// One pass: full bytes, clipped bytes, and the shape the clip produces.
	// ST_Intersection of a LINESTRING with a POLYGON is a LINESTRING when the
	// road crosses once and a MULTILINESTRING when it leaves and returns.
	const [r] = await conn.query(
		`SELECT COUNT(*) rows_n,
		        SUM(LENGTH(ST_AsText(geom))) full_b,
		        SUM(LENGTH(ST_AsText(ST_Intersection(geom, ST_GeomFromText(?, 4326))))) clip_b,
		        SUM(ST_GeometryType(ST_Intersection(geom, ST_GeomFromText(?, 4326)))
		            = 'MULTILINESTRING') multi_n,
		        SUM(ST_IsEmpty(ST_Intersection(geom, ST_GeomFromText(?, 4326)))) empty_n
		   FROM osm_lines
		  WHERE feature_type = 'highway'
		    AND subtype IN (${ph})
		    AND MBRIntersects(geom, ST_GeomFromText(?, 4326))`,
		[poly, poly, poly, ...WALKABLE, poly],
	);
	const rows = n(r.rows_n), full = n(r.full_b), clip = n(r.clip_b);
	const multi = n(r.multi_n), empty = n(r.empty_n);
	totRows += rows; totFull += full; totClip += clip;
	totMulti += multi; totEmpty += empty;
	console.log(
		`${name.padEnd(18)} ${String(rows).padStart(5)} ways · ` +
		`${(full / 1024).toFixed(0).padStart(5)} KiB full · ` +
		`${(clip / 1024).toFixed(0).padStart(5)} KiB clipped · ` +
		`${((1 - clip / full) * 100).toFixed(1).padStart(5)}% outside the box · ` +
		`${multi} multipart · ${empty} empty`,
	);
}

console.log(
	`\nTOTAL              ${String(totRows).padStart(5)} ways · ` +
	`${(totFull / 1024).toFixed(0)} KiB full · ${(totClip / 1024).toFixed(0)} KiB clipped · ` +
	`${((1 - totClip / totFull) * 100).toFixed(1)}% of the bytes are outside the asking box`,
);
console.log(
	`multipart after clip: ${totMulti}/${totRows} ` +
	`(${((totMulti / totRows) * 100).toFixed(1)}%) — each one is a way ` +
	`parse_linestring_wkt would silently drop to empty`,
);
console.log(`empty after clip: ${totEmpty}/${totRows} — MBR touches, geometry does not`);

// ## The margin's own share — the lever the clip ratio is not
//
// `query_ways` pads the disc by ROAD_CORRIDOR_MARGIN_M before it builds the
// box, so a 231 m disc asks a 631 m half-width square: 7.5x the AREA of the
// disc it was asked about. This sweeps the pad and prices each step, because
// "ask for less geometry" has to name a number to be a change.
//
// ⚠ A SMALLER MARGIN IS NOT FREE and this probe cannot tell you what it costs.
// The margin is road CONTEXT: a walk near the rim of the disc needs the road it
// is on to continue past the rim, or the matcher loses it. What the floors do
// is a gate question and nothing here answers it.
console.log("\nmargin sweep — ways and bytes per road query\n");
console.log("  point                margin   ways      KiB    vs 400 m");
for (const [name, lat, lon] of POINTS) {
	// ⚠ MEASURE ALL FIVE, THEN PRINT. The "% of 400 m" column needs the 400 m
	// row as its denominator, and 400 is the LAST margin swept — printing inside
	// the loop leaves that column blank on every row but one.
	const sweep = [];
	for (const margin of [0, 50, 100, 200, 400]) {
		const [r] = await conn.query(
			`SELECT COUNT(*) rows_n, SUM(LENGTH(ST_AsText(geom))) full_b
			   FROM osm_lines
			  WHERE feature_type = 'highway' AND subtype IN (${ph})
			    AND MBRIntersects(geom, ST_GeomFromText(?, 4326))`,
			[...WALKABLE, bboxWkt(lat, lon, RADIUS_M, margin)],
		);
		sweep.push({ margin, rows: n(r.rows_n), kib: n(r.full_b) / 1024 });
	}
	const base = sweep[sweep.length - 1].kib;
	for (const { margin, rows, kib } of sweep) {
		console.log(
			`  ${name.padEnd(18)} ${String(margin).padStart(5)}   ` +
			`${String(rows).padStart(5)}   ${kib.toFixed(0).padStart(6)}` +
			`    ${((kib / base) * 100).toFixed(0)}%`,
		);
	}
	console.log("");
}

await conn.end();
