/**
 * V8 reference values for `annotateUndergroundRuns` — the segment-level pass in
 * `underground-rail.ts` that carves a reconstructed tube ride out of the host
 * segment it was hiding inside.
 *
 * This is the LAST unported leaf's home. `isUndergroundSignal` is
 * module-private and reachable only through this pass, and the distinction it
 * draws is the point of the whole module: it accepts `accuracy >= 100` with NO
 * upper bound, where `isCoarse` (the snapping predicate) caps at 800. A
 * total-loss fix — kilometre-scale uncertainty — cannot be snapped to a
 * station, but its PRESENCE is itself the underground signal, because open-air
 * GPS never reports that. Counting total-loss fixes when detecting the dark
 * window, and excluding them when snapping, is what lets a deep-tube leg whose
 * coarse fixes alone are too sparse still be recognised. The `deepTube` case
 * below is exactly that shape and fails if the upper bound is added back.
 *
 * The three OSM lookups are injected (stations / lines / ways), so the pass is
 * `async` only in its plumbing — the same technique that made `upgradeTubeHops`
 * and `reconstructUndergroundRun` reference-testable through their public
 * entry point. `sideWayName` is private and pinned through the split output.
 *
 * # This harness had drifted out of its own subject's signature
 *
 * It called `annotateUndergroundRuns` with FIVE arguments. The pass has taken
 * seven since `ed5471e`/`0a72d58` — `points` and `servedLookup` were added — so
 * the call was passing `stations` where the track goes and defaulting the last
 * two to `dbOsmAdapter`, i.e. reaching for the live OSM mirror instead of the
 * stubs. Nothing caught it, because nothing typechecks these harnesses (#418),
 * and the values in `UndergroundAnnotate.lean` are therefore pinned against a
 * TS that stopped existing on 2026-07-28.
 *
 * Corrected here. The way-label cases will produce DIFFERENT answers from the
 * ones the Lean currently guards, because `8655be3` changed which question
 * `sideWayName` asks — that is the point, not a regression.
 *
 * Run: nix develop /Users/pippijn/Code/health --command npx tsx lean/experiments/underground-annotate-refs.mts
 */

import type { FilteredPoint } from "../../src/geo/kalman.js";
import type { NearbyStation, NearbyWay } from "../../src/geo/osm.js";
import type { CoarseFix } from "../../src/geo/underground-rail.js";
import { annotateUndergroundRuns } from "../../src/geo/underground-rail.js";

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

const st = (name: string, distanceM: number): NearbyStation => ({ name, distanceM, subtype: "station" }) as NearbyStation;

/** Three station zones, as in the journey harness: below 1 km, 1-3 km, above. */
const stations = async (lat: number, _lon: number): Promise<NearbyStation[]> => {
	const m = (lat - LAT0) / MLAT;
	if (m < 1000) return [st("Highbury & Islington", 40)];
	if (m < 3000) return [st("King's Cross", 50)];
	return [st("Wembley Park", 60)];
};

/** One line end to end: the single-run arm resolves, no interchange. */
const oneLine = async (_lat: number, _lon: number): Promise<Set<string>> => new Set(["Victoria Line"]);

/** A genuine change at the middle zone — drives the two-leg output. */
const changeLines = async (lat: number, _lon: number): Promise<Set<string>> => {
	const m = (lat - LAT0) / MLAT;
	if (m < 1500) return new Set(["Victoria Line"]);
	if (m < 2500) return new Set(["Victoria Line", "Metropolitan Line"]);
	return new Set(["Metropolitan Line"]);
};

/** No line resolves anywhere: reconstruction returns no legs. */
const noLines = async (_lat: number, _lon: number): Promise<Set<string>> => new Set<string>();

const way = (type: string, name: string | undefined, distanceM: number): NearbyWay =>
	({ type, subtype: "residential", name, distanceM }) as NearbyWay;

/** Ways split by zone so the pre-tube and post-tube walks get DIFFERENT
 *  labels — the leak this pass exists to prevent (#248). */
