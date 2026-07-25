/**
 * V8 reference values for `src/geo/passes/tube-hop.ts` and the `pickBestStation`
 * helper it uses.
 *
 * `upgradeTubeHops` is async but its docstring is exact: "all OSM access is
 * through the two injected lookups". So the whole pass drives here with stub
 * lookups, which makes the private `findBlackoutHop` reachable honestly rather
 * than through a test-only export.
 *
 * The pass upgrades a fast station-to-station `driving` leg to `train`. Two
 * sufficient structural signatures, both checked BEFORE any lookup so a leg with
 * neither makes no OSM query: fast enough that no bus explains the average, or
 * the tunnel-blackout shape — displacement concentrated in one motorised
 * inter-fix hop with everything observed around it at walking pace.
 *
 * Run: nix develop /Users/pippijn/Code/health --command npx tsx lean/experiments/tube-hop-refs.mts
 */

import type { NearbyStation } from "../../src/geo/osm.js";
import { pickBestStation } from "../../src/geo/osm.js";
import { upgradeTubeHops } from "../../src/geo/passes/tube-hop.js";
import type { TransportMode } from "../../src/geo/segments.js";

const show = (label: string, v: unknown): void => {
	// eslint-disable-next-line no-console
	console.log(`${label}: ${JSON.stringify(v)}`);
};

const LAT0 = 51.52;
const LON0 = -0.13;
const MLAT = 1 / 111320;
/** `n` metres north of the frame origin. */
const north = (n: number): { lat: number; lon: number } => ({ lat: LAT0 + n * MLAT, lon: LON0 });
show("frame.north(3000)", north(3000));

/* ------------------------------------------------------------------ */
/* 1. pickBestStation                                                  */
/* ------------------------------------------------------------------ */

const st = (name: string, distanceM: number, subtype = "station"): NearbyStation =>
	({ name, distanceM, subtype }) as NearbyStation;

const PICK_CASES: Record<string, NearbyStation[]> = {
	// Nearest wins.
	nearest: [st("Far", 300), st("Near", 50)],
	// An entrance is skipped in favour of a real station, however much further.
	skipsEntranceSubtype: [st("Entrance", 5, "subway_entrance"), st("Real", 400)],
	// …and so is an entrance-CODE name, which the regex `^[A-Z]\d?$` catches:
	// a bare capital, optionally followed by one digit.
	skipsEntranceCodeName: [st("A", 5), st("Real", 400)],
	skipsEntranceCodeWithDigit: [st("B2", 5), st("Real", 400)],
	// …but not a two-digit code, nor a lowercase one, nor a longer name.
	twoDigitCodeIsReal: [st("B22", 5), st("Real", 400)],
	lowercaseIsReal: [st("a", 5), st("Real", 400)],
	// With ONLY entrances, the nearest entrance is returned rather than nothing.
	allEntrances: [st("Entrance", 400, "subway_entrance"), st("A", 50)],
	// Equal distances: the STABLE sort keeps input order.
	tieKeepsInputOrder: [st("First", 100), st("Second", 100)],
	empty: [],
};
for (const [name, stations] of Object.entries(PICK_CASES)) {
	show(`pick.${name}`, pickBestStation(stations)?.name ?? null);
}

/* ------------------------------------------------------------------ */
/* 2. upgradeTubeHops                                                  */
/* ------------------------------------------------------------------ */

type Seg = {
	startTs: number;
	endTs: number;
	mode: TransportMode;
	refinedMode?: TransportMode;
	refinedReason?: string;
	wayName?: string;
	avgSpeed: number;
};

const seg = (startTs: number, endTs: number, mode: TransportMode, avgSpeed: number, extra: Partial<Seg> = {}): Seg => ({
	startTs,
	endTs,
	mode,
	avgSpeed,
	...extra,
});

/** Stations resolve by which end of the frame the query lands nearest. */
const stationsAt = (lat: number): NearbyStation[] =>
	lat < LAT0 + 1500 * MLAT ? [st("Euston Square", 40)] : [st("Wembley Park", 60)];

