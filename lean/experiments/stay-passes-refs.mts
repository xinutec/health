/**
 * V8 reference values for the first slice of the ORCHESTRATION tier: the pure
 * array transforms in `src/geo/passes/moving.ts` and `src/geo/passes/stays.ts`.
 *
 *   moving.ts — `composeWayName`, `mergeAdjacentMoving`
 *   stays.ts  — `mergeAdjacentStays`, `absorbIntraPlaceWalk`,
 *               `absorbFarFocusPlacePhantom`, `attachStayCentroids`,
 *               `planJitterStayRuns`
 *
 * These are the passes that REWRITE the segment list rather than decide about
 * one segment, so unlike the leaves ported so far the output records are the
 * answer. Everything below is exported and pure; the async OSM arms of both
 * modules (`consolidateJitterStays`, `mapLimit`) stay shell.
 *
 * All coordinates are built from a metres-offset frame anchored at
 * (51.52, -0.13) so a case can say "78 m east" and mean it; the frame constants
 * are dumped too, because the Lean guards rebuild coordinates the same way and
 * must agree bit-for-bit before any behaviour is compared.
 *
 * Run: nix develop /Users/pippijn/Code/health --command npx tsx lean/experiments/stay-passes-refs.mts
 */

import type { EnrichedSegment } from "../../src/geo/enriched-segment.js";
import { composeWayName, mergeAdjacentMoving } from "../../src/geo/passes/moving.js";
import {
	absorbFarFocusPlacePhantom,
	absorbIntraPlaceWalk,
	attachStayCentroids,
	mergeAdjacentStays,
	planJitterStayRuns,
} from "../../src/geo/passes/stays.js";
import type { RefinedKind, TransportMode } from "../../src/geo/segments.js";

const show = (label: string, v: unknown): void => {
	// eslint-disable-next-line no-console
	console.log(`${label}: ${JSON.stringify(v)}`);
};

/* ------------------------------------------------------------------ */
/* Coordinate frame                                                    */
/* ------------------------------------------------------------------ */

const LAT0 = 51.52;
const LON0 = -0.13;
const MLAT = 1 / 111320;
const MLON = 1 / (111320 * Math.cos((LAT0 * Math.PI) / 180));
/** `n` metres north, `e` metres east of the frame origin. */
const pt = (n: number, e: number): { lat: number; lon: number } => ({ lat: LAT0 + n * MLAT, lon: LON0 + e * MLON });

show("frame.mlat", MLAT);
show("frame.mlon", MLON);
show("frame.pt(0,0)", pt(0, 0));
show("frame.pt(100,0)", pt(100, 0));
show("frame.pt(0,100)", pt(0, 100));

/**
 * Coordinates a hair either side of each distance threshold, under
 * `haversineMeters` — the metric every gate below actually uses.
 *
 * Two reasons these are not just `pt(0, 75)`:
 *
 * 1. The `pt()` frame is equirectangular (111320 m/deg) and haversine is not
 *    (R = 6371000 ⇒ 111194.9 m/deg), so "120 m east" in the frame is 119.86
 *    haversine metres — a boundary case built that way silently sits on the
 *    WRONG side of a 120 m bar and pins nothing.
 * 2. A point sitting EXACTLY on the bar would be worse than useless. Distances
 *    here are ULP-close, not bit-identical (atan2/sin/cos), so a knife-edge
 *    input can land on opposite sides in V8 and Lean. An earlier draft used
 *    exact-hit coordinates found by search and the 75 m one diverged by one ULP
 *    on the very first Lean build.
 *
 * So each bar gets a pair ±1e-6 m either side: ~10^8 ULPs clear of any libm
 * disagreement, while still pinning the constant to six decimal places.
 */
const UNDER_75 = { lat: 51.52067449119544, lon: LON0 };
const OVER_75 = { lat: 51.52067449121344, lon: LON0 };
const UNDER_90 = { lat: 51.52080938943633, lon: LON0 };
const OVER_90 = { lat: 51.52080938945433, lon: LON0 };
const UNDER_120 = { lat: 51.521079185918104, lon: LON0 };
const OVER_120 = { lat: 51.5210791859361, lon: LON0 };

/* ------------------------------------------------------------------ */
/* Segment builder                                                     */
/* ------------------------------------------------------------------ */