const ways = async (lat: number, _lon: number): Promise<NearbyWay[]> => {
	const m = (lat - LAT0) / MLAT;
	if (m < 1000) return [way("highway", "Holloway Road", 12), way("highway", "Furthest Street", 40)];
	if (m < 3000) return [way("highway", "Midway Road", 8)];
	return [way("highway", "Wembley Park Drive", 15)];
};
/** Nothing named nearby, and a non-highway that must not be picked. */
const unnamedWays = async (_lat: number, _lon: number): Promise<NearbyWay[]> => [
	way("highway", undefined, 5),
	way("railway", "Metropolitan Line", 3),
];
/** An EMPTY name is falsy in the TS filter, so the nearer way is skipped and
 *  the farther named one wins — not the other way round. */
const emptyNameWays = async (_lat: number, _lon: number): Promise<NearbyWay[]> => [
	way("highway", "", 2),
	way("highway", "Named Street", 30),
];
const noWays = async (_lat: number, _lon: number): Promise<NearbyWay[]> => [];

const seg = (o: Record<string, unknown>) =>
	({
		startTs: 0,
		endTs: 0,
		mode: "walking",
		confidence: 0.8,
		confidenceMargin: 2,
		avgSpeed: 4,
		maxSpeed: 6,
		linearity: 0.5,
		pointCount: 10,
		...o,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	}) as any;

/** The host: a "walk" spanning walk -> tube -> walk. */
const HOST = seg({ startTs: 500, endTs: 2100, mode: "walking", wayName: "Composed Across Everything" });

/** Good fixes bracketing the dark stretch, plus two inside each walk so
 *  `sideWayName` has something to vote on. */
const GOOD: CoarseFix[] = [
	fix(500, 0, 10),
	fix(700, 100, 12),
	fix(900, 200, 15), // last good before the run
	fix(1700, 3900, 15), // first good after
	fix(1900, 4000, 12),
	fix(2100, 4050, null), // a null accuracy is a GOOD fix
];
/** Coarse fixes inside the dark stretch: span 1000..1600 = 600 s. */
const COARSE: CoarseFix[] = [
	fix(1000, 200, 200),
	fix(1200, 1500, 250),
	fix(1400, 3200, 250),
	fix(1600, 3800, 200),
];

/** The Kalman track `sideWayName` samples. `ed5471e`..`8655be3` changed the
 *  pass to name a carve remainder from the SMOOTHED points by the enricher's
 *  own rule, rather than from the raw good fixes by a second local rule — so
 *  the harness has to supply a track, and the labels it produces are a
 *  different question from the ones the pre-`8655be3` guards pinned.
 *
 *  Derived from the case's own fixes so every case gets a track covering its
 *  own span: the pace is what `refineMode` reads, and a walk handed a train's
 *  speed is refined as one. */
const points = (fixes: CoarseFix[]): FilteredPoint[] =>
	[...fixes]
		.sort((a, b) => a.ts - b.ts)
		.map((f) => ({ ts: f.ts, lat: f.lat, lon: f.lon, speed_kmh: 4 }) as FilteredPoint);

/** The mirror knows no line's stops, so `lineCannotServe` asserts nothing and
 *  the membership veto never fires. That is the honest default here: these
 *  cases are about the window and the labels, and an empty list is "unknown",
 *  NOT "serves nothing" (`line-membership.ts`). A case that wants to pin the
 *  veto has to supply its own. */
const servedNothing = async (_line: string): Promise<{ name: string }[]> => [];

type Case = {
	segments?: ReturnType<typeof seg>[];
	fixes?: CoarseFix[];
	points?: FilteredPoint[];
	lines?: typeof oneLine;
	ways?: typeof ways;
	served?: typeof servedNothing;
};

