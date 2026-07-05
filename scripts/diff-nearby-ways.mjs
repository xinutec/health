// Minimal repro for the Mac-vs-pod divergence. Calls nearbyWays at a
// specific lat/lon (one of the 13:16-13:26 segment fixes from 2026-05-22),
// then dumps the deduplicated result + the raw per-type queries in
// order. Run on Mac via prod-db.sh + inside the pod, diff the output.
//
// If outputs differ → OSM query path is non-deterministic between hosts.
// If outputs match → the divergence is downstream (candidate generator,
// factor scorer, or refineMode logic).
import { initPool, withConnection } from "../dist/db/pool.js";
import { migrate } from "../dist/db/schema.js";
import { nearbyWays } from "../dist/geo/osm.js";
import { queryLines, queryPoints } from "../dist/geo/osm-local.js";

initPool({
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: process.env.DB_NAME,
});
await withConnection(migrate);

// Mid-segment fix from the 13:16-13:26 window on 2026-05-22.
const lat = 51.55276;
const lon = -0.24394;
const radiusM = 50;

console.log(`# nearbyWays(${lat}, ${lon}, ${radiusM})`);
const ways = await nearbyWays(lat, lon, radiusM);
console.log(`count=${ways.length}`);
for (const w of ways) {
	console.log(`  ${w.type}/${w.subtype} d=${w.distanceM?.toFixed(1) ?? "?"} name=${w.name ?? "-"}`);
}

console.log(`\n# raw per-type queries`);
for (const ft of ["highway", "railway", "waterway", "aeroway"]) {
	const rows = await queryLines(lat, lon, radiusM, ft);
	console.log(`  ${ft}: ${rows.length} rows`);
	for (const r of rows) {
		console.log(`    ${ft}/${r.subtype} d=${r.distance_m.toFixed(1)} name=${r.name ?? "-"} osm_id=${r.osm_id}`);
	}
}

process.exit(0);