function seg(
	startTs: number,
	endTs: number,
	mode: TransportMode,
	extra: Partial<EnrichedSegment> = {},
): EnrichedSegment {
	return {
		startTs,
		endTs,
		mode,
		confidence: 0.8,
		confidenceMargin: 2,
		avgSpeed: 0,
		maxSpeed: 0,
		linearity: 0.5,
		pointCount: 10,
		...extra,
	};
}

/* ------------------------------------------------------------------ */
/* 1. composeWayName                                                   */
/* ------------------------------------------------------------------ */

const WAY_CASES: Record<string, Array<[string, number]>> = {
	// A single contributor comes back as itself.
	single: [["Euston Road", 600]],
	// Two contributors, both over the 15% coverage floor, joined while the
	// running label stays inside the 30-char budget.
	twoShort: [
		["Gower St", 600],
		["Store St", 300],
	],
	// The second name would push past 30 chars, so the loop BREAKS and the
	// label stays at one name — it does not skip ahead to a shorter third.
	budgetBreaksEarly: [
		["Tottenham Court Road", 600],
		["Great Russell Street", 500],
		["Bury Pl", 400],
	],
	// Ranked by duration DESC, so insertion order is irrelevant.
	ranksByDuration: [
		["B St", 100],
		["A St", 900],
	],
	// Under 15% coverage: dropped even though it is a real contributor.
	belowCoverage: [
		["Main St", 900],
		["Alley", 100],
	],
	// Exactly at the floor (>= 0.15) survives.
	exactlyAtCoverage: [
		["Main St", 850],
		["Alley", 150],
	],
	// At most three names, and the cap is what excludes the fourth — all four
	// clear the 15% coverage floor here, so nothing else can be doing it.
	capsAtThree: [
		["A", 250],
		["B", 250],
		["C", 250],
		["D", 250],
	],
	// The joined label is EXACTLY 30 characters, so the `> 30` budget accepts it…
	budgetExactlyAtBar: [
		["Abbey Road", 600],
		["Seventeen Chars Xx", 500],
	],
	// …and one character more breaks the join, leaving the leader alone.
	budgetOneOver: [
		["Abbey Road", 600],
		["Nineteen Chars Xxxx", 500],
	],
	// Every contribution zero → total 0 → null (not "").
	allZero: [["Nowhere", 0]],
	empty: [],
};
for (const [name, entries] of Object.entries(WAY_CASES)) {
	show(`composeWayName.${name}`, composeWayName(new Map(entries)));
}

/* ------------------------------------------------------------------ */
/* 2. mergeAdjacentMoving                                              */
/* ------------------------------------------------------------------ */

function movingCases(): Record<string, EnrichedSegment[]> {
	return {
		// Two walks 60 s apart merge; the numeric fields become point-count
		// weighted means, each rounded to its own precision (speed 1 dp,
		// linearity / confidence / margin 2 dp).
		basicMerge: [
			seg(0, 600, "walking", {
				pointCount: 10,
				avgSpeed: 4.7,
				maxSpeed: 6.1,
				linearity: 0.62,
				confidence: 0.81,
				confidenceMargin: 2.4,
				wayName: "Gower St",
			}),
			seg(660, 1200, "walking", {
				pointCount: 30,
				avgSpeed: 5.3,
				maxSpeed: 7.9,
				linearity: 0.74,
				confidence: 0.93,
				confidenceMargin: 3.8,
				wayName: "Store St",
			}),
		],
		// 181 s is past the 3-minute bar.
		gapTooBig: [seg(0, 600, "walking"), seg(781, 1200, "walking")],
		// 180 s exactly still merges (the test is `<=`).
		gapExactlyAtBar: [seg(0, 600, "walking"), seg(780, 1200, "walking")],
		// Stationary never merges, even with itself — that is `mergeAdjacentStays`'
		// job and it has different rules.
		stationaryNeverMerges: [seg(0, 600, "stationary"), seg(660, 1200, "stationary")],
		// Different modes do not merge.
		differentModes: [seg(0, 600, "walking"), seg(660, 1200, "cycling")],
		// effectiveMode: a leg refined to walking merges with a walking leg.
		refinedModeMatches: [seg(0, 600, "driving", { refinedMode: "walking" }), seg(660, 1200, "walking")],
		// Two DIFFERENT defined cities block the merge — a real boundary crossing.
		cityConflict: [seg(0, 600, "walking", { city: "London" }), seg(660, 1200, "walking", { city: "Brent" })],
		// One tagged, one not: merge allowed, but the merged city is dropped,
		// because the span no longer corresponds to a single city.
		cityOneSided: [seg(0, 600, "walking", { city: "London" }), seg(660, 1200, "walking")],
		// Both agree: the city survives.
		citySame: [seg(0, 600, "walking", { city: "London" }), seg(660, 1200, "walking", { city: "London" })],
		// The composite way name is built from DURATION contributions, so the
		// longer leg leads regardless of order in the list.
		compositeWayName: [
			seg(0, 120, "walking", { wayName: "Short St" }),
			seg(120, 1200, "walking", { wayName: "Long Road" }),
		],
		// A single contributor short-circuits: the existing wayName is kept.
		singleContributor: [seg(0, 600, "walking", { wayName: "Gower St" }), seg(660, 1200, "walking")],
		// Three-way run merges left to right in one pass.
		threeWayRun: [
			seg(0, 600, "walking", { pointCount: 10, avgSpeed: 4, maxSpeed: 5 }),
			seg(600, 1200, "walking", { pointCount: 10, avgSpeed: 5, maxSpeed: 6 }),
			seg(1200, 1800, "walking", { pointCount: 20, avgSpeed: 6, maxSpeed: 9 }),
		],
		empty: [],
	};
}

