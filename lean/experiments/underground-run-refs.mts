/**
 * V8 reference values for `reconstructUndergroundRun` (`underground-rail.ts`)
 * and, through it, the private `isCoarse` accuracy predicate.
 *
 * I had recorded this as needing a stub OSM ADAPTER. That was wrong: the
 * function takes injected `stationsLookup` / `linesLookup` exactly as
 * `upgradeTubeHops` does, so the same technique applies and the private
 * predicate is reachable through the public function.
 *
 * What it decides: given the coarse cell-network fixes inside a GPS-dark
 * stretch plus the last well-located fix before it and the first one after,
 * which single Underground line the journey followed — or nothing, when the
 * evidence does not single one out. A candidate must serve BOTH ends and be
 * hugged by at least one coarse fix, so a parallel line that merely connects
 * the endpoints loses to the one the train actually followed.
 *
 * Run: nix develop /Users/pippijn/Code/health --command npx tsx lean/experiments/underground-run-refs.mts
 */

import type { NearbyStation } from "../../src/geo/osm.js";
import type { CoarseFix } from "../../src/geo/underground-rail.js";
import { reconstructUndergroundRun } from "../../src/geo/underground-rail.js";

const show = (label: string, v: unknown): void => {
	// eslint-disable-next-line no-console
	console.log(`${label}: ${JSON.stringify(v)}`);
};

const LAT0 = 51.52;
const LON0 = -0.13;
const MLAT = 1 / 111320;
const north = (n: number): { lat: number; lon: number } => ({ lat: LAT0 + n * MLAT, lon: LON0 });
show("frame.north(2000)", north(2000));

const fix = (ts: number, metresNorth: number, accuracy: number | null): CoarseFix => ({
	ts,
	...north(metresNorth),
	accuracy,
});

const BOARD = north(0);
const ALIGHT = north(2000);

const st = (name: string, distanceM: number): NearbyStation => ({ name, distanceM, subtype: "station" }) as NearbyStation;

/** Stations split at 400 m. Deliberately BELOW the 800 m journey-length bar:
 *  with the split at the midpoint, a sub-800 m case resolves both ends to the
 *  same station and is refused there, so the length bar is never reached — an
 *  earlier draft made exactly that mistake. */
const stations = async (lat: number, _lon: number): Promise<NearbyStation[]> =>
	lat < LAT0 + 400 * MLAT ? [st("Highbury & Islington", 40)] : [st("Wembley Park", 60)];
const sameStation = async (_lat: number, _lon: number): Promise<NearbyStation[]> => [st("Highbury & Islington", 40)];
const noStations = async (_lat: number, _lon: number): Promise<NearbyStation[]> => [];

/** Both ends on the Victoria Line, and the coarse fixes hug it. */
const victoria = async (_lat: number, _lon: number): Promise<Set<string>> => new Set(["Victoria Line"]);
/** Both ends serve two lines, but only ONE is hugged by the coarse fixes. */
const twoAtEnds = async (lat: number, _lon: number): Promise<Set<string>> =>
	lat === BOARD.lat || lat === ALIGHT.lat
		? new Set(["Victoria Line", "Piccadilly Line"])
		: new Set(["Victoria Line"]);
/** Both ends serve two lines and the coarse fixes hug BOTH — but one more
 *  often, so the count breaks the tie. */
const weightedTie = async (lat: number, _lon: number): Promise<Set<string>> => {
	if (lat === BOARD.lat || lat === ALIGHT.lat) return new Set(["Victoria Line", "Piccadilly Line"]);
	// The fix at 600 m hugs only Piccadilly; the other two hug only Victoria.
	return lat === north(600).lat ? new Set(["Piccadilly Line"]) : new Set(["Victoria Line"]);
};
/** The ends share a line, but NO coarse fix hugs it — a parallel line that
 *  merely connects the endpoints. */
const noCoarseSupport = async (lat: number, _lon: number): Promise<Set<string>> =>
	lat === BOARD.lat || lat === ALIGHT.lat ? new Set(["Victoria Line"]) : new Set(["Jubilee Line"]);
