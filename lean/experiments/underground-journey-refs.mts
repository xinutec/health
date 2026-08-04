/**
 * V8 reference values for `reconstructUndergroundJourney` — the two-leg
 * interchange split in `underground-rail.ts`.
 *
 * A single coarse run can span an interchange: the cell fixes hug one line, GPS
 * briefly recovers on the platform at the changeover, then coarse fixes hug the
 * next line. No single line serves both ends, so `reconstructUndergroundRun`
 * alone returns null and the whole ride is lost.
 *
 * The gate that makes this safe is the THREE-WAY disjointness test, and it
 * compares PHYSICAL lines rather than OSM relation strings. That matters
 * because OSM writes the same line two ways: "Metropolitan Line" at one station
 * and "Circle, Hammersmith & City and Metropolitan Lines" at another. A raw
 * string intersection sees no shared line and would manufacture a phantom
 * interchange on what was one continuous Metropolitan ride (2026-06-23 Wembley
 * Park → Euston Square). Canonicalised, the two halves are the same line and the
 * split is refused.
 *
 * Run: nix develop /Users/pippijn/Code/health --command npx tsx lean/experiments/underground-journey-refs.mts
 */

import type { NearbyStation } from "../../src/geo/osm.js";
import type { CoarseFix } from "../../src/geo/underground-rail.js";
import { reconstructUndergroundJourney } from "../../src/geo/underground-rail.js";

const show = (label: string, v: unknown): void => {
	// eslint-disable-next-line no-console
	console.log(`${label}: ${JSON.stringify(v)}`);
};

const LAT0 = 51.52;
const LON0 = -0.13;
const MLAT = 1 / 111320;
const north = (n: number): { lat: number; lon: number } => ({ lat: LAT0 + n * MLAT, lon: LON0 });
show("frame.north(4000)", north(4000));

const fix = (ts: number, metresNorth: number, accuracy: number | null): CoarseFix => ({
	ts,
	...north(metresNorth),
	accuracy,
});

const BOARD = north(0);
const ALIGHT = north(4000);

const st = (name: string, distanceM: number): NearbyStation => ({ name, distanceM, subtype: "station" }) as NearbyStation;

/** Three station zones: below 1 km, 1–3 km, above 3 km. */
const stations = async (lat: number, _lon: number): Promise<NearbyStation[]> => {
	const m = (lat - LAT0) / MLAT;
	if (m < 1000) return [st("Highbury & Islington", 40)];
	if (m < 3000) return [st("King's Cross", 50)];
	return [st("Wembley Park", 60)];
};

/** A genuine change: Victoria south of the interchange, Metropolitan north, and
 *  the interchange point itself serves both. */
const changeLines = async (lat: number, _lon: number): Promise<Set<string>> => {
	const m = (lat - LAT0) / MLAT;
	if (m < 1500) return new Set(["Victoria Line"]);
	if (m < 2500) return new Set(["Victoria Line", "Metropolitan Line"]);
	return new Set(["Metropolitan Line"]);
};

/** THE PARALLEL-CORRIDOR TRAP: one continuous Metropolitan ride, but OSM names
 *  the line differently at the two ends. A raw string intersection sees nothing
 *  shared; canonicalised, both halves are Metropolitan. */
const COMBINED = "Circle, Hammersmith & City and Metropolitan Lines";
const sameLineTwoNames = async (lat: number, _lon: number): Promise<Set<string>> => {
	const m = (lat - LAT0) / MLAT;
	if (m < 1500) return new Set(["Metropolitan Line"]);
	if (m < 2500) return new Set(["Metropolitan Line", COMBINED]);
	return new Set([COMBINED]);
};

/** THE BOARD-END CONJUNCT, isolated. The board end serves leg2's line under the
 *  COMBINED name, so a raw-string single-run attempt still fails, but
 *  canonicalised the rider could have stayed on one line the whole way. Only
 *  `disjoint(expand(boardLines), leg2Lines)` refuses this. */
const boardEndCouldRideThrough = async (lat: number, _lon: number): Promise<Set<string>> => {
	const m = (lat - LAT0) / MLAT;
	if (m < 1500) return new Set(["Victoria Line", COMBINED]);
	if (m < 2500) return new Set(["Victoria Line", "Metropolitan Line"]);
	return new Set(["Metropolitan Line"]);
};

/** THE ALIGHT-END CONJUNCT, isolated. Mirror image: the alight end serves
 *  leg1's line under a combined name. Only
 *  `disjoint(expand(alightLines), leg1Lines)` refuses this. */