for (const [name, input] of Object.entries(movingCases())) {
	show(
		`moving.${name}`,
		mergeAdjacentMoving(input).map((s) => ({
			startTs: s.startTs,
			endTs: s.endTs,
			mode: s.mode,
			pointCount: s.pointCount,
			avgSpeed: s.avgSpeed,
			maxSpeed: s.maxSpeed,
			linearity: s.linearity,
			confidence: s.confidence,
			confidenceMargin: s.confidenceMargin,
			city: s.city ?? null,
			wayName: s.wayName ?? null,
		})),
	);
}

/* ------------------------------------------------------------------ */
/* 3. mergeAdjacentStays                                               */
/* ------------------------------------------------------------------ */

const stepsAt = (from: number, to: number, perMin: number): Array<{ ts: number; steps: number }> => {
	const out: Array<{ ts: number; steps: number }> = [];
	for (let ts = from; ts < to; ts += 60) out.push({ ts, steps: perMin });
	return out;
};

function stayMergeCases(): Record<string, { segs: EnrichedSegment[]; steps: Array<{ ts: number; steps: number }> }> {
	const home = (a: number, b: number, extra: Partial<EnrichedSegment> = {}) =>
		seg(a, b, "stationary", { place: "Home", ...extra });
	return {
		// Same place, back to back: collapse.
		samePlaceAdjacent: { segs: [home(0, 600), home(660, 1200)], steps: [] },
		// 301 s apart is past the 5-minute bar.
		gapTooBig: { segs: [home(0, 600), home(901, 1200)], steps: [] },
		// 300 s exactly still merges.
		gapExactlyAtBar: { segs: [home(0, 600), home(900, 1200)], steps: [] },
		// Different places never merge.
		differentPlaces: { segs: [home(0, 600), seg(660, 1200, "stationary", { place: "Work" })], steps: [] },
		// A stay with NO place does not merge — `prev.place` must be truthy.
		noPlace: { segs: [seg(0, 600, "stationary"), seg(660, 1200, "stationary")], steps: [] },
		// effectiveMode: a walk that biometricCorrect reclassified to stationary
		// still merges with its same-place neighbour.
		refinedToStationary: {
			segs: [home(0, 600), seg(660, 1200, "walking", { refinedMode: "stationary", place: "Home" })],
			steps: [],
		},
		// BRIDGE shape 1 — a brief multipath phantom move between two Home stays:
		// ≤ 10 min, avg ≤ 2 km/h, cadence below 20/min. The middle is dropped and
		// its points folded into the surviving stay.
		bridgePhantomMove: {
			segs: [home(0, 600), seg(600, 900, "walking", { avgSpeed: 1.5, pointCount: 4 }), home(900, 1800)],
			steps: stepsAt(600, 900, 5),
		},
		// Same shape but the middle STEPS like a real errand (60/min) — the #329
		// guard. Not bridged.
		bridgeVetoedByCadence: {
			segs: [home(0, 600), seg(600, 900, "walking", { avgSpeed: 1.5, pointCount: 4 }), home(900, 1800)],
			steps: stepsAt(600, 900, 60),
		},
		// Too fast to be multipath.
		bridgeVetoedBySpeed: {
			segs: [home(0, 600), seg(600, 900, "walking", { avgSpeed: 2.5, pointCount: 4 }), home(900, 1800)],
			steps: [],
		},
		// Too long (601 s > 600 s).
		bridgeVetoedByDuration: {
			segs: [home(0, 600), seg(600, 1201, "walking", { avgSpeed: 1.5, pointCount: 4 }), home(1201, 1800)],
			steps: [],
		},
		// The duration test is `<=`, so exactly 600 s bridges.
		bridgeDurationExactlyAtBar: {
			segs: [home(0, 600), seg(600, 1200, "walking", { avgSpeed: 1.5, pointCount: 4 }), home(1200, 1800)],
			steps: [],
		},
		// BRIDGE shape 2 — a no-GPS blackout of ANY length, bracketed by the same
		// place. Place identity outranks the speculative split, so the duration
		// and speed caps do not apply.
		bridgeBlackout: {
			segs: [home(0, 600), seg(600, 3600, "unknown", { pointCount: 0, avgSpeed: 40 }), home(3600, 7200)],
			steps: [],
		},
		// An `unknown` middle WITH fixes is not a blackout; it fails the speed cap
		// too, so nothing bridges.
		blackoutNeedsZeroPoints: {
			segs: [home(0, 600), seg(600, 3600, "unknown", { pointCount: 5, avgSpeed: 40 }), home(3600, 7200)],
			steps: [],
		},
		// The bridge tests the middle's RAW mode, not effectiveMode, so a middle
		// biometricCorrect reclassified to stationary still bridges (2026-05-22).
		bridgeMiddleRefinedToStationary: {
			segs: [
				home(0, 600),
				seg(600, 900, "walking", { refinedMode: "stationary", avgSpeed: 1.5, pointCount: 4 }),
				home(900, 1800),
			],
			steps: [],
		},
		// Brackets at DIFFERENT places do not bridge.
		bridgeDifferentBrackets: {
			segs: [
				home(0, 600),
				seg(600, 900, "walking", { avgSpeed: 1.5, pointCount: 4 }),
				seg(900, 1800, "stationary", { place: "Work" }),
			],
			steps: [],
		},
		empty: { segs: [], steps: [] },
	};
}

