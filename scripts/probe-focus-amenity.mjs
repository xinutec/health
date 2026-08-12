// Read-only: WHY does a focus place carry the amenity_label it carries?
//
// Written for #789, where a focus place gained a third visit-day and LOST its
// mined amenity label, so a confirmed evening stay fell through to the venue
// scorer and came back named for a different, larger nearby feature.
//
// (Deliberately unnamed here: this repo is public, and a venue plus a date is
// exactly the pair that must not be committed. The task carries the specifics.)
//
// `refresh-focus-places` nulls a label at THREE independent gates, and the task
// only listed the first. This probe reports all three for one place, so the
// next step is chosen from evidence rather than from the most plausible story:
//
//   1. VOTE       `pickWinningAmenity` is dwell-weighted and needs a MAJORITY
//                 (minFraction 0.5) over at least 30 min of voting dwell. With
//                 two visits agreeing a venue holds 100%; one dissenting third
//                 visit carrying half the dwell drops it under the floor. A
//                 third visit that casts NO vote cannot do this — those are
//                 skipped before the tally.
//   2. FLOOR      a stay only votes if its best candidate is a real venue type
//                 (`isLabelWorthyVenue`) AND clears VENUE_RANK_FLOOR_NATS.
//   3. CENTROID   the winner must ALSO be within 100 m of the cluster centroid
//                 and label-worthy there. The centroid is dwell-weighted, so a
//                 third visit MOVES it — and can move the winner out of range
//                 while the vote itself is untouched. This is the gate #789 did
//                 not consider.
//
// This probe answers 3 without a Nextcloud fetch: it asks the prod OSM mirror
// what is label-worthy at the stored centroid. If the expected venue is absent
// there, gate 3 is the cause and no vote replay is needed. If it is present,
// gate 3 is exonerated and the cause is 1 or 2, which does need the replay.
//
// Usage:  scripts/prod-db.sh node scripts/probe-focus-amenity.mjs <id> [<id>...]
//         scripts/prod-db.sh node scripts/probe-focus-amenity.mjs --at <lat> <lon>
//
// `--at` takes a bare coordinate, which is how a HISTORICAL centroid gets
// tested: old rows survive in the golden fixtures' `inputs.knownPlaces`, so
// `git show <rev>:days/<day>.json` yields the centroid a label was mined at and
// this reports whether the venue cleared the gate there.
//
// Writes nothing.
import * as mariadb from "mariadb";
import { initPool, destroyPool } from "../dist/db/pool.js";
import { isLabelWorthyVenue, nearbyLandmarks } from "../dist/geo/osm.js";

const dbCfg = {
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: process.env.DB_NAME,
};
initPool(dbCfg);

const pool = mariadb.createPool({ ...dbCfg, connectionLimit: 1 });
const conn = await pool.getConnection();

const argv = process.argv.slice(2);
let rows;
if (argv[0] === "--at") {
	const lat = Number(argv[1]);
	const lon = Number(argv[2]);
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
		console.error("usage: probe-focus-amenity.mjs --at <lat> <lon>");
		process.exit(2);
	}
	rows = [
		{
			id: "(bare coordinate)",
			centroid_lat: lat,
			centroid_lon: lon,
			visit_count: "—",
			unique_days: "—",
			total_dwell_sec: 0,
			amenity_label: null,
			amenity_kind: null,
		},
	];
} else {
	const ids = argv.map(Number).filter(Number.isFinite);
	if (ids.length === 0) {
		console.error("usage: probe-focus-amenity.mjs <focus_place id>... | --at <lat> <lon>");
		process.exit(2);
	}
	rows = await conn.query(
		"SELECT id, centroid_lat, centroid_lon, radius_m, visit_count, unique_days, total_dwell_sec, amenity_label, amenity_kind " +
			"FROM focus_places WHERE id IN (?)",
		[ids],
	);
}

// The gate's own radius. `nearbyLandmarks` defaults to 100 m and the centroid
// gate passes 100 explicitly; both are spelled here so a change to the default
// cannot silently widen what this probe reports.
const CENTROID_GATE_M = 100;

for (const p of rows) {
	const lat = Number(p.centroid_lat);
	const lon = Number(p.centroid_lon);
	console.log(`\n=== focus_place ${p.id} ===`);
	console.log(`  centroid ${lat.toFixed(6)}, ${lon.toFixed(6)}   visits=${p.visit_count} days=${p.unique_days}`);
	console.log(`  dwell    ${(Number(p.total_dwell_sec) / 60).toFixed(1)} min   (vote needs >= 30 min of VOTING dwell)`);
	console.log(`  stored   amenity_label=${p.amenity_label ?? "NULL"}  kind=${p.amenity_kind ?? "NULL"}`);

	const landmarks = await nearbyLandmarks(lat, lon, CENTROID_GATE_M);
	console.log(`\n  --- gate 3: what is within ${CENTROID_GATE_M} m of the CENTROID (${landmarks.length} landmark(s)) ---`);
	if (landmarks.length === 0) {
		console.log("  (none — any vote winner would be nulled by the centroid gate)");
	}
	const sorted = [...landmarks].sort((a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity));
	for (const l of sorted) {
		const worthy = isLabelWorthyVenue(l);
		const d = l.distanceM === null || l.distanceM === undefined ? "—" : `${l.distanceM.toFixed(0)} m`;
		console.log(
			`  ${worthy ? "PASS" : "reject"}  ${d.padStart(6)}  ${l.subtype ?? "?"}  ${l.name ?? "(unnamed)"}`,
		);
	}
	const worthyHere = sorted.filter(isLabelWorthyVenue);
	console.log(
		`\n  => ${worthyHere.length} label-worthy candidate(s) survive the centroid gate: ` +
			(worthyHere.length === 0 ? "NONE — gate 3 nulls any winner" : worthyHere.map((l) => l.name).join(", ")),
	);
}

await conn.end();
await pool.end();
await destroyPool();