const stationsLookup = async (lat: number, _lon: number): Promise<NearbyStation[]> => stationsAt(lat);
/** Both endpoints on one line by default. */
const oneLine = async (_lat: number, _lon: number): Promise<Set<string>> => new Set(["Metropolitan Line"]);
/** Three shared lines — the sub-surface case, where the label stays bare. */
const threeLines = async (_lat: number, _lon: number): Promise<Set<string>> =>
	new Set(["Circle, Hammersmith & City and Metropolitan Lines"]);
/** Directional variants of ONE line: canonicalised, they still intersect. */
const directional = async (lat: number, _lon: number): Promise<Set<string>> =>
	new Set([lat < LAT0 + 1500 * MLAT ? "Metropolitan Line Northbound" : "Metropolitan Line Southbound"]);
/** No line in common. */
const disjointLines = async (lat: number, _lon: number): Promise<Set<string>> =>
	new Set([lat < LAT0 + 1500 * MLAT ? "Metropolitan Line" : "Jubilee Line"]);
const noStations = async (_lat: number, _lon: number): Promise<NearbyStation[]> => [];
const sameStation = async (_lat: number, _lon: number): Promise<NearbyStation[]> => [st("Euston Square", 40)];

/** A fast leg: 40 km/h average, so the speed signature alone qualifies it. */
const FAST_POINTS = [
	{ ts: 1000, ...north(0) },
	{ ts: 1300, ...north(3000) },
];
/** A BLACKOUT leg: slow average, but the displacement is one 3 km hop across a
 *  120 s gap, with walking-pace fixes either side. */
const BLACKOUT_POINTS = [
	{ ts: 1000, ...north(0) },
	{ ts: 1100, ...north(50) },
	{ ts: 1220, ...north(3050) },
	{ ts: 1320, ...north(3100) },
];
/** Slow AND diffuse: no single hop carries the displacement.  */
const DIFFUSE_POINTS = [
	{ ts: 1000, ...north(0) },
	{ ts: 1200, ...north(1000) },
	{ ts: 1400, ...north(2000) },
	{ ts: 1600, ...north(3000) },
];

type Case = {
	segs: Seg[];
	points: typeof FAST_POINTS;
	stations?: typeof stationsLookup;
	lines?: typeof oneLine;
};