for (const [name, c] of Object.entries(stayMergeCases())) {
	show(
		`stayMerge.${name}`,
		mergeAdjacentStays(c.segs, c.steps).map((s) => ({
			startTs: s.startTs,
			endTs: s.endTs,
			mode: s.mode,
			refinedMode: s.refinedMode ?? null,
			place: s.place ?? null,
			pointCount: s.pointCount,
		})),
	);
}

/* ------------------------------------------------------------------ */
/* 4. attachStayCentroids                                              */
/* ------------------------------------------------------------------ */

const CENTROID_POINTS = [
	{ ts: 100, ...pt(0, 0) },
	{ ts: 200, ...pt(20, 0) },
	{ ts: 300, ...pt(0, 40) },
	// Exactly on the closing boundary — the window is INCLUSIVE both ends, so
	// this one counts for a segment ending at 400.
	{ ts: 400, ...pt(40, 40) },
	{ ts: 500, ...pt(1000, 1000) },
];

show(
	"attachCentroids.stationary",
	attachStayCentroids([seg(100, 400, "stationary")], CENTROID_POINTS).map((s) => ({
		centroidLat: s.centroidLat ?? null,
		centroidLon: s.centroidLon ?? null,
	})),
);
show(
	"attachCentroids.movingUntouched",
	attachStayCentroids([seg(100, 400, "walking")], CENTROID_POINTS).map((s) => ({
		centroidLat: s.centroidLat ?? null,
		centroidLon: s.centroidLon ?? null,
	})),
);
show(
	"attachCentroids.noFixes",
	attachStayCentroids([seg(5000, 6000, "stationary")], CENTROID_POINTS).map((s) => ({
		centroidLat: s.centroidLat ?? null,
		centroidLon: s.centroidLon ?? null,
	})),
);
show(
	"attachCentroids.refinedToStationary",
	attachStayCentroids([seg(100, 400, "walking", { refinedMode: "stationary" })], CENTROID_POINTS).map((s) => ({
		centroidLat: s.centroidLat ?? null,
		centroidLon: s.centroidLon ?? null,
	})),
);

