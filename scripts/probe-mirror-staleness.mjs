// Why are the oldest mirror rows still there — no tile deleted them, or no tile
// COULD? (#1153)
//
// Usage (from the health repo root):
//   scripts/prod-db.sh node scripts/probe-mirror-staleness.mjs
//
// The merge scopes its DELETE to the tiles that answered (`tile_key = ?`), and
// only a full-coverage run clears the table outright. That leaves two entirely
// different reasons a row can be months old, and the fix differs for each:
//
//  1. ⚠ `tile_key IS NULL` — written BEFORE the column existed. A per-tile
//     delete cannot name it, so no amount of nightly coverage retires it. Only
//     a `full_rebuild` can, which needs every tile to answer.
//  2. `tile_key` set, tile has answered since — then the route really is gone
//     from OSM and something is re-inserting it, which would be a live bug.
//
// The ticket assumed (2) from an independence argument over 84 nights. This
// asks the column instead.
import { createConnection } from "mariadb";

const c = await createConnection({
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: "health",
});

for (const t of ["bus_route_cache", "rail_stops_cache"]) {
	console.log(`\n== ${t}`);
	const rows = await c.query(
		`SELECT tile_key IS NULL AS legacy, DATE(computed_at) AS day, COUNT(*) AS n
		 FROM ${t} GROUP BY legacy, day ORDER BY day`,
	);
	let legacy = 0, keyed = 0;
	for (const r of rows) {
		const n = Number(r.n);
		if (Number(r.legacy)) legacy += n; else keyed += n;
	}
	console.log(`   ${keyed} row(s) carry a tile_key, ${legacy} predate the column`);
	console.log("   computed_at        keyed   legacy");
	const byDay = new Map();
	for (const r of rows) {
		const d = String(r.day);
		const e = byDay.get(d) ?? { keyed: 0, legacy: 0 };
		if (Number(r.legacy)) e.legacy += Number(r.n); else e.keyed += Number(r.n);
		byDay.set(d, e);
	}
	for (const [d, e] of [...byDay].sort()) {
		console.log(`   ${d}   ${String(e.keyed).padStart(6)}  ${String(e.legacy).padStart(6)}`);
	}
	// Of the KEYED stale rows, how many sit under a tile that has answered
	// recently? A route under a tile that refreshed yesterday and is still old is
	// the live bug; one under a tile nothing has touched is just uncovered.
	const perTile = await c.query(
		`SELECT tile_key, COUNT(*) AS n, MAX(computed_at) AS newest, MIN(computed_at) AS oldest
		 FROM ${t} WHERE tile_key IS NOT NULL GROUP BY tile_key ORDER BY newest`,
	);
	console.log(`   ${perTile.length} tile(s) present; per-tile freshness spread:`);
	for (const r of perTile) {
		const span = Math.round((new Date(r.newest) - new Date(r.oldest)) / 86400000);
		console.log(`     ${r.tile_key.padEnd(18)} ${String(r.n).padStart(5)} rows  newest ${String(r.newest).slice(0, 10)}  spans ${span}d`);
	}
}

await c.end();