const CASES: Record<string, Case> = {
	// The speed signature: 40 km/h average between two stations on one line.
	fastUpgraded: { segs: [seg(1000, 1300, "driving", 40)], points: FAST_POINTS },
	// The BLACKOUT signature: a slow average, but one motorised hop carries the
	// displacement and the surface fixes are at walking pace.
	blackoutUpgraded: { segs: [seg(1000, 1320, "driving", 10)], points: BLACKOUT_POINTS },
	// Slow and diffuse: neither signature, so no upgrade and NO lookup.
	slowDiffuse: { segs: [seg(1000, 1600, "driving", 10)], points: DIFFUSE_POINTS },
	// THE SPEED BAR, isolated. Same geometry both times, so the only thing that
	// differs is the average. 28 km/h exactly clears it (the test is `<`), so
	// the leg upgrades on the station-pair signature without the blackout shape
	// ever being consulted; a hair under, and it upgrades via the BLACKOUT arm
	// instead. The reason string is what distinguishes them.
	// (An earlier draft used DIFFUSE_POINTS here and proved nothing: its
	// in-window fixes both resolve to the same station, so a different gate
	// decided the outcome.)
	speedExactlyAtBar: { segs: [seg(1000, 1300, "driving", 28)], points: FAST_POINTS },
	speedJustUnderBar: { segs: [seg(1000, 1300, "driving", 27.9)], points: FAST_POINTS },
	// Slow AND diffuse, with endpoints that DO resolve to distinct stations:
	// the blackout gate is the one that refuses.
	slowDiffuseDistinctStations: { segs: [seg(1000, 1600, "driving", 10)], points: DIFFUSE_POINTS },
	// The blackout gate's THREE refusals, each isolated (an earlier draft
	// exercised only the share gate, because DIFFUSE_POINTS refuses there first
	// and the other two were never reached):
	//   implied speed — one hop carries everything, but over 50 minutes, so it
	//   is a slow crawl and not a tunnel transit.
	blackoutLowImpliedSpeed: {
		segs: [seg(1000, 4000, "driving", 10)],
		points: [
			{ ts: 1000, ...north(0) },
			{ ts: 4000, ...north(3000) },
		],
	},
	//   surface pace — the hop is genuinely motorised, but what is observed
	//   around it moves at 18 km/h, so this is a drive with one sparse stretch.
	blackoutFastSurface: {
		segs: [seg(1000, 1200, "driving", 10)],
		points: [
			{ ts: 1000, ...north(0) },
			{ ts: 1100, ...north(500) },
			{ ts: 1200, ...north(3500) },
		],
	},
	//   share — 0.633 of the net displacement in one hop clears the 0.6 bar,
	//   with the remainder at walking pace. Pins the CONSTANT (a 0.65 bar
	//   refuses this), not the strictness.
	blackoutShareJustAboveBar: {
		segs: [seg(1000, 1700, "driving", 10)],
		points: [
			{ ts: 1000, ...north(0) },
			{ ts: 1600, ...north(1100) },
			{ ts: 1700, ...north(3000) },
		],
	},
	// A ZERO-DURATION hop (duplicate timestamps) is still a teleport: its
	// implied speed is infinite rather than a division by zero.
	blackoutZeroDurationHop: {
		segs: [seg(1000, 1000, "driving", 10)],
		points: [
			{ ts: 1000, ...north(0) },
			{ ts: 1000, ...north(3000) },
		],
	},
	// The board fix is the hop's START, not the leg's first fix. Here they sit
	// on opposite sides of the station boundary, so using the leg's first fix
	// would resolve BOTH ends to Wembley Park and refuse.
	boardIsHopStartNotFirstFix: {
		segs: [seg(1000, 1220, "driving", 10)],
		points: [
			{ ts: 1000, ...north(1600) },
			{ ts: 1100, ...north(1400) },
			{ ts: 1220, ...north(4400) },
		],
	},
	// Adjacent to a train on EITHER side: a fragment of that ride, not a hop.
	// Checked before any lookup so an adjacent-train day stays fixture-stable.
	adjacentTrainBefore: {
		segs: [seg(0, 1000, "train", 40), seg(1000, 1300, "driving", 40)],
		points: FAST_POINTS,
	},
	adjacentTrainAfter: {
		segs: [seg(1000, 1300, "driving", 40), seg(1300, 2000, "train", 40)],
		points: FAST_POINTS,
	},
	// Not driving at all.
	notDriving: { segs: [seg(1000, 1300, "walking", 40)], points: FAST_POINTS },
	// Fewer than two fixes in the window.
	tooFewFixes: { segs: [seg(1000, 1050, "driving", 40)], points: FAST_POINTS },
	// The station gate a taxi between two addresses fails.
	noStations: { segs: [seg(1000, 1300, "driving", 40)], points: FAST_POINTS, stations: noStations },
	// Both endpoints resolving to the SAME station is not a journey.
	sameStationBothEnds: { segs: [seg(1000, 1300, "driving", 40)], points: FAST_POINTS, stations: sameStation },
	// No shared line: the endpoints are stations but not on one corridor.
	disjointLines: { segs: [seg(1000, 1300, "driving", 40)], points: FAST_POINTS, lines: disjointLines },
	// Directional variants canonicalise to the same line and still intersect.
	directionalVariants: { segs: [seg(1000, 1300, "driving", 40)], points: FAST_POINTS, lines: directional },
	// THREE shared lines (the sub-surface stations): the label stays bare,
	// because naming one of three would be a guess.
	threeSharedLines: { segs: [seg(1000, 1300, "driving", 40)], points: FAST_POINTS, lines: threeLines },
	// An existing refinedReason is quoted in the new one.
	existingReason: {
		segs: [seg(1000, 1300, "driving", 40, { refinedReason: "earlier note" })],
		points: FAST_POINTS,
	},
	empty: { segs: [], points: FAST_POINTS },
};

for (const [name, c] of Object.entries(CASES)) {
	const out = await upgradeTubeHops(c.segs, c.points, c.stations ?? stationsLookup, c.lines ?? oneLine);
	show(
		`hop.${name}`,
		out.map((s) => ({
			startTs: s.startTs,
			mode: s.mode,
			refinedMode: s.refinedMode ?? null,
			wayName: s.wayName ?? null,
			refinedReason: s.refinedReason ?? null,
		})),
	);
}
