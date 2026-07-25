/**
 * V8 reference values for the pure leaves of `src/geo/passes/rail-runs.ts`:
 *
 *   `findBoardingPlatformFix` — the two-phase backward walk that finds the
 *                               platform anchor before a ride
 *   `findRunAlightFix`        — the first sustained slow fix after a ride,
 *                               walking past mid-ride station dwells
 *   `expandTubeLineNames`     — one OSM line name → the physical lines it denotes
 *
 * `expandTubeLineNames` is the THIRD function in this repo that canonicalises a
 * tube line name, and it is not interchangeable with the other two.
 * `route-graph.ts parseLineMemberships` (already in Lean as
 * `Verified.Hsmm.RouteGraph.parseLineMemberships`) REQUIRES a " Line"/" Lines"
 * suffix and returns empty without one; this one falls back to the input. It
 * also strips a directional with a REGEX (`\s+(?:East|West|North|South)bound$`,
 * case-insensitive) rather than matching a fixed list of " Eastbound"-style
 * suffixes, so it strips "line   eastbound" and "Line EASTBOUND" too. The cases
 * below pin both differences.
 *
 * The two fix-finders are driven with tracks shaped so every arm fires: the
 * anchor-and-extend chain and each of its three break conditions, and each of
 * `findRunAlightFix`'s three fallbacks.
 *
 * Run: nix develop /Users/pippijn/Code/health --command npx tsx lean/experiments/rail-runs-refs.mts
 */

import type { FilteredPoint } from "../../src/geo/kalman.js";
import { expandTubeLineNames, findBoardingPlatformFix, findRunAlightFix } from "../../src/geo/passes/rail-runs.js";

const show = (label: string, v: unknown): void => {
	// eslint-disable-next-line no-console
	console.log(`${label}: ${JSON.stringify(v)}`);
};

const LAT0 = 51.52;
const LON0 = -0.13;
const MLAT = 1 / 111320;
/** `n` metres north of the frame origin. */
const north = (n: number): { lat: number; lon: number } => ({ lat: LAT0 + n * MLAT, lon: LON0 });

show("frame.mlat", MLAT);
show("frame.north(200)", north(200));

function fix(ts: number, speed_kmh: number, metresNorth = 0): FilteredPoint {
	return { ts, ...north(metresNorth), speed_kmh, bearing: 0 };
}

/* ------------------------------------------------------------------ */
/* 1. expandTubeLineNames                                              */
/* ------------------------------------------------------------------ */

const EXPAND_CASES = [
	// A plain singular name comes back as itself.
	"Metropolitan Line",
	// Directional suffixes are stripped…
	"Victoria Line Northbound",
	"Jubilee Line Eastbound",
	// …case-insensitively, and through arbitrary whitespace — the regex is
	// `\s+(?:East|West|North|South)bound$/i`, not a fixed suffix list.
	"Jubilee Line EASTBOUND",
	"Jubilee Line   Westbound",
	// Shared-track combined relations split on ", " and " and ", and each part
	// is re-suffixed. "&" is NOT a separator, so "Hammersmith & City" survives.
	"Circle, Hammersmith & City and Metropolitan Lines",
	"Circle and District Lines",
	// A combined name that splits into ONE part returns the BASE, suffix and all
	// — the `parts.length > 1` guard — so this is "Solo Lines", not "Solo Line".
	"Solo Lines",
	// Directional stripping happens BEFORE the combine match.
	"Circle and District Lines Southbound",
	// No " Lines" suffix: returned as-is, where `parseLineMemberships` would
	// return the EMPTY set for the same input.
	"Bakerloo",
	"",
	// Whitespace is trimmed after the directional strip.
	"  Central Line  ",
	// The `\s+` before the compass word is REQUIRED: a name that merely ENDS in
	// those letters keeps them. Without this pair the whitespace requirement is
	// unpinned.
	"Eastbound",
	"XEastbound",
	// `\s+and\s+` needs whitespace on BOTH sides, so the "and" inside "Grand"
	// is not a separator. Without this the requirement is unpinned — a
	// whitespace-optional rule would split it into "Gr" and "Union and Lee".
	"Grand Union and Lee Lines",
	// …and it tolerates runs of whitespace, which a literal " and " split would
	// not.
	"Circle  and  District Lines",
	// The TRAILING `\s+` matters too: "andDistrict" is one word, not a separator
	// followed by a name, so this does not split at all and keeps its suffix.
	"Circle andDistrict Lines",
];
for (const n of EXPAND_CASES) {
	show(`expand(${JSON.stringify(n)})`, expandTubeLineNames(n));
}

