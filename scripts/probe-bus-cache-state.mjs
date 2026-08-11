// Read-only: what does the bus route mirror actually hold, and how big a
// bbox would a refresh tile? Answers #255's two open questions without
// touching Overpass or writing anything.
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

const [{ n }] = await conn.query("SELECT COUNT(*) AS n FROM bus_route_cache");
console.log(`bus_route_cache rows: ${n}`);

const RECENT_DAYS = 120;
const cutoff = Math.floor(Date.now() / 1000) - RECENT_DAYS * 86400;
const places = await conn.query(
	"SELECT centroid_lat, centroid_lon FROM focus_places WHERE last_seen_ts >= ?",
	[cutoff],
);
console.log(`focus places in the last ${RECENT_DAYS} days: ${places.length}`);
if (places.length > 0) {
	const lat = places.map((p) => Number(p.centroid_lat));
	const lon = places.map((p) => Number(p.centroid_lon));
	// Not the clustered home region the job uses — a crude whole-set bbox, which
	// OVERSTATES the tiling if the set spans regions. Enough to size the load.
	const pad = 1500 / 111_320;
	const box = {
		minLat: Math.min(...lat) - pad,
		maxLat: Math.max(...lat) + pad,
		minLon: Math.min(...lon) - pad,
		maxLon: Math.max(...lon) + pad,
	};
	const tiles =
		Math.ceil((box.maxLat - box.minLat) / 0.05) * Math.ceil((box.maxLon - box.minLon) / 0.05);
	console.log(
		`whole-set bbox ${box.minLat.toFixed(3)},${box.minLon.toFixed(3)}→${box.maxLat.toFixed(3)},${box.maxLon.toFixed(3)}` +
			`  =>  <= ${tiles} tiles at 0.05deg (upper bound: the job clusters to the home region first)`,
	);
}

await conn.release();
await pool.end();
