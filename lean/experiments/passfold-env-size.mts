/**
 * What does `PassFold.Env` cost on the wire?
 *
 * Task #424, step 2, and it runs BEFORE any parity measurement on purpose.
 * #405 measured four of five Lean tenants spending their time on bridge
 * crossing rather than arithmetic, and #411 is the HSMM tenant shipping 33-40
 * MiB to decode 1440 minutes. Measuring the fold's parity before its payload
 * would measure the same thing again.
 *
 * # The question the sizes decide
 *
 * `Env` has three kinds of field, and only two of them cross:
 *
 *   - OBSERVATIONS and DAY TABLES — the raw fixes, steps, HR, sleep, and the
 *     five cached row-sets. Data. They cross.
 *   - LOOKUPS — `nearbyStations`, `linesAtPoint`, `nearbyWays`,
 *     `transitStops`, `stationsOnLine`, `bestPlace`, and (added after this was
 *     first measured) `reverseGeocode`. Functions, so they cross as ANSWER
 *     TABLES: the fixture's `osmTrace` is already keyed
 *     `${lat}|${lon}|${radius}`, which is exactly the shape a pushed table
 *     needs, and `FixtureOsmAdapter` already hard-errors on an uncaptured key
 *     instead of returning short results. No new capture, no new oracle.
 *   - SHELL CALLBACKS — `roadEnv` and `walkEnv`. Kept as callbacks in the `Env`,
 *     so the road and walk GEOMETRY never crosses at all. That is the design
 *     claim this script exists to price: `drivableRoads`, `walkableRoads` and
 *     `buildingsNear` are sized separately, as the saving.
 *
 * `reenrich` was in the third group and has moved to the second. It looked like a
 * shell because the TS function behind it is `async` — but what is async about it
 * is two OSM reads, and everything between them is arithmetic. Ported as
 * `Verified.Geo.Enrich`, it costs one more answer table (`reverseGeocode`) and no
 * geometry. A callback is not a shell just because it is a callback; it is a
 * shell when what it does cannot be said in Lean.
 *
 * The alternative to answer tables is pushing raw rows and computing the
 * lookups in Lean, which `Verified.Geo.OsmSpatial` can already do. That is the
 * better architecture — a spatial predicate stated as a definition rather than
 * replayed as an oracle — and it is what #412 built the row-set for. It is
 * priced here too, as `osmRowSet`, because if it is affordable the answer-table
 * step can be skipped entirely.
 *
 * # Method
 *
 * Fixture-local, no DB, for the reason `osm-oracle-parity.mts` gives: the trace
 * and the row-set were captured in one run, so they are contemporaneous by
 * construction.
 *
 * Trace sections are an UPPER bound on what the fold asks for. A section holds
 * every call the whole day made, including the ones segmentation and enrichment
 * made before the cascade started; the fold's 38 passes ask for a subset. The
 * bound is the honest number to design against, and narrowing it needs the
 * cascade instrumented, which is a later step if these numbers make it matter.
 *
 * Bytes are `JSON.stringify().length` — the bridge crosses UTF-8 JSON on a
 * pipe, so this is the transferred size, not an in-memory footprint.
 *
 * # What it found (2026-08-04, 33 fixtures)
 *
 *     answer tables      2.21 MiB/day
 *     raw rows          15.72 MiB/day
 *     kept shell-side    4.31 MiB/day   the callback design's saving
 *     steady-state       0.35 MiB/day   answer tables, content-addressed
 *
 * Three things decide the format, and only the first was expected.
 *
 * ANSWER TABLES COST ALMOST NOTHING. All six lookups together are 0.154
 * MiB/day — 7% of the payload. The "replay an oracle or compute from rows"
 * question, which #412 settled on correctness grounds, turns out not to be a
 * cost question at all in this direction: computing them in Lean means pushing
 * the row-set, and that is 13.7 MiB/day, 89x what the answers cost. The
 * row-set stays the golden replay's oracle for the reason #412 gives; the
 * serve path takes the answers.
 *
 * THE PAYLOAD IS MOSTLY NOT DAY DATA. `busRouteCache` is 1.448 MiB — 65% of
 * everything that crosses — and it is BYTE-IDENTICAL on all 33 days, because
 * it is the mirror's bus layer, not an observation. `railStopsCache`,
 * `railRouteCache` and `knownPlaces` take 4, 5 and 2 distinct values. Sizing
 * the payload per day and calling that the wire cost would have been the same
 * error shape `raillineset-push-size.mts` corrected: measuring the wrong set.
 * Content-addressing them — the shell sends a hash, the table crosses only on
 * a miss — leaves 0.35 MiB/day of genuinely per-day data.
 *
 * THE CALLBACKS ARE WORTH MORE THAN THE TABLES. Keeping `roadEnv` / `walkEnv`
 * as callbacks in the `Env` keeps 4.31 MiB/day of road and building geometry
 * shell-side — 12x the entire steady-state payload. Those five walk-solver
 * leaves and one road matcher are the least-ported part of the fold and the
 * most expensive to feed, which is a coincidence worth not spending.
 *
 * So: 0.35 MiB/day against the HSMM tenant's 33-40. The bridge is not the cost
 * here, and the first parity measurement will be of the computation.
 *
 * Run: npx tsx lean/experiments/passfold-env-size.mts
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseCapturedDay } from "../../src/cli/fixture-day.js";

const DAYS_DIR = path.join(import.meta.dirname, "../../tests/golden/days");

const MIB = 1024 * 1024;

/** JSON bytes of a value, 0 for absent. */
function bytes(v: unknown): number {
	if (v === undefined || v === null) return 0;
	return JSON.stringify(v).length;
}

