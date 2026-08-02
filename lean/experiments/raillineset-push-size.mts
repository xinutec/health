/**
 * How big is the rail-line set a REAL day would push?
 *
 * Task #414, and a correction to `stationsonline-push-size.mts`. That script
 * sized the 24 line names the corpus was observed to ASK about. The push is not
 * keyed on those: `loadRailLineSet` cannot know what a day will ask, so it
 * fetches for every CANDIDATE — every railway name on a row already inside the
 * day's coverage boxes — and each candidate expands through `lineNamesMatching`
 * to every mirror name sharing its base token. On a London day that is tens of
 * candidates, not the one or two the day goes on to ask about.
 *
 * Sizing the asked set and calling it the push size is the same error shape as
 * grading a cache by its hits. This measures the set that is actually fetched.
 *
 * Candidates come from each fixture's own stored row-set, so the derivation is
 * the real one rather than a re-approximation; only the geometry size needs the
 * mirror.
 *
 * # What it found (2026-08-02, 33 fixtures)
 *
 *     mean       1.14 MiB/day
 *     worst      5.19 MiB — 2026-05-11, 371 candidates → 1082 names
 *     typical    ~145 candidates → ~185 names → ~1.0 MiB
 *
 * About 2x the asked-set estimate, and the design decision is unchanged: still
 * an order of magnitude under the 20-40 MiB of bbox rows the same fixtures
 * already carry, so the raw inputs go over and the 300 m decision stays a
 * computation rather than a stored answer.
 *
 * 05-11 is the interesting row. 371 candidates expand to 1082 of the mirror's
 * 1090 distinct railway names — base-token expansion nearly saturating, because
 * a day touching that much distinct track produces base tokens general enough to
 * match almost everything. It is a ceiling worth knowing: a day cannot cost more
 * than the whole railway layer, which is ~5 MiB, so this section has a hard
 * bound and does not need a cap.
 *
 * Run: scripts/prod-db.sh npx tsx lean/experiments/raillineset-push-size.mts
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { sql } from "kysely";
import { parseCapturedDay } from "../../src/cli/fixture-day.js";
import { db, initPool } from "../../src/db/pool.js";
import { lineNamesMatching } from "../../src/geo/line-stations.js";

initPool({
	host: process.env.DB_HOST ?? "health-db",
	port: Number(process.env.DB_PORT ?? 3306),
	user: process.env.DB_USER ?? "",
	password: process.env.DB_PASSWORD ?? "",
	database: process.env.DB_NAME ?? "health",
});

const DAYS_DIR = path.join(process.cwd(), "tests", "golden", "days");

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

/** Bytes of WKT per railway line name, fetched once and reused across days —
 *  the same name recurs on nearly every London day. */
const bytesByName = new Map<string, number>();
async function sizeOf(names: readonly string[]): Promise<number> {
	const missing = names.filter((n) => !bytesByName.has(n));
	if (missing.length > 0) {
		const rows = (
			await sql<{ name: string; bytes: bigint | null }>`
				SELECT name, SUM(LENGTH(ST_AsText(geom))) AS bytes
				FROM osm_lines
				WHERE feature_type = 'railway' AND name IN (${sql.join(missing)})
				GROUP BY name
			`.execute(db())
		).rows;
		for (const n of missing) bytesByName.set(n, 0);
		for (const r of rows) bytesByName.set(r.name, Number(r.bytes ?? 0));
	}
	return names.reduce((n, name) => n + (bytesByName.get(name) ?? 0), 0);
}

const stationCount = Number(
	(
		await sql<{ n: bigint }>`
			SELECT COUNT(*) AS n FROM osm_points
			WHERE feature_type = 'railway' AND subtype = 'station' AND name IS NOT NULL
		`.execute(db())
	).rows[0].n,
);
// A pushed station is `{name, lat, lon}` — the JSON is what travels, so measure
// that rather than a notional row width.
const stationBytes = stationCount * JSON.stringify({ name: "Kings Cross St Pancras", lat: 51.5308, lon: -0.1238 }).length;
const nameListBytes = JSON.stringify(allNames).length;

console.log(`fixed cost per day: name list ${(nameListBytes / 1024).toFixed(1)} KiB + stations ${(stationBytes / 1024).toFixed(1)} KiB\n`);

let worst = { date: "", bytes: 0, candidates: 0, fetched: 0 };
let total = 0;
let days = 0;

for (const file of readdirSync(DAYS_DIR).filter((f) => f.endsWith(".json")).sort()) {
	const captured = parseCapturedDay(readFileSync(path.join(DAYS_DIR, file), "utf8"));
	const rowSet = captured.inputs.osmRowSet;
	if (!rowSet) continue;

	const candidates = new Set<string>();
	for (const l of rowSet.lines) {
		if (l.featureType === "railway" && l.name !== null) candidates.add(l.name);
	}
	const fetched = new Set<string>();
	for (const c of candidates) for (const n of lineNamesMatching(c, allNames)) fetched.add(n);

	const bytes = (await sizeOf([...fetched])) + stationBytes + nameListBytes;
	days++;
	total += bytes;
	if (bytes > worst.bytes) {
		worst = { date: file.slice(0, 10), bytes, candidates: candidates.size, fetched: fetched.size };
	}
	console.log(
		`${file.slice(0, 10)}  ${String(candidates.size).padStart(3)} candidate(s) → ` +
			`${String(fetched.size).padStart(4)} fetched name(s)  ${(bytes / 1024 / 1024).toFixed(2).padStart(6)} MiB`,
	);
}

console.log(`\n=== ${days} day(s) ===`);
console.log(`mean ${(total / days / 1024 / 1024).toFixed(2)} MiB/day`);
console.log(`worst ${worst.date}: ${(worst.bytes / 1024 / 1024).toFixed(2)} MiB (${worst.candidates} candidates → ${worst.fetched} names)`);
console.log(`\nfor comparison: the bbox rows already cost 20-40 MiB/day, the HSMM payload 33-40 MiB (#411).`);

await db().destroy();
