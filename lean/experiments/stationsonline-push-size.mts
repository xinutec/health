/**
 * How big is the INPUT `stationsOnLine` needs, per line?
 *
 * Task #414. The key set is settled: `delegated-lookup-keys.mts` measured 24
 * distinct line names asked across the 33-day corpus and every one of them is
 * reachable from a `linesAtPoint` probe over the day's own track, which the
 * row-set already answers. So a day's candidate lines CAN be enumerated before
 * the pipeline runs. What that leaves open is what the push should carry.
 *
 * Two shapes, and the difference is the wire:
 *
 *   A. Push the RAW INPUTS per day — every railway way whose name matches a
 *      candidate line, plus the station table — and let the kernel compute
 *      `filterStationsByLineProximity` per call. Purest: the 300 m decision
 *      moves into Lean and nothing is a captured answer.
 *   B. Compute the line → stations table OFFLINE with the same kernel, once per
 *      mirror refresh, and have the day push only the rows for its candidate
 *      lines. The decision is still Lean's; only its TIMING moves. This is the
 *      pattern `rail_route_cache` (#363) and `rail_stops_cache` (#364) already
 *      established in this repo.
 *
 * A is only worth its purity if the geometry is small. This measures that,
 * because a London tube line is hundreds of ways of dense track and #405
 * already found that transport, not computation, is what the Lean tenants cost
 * — with the HSMM's 33-40 MiB/day payload open as #411. Adding a second payload
 * of that class to fix a boundary problem would be trading one for one.
 *
 * # What it found (2026-08-02) — A, comfortably
 *
 *     mirror                     1090 distinct railway line names (17.3 KiB),
 *                                1232 named stations
 *     worst single line          0.06 MiB (Northern Line, Bank Branch)
 *     all 24 asked lines         0.56 MiB
 *     worst plausible day        0.51 MiB (the 15 dearest, matching 06-23)
 *
 * So the whole input a day needs — name list, station table, and the way
 * geometry of every line it could ask about — is under 0.6 MiB, roughly 1.5% of
 * the HSMM payload. The premise behind option B was that a tube line's geometry
 * is heavy. It is not: 224 ways of the Northern Line are 60 KiB, because rail
 * track is sparsely-vertexed compared with the road and building layers the
 * row-set already carries at 20-40 MiB per day.
 *
 * B was the option I expected to take, on the reasoning that it matches the
 * `rail_route_cache` / `rail_stops_cache` pattern and keeps the wire small.
 * That reasoning was sound and the number makes it moot — which is the point of
 * measuring the cost of a purity trade before paying for the cheaper one.
 *
 * Read-only. Counts and byte sizes, no writes, no pipeline.
 *
 * Run: scripts/prod-db.sh npx tsx lean/experiments/stationsonline-push-size.mts
 */

import { sql } from "kysely";
import { db, initPool } from "../../src/db/pool.js";
import { lineNamesMatching } from "../../src/geo/line-stations.js";

// `prod-db.sh` exports these; nothing else here needs config, so the pool is
// built straight from the env rather than through a CLI's zod schema.
initPool({
	host: process.env.DB_HOST ?? "health-db",
	port: Number(process.env.DB_PORT ?? 3306),
	user: process.env.DB_USER ?? "",
	password: process.env.DB_PASSWORD ?? "",
	database: process.env.DB_NAME ?? "health",
});

/** The line names the 33-day corpus actually asked `stationsOnLine` for,
 *  from `delegated-lookup-keys.mts`. Frozen here rather than re-derived so this
 *  script needs no fixtures — it is measuring the MIRROR, not a day. */
const ASKED_LINES = [
	"514a",
	"560",
	"Belsize Fast Tunnel",
	"Belsize Slow Tunnel",
	"Brighton Main Line",
	"Chatham Main Line",
	"Chiltern Main Line",
	"Circle Line",
	"Circle and District Lines",
	"Circle, Hammersmith & City and Metropolitan Lines",
	"Dudding Hill Line",
	"Jubilee Line",
	"LEC1",
	"London Euston to Crewe Line",
	"London–Aylesbury Line",
	"Metropolitan Line",
	"Midland Main Line",
	"North London line",
	"Northern Line (Bank Branch)",
	"Northern Line (Charing Cross Branch)",
	"Northern Line (Charing Cross Branch) Southbound",
	"SPC1",
	"Victoria Line",
	"Victoria Line Northbound",
];

const allNames = (
	(await db()
		.selectFrom("osm_lines")
		.where("feature_type", "=", "railway")
		.where("name", "is not", null)
		.select("name")
		.distinct()
		.execute()) as Array<{ name: string | null }>
)
	.map((r) => r.name)
	.filter((n): n is string => n !== null);

const stationCount = Number(
	(
		await sql<{ n: bigint }>`
			SELECT COUNT(*) AS n FROM osm_points
			WHERE feature_type = 'railway' AND subtype = 'station' AND name IS NOT NULL
		`.execute(db())
	).rows[0].n,
);

console.log(`mirror: ${allNames.length} distinct railway line name(s), ${stationCount} named station(s)`);
console.log(`        name list ≈ ${(allNames.join("").length / 1024).toFixed(1)} KiB of strings\n`);

let worstBytes = 0;
let worstLine = "";
const perLine: Array<{ line: string; ways: number; bytes: number; matched: number }> = [];

for (const line of ASKED_LINES) {
	const matchNames = lineNamesMatching(line, allNames);
	if (matchNames.length === 0) {
		perLine.push({ line, ways: 0, bytes: 0, matched: 0 });
		continue;
	}
	// `LENGTH(ST_AsText(geom))` is the WKT byte count — the honest proxy for
	// what a push would carry, since that is the form the row-set already
	// ships geometry in.
	const row = (
		await sql<{ n: bigint; bytes: bigint | null }>`
			SELECT COUNT(*) AS n, SUM(LENGTH(ST_AsText(geom))) AS bytes
			FROM osm_lines
			WHERE feature_type = 'railway' AND name IN (${sql.join(matchNames)})
		`.execute(db())
	).rows[0];
	const ways = Number(row.n);
	const bytes = Number(row.bytes ?? 0);
	perLine.push({ line, ways, bytes, matched: matchNames.length });
	if (bytes > worstBytes) {
		worstBytes = bytes;
		worstLine = line;
	}
}

for (const p of perLine.sort((a, b) => b.bytes - a.bytes)) {
	console.log(
		`${p.line.padEnd(50)} ${String(p.matched).padStart(3)} name(s) ` +
			`${String(p.ways).padStart(5)} way(s) ${(p.bytes / 1024 / 1024).toFixed(2).padStart(7)} MiB`,
	);
}

// The corpus-wide worst DAY is what a per-day push has to absorb, so report the
// busiest day's line count against the per-line cost rather than the sum over
// all 24 — no day asks for all of them. 06-23 asked 15, the corpus maximum.
const sorted = perLine.map((p) => p.bytes).sort((a, b) => b - a);
const worstDay = sorted.slice(0, 15).reduce((n, b) => n + b, 0);

console.log(`\nworst single line: ${worstLine} at ${(worstBytes / 1024 / 1024).toFixed(2)} MiB`);
console.log(`all 24 asked lines: ${(sorted.reduce((n, b) => n + b, 0) / 1024 / 1024).toFixed(2)} MiB`);
console.log(`worst plausible day (the 15 dearest, matching 06-23's count): ${(worstDay / 1024 / 1024).toFixed(2)} MiB`);
console.log(`\nfor comparison, the HSMM tenant's payload (#411) is 33-40 MiB per day.`);

await db().destroy();