/** The two ends share nothing. */
const disjoint = async (lat: number, _lon: number): Promise<Set<string>> =>
	new Set([lat < LAT0 + 400 * MLAT ? "Victoria Line" : "Metropolitan Line"]);
const noLines = async (_lat: number, _lon: number): Promise<Set<string>> => new Set<string>();

/** Three coarse fixes: accuracy inside [100, 800] is the coarse band. */
const COARSE: CoarseFix[] = [fix(1000, 300, 200), fix(1100, 600, 300), fix(1200, 1500, 250)];

type Case = {
	fixes: CoarseFix[];
	board?: { lat: number; lon: number };
	alight?: { lat: number; lon: number };
	stations?: typeof stations;
	lines?: typeof victoria;
};

const CASES: Record<string, Case> = {
	// The Victoria Line serves both ends and the coarse fixes hug it.
	resolved: { fixes: COARSE },
	// Two lines at both ends, only one hugged: the hugged one wins.
	oneHugged: { fixes: COARSE, lines: twoAtEnds },
	// Both hugged, but Victoria by two fixes to one — the COUNT decides, so a
	// parallel line the journey merely brushed cannot win.
	countBreaksTie: { fixes: COARSE, lines: weightedTie },
	// The ends share a line, but no coarse fix hugs it.
	noCoarseSupport: { fixes: COARSE, lines: noCoarseSupport },
	// The ends share no line at all; or one end resolves no line.
	disjointEnds: { fixes: COARSE, lines: disjoint },
	noLinesAtEnds: { fixes: COARSE, lines: noLines },
	// FEWER than two coarse fixes: not enough evidence.
	oneCoarseFix: { fixes: [fix(1000, 300, 200)] },
	// ACCURACY BAND, isolated. 100 m exactly is coarse (`>=`); 99 is a good
	// fix; 800 exactly is coarse (`<=`); 801 is total-loss garbage. Each case
	// leaves only ONE fix in the band, so it falls below the minimum.
	accuracyJustUnderBand: { fixes: [fix(1000, 300, 99), fix(1100, 600, 300)] },
	accuracyAtLowerEdge: { fixes: [fix(1000, 300, 100), fix(1100, 600, 300)] },
	accuracyAtUpperEdge: { fixes: [fix(1000, 300, 800), fix(1100, 600, 300)] },
	accuracyJustOverBand: { fixes: [fix(1000, 300, 801), fix(1100, 600, 300)] },
	// A null accuracy is not coarse.
	nullAccuracy: { fixes: [fix(1000, 300, null), fix(1100, 600, 300)] },
	// Both ends resolving to the SAME station is a platform wait, not a journey.
	sameStationBothEnds: { fixes: COARSE, stations: sameStation },
	noStationAtEnd: { fixes: COARSE, stations: noStations },
	// Under 800 m end to end is not a journey either. With the station split at
	// 400 m these two DO resolve to distinct stations, so the length bar is the
	// only thing that can decide them. A pair either side rather than a point ON
	// the bar: the frame's 800 m round-trips through `equirectMeters` a hair
	// SHORT of 800, so an exactly-at-the-bar case would test the float wobble
	// rather than the constant.
	tooShort: { fixes: COARSE, alight: north(790) },
	journeyLengthJustOverBar: { fixes: COARSE, alight: north(810) },
	// The run's span comes from the SORTED coarse fixes, so input order does
	// not matter.
	unsortedFixes: { fixes: [fix(1200, 1500, 250), fix(1000, 300, 200), fix(1100, 600, 300)] },
	empty: { fixes: [] },
};

for (const [name, c] of Object.entries(CASES)) {
	const r = await reconstructUndergroundRun(
		c.fixes,
		c.board ?? BOARD,
		c.alight ?? ALIGHT,
		c.stations ?? stations,
		c.lines ?? victoria,
	);
	show(`run.${name}`, r);
}
