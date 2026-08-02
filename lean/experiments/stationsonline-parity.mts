/**
 * Does the pushed-rows `stationsOnLine` reproduce what MariaDB answered?
 *
 * Task #414's referee. The fixture carries both halves by construction, and for
 * the same reason `osm-oracle-parity.mts` does: the recorded trace is what the
 * LIVE adapter returned during pass 1 of the capture, and the rail-line set is
 * the raw rows fetched in the same run, so the two are contemporaneous and no
 * mirror drift can be mistaken for a porting error.
 *
 * The comparison is on the full station list, name and coordinates, in order.
 * Order matters and is not incidental: `filterStationsByLineProximity` returns
 * stations in the order the station table yielded them, and downstream
 * `resolveJourneyAlight` / `ridesBackTowardBoard` read positional relationships
 * out of that list. A set-equal-but-reordered answer would be a real change.
 *
 * A day whose row-set predates the rail-line section is SKIPPED rather than
 * counted — it has nothing to compute from, so it can neither agree nor
 * disagree, and folding it into a pass count would report coverage the corpus
 * does not have.
 *
 * Run: nix develop . --command npx tsx lean/experiments/stationsonline-parity.mts [day ...]
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseCapturedDay } from "../../src/cli/fixture-day.js";
import type { Station } from "../../src/geo/line-stations.js";
import { RowSetOsmAdapter } from "../../src/geo/osm-adapter-rowset.js";

const DAYS_DIR = path.join(process.cwd(), "tests", "golden", "days");

/** Identity of an answer: names AND coordinates AND order. */
const key = (s: readonly Station[]): string => JSON.stringify(s.map((x) => [x.name, x.lat, x.lon]));

const requested = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const files = readdirSync(DAYS_DIR)
	.filter((f) => f.endsWith(".json"))
	.filter((f) => requested.length === 0 || requested.some((d) => f.startsWith(d)))
	.sort();

let daysCompared = 0;
let daysSkipped = 0;
let same = 0;
let differed = 0;

for (const file of files) {
	const captured = parseCapturedDay(readFileSync(path.join(DAYS_DIR, file), "utf8"));
	const rowSet = captured.inputs.osmRowSet;
	const recorded = captured.inputs.osmTrace.stationsOnLine ?? {};
	if (!rowSet?.railLines) {
		daysSkipped++;
		console.log(`${file.slice(0, 10)}  SKIP — row-set predates the rail-line section`);
		continue;
	}
	daysCompared++;

	// The inner adapter must never be reached; a delegation here would mean the
	// computed path silently fell back and the comparison measured nothing.
	const thrower = new Proxy(
		{},
		{
			get(_t, prop) {
				return () => {
					throw new Error(`stationsonline-parity: unexpected delegation to ${String(prop)}`);
				};
			},
		},
	);
	const osm = new RowSetOsmAdapter(rowSet, thrower as never);

	const lines = Object.keys(recorded);
	const diffs: string[] = [];
	for (const line of lines) {
		const expected = recorded[line];
		let got: Station[];
		try {
			got = await osm.stationsOnLine(line);
		} catch (e) {
			diffs.push(`${line}: REFUSED — ${(e as Error).message.split(" — ")[0]}`);
			differed++;
			continue;
		}
		if (key(got) === key(expected)) {
			same++;
		} else {
			differed++;
			const names = (s: readonly Station[]) => new Set(s.map((x) => x.name));
			const g = names(got);
			const e = names(expected);
			const onlyComputed = [...g].filter((n) => !e.has(n));
			const onlyRecorded = [...e].filter((n) => !g.has(n));
			diffs.push(
				`${line}: computed ${got.length} vs recorded ${expected.length}` +
					(onlyComputed.length > 0 ? ` · only computed: ${onlyComputed.join(", ")}` : "") +
					(onlyRecorded.length > 0 ? ` · only recorded: ${onlyRecorded.join(", ")}` : "") +
					(onlyComputed.length === 0 && onlyRecorded.length === 0 ? " · same set, different ORDER" : ""),
			);
		}
	}
	console.log(`${file.slice(0, 10)}  ${lines.length - diffs.length}/${lines.length} identical`);
	for (const d of diffs) console.log(`      ${d}`);
}

console.log(`\n=== ${daysCompared} day(s) compared, ${daysSkipped} skipped ===`);
console.log(`${same} line answer(s) identical, ${differed} differed`);
process.exit(differed > 0 ? 1 : 0);