/** The three groups, and what each means for the design. */
type Group = "crosses" | "table" | "callback" | "alt";

interface Section {
	name: string;
	group: Group;
	of: (c: ReturnType<typeof parseCapturedDay>) => unknown;
}

const SECTIONS: Section[] = [
	// Observations + day tables: data, and they cross whatever we decide.
	{ name: "phonetrack", group: "crosses", of: (c) => c.inputs.phonetrack },
	{ name: "steps", group: "crosses", of: (c) => c.inputs.biometrics?.steps },
	{ name: "hr", group: "crosses", of: (c) => c.inputs.biometrics?.hr },
	{ name: "sleep", group: "crosses", of: (c) => c.inputs.biometrics?.sleep },
	{ name: "knownPlaces", group: "crosses", of: (c) => c.inputs.knownPlaces },
	{ name: "hsmmDecode", group: "crosses", of: (c) => c.inputs.hsmmDecode },
	{ name: "railRouteCache", group: "crosses", of: (c) => c.inputs.railRouteCache },
	{ name: "busRouteCache", group: "crosses", of: (c) => c.inputs.busRouteCache },
	{ name: "railStopsCache", group: "crosses", of: (c) => c.inputs.railStopsCache },

	// Lookups, as answer tables keyed the way the trace already keys them.
	{ name: "nearbyStations", group: "table", of: (c) => c.inputs.osmTrace.nearbyStations },
	{ name: "linesAtPoint", group: "table", of: (c) => c.inputs.osmTrace.linesAtPoint },
	{ name: "nearbyWays", group: "table", of: (c) => c.inputs.osmTrace.nearbyWays },
	{ name: "nearbyTransitStops", group: "table", of: (c) => c.inputs.osmTrace.nearbyTransitStops },
	{ name: "stationsOnLine", group: "table", of: (c) => c.inputs.osmTrace.stationsOnLine },
	{ name: "reverseGeocode", group: "table", of: (c) => c.inputs.osmTrace.reverseGeocode },

	// Solver-leaf geometry. Under the callback design this does NOT cross.
	{ name: "drivableRoads", group: "callback", of: (c) => c.inputs.osmTrace.drivableRoads },
	{ name: "walkableRoads", group: "callback", of: (c) => c.inputs.osmTrace.walkableRoads },
	{ name: "buildingsNear", group: "callback", of: (c) => c.inputs.osmTrace.buildingsNear },

	// The alternative: push rows, compute the lookups in Lean.
	{ name: "osmRowSet", group: "alt", of: (c) => c.inputs.osmRowSet },
];

const totals = new Map<string, number>();
const worst = new Map<string, { date: string; b: number }>();
/** Distinct VALUES a section takes across the corpus. A section with one
 *  distinct value is not day data at all, whatever its name says. */
const distinct = new Map<string, Map<string, number>>();
let days = 0;

const files = readdirSync(DAYS_DIR)
	.filter((f) => f.endsWith(".json"))
	.sort();

