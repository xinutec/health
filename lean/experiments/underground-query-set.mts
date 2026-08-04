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

const asked: string[] = [];
const inner = inputs.osm.linesAtPoint.bind(inputs.osm);
inputs.osm.linesAtPoint = async (lat: number, lon: number, radiusM?: number) => {
	if (radiusM === UNDERGROUND_LINES_RADIUS_M) asked.push(`${lat}, ${lon}`);
	return await inner(lat, lon, radiusM);
};

// The day's raw fixes, to say of each query whether it is one of them rather
// than a derived point (a cluster centroid).
const raw = new Set(captured.inputs.phonetrack.today.map((p) => `${p.lat}, ${p.lon}`));

try {
	await computeVelocityFromInputs(inputs);
} catch (e) {
	console.log(`(threw: ${(e as Error).message})`);
}

console.log(`${date}: ${asked.length} linesAtPoint(…, r=${UNDERGROUND_LINES_RADIUS_M}) queries`);
for (const [i, q] of asked.entries()) console.log(`  ${i + 1}. ${q}${raw.has(q) ? "  [raw fix]" : ""}`);