/* ------------------------------------------------------------------ */
/* 5. absorbIntraPlaceWalk                                             */
/* ------------------------------------------------------------------ */

/** Fixes inside the footprint (≤ 120 m from the bracketing centroid). */
const INSIDE_FIXES = [
	{ ts: 650, ...pt(0, 30), speed_kmh: 3, bearing: 0 },
	{ ts: 750, ...pt(0, 80), speed_kmh: 3, bearing: 0 },
];
/** …and one that strays past it. */
const OUTSIDE_FIXES = [
	{ ts: 650, ...pt(0, 30), speed_kmh: 3, bearing: 0 },
	{ ts: 750, ...pt(0, 200), speed_kmh: 3, bearing: 0 },
];

function intraPlaceCase(
	walk: Partial<EnrichedSegment>,
	prevC: { lat: number; lon: number },
	nextC: { lat: number; lon: number },
	// NOT a defaulted parameter: passing `undefined` to one re-triggers the
	// default, which silently turned the "no place" case into a "Work" case.
	place: string | null = "Work",
): EnrichedSegment[] {
	const placeOrNone = place ?? undefined;
	return [
		seg(0, 600, "stationary", { place: placeOrNone, city: "London", centroidLat: prevC.lat, centroidLon: prevC.lon }),
		seg(600, 900, "walking", walk),
		seg(900, 1800, "stationary", { place: placeOrNone, centroidLat: nextC.lat, centroidLon: nextC.lon }),
	];
}

const INTRA_CASES: Record<string, { segs: EnrichedSegment[]; fixes: typeof INSIDE_FIXES }> = {
	// The 2026-06-17 case: a 5-min kitchen run between two Work stays 2 m apart.
	absorbed: { segs: intraPlaceCase({}, pt(0, 0), pt(2, 0)), fixes: INSIDE_FIXES },
	// The walk leaves the footprint — a real excursion, kept as a leg.
	outsideFootprint: { segs: intraPlaceCase({}, pt(0, 0), pt(2, 0)), fixes: OUTSIDE_FIXES },
	// The two bracketing stays are not the same SPOT — 200 m apart, so the user
	// really did move between two buildings.
	bracketsTooFarApart: { segs: intraPlaceCase({}, pt(0, 0), pt(0, 200)), fixes: INSIDE_FIXES },
	// The same-spot bar, from both sides: `> 75` rejects, so just under is still
	// the same spot and just over is not.
	bracketsJustUnderSameSpotBar: { segs: intraPlaceCase({}, pt(0, 0), UNDER_75), fixes: INSIDE_FIXES },
	bracketsJustOverSameSpotBar: { segs: intraPlaceCase({}, pt(0, 0), OVER_75), fixes: INSIDE_FIXES },
	// The footprint bar, from both sides: `> 120` rejects.
	fixJustUnderFootprintBar: {
		segs: intraPlaceCase({}, pt(0, 0), pt(2, 0)),
		fixes: [{ ts: 650, ...UNDER_120, speed_kmh: 3, bearing: 0 }],
	},
	fixJustOverFootprintBar: {
		segs: intraPlaceCase({}, pt(0, 0), pt(2, 0)),
		fixes: [{ ts: 650, ...OVER_120, speed_kmh: 3, bearing: 0 }],
	},
	// Different place labels.
	differentPlaces: {
		segs: [
			seg(0, 600, "stationary", { place: "Work", centroidLat: pt(0, 0).lat, centroidLon: pt(0, 0).lon }),
			seg(600, 900, "walking"),
			seg(900, 1800, "stationary", { place: "Home", centroidLat: pt(2, 0).lat, centroidLon: pt(2, 0).lon }),
		],
		fixes: INSIDE_FIXES,
	},
	// No place on the brackets.
	noPlace: { segs: intraPlaceCase({}, pt(0, 0), pt(2, 0), null), fixes: INSIDE_FIXES },
	// Too long: 721 s > 12 min.
	tooLong: {
		segs: [
			seg(0, 600, "stationary", { place: "Work", centroidLat: pt(0, 0).lat, centroidLon: pt(0, 0).lon }),
			seg(600, 1321, "walking"),
			seg(1321, 2000, "stationary", { place: "Work", centroidLat: pt(2, 0).lat, centroidLon: pt(2, 0).lon }),
		],
		fixes: INSIDE_FIXES,
	},
	// No fixes in the walk's window at all — cannot show it stayed inside.
	noFixes: { segs: intraPlaceCase({}, pt(0, 0), pt(2, 0)), fixes: [] },
	// An existing refinedReason is appended to, not replaced.
	existingReason: { segs: intraPlaceCase({ refinedReason: "earlier note" }, pt(0, 0), pt(2, 0)), fixes: INSIDE_FIXES },
	// A wayName on the absorbed walk is CLEARED — it is no longer a leg.
	clearsWayName: { segs: intraPlaceCase({ wayName: "Corridor" }, pt(0, 0), pt(2, 0)), fixes: INSIDE_FIXES },
};