const alightEndCouldRideThrough = async (lat: number, _lon: number): Promise<Set<string>> => {
	const m = (lat - LAT0) / MLAT;
	if (m < 1500) return new Set(["Victoria Line"]);
	if (m < 2500) return new Set(["Victoria Line", "Metropolitan Line"]);
	return new Set(["Metropolitan Line", "Victoria and Bakerloo Lines"]);
};

/** Both ends on one line, hugged throughout: the single-run arm succeeds. */
const oneLine = async (_lat: number, _lon: number): Promise<Set<string>> => new Set(["Victoria Line"]);

/** Coarse fixes: two south of the interchange, two north. */
const COARSE: CoarseFix[] = [
	fix(1000, 200, 200),
	fix(1100, 800, 250),
	fix(1400, 3200, 250),
	fix(1500, 3800, 200),
];
/** A good-fix cluster on the platform at the changeover, mid-run. */
const INTERCHANGE: CoarseFix[] = [fix(1200, 2000, 20), fix(1250, 2010, 15)];

/** The mirror knows no line's stops, so `lineCannotServe` asserts nothing —
 *  "unknown is not evidence". These cases are about the SPLIT. */
const servedNothing = async (_line: string): Promise<{ name: string }[]> => [];

type Case = {
	served?: typeof servedNothing;
	fixes?: CoarseFix[];
	interchange?: CoarseFix[];
	lines?: typeof changeLines;
};

const CASES: Record<string, Case> = {
	// The single-line arm wins outright and no split is attempted.
	singleLineWins: { lines: oneLine },
	// A genuine interchange: two legs, meeting at King's Cross.
	genuineChange: {},
	// The parallel-corridor trap: the same physical line under two OSM names.
	// The single arm fails on raw strings, and the disjointness test then
	// refuses the split — no phantom interchange.
	sameLineTwoNames: { lines: sameLineTwoNames },
	// The three-way disjointness test, one conjunct at a time. Each of these
	// passes every other gate and is refused by exactly ONE.
	boardEndCouldRideThrough: { lines: boardEndCouldRideThrough },
	alightEndCouldRideThrough: { lines: alightEndCouldRideThrough },
	// A cluster deep inside leg2's own zone: refused because no line serves both
	// the board end and that point, so leg1 never resolves.
	clusterInsideLegTwoZone: { interchange: [fix(1300, 3100, 20)] },
	// Fewer than 2 x MIN_COARSE_FIXES: not enough to make two real legs.
	tooFewCoarseFixes: { fixes: [fix(1000, 200, 200), fix(1100, 800, 250), fix(1400, 3200, 250)] },
	// No mid-run good fixes at all: nothing pins an interchange.
	noInterchangeFixes: { interchange: [] },
	// The cluster sits OUTSIDE the coarse span (before the first coarse fix), so
	// it is not a mid-run recovery.
	clusterBeforeSpan: { interchange: [fix(900, 2000, 20)] },
	clusterAfterSpan: { interchange: [fix(1600, 2000, 20)] },
	// A cluster so early that one side has too few coarse fixes to reconstruct.
	clusterLeavesOneSideShort: { interchange: [fix(1050, 2000, 20)] },
	// TWO clusters separated by more than MAX_COARSE_GAP_S are distinct
	// candidates; the first that satisfies every gate wins.
	twoClusters: { interchange: [fix(1120, 2000, 20), fix(1450, 2000, 20)] },
	// CLUSTERING IS LOAD-BEARING, and this is the case that shows it. The two
	// fixes are 150 s apart — inside MAX_COARSE_GAP_S — so they MERGE, and the
	// merged centroid (2000 m) lands at King's Cross. Treated as two clusters
	// they would land at 900 m and 3100 m, each of which resolves to a leg's own
	// endpoint station and is refused. Merged: a real interchange.
	clusterMergeIsLoadBearing: { interchange: [fix(1150, 900, 20), fix(1300, 3100, 20)] },
	empty: { fixes: [] },
};

for (const [name, c] of Object.entries(CASES)) {
	const r = await reconstructUndergroundJourney(
		c.fixes ?? COARSE,
		c.interchange ?? INTERCHANGE,
		BOARD,
		ALIGHT,
		stations,
		c.lines ?? changeLines,
		c.served ?? servedNothing,
	);
	show(`journey.${name}`, r);
}
