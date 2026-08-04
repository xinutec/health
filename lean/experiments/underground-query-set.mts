/**
 * WHICH coordinates does the TS `undergroundRail` pass ask `linesAtPoint` about?
 *
 * Task #425. The Lean fold aborts on 2026-04-29 asking about a coordinate the TS
 * cascade never probed, and the Lean backtrace puts the call in
 * `reconstructUndergroundRun`'s FIRST (single-line) arm — so the disagreement is
 * about the bracketing good fixes or the coarse run itself, not about a cluster
 * centroid.
 *
 * This prints the TS arm's query set at `UNDERGROUND_LINES_RADIUS_M`, which is
 * the pass's own radius and nothing else's. Run it against the pass as written,
 * then again with `growThroughDarkness` / `trimBlipTail` ablated at
 * `underground-rail.ts:585` — if the ablated set contains the key Lean asks for,
 * the mechanism is the run-growth the Lean port predates, measured rather than
 * argued.
 *
 * Run: TMPDIR=/tmp npx tsx lean/experiments/underground-query-set.mts [date]
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { inputsFromFixture, parseCapturedDay } from "../../src/cli/fixture-day.js";
import { UNDERGROUND_LINES_RADIUS_M } from "../../src/geo/underground-rail.js";
import { computeVelocityFromInputs } from "../../src/geo/velocity.js";

const date = process.argv[2] ?? "2026-04-29";
const DAYS_DIR = path.join(import.meta.dirname, "../../tests/golden/days");
// The fixture is `<date>-<user>.json`; the user is not the caller's business.
const file = readdirSync(DAYS_DIR).find((f) => f.startsWith(date));
if (file === undefined) throw new Error(`no fixture for ${date} in ${DAYS_DIR}`);
const captured = parseCapturedDay(readFileSync(path.join(DAYS_DIR, file), "utf8"));
const inputs = inputsFromFixture(captured, "rows");

/** Both lookups the pass makes, in call order, tagged by which one.
 *
 *  `nearbyWays` needs no radius filter: `sideWayName` is the only caller inside
 *  the 38-pass cascade, so every two-argument call here is the pass's. That is
 *  the same fact `passfold-parity.mts` relies on to attribute a miss. */
const asked: { what: string; key: string }[] = [];
const lines = inputs.osm.linesAtPoint.bind(inputs.osm);
inputs.osm.linesAtPoint = async (lat: number, lon: number, radiusM?: number) => {
	if (radiusM === UNDERGROUND_LINES_RADIUS_M) asked.push({ what: "linesAtPoint", key: `${lat}, ${lon}` });
	return await lines(lat, lon, radiusM);
};
const ways = inputs.osm.nearbyWays.bind(inputs.osm);
inputs.osm.nearbyWays = async (lat: number, lon: number, radiusM?: number) => {
	if (radiusM === undefined) asked.push({ what: "nearbyWays", key: `${lat}, ${lon}` });
	return await ways(lat, lon, radiusM);
};

// The day's raw fixes, to say of each query whether it is one of them rather
// than a derived point (a cluster centroid, or a smoothed track point).
const raw = new Set(captured.inputs.phonetrack.today.map((p) => `${p.lat}, ${p.lon}`));

try {
	await computeVelocityFromInputs(inputs);
} catch (e) {
	console.log(`(threw: ${(e as Error).message})`);
}

// `only` narrows to one lookup when a miss has already named it.
const only = process.argv[3];
const shown = only ? asked.filter((a) => a.what === only) : asked;
console.log(`${date}: ${shown.length} ${only ?? "underground"} queries`);
for (const [i, q] of shown.entries())
	console.log(`  ${i + 1}. ${q.what.padEnd(13)} ${q.key}${raw.has(q.key) ? "  [raw fix]" : ""}`);
