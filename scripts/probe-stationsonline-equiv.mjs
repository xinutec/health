// Verify the new indexed path selects the SAME railway names as the old
// leading-wildcard `LIKE '%base%'` query (the only place collation could
// make them diverge), and measure the speedup. If the name sets match,
// the `name IN (...)` way fetch is identical to the old `LIKE` way fetch,
// so classification output is unchanged. Run via prod-db.sh.
import { db, initPool } from "../dist/db/pool.js";
import { lineNamesMatching, stationsOnLine } from "../dist/geo/line-stations.js";

initPool({
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: "health",
});

const now = () => Number(process.hrtime.bigint() / 1_000_000n);

const LINES = [
	"Victoria Line",
	"Chatham Main Line",
	"Brighton Main Line",
	"Circle and District Lines",
	"Jubilee Line",
	"Metropolitan Line",
	"London–Aylesbury Line",
];

const allNames = (
	await db().selectFrom("osm_lines").where("feature_type", "=", "railway").where("name", "is not", null).select("name").distinct().execute()
).map((r) => r.name);
console.log(`distinct railway names: ${allNames.length}`);

let mismatches = 0;
for (const line of LINES) {
	const base = line.replace(/\s+lines?\b.*$/i, "").trim();
	// OLD: what `name LIKE '%base%'` matches, as a distinct name set.
	const oldNames = new Set(
		(
			await db()
				.selectFrom("osm_lines")
				.where("feature_type", "=", "railway")
				.where("name", "like", `%${base}%`)
				.select("name")
				.distinct()
				.execute()
		).map((r) => r.name),
	);
	// NEW: what lineNamesMatching picks from the cached name list.
	const newNames = new Set(lineNamesMatching(line, allNames));
	const same = oldNames.size === newNames.size && [...oldNames].every((n) => newNames.has(n));
	if (!same) {
		mismatches++;
		console.log(`  DIFF ${line}: old=${[...oldNames]} new=${[...newNames]}`);
	} else {
		console.log(`  OK   ${line}: ${oldNames.size} names`);
	}
}
console.log(mismatches === 0 ? "\nEQUIVALENCE: PASS (identical name sets)" : `\nEQUIVALENCE: FAIL (${mismatches} differ)`);

const t = now();
const lists = await Promise.all(LINES.map((l) => stationsOnLine(l)));
console.log(`\nnew fan-out (7 lines, concurrent, incl. one-time name load): ${now() - t}ms`);
const t2 = now();
await Promise.all(LINES.map((l) => stationsOnLine(l)));
console.log(`new fan-out (warm cache): ${now() - t2}ms`);
console.log(`station counts: ${lists.map((s) => s.length).join(", ")}`);
process.exit(0);
