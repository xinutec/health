/**
 * CLI: attribute residual building crossings to their cause in `correctWalkPath`.
 *
 * For each golden day (or a given list) it replays the fixture through the walk
 * pipeline with `WALK_CORRECT_DIAG=1`, drains the per-crossing-run decision
 * records, and tallies the OUTCOME that left a building crossing standing:
 *
 *   routed          — case 2 accepted (a repair happened; not a residual)
 *   escaped         — case 1 accepted (a repair happened; not a residual)
 *   trustGPS        — BOTH refused → the crossing survives. Sub-cause:
 *                       no-route   = graph gap (no walkable path around → OSM data)
 *                       route-bad  = dense area (the route-around also crosses)
 *                       budget     = whole-leg inflation budget spent
 *   invariant-revert — the whole leg's corrections were discarded (made it worse)
 *
 * Pure replay against the fixture's own OSM trace — zero DB, zero Overpass.
 *
 *   node dist/cli/diag-walk-crossings.js            # every golden day, pippijn
 *   node dist/cli/diag-walk-crossings.js 2026-04-29 # one day
 */
import { readdirSync, readFileSync } from "node:fs";
import { FixtureOsmAdapter } from "../geo/osm-adapter-fixture.js";
import { drainWalkCorrectDiag } from "../geo/pedestrian-match-annotate.js";
import { computeVelocityFromInputs } from "../geo/velocity.js";
import { inputsFromFixture, parseCapturedDay } from "./fixture-day.js";

const USER = "pippijn";

function goldenDays(): string[] {
	return readdirSync("tests/golden/days")
		.map((f) => f.match(/^(\d{4}-\d{2}-\d{2})-pippijn\.json$/)?.[1])
		.filter((d): d is string => d !== undefined)
		.sort();
}

/** Anchor-snap radius (m) the router uses — mirrors DEFAULT_CORRECT_OPTIONS. */
const ROUTE_SNAP_M = 35;

function subCause(r: {
	routeFound: boolean;
	routeBadM: number | null;
	runBadM: number;
	anchorASnapM: number | null;
	anchorBSnapM: number | null;
}): string {
	if (r.routeFound) return r.routeBadM !== null && r.routeBadM >= r.runBadM ? "route-bad" : "budget";
	// No route. Split by whether the ways EXIST near both anchors.
	const a = r.anchorASnapM;
	const b = r.anchorBSnapM;
	if (a !== null && b !== null && a <= ROUTE_SNAP_M && b <= ROUTE_SNAP_M) return "fragmented"; // ways exist, graph disconnected → FIXABLE
	return "unmapped"; // an anchor is far from any way → genuine data gap → ACCEPT
}

async function main(): Promise<void> {
	process.env.WALK_CORRECT_DIAG = "1";
	const days = process.argv.slice(2).length > 0 ? process.argv.slice(2) : goldenDays();

	const tally: Record<string, number> = {
		routed: 0,
		escaped: 0,
		"trustGPS/fragmented": 0,
		"trustGPS/unmapped": 0,
		"trustGPS/route-bad": 0,
		"trustGPS/budget": 0,
		"invariant-revert": 0,
	};
	const survivors: Array<{
		date: string;
		startTs: number;
		cause: string;
		runBadM: number;
		straightM: number;
		snapA: number | null;
		snapB: number | null;
	}> = [];

	for (const date of days) {
		let captured: ReturnType<typeof parseCapturedDay>;
		try {
			captured = parseCapturedDay(readFileSync(`tests/golden/days/${date}-${USER}.json`, "utf8"));
		} catch {
			continue;
		}
		const base = inputsFromFixture(captured);
		drainWalkCorrectDiag(); // clear any residue
		await computeVelocityFromInputs(
			{ ...base, osm: new FixtureOsmAdapter(captured.inputs.osmTrace) },
			{ walkMatch: true },
		);
		for (const r of drainWalkCorrectDiag()) {
			if (r.outcome === "routed") tally.routed++;
			else if (r.outcome === "escaped") tally.escaped++;
			else if (r.outcome === "invariant-revert") tally["invariant-revert"]++;
			else {
				const cause = subCause(r);
				tally[`trustGPS/${cause}`]++;
				survivors.push({
					date,
					startTs: r.startTs,
					cause,
					runBadM: r.runBadM,
					straightM: r.straightM,
					snapA: r.anchorASnapM,
					snapB: r.anchorBSnapM,
				});
			}
		}
	}

	console.log(`\nCROSSING-RUN OUTCOMES across ${days.length} day(s):`);
	for (const [k, v] of Object.entries(tally)) console.log(`  ${k.padEnd(20)} ${v}`);

	const iso = (t: number) => new Date(t * 1000).toISOString().slice(11, 16);
	const m = (x: number | null) => (x === null ? " —" : x.toFixed(0).padStart(3));
	console.log(`\nSURVIVING CROSSINGS (trustGPS runs, worst first):`);
	for (const s of survivors.sort((a, b) => b.runBadM - a.runBadM).slice(0, 25))
		console.log(
			`  ${s.date} @${iso(s.startTs)}Z  ${s.cause.padEnd(10)} runBad ${s.runBadM.toFixed(0).padStart(3)}m  straight ${s.straightM.toFixed(0).padStart(3)}m  anchorSnap ${m(s.snapA)}/${m(s.snapB)}m`,
		);
}

void main();