for (const [name, c] of Object.entries(INTRA_CASES)) {
	show(
		`intraPlace.${name}`,
		absorbIntraPlaceWalk(c.segs, c.fixes).map((s) => ({
			startTs: s.startTs,
			refinedMode: s.refinedMode ?? null,
			place: s.place ?? null,
			city: s.city ?? null,
			wayName: s.wayName ?? null,
			centroidLat: s.centroidLat ?? null,
			refinedReason: s.refinedReason ?? null,
		})),
	);
}

/* ------------------------------------------------------------------ */
/* 6. absorbFarFocusPlacePhantom                                       */
/* ------------------------------------------------------------------ */

/** Only `id` and the centroid are read by this pass; the rest of the mined
 *  projection is filled with neutral values so the harness builds the real
 *  shape rather than a cast. */
const FOCUS_PLACES = [
	{
		id: 7,
		centroidLat: pt(0, 0).lat,
		centroidLon: pt(0, 0).lon,
		displayName: null,
		sleepHours: 0,
		amenityLabel: null,
		uniqueDays: 0,
		hourProfile: null,
	},
];

function phantomCase(farOffsetM: number, nearOffsetM: number, between: EnrichedSegment[] = []): EnrichedSegment[] {
	return phantomAt(pt(0, farOffsetM), pt(0, nearOffsetM), between);
}

function phantomAt(
	far: { lat: number; lon: number },
	near: { lat: number; lon: number },
	between: EnrichedSegment[] = [],
): EnrichedSegment[] {
	return [
		seg(0, 600, "stationary", {
			place: "Work",
			focusPlaceId: 7,
			city: "London",
			centroidLat: far.lat,
			centroidLon: far.lon,
		}),
		seg(600, 900, "walking"),
		...between,
		seg(900, 1800, "stationary", {
			place: "Work",
			focusPlaceId: 7,
			centroidLat: near.lat,
			centroidLon: near.lon,
		}),
	];
}

const PHANTOM_CASES: Record<string, EnrichedSegment[]> = {
	// The 2026-07-10 case: a coffee stop ~190 m from the Work centroid, stamped
	// "Work", next to the real arrival at the centroid.
	swallowed: phantomCase(190, 5),
	// Well below the FAR bar (120 m) — borderline, deliberately left alone.
	farBelowBar: phantomCase(100, 5),
	// The FAR bar from both sides: `< 120` skips, so just over is far and just
	// under is not.
	farJustUnderBar: phantomAt(UNDER_120, pt(0, 5)),
	farJustOverBar: phantomAt(OVER_120, pt(0, 5)),
	// The near stay is 190 m out — well past the NEAR bar (90 m), so there is no
	// anchoring real visit and nothing is swallowed.
	nearTooFar: phantomCase(190, 190),
	// The NEAR bar from both sides: `> 90` skips, so just under is AT the place.
	nearJustUnderBar: phantomAt(pt(0, 190), UNDER_90),
	nearJustOverBar: phantomAt(pt(0, 190), OVER_90),
	// Another stay between them means this is a real round-trip, not one visit
	// split by movement.
	stayBetween: phantomCase(190, 5, [
		seg(700, 800, "stationary", { place: "Cafe", centroidLat: pt(0, 100).lat, centroidLon: pt(0, 100).lon }),
	]),
	// Different focus ids never pair.
	differentFocusIds: [
		seg(0, 600, "stationary", { place: "Work", focusPlaceId: 7, centroidLat: pt(0, 190).lat, centroidLon: pt(0, 190).lon }),
		seg(600, 900, "walking"),
		seg(900, 1800, "stationary", { place: "Gym", focusPlaceId: 8, centroidLat: pt(0, 5).lat, centroidLon: pt(0, 5).lon }),
	],
	// A stay whose distance cannot be computed (no centroid, no fixes) is never
	// a phantom and never a twin — conservative on missing data.
	missingCentroid: [
		seg(0, 600, "stationary", { place: "Work", focusPlaceId: 7 }),
		seg(600, 900, "walking"),
		seg(900, 1800, "stationary", { place: "Work", focusPlaceId: 7, centroidLat: pt(0, 5).lat, centroidLon: pt(0, 5).lon }),
	],
	empty: [],
};