/* ------------------------------------------------------------------ */
/* 2. findBoardingPlatformFix                                          */
/* ------------------------------------------------------------------ */

/** The classifier's start of the ride; the search window is the 900 s before. */
const START_TS = 10_000;

const BOARDING_CASES: Record<string, FilteredPoint[]> = {
	// The platform-train-platform pattern: approach at walking pace, stand on
	// the platform, accelerate, then train speed. The anchor is the first
	// near-stationary fix walking BACK from the first fast one, then the chain
	// extends back through more near-stationary fixes. Earliest wins.
	classicPattern: [
		fix(START_TS - 800, 5, 0), // walking approach — stops the chain
		fix(START_TS - 700, 1, 200), // platform (earliest still)
		fix(START_TS - 640, 1, 205), // platform
		fix(START_TS - 580, 6, 210), // accelerating — walked PAST by phase one
		fix(START_TS - 520, 40, 400), // first train-speed fix
	],
	// No train-speed fix in the window: the classifier's start is already at or
	// before the first train signal, so there is nothing to extend.
	noFastFix: [fix(START_TS - 700, 1, 0), fix(START_TS - 600, 5, 50)],
	// A fast fix with no near-stationary fix before it: no anchor, so null.
	noStillFix: [fix(START_TS - 700, 10, 0), fix(START_TS - 600, 40, 300)],
	// The chain BREAKS on a time gap: 181 s between two platform fixes is more
	// than PLATFORM_MAX_GAP_S, so the earlier one is not part of this wait.
	chainBreaksOnGap: [
		fix(START_TS - 900, 1, 200),
		fix(START_TS - 719, 1, 205), // 181 s later
		fix(START_TS - 660, 1, 205),
		fix(START_TS - 600, 40, 400),
	],
	// 180 s exactly still chains.
	gapExactlyAtBar: [
		fix(START_TS - 900, 1, 200),
		fix(START_TS - 720, 1, 205),
		fix(START_TS - 660, 1, 205),
		fix(START_TS - 600, 40, 400),
	],
	// The chain BREAKS on spread: a near-stationary fix 200 m from the anchor is
	// a different place, not the same platform.
	chainBreaksOnSpread: [
		fix(START_TS - 800, 1, 0),
		fix(START_TS - 700, 1, 200),
		fix(START_TS - 640, 1, 205),
		fix(START_TS - 600, 40, 400),
	],
	// A single platform fix, no chain to extend.
	singlePlatformFix: [fix(START_TS - 700, 1, 200), fix(START_TS - 600, 40, 400)],
	// Fixes OUTSIDE the 900 s walkback window are not considered. 901 s before
	// the start is out; the in-window platform fix is the answer.
	outsideWalkback: [
		fix(START_TS - 901, 1, 200),
		fix(START_TS - 700, 1, 205),
		fix(START_TS - 600, 40, 400),
	],
	// A fix at EXACTLY the train bar (30 km/h) counts as train-in-motion, so it
	// is the one phase one walks back from.
	fastFixExactlyAtBar: [fix(START_TS - 700, 1, 200), fix(START_TS - 600, 30, 400)],
	// A fix at EXACTLY the still bar (3 km/h) is NOT near-stationary — the test
	// is strict — so there is no anchor and the answer is null.
	stillFixExactlyAtBar: [fix(START_TS - 700, 3, 200), fix(START_TS - 600, 40, 400)],
	// Just under it is.
	stillFixJustUnderBar: [fix(START_TS - 700, 2.9, 200), fix(START_TS - 600, 40, 400)],
	// The walkback WINDOW bound, isolated: two platform fixes 101 s apart, the
	// earlier one 901 s before the start. It is outside the window, so the
	// chain — which would otherwise reach it — starts at the later one.
	walkbackWindowExcludesReachableFix: [
		fix(START_TS - 901, 1, 200),
		fix(START_TS - 800, 1, 200),
		fix(START_TS - 600, 40, 400),
	],
	// Input order does not matter: the window is sorted by ts first.
	unsorted: [
		fix(START_TS - 600, 40, 400),
		fix(START_TS - 640, 1, 205),
		fix(START_TS - 700, 1, 200),
		fix(START_TS - 800, 5, 0),
	],
	empty: [],
};
for (const [name, points] of Object.entries(BOARDING_CASES)) {
	const r = findBoardingPlatformFix(points, START_TS);
	show(`boarding.${name}`, r === null ? null : { ts: r.ts, speed_kmh: r.speed_kmh });
}

