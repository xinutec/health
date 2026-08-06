/**
 * CLI: attribute residual building crossings to their cause in `correctWalkPath`.
 *
 * For each golden day (or a given list) it replays the fixture through the walk
 * pipeline with `WALK_CORRECT_DIAG=1`, drains the per-crossing-run decision
 * records, and tallies the OUTCOME that left a building crossing standing:
 *
 *   routed          — case 2 accepted (a repair happened; not a residual)
 *   cornered        — case 2.5 accepted (a repair happened; not a residual)
 *   escaped         — case 1 accepted (a repair happened; not a residual)
 *   trustGPS        — every repair refused → the crossing survives. Sub-cause:
 *                       sub-threshold = under `minCrossingM`; the router was
 *                                       never called, so no route-shaped cause
 *                                       applies (this is NOT a routing failure)
 *                       over-bound    = a walkable route EXISTS but is longer
 *                                       than `maxRouteM` — a threshold question
 *                       fragmented    = no path at any length, though ways exist
 *                                       within `ROUTE_SNAP_M` of both anchors
 *                                       → our graph is disconnected, FIXABLE
 *                       unmapped      = an anchor is far from any way → genuine
 *                                       OSM data gap → ACCEPT
 *                       route-bad     = dense area (the route-around also crosses)
 *                       budget        = whole-leg inflation budget spent
 *   budget-revert   — the leg exceeded its pedometer step budget, so ALL of its
 *                     corrections were discarded (#347). A whole-leg outcome,
 *                     not a surviving run.
 *   invariant-revert — the whole leg's corrections were discarded (made it worse)
 *
 * Days that cannot be replayed (stale fixture, uncaptured OSM lookup) are
 * reported separately rather than dropped: a day that threw contributes exactly
 * what a day with no crossings contributes, and the tally must not read as
 * whole-corpus coverage when it is not.
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
	unboundedRouteM: number | null;
	routeAttempted: boolean;
}): string {
	// A run under `minCrossingM` never calls the router at all, so none of the
	// route-shaped causes below apply to it. It is a sub-threshold nick, not a
	// routing failure, and folding it in inflates whichever bucket it lands in.
	if (!r.routeAttempted) return "sub-threshold";
	if (r.routeFound) return r.routeBadM !== null && r.routeBadM >= r.runBadM ? "route-bad" : "budget";
	// No route WITHIN THE DETOUR BOUND. Three different failures hide here, and
	// they fork the fix, so ask the graph directly rather than inferring from
	// the anchors: a finite unbounded route means the network is connected and
	// `maxRouteM` refused it (a THRESHOLD question, not a data one).
	if (r.unboundedRouteM !== null) return "over-bound";
	// Genuinely no path at any length. Split by whether ways exist near both ends.
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
		cornered: 0,
		escaped: 0,
		"budget-revert": 0,
		"trustGPS/sub-threshold": 0,
		"trustGPS/over-bound": 0,
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
		unboundedM: number | null;
	}> = [];

	// Days the replay could not reach, with why. A crossing tally is a claim
	// about COVERAGE as much as about crossings, and a day that threw looks
	// exactly like a day with no crossings once it is dropped from the loop.
	const unreplayable: Array<{ date: string; why: string }> = [];

	/** A caught value as a readable sentence. Narrowed rather than stringified:
	 *  `String(e)` on a non-Error prints "[object Object]", and this text IS the
	 *  report of why a day contributed nothing — an unreadable reason there is
	 *  the same failure as dropping the day silently. */
	const why = (e: unknown): string => {
		if (e instanceof Error) return e.message;
		if (typeof e === "string") return e;
		return JSON.stringify(e) ?? "non-Error throw";
	};

	for (const date of days) {
		let captured: ReturnType<typeof parseCapturedDay>;
		try {
			captured = parseCapturedDay(readFileSync(`tests/golden/days/${date}-${USER}.json`, "utf8"));
		} catch (e) {
			unreplayable.push({ date, why: `fixture unreadable: ${why(e)}` });
			continue;
		}
		const base = inputsFromFixture(captured);
		drainWalkCorrectDiag(); // clear any residue
		try {
			await computeVelocityFromInputs(
				{ ...base, osm: new FixtureOsmAdapter(captured.inputs.osmTrace) },
				{ walkMatch: true },
			);
		} catch (e) {
			// A stale fixture (uncaptured OSM lookup) must not abort the sweep —
			// nor be swallowed into a smaller-looking corpus.
			unreplayable.push({ date, why: why(e) });
			drainWalkCorrectDiag();
			continue;
		}
		for (const r of drainWalkCorrectDiag()) {
			if (r.outcome === "routed") tally.routed++;
			else if (r.outcome === "cornered") tally.cornered++;
			else if (r.outcome === "escaped") tally.escaped++;
			else if (r.outcome === "invariant-revert") tally["invariant-revert"]++;
			// A whole-leg discard, NOT a per-run survivor. It used to fall through to
			// `subCause`, which reads a record that carries no run at all (runBad 0,
			// straight 0, null anchors) and reported it as a trustGPS crossing —
			// hiding the one outcome that throws away every correction on the leg.
			else if (r.outcome === "budget-revert") tally["budget-revert"]++;
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
					unboundedM: r.unboundedRouteM,
				});
			}
		}
	}

	console.log(`\nCROSSING-RUN OUTCOMES across ${days.length - unreplayable.length} of ${days.length} day(s):`);
	for (const [k, v] of Object.entries(tally)) console.log(`  ${k.padEnd(20)} ${v}`);

	const iso = (t: number) => new Date(t * 1000).toISOString().slice(11, 16);
	const m = (x: number | null) => (x === null ? " —" : x.toFixed(0).padStart(3));
	console.log(`\nSURVIVING CROSSINGS (trustGPS runs, worst first):`);
	for (const s of survivors.sort((a, b) => b.runBadM - a.runBadM).slice(0, 25))
		console.log(
			`  ${s.date} @${iso(s.startTs)}Z  ${s.cause.padEnd(11)} runBad ${s.runBadM.toFixed(0).padStart(3)}m  straight ${s.straightM.toFixed(0).padStart(3)}m  anchorSnap ${m(s.snapA)}/${m(s.snapB)}m  unbounded ${s.unboundedM === null ? "  none" : `${s.unboundedM.toFixed(0).padStart(4)}m`}`,
		);

	if (unreplayable.length > 0) {
		console.log(`\nNOT REPLAYED — ${unreplayable.length} day(s) contribute NOTHING to the tally above:`);
		for (const u of unreplayable) console.log(`  ${u.date}  ${u.why.split("\n")[0]}`);
	}
}

void main();