for (const file of files) {
	const captured = parseCapturedDay(readFileSync(path.join(DAYS_DIR, file), "utf8"));
	const date = file.slice(0, 10);
	days++;
	for (const s of SECTIONS) {
		const v = s.of(captured);
		const b = bytes(v);
		totals.set(s.name, (totals.get(s.name) ?? 0) + b);
		const w = worst.get(s.name);
		if (!w || b > w.b) worst.set(s.name, { date, b });
		const d = createHash("sha256").update(JSON.stringify(v ?? null)).digest("hex");
		if (!distinct.has(s.name)) distinct.set(s.name, new Map());
		const m = distinct.get(s.name)!;
		m.set(d, (m.get(d) ?? 0) + 1);
	}
	const line = (g: Group): number =>
		SECTIONS.filter((s) => s.group === g).reduce((a, s) => a + bytes(s.of(captured)), 0);
	console.log(
		`${date}  crosses ${(line("crosses") / MIB).toFixed(2).padStart(6)}` +
			`  tables ${(line("table") / MIB).toFixed(2).padStart(6)}` +
			`  callback-only ${(line("callback") / MIB).toFixed(2).padStart(7)}` +
			`  rowset ${(line("alt") / MIB).toFixed(2).padStart(7)}  MiB`,
	);
}

console.log(`\n=== ${days} day(s), mean MiB/day, by section ===`);
for (const g of ["crosses", "table", "callback", "alt"] as const) {
	const label = {
		crosses: "OBSERVATIONS + DAY TABLES — cross under every design",
		table: "LOOKUP ANSWER TABLES — cross if the lookups stay oracles",
		callback: "SOLVER-LEAF GEOMETRY — does NOT cross under the callback design",
		alt: "RAW ROWS — the alternative: compute the lookups in Lean",
	}[g];
	console.log(`\n${label}`);
	let sub = 0;
	for (const s of SECTIONS.filter((x) => x.group === g)) {
		const mean = (totals.get(s.name) ?? 0) / days;
		sub += mean;
		const w = worst.get(s.name);
		const n = distinct.get(s.name)?.size ?? 0;
		console.log(
			`  ${s.name.padEnd(20)} ${(mean / MIB).toFixed(3).padStart(8)} MiB` +
				`   worst ${(((w?.b ?? 0) / MIB) || 0).toFixed(3).padStart(8)} MiB  ${w?.date ?? ""}` +
				`   ${String(n).padStart(2)} distinct`,
		);
	}
	console.log(`  ${"SUBTOTAL".padEnd(20)} ${(sub / MIB).toFixed(3).padStart(8)} MiB`);
}

const meanOf = (g: Group): number =>
	SECTIONS.filter((s) => s.group === g).reduce((a, s) => a + (totals.get(s.name) ?? 0), 0) / days;

// A section taking few distinct values over 33 days is not day data, whatever
// its name says: `busRouteCache` is the mirror's bus layer, identical on every
// day in the corpus. Content-addressing the payload — the shell sends a hash,
// the full table crosses only on a miss — turns those into a once-per-run cost.
// Everything else is genuinely per-day and crosses every time.
const CONTENT_ADDRESSED = SECTIONS.filter(
	(s) => (s.group === "crosses" || s.group === "table") && (distinct.get(s.name)?.size ?? days) <= days / 4,
);
const steady =
	meanOf("crosses") +
	meanOf("table") -
	CONTENT_ADDRESSED.reduce((a, s) => a + (totals.get(s.name) ?? 0) / days, 0);

console.log(`\n=== the two candidate wire formats ===`);
console.log(`  answer tables   ${((meanOf("crosses") + meanOf("table")) / MIB).toFixed(2)} MiB/day`);
console.log(`  raw rows        ${((meanOf("crosses") + meanOf("alt")) / MIB).toFixed(2)} MiB/day`);
console.log(`  kept shell-side ${(meanOf("callback") / MIB).toFixed(2)} MiB/day (the callback design's saving)`);
console.log(`\n=== answer tables, content-addressed ===`);
console.log(`  near-constant, crossing once per run rather than per day:`);
for (const s of CONTENT_ADDRESSED) {
	console.log(`    ${s.name.padEnd(20)} ${distinct.get(s.name)?.size} distinct value(s) over ${days} days`);
}
console.log(`  steady-state    ${(steady / MIB).toFixed(2)} MiB/day`);
console.log(`\nfor comparison: the HSMM tenant ships 33-40 MiB/day (#411).`);