/* ------------------------------------------------------------------ */
/* 3. findRunAlightFix                                                 */
/* ------------------------------------------------------------------ */

const END_TS = 20_000;

const ALIGHT_CASES: Record<string, FilteredPoint[]> = {
	// The preferred arm: the first fix under 5 km/h that is NOT followed within
	// 120 s by a return to transit speed.
	sustainedSlow: [fix(END_TS + 60, 40), fix(END_TS + 120, 2), fix(END_TS + 180, 2)],
	// A mid-ride station DWELL: slow, then back to transit speed inside 120 s.
	// The real alight is the later slow fix that stays slow.
	walksPastMidRideDwell: [
		fix(END_TS + 60, 2), // dwell at a station…
		fix(END_TS + 120, 40), // …train pulls away, so not the alight
		fix(END_TS + 240, 2), // this one stays slow
		fix(END_TS + 300, 1),
	],
	// A resume 121 s later is OUTSIDE the window, so the first slow fix wins.
	resumeJustOutsideWindow: [fix(END_TS + 60, 2), fix(END_TS + 181, 40)],
	// 120 s exactly is INSIDE the window (`<=`), so the first is skipped.
	resumeExactlyAtBar: [fix(END_TS + 60, 2), fix(END_TS + 180, 40), fix(END_TS + 300, 2)],
	// The tight arm is PREFERRED, not merely first: a 10 km/h fix (slow by the
	// loose bar) precedes a 2 km/h one, and the 2 wins. Without this case the
	// two arms are indistinguishable.
	tightArmBeatsEarlierLooseFix: [fix(END_TS + 60, 40), fix(END_TS + 120, 10), fix(END_TS + 180, 2)],
	// SECOND arm: nothing under 5 km/h, but something under 15 — the looser
	// post-transit bar.
	fallbackToLooseSlow: [fix(END_TS + 60, 40), fix(END_TS + 120, 10), fix(END_TS + 180, 10)],
	// THIRD arm: nothing slow at all — the first fix after the end, whatever it
	// is. The ride ran off the end of the data.
	fallbackToFirstAfterEnd: [fix(END_TS + 60, 40), fix(END_TS + 120, 40)],
	// Fixes at or before endTs are ignored (`p.ts <= endTs` skips).
	ignoresFixesAtOrBeforeEnd: [fix(END_TS - 60, 1), fix(END_TS, 1), fix(END_TS + 60, 2)],
	empty: [],
};
for (const [name, points] of Object.entries(ALIGHT_CASES)) {
	const r = findRunAlightFix(points, END_TS);
	show(`alight.${name}`, r === undefined ? null : { ts: r.ts, speed_kmh: r.speed_kmh });
}