for (const [name, segs] of Object.entries(PHANTOM_CASES)) {
	show(
		`phantom.${name}`,
		absorbFarFocusPlacePhantom(segs, FOCUS_PLACES, []).map((s) => ({
			startTs: s.startTs,
			refinedMode: s.refinedMode ?? null,
			place: s.place ?? null,
			focusPlaceId: s.focusPlaceId ?? null,
			city: s.city ?? null,
			refinedReason: s.refinedReason ?? null,
		})),
	);
}

/* ------------------------------------------------------------------ */
/* 7. planJitterStayRuns                                               */
/* ------------------------------------------------------------------ */

const JITTER: readonly RefinedKind[] = ["gps-jitter"];

function stay(a: number, b: number, offsetM: number, kinds?: readonly RefinedKind[]): EnrichedSegment {
	return stayAt(a, b, pt(0, offsetM), kinds);
}

function stayAt(
	a: number,
	b: number,
	c: { lat: number; lon: number },
	kinds?: readonly RefinedKind[],
): EnrichedSegment {
	return seg(a, b, "stationary", { centroidLat: c.lat, centroidLon: c.lon, refinedKinds: kinds });
}

const JITTER_CASES: Record<string, EnrichedSegment[]> = {
	// Three co-located fragments, one jitter-demoted: one run.
	basicRun: [stay(0, 600, 0, JITTER), stay(600, 1200, 20), stay(1200, 1800, 40)],
	// Same geometry with NO jitter tag anywhere: this pass must not touch a
	// normal multi-stay day.
	noJitterTag: [stay(0, 600, 0), stay(600, 1200, 20), stay(1200, 1800, 40)],
	// The third fragment is 200 m from the run ANCHOR, so the run ends at the
	// second — the comparison is against the ANCHOR, not the neighbour, and 50 m
	// + 150 m of drift would otherwise chain indefinitely.
	breaksAtRadius: [stay(0, 600, 0, JITTER), stay(600, 1200, 50), stay(1200, 1800, 200)],
	// The merge radius from both sides: `> 75` breaks the run.
	radiusJustUnderBar: [stay(0, 600, 0, JITTER), stayAt(600, 1200, UNDER_75)],
	radiusJustOverBar: [stay(0, 600, 0, JITTER), stayAt(600, 1200, OVER_75)],
	// A moving segment breaks the run.
	brokenByMove: [stay(0, 600, 0, JITTER), seg(600, 700, "walking"), stay(700, 1300, 20, JITTER)],
	// A stationary segment with no centroid also breaks it.
	brokenByMissingCentroid: [stay(0, 600, 0, JITTER), seg(600, 1200, "stationary"), stay(1200, 1800, 20, JITTER)],
	// A run of one is never emitted.
	singleton: [stay(0, 600, 0, JITTER)],
	// Two separate runs in one day.
	twoRuns: [
		stay(0, 600, 0, JITTER),
		stay(600, 1200, 20),
		seg(1200, 1300, "walking"),
		stay(1300, 1900, 1000, JITTER),
		stay(1900, 2500, 1020),
	],
	empty: [],
};

for (const [name, segs] of Object.entries(JITTER_CASES)) {
	show(`jitterRuns.${name}`, planJitterStayRuns(segs));
}
