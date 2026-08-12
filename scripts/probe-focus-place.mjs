// Read-only: what does prod hold for one focus place, and what is at it?
//
// Written for #789, where place 6280 GAINED a visit-day and LOST its mined
// `amenity_label` between two captures — more evidence making the label worse.
// The suspicion this probe exists to test is `pickWinningAmenity`'s majority
// rule (`minFraction: 0.5`, dwell-weighted): with two visits agreeing, a venue
// holds 100% of the vote; a third visit that ranks a DIFFERENT venue and
// carries half the cluster's dwell drops the incumbent under the floor and the
// label becomes NULL. A third visit that casts no vote at all cannot do this —
// `refresh-focus-places` skips those before they reach the tally — so the
// prediction is specific: there is a dissenting third stay, not merely a third.
//
// Usage:  scripts/prod-db.sh node scripts/probe-focus-place.mjs <id> [<id>...]
//         scripts/prod-db.sh node scripts/probe-focus-place.mjs --near <lat> <lon> [radiusM]
//
// Writes nothing. Prints the row, its neighbours within the search radius, and
// the decoded-day usage that would carry a label into the timeline.
import * as mariadb from "mariadb";

const pool = mariadb.createPool({
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: process.env.DB_NAME,
	connectionLimit: 1,
});
const conn = await pool.getConnection();

const COLS =
	"id, user_id, centroid_lat, centroid_lon, radius_m, total_dwell_sec, visit_count, unique_days, " +
	"first_seen_ts, last_seen_ts, detected_label, display_name, sleep_hours, amenity_label, amenity_kind, refreshed_at";

const iso = (t) => (t === null || t === undefined ? "—" : new Date(Number(t) * 1000).toISOString());

function show(p) {
	console.log(`\n=== focus_place ${p.id} (${p.user_id}) ===`);
	console.log(`  centroid   ${Number(p.centroid_lat).toFixed(6)}, ${Number(p.centroid_lon).toFixed(6)}  r=${p.radius_m} m`);
	console.log(`  visits     ${p.visit_count} across ${p.unique_days} unique day(s)`);
	console.log(`  dwell      ${(Number(p.total_dwell_sec) / 3600).toFixed(2)} h`);
	console.log(`  seen       ${iso(p.first_seen_ts)} … ${iso(p.last_seen_ts)}`);
	console.log(`  labels     detected=${p.detected_label ?? "—"}  display=${p.display_name ?? "—"}`);
	console.log(`  AMENITY    label=${p.amenity_label ?? "NULL"}  kind=${p.amenity_kind ?? "NULL"}`);
	console.log(`  sleep_h    ${p.sleep_hours ?? "—"}`);
	console.log(`  refreshed  ${p.refreshed_at ?? "—"}`);
}

const argv = process.argv.slice(2);
let rows = [];

if (argv[0] === "--near") {
	const lat = Number(argv[1]);
	const lon = Number(argv[2]);
	const radiusM = argv[3] === undefined ? 300 : Number(argv[3]);
	// Crude degree box — this is a diagnostic, not the matcher. 1e-5° ≈ 1.11 m
	// of latitude; longitude is scaled by cos(lat) so the box is square in metres.
	const dLat = radiusM / 111_195;
	const dLon = radiusM / (111_195 * Math.cos((lat * Math.PI) / 180));
	rows = await conn.query(
		`SELECT ${COLS} FROM focus_places
       WHERE centroid_lat BETWEEN ? AND ? AND centroid_lon BETWEEN ? AND ?
       ORDER BY total_dwell_sec DESC`,
		[lat - dLat, lat + dLat, lon - dLon, lon + dLon],
	);
	console.log(`# ${rows.length} focus place(s) within ~${radiusM} m of ${lat}, ${lon}`);
} else {
	const ids = argv.map(Number).filter((n) => Number.isFinite(n));
	if (ids.length === 0) {
		console.error("usage: probe-focus-place.mjs <id>... | --near <lat> <lon> [radiusM]");
		process.exit(2);
	}
	rows = await conn.query(`SELECT ${COLS} FROM focus_places WHERE id IN (?)`, [ids]);
}

for (const p of rows) show(p);

// How many focus places carry a mined label at all — the base rate the #789
// disappearance should be read against. A column that is mostly NULL says the
// vote rarely clears its floor, which is a different story from one label
// vanishing.
const [{ total, labelled }] = await conn.query(
	"SELECT COUNT(*) AS total, SUM(amenity_label IS NOT NULL) AS labelled FROM focus_places",
);
console.log(`\n# corpus-wide: ${labelled} of ${total} focus places carry an amenity_label`);

await conn.end();
await pool.end();