const CASES: Record<string, Case> = {
	// The whole pass, happy path: host splits into walk / train / walk, the two
	// side pieces get their OWN way labels, and the train carries the triple.
	split: {},
	// TWO legs: the reason string switches to the interchange form and a
	// boundary timestamp is minted between the legs. Needs a GOOD fix
	// surfaced mid-run (the platform at the changeover) — without one there
	// are no interchange candidates and the split is never attempted.
	interchange: {
		lines: changeLines,
		fixes: [
			fix(500, 0, 10),
			fix(900, 200, 15),
			fix(1250, 2000, 20), // recovered on the interchange platform
			fix(1700, 3900, 15),
			fix(2100, 4050, null),
			fix(1000, 200, 200),
			fix(1100, 800, 250),
			fix(1400, 3200, 250),
			fix(1600, 3800, 200),
		],
	},

	// --- isUndergroundSignal, the leaf ---
	// TOTAL-LOSS fixes count for the WINDOW but not for snapping. The two
	// COARSE fixes here span only 100 s — under MIN_RUN_DURATION_S, so on
	// their own they are not a run at all. The kilometre-scale fixes at 1350
	// and 1600 carry the dark window out to 600 s, and reconstruction then
	// re-filters to the two coarse fixes to snap the line. Restoring the
	// COARSE_ACCURACY_MAX_M upper bound to isUndergroundSignal loses the ride.
	deepTube: {
		fixes: [...GOOD, fix(1000, 200, 200), fix(1100, 800, 250), fix(1350, 2400, 5000), fix(1600, 3800, 9999)],
	},
	// The lower edge, isolated. 100 exactly is a signal, so the run has two
	// fixes 300 s apart and qualifies; 99 is a GOOD fix, leaving one dark
	// fix and no run at all.
	signalAtLowerEdge: { fixes: [...GOOD, fix(1000, 200, 100), fix(1300, 2400, 250)] },
	signalJustUnderEdge: { fixes: [...GOOD, fix(1000, 200, 99), fix(1300, 2400, 250)] },
	// A null accuracy is never a signal (and IS a good fix).
	nullAccuracyNotSignal: { fixes: [...GOOD, fix(1000, 200, null), fix(1300, 2400, 250)] },

	// --- run selection ---
	// A gap ABOVE MAX_COARSE_GAP_S splits the run in two; neither half clears
	// MIN_RUN_DURATION_S, so nothing is carved out.
	gapSplitsRun: { fixes: [...GOOD, fix(1000, 200, 200), fix(1100, 800, 250), fix(1500, 3400, 250), fix(1600, 3800, 200)] },
	// Exactly 300 s apart: still ONE run (the test is `<=`).
	gapExactlyAtBar: { fixes: [...GOOD, fix(1000, 200, 200), fix(1300, 2400, 250), fix(1600, 3800, 200)] },
	// Span exactly 180 s clears the bar (`>=`); 179 does not.
	spanAtBar: { fixes: [...GOOD, fix(1000, 200, 200), fix(1180, 3800, 200)] },
	spanJustUnderBar: { fixes: [...GOOD, fix(1000, 200, 200), fix(1179, 3800, 200)] },
	// A single coarse fix is below MIN_COARSE_FIXES.
	oneCoarseFix: { fixes: [...GOOD, fix(1000, 200, 200)] },
	// A gap above MAX_COARSE_GAP_S but inside MAX_INTERCHANGE_GAP_S, whose ends
	// are 2.5 km apart — so displacement alone says "the ride carried on" and
	// bridges it. What the two cases differ in is what the phone reported IN the
	// gap. Travelling (600 m of drift, the 2026-07-01 walk out of the station)
	// splits, so only the first stretch is a run and the window is short; a dwell
	// (100 m, the 2026-07-02 change of trains) joins, and the window spans both.
	heardTravellingSplitsRun: {
		fixes: [
			fix(500, 0, 10),
			fix(900, 200, 15),
			fix(1000, 200, 200),
			fix(1200, 900, 250), // run A: span 200, qualifies alone
			fix(1300, 1200, 12),
			fix(1450, 1800, 10), // heard MOVING between the two
			fix(1600, 3400, 250),
			fix(1700, 3800, 200), // run B: span 100, does not
			fix(1900, 4000, 12),
			fix(2100, 4050, null),
		],
	},
	dwellJoinsRun: {
		fixes: [
			fix(500, 0, 10),
			fix(900, 200, 15),
			fix(1000, 200, 200),
			fix(1200, 900, 250),
			fix(1300, 2000, 12),
			fix(1450, 2100, 10), // heard, but going nowhere
			fix(1600, 3400, 250),
			fix(1700, 3800, 200),
			fix(1900, 4000, 12),
			fix(2100, 4050, null),
		],
	},

	// TWO qualifying runs, separated by a gap above MAX_COARSE_GAP_S. The
	// LONGEST-spanning one wins, not the first — and the two produce
	// different train windows, so the choice is visible in the output.
	longestRunWins: {
		fixes: [
			...GOOD,
			fix(1000, 200, 200),
			fix(1200, 300, 250), // run A: span 200, first
			fix(1600, 3400, 250),
			fix(1850, 3800, 200), // run B: span 250 — wins
		],
	},
	// Run SELECTION, kept honest. `longestRunWins` above no longer separates its
	// two runs at all — displacement joins them into one — so what pins the
	// longest-span choice has to be a pair the bridging genuinely refuses. Held
	// apart here by the travel test: run B spans 300 s to run A's 200, and wins,
	// which is visible because the two board and alight at different stations.
	longestRunWinsAcrossTravel: {
		fixes: [
			fix(500, 0, 10),
			fix(900, 200, 15),
			fix(1000, 200, 200),
			fix(1200, 900, 250), // run A: span 200
			fix(1300, 1200, 12),
			fix(1450, 1800, 10), // heard moving: the runs stay apart
			fix(1600, 3100, 250),
			fix(1900, 3800, 200), // run B: span 300 — wins
			fix(1950, 4000, 12),
			fix(2100, 4050, null),
		],
	},

	// --- bracketing good fixes ---
	// No good fix at or before the run start: nothing to board from.
	noBoardingFix: { fixes: [fix(1700, 3900, 15), fix(1900, 4000, 12), ...COARSE] },
	noAlightingFix: { fixes: [fix(500, 0, 10), fix(900, 200, 15), ...COARSE] },
	// No line resolves: reconstruction yields no legs, host passes through.
	noLegs: { lines: noLines },

	// --- host filtering ---
	stationaryHost: { segments: [seg({ ...HOST, mode: "stationary" })] },
	// An already-annotated rail run (wayName carries the arrow) is left alone.
	alreadyRail: { segments: [seg({ ...HOST, mode: "train", wayName: "A → B · Victoria Line" })] },
	// A train segment WITHOUT the arrow is NOT already-rail, so it is processed.
	trainWithoutArrow: { segments: [seg({ ...HOST, mode: "train", wayName: "Some Street" })] },

	// --- side-piece trimming (MIN_SIDE_DURATION_S) ---
	// Host starts 60 s before the boarding fix: exactly at the bar, so the pre
	// piece is KEPT (`>=`). At 59 it is absorbed into the train.
	preSideAtBar: { segments: [seg({ ...HOST, startTs: 840 })] },
	preSideJustUnderBar: { segments: [seg({ ...HOST, startTs: 841 })] },
	postSideAtBar: { segments: [seg({ ...HOST, endTs: 1760 })] },
	postSideJustUnderBar: { segments: [seg({ ...HOST, endTs: 1759 })] },

	// --- sideWayName ---
	// No named highway near the side pieces: honest blank, not a leaked label.
	unnamedSideWays: { ways: unnamedWays },
	noSideWays: { ways: noWays },
	emptyNameSideWays: { ways: emptyNameWays },
	// THE SAMPLE COUNT matters only when the samples disagree. Here the pre-walk
	// piece has its FIRST fix in one way-zone and its other two in another, so
	// sampling one fix and sampling three give different labels.
	sampleMajorityBeatsFirst: {
		fixes: [
			fix(500, 200, 10), // zone A — the only fix sampled if sampleCount were 1
			fix(700, 1200, 12), // zone B
			fix(900, 1500, 15), // zone B — majority
			fix(1700, 3900, 15),
			fix(1900, 4000, 12),
			fix(2100, 4050, null),
			...COARSE,
		],
	},
	// A THREE-WAY TIE on one vote each: the FIRST-inserted name wins, because
	// the TS sorts the entries descending with a stable sort and takes the head.
	// The LAST pre-piece fix must stay near the boarding station, or both ends
	// of the run resolve to the same station and it is refused before any of
	// this is reached.
	sideWayVoteTie: {
		fixes: [
			fix(500, 1500, 10), // zone B: Midway Road — first inserted, so it wins
			fix(700, 3500, 12), // zone C: Wembley Park Drive
			fix(900, 200, 15), // zone A: Holloway Road
			fix(1700, 3900, 15),
			fix(1900, 4000, 12),
			fix(2100, 4050, null),
			...COARSE,
		],
	},

	// --- boundary conditions the first probe pass left unpinned ---
	// A GOOD fix at exactly the run's first timestamp: the boarding scan is
	// `<=`, so it — not the earlier one — is the boarding fix, which moves the
	// train window.
	goodFixExactlyAtRunStart: { fixes: [...GOOD, fix(1000, 250, 15), ...COARSE] },
	// A dark fix at exactly the host's end: the host window is INCLUSIVE both
	// ends, so it belongs to the run. Excluding it drops the run below the
	// span bar.
	darkFixExactlyAtHostEnd: {
		segments: [seg({ ...HOST, endTs: 1300 })],
		fixes: [fix(500, 0, 10), fix(900, 200, 15), fix(1900, 4000, 12), fix(1000, 200, 200), fix(1300, 2400, 250)],
	},
	// A NON-train segment whose label happens to carry an arrow is NOT an
	// already-annotated rail run — the mode test is load-bearing.
	walkingHostWithArrowLabel: { segments: [seg({ ...HOST, wayName: "A → B" })] },
	// The already-rail test is on the ARROW alone: a label with the arrow and
	// no line separator still counts...
	alreadyRailNoLineSep: { segments: [seg({ ...HOST, mode: "train", wayName: "A → B" })] },
	// ...and a label with the line separator but no arrow does NOT.
	trainWithDotButNoArrow: { segments: [seg({ ...HOST, mode: "train", wayName: "Some · Street" })] },
	// A host carrying a place: the train legs must CLEAR it (the ride is not at
	// the place), while the side walks inherit it through the spread.
	hostWithPlace: { segments: [seg({ ...HOST, place: "Home", city: "London" })] },

	// Several hosts in one call, including ones that pass through untouched.
	multipleHosts: {
		segments: [
			seg({ startTs: 0, endTs: 400, mode: "stationary", place: "Home" }),
			HOST,
			seg({ startTs: 2100, endTs: 2500, mode: "walking", wayName: "After Street" }),
		],
	},
	empty: { segments: [], fixes: [] },
};

/** The output fields this pass decides. */
const view = (segs: unknown[]) =>
	segs.map((s) => {
		const x = s as Record<string, unknown>;
		return {
			startTs: x.startTs,
			endTs: x.endTs,
			mode: x.mode,
			refinedMode: x.refinedMode ?? null,
			wayName: x.wayName ?? null,
			place: x.place ?? null,
			city: x.city ?? null,
			avgSpeed: x.avgSpeed ?? null,
			maxSpeed: x.maxSpeed ?? null,
			confidence: x.confidence ?? null,
			confidenceMargin: x.confidenceMargin ?? null,
			linearity: x.linearity ?? null,
			pointCount: x.pointCount ?? null,
			refinedReason: x.refinedReason ?? null,
		};
	});

for (const [name, c] of Object.entries(CASES)) {
	const r = await annotateUndergroundRuns(
		c.segments ?? [HOST],
		c.fixes ?? [...GOOD, ...COARSE],
		c.points ?? points(c.fixes ?? [...GOOD, ...COARSE]),
		stations,
		c.lines ?? oneLine,
		c.ways ?? ways,
		c.served ?? servedNothing,
	);
	show(`annotate.${name}`, view(r));
}
