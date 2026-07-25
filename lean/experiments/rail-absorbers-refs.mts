/**
 * V8 reference values for the pure passes in `src/geo/passes/rail-absorbers.ts`,
 * plus the label parser they depend on.
 *
 *   `absorbDriveStops`           — swallow a phantom in-car stop between two drives
 *   `absorbInterchanges`         — extend a train over the platform run after it
 *   `relabelWalkingInterchanges` — name a between-trains walk after the station
 *   `parseRailWayName`           — rail-reconcile.ts's parser, NOT rail-snap's
 *
 * ## Why the parser is here at all
 *
 * `Board → Alight · Line` is parsed by THREE different functions in this repo
 * and they disagree. `relabelWalkingInterchanges` uses rail-reconcile's, which
 * is NOT the one already in Lean (`Verified.Geo.Worldline.parseRailWayName`
 * mirrors rail-snap's). The two differ on real inputs:
 *
 *   input           rail-snap / Worldline        rail-reconcile
 *   "A · X → B"     null (line stripped first,   {board:"A · X", alight:"B"}
 *                   leaving no arrow)
 *   " → B"          null (empty board rejected)  {board:"", alight:"B"}
 *   "A → "          null (empty alight rejected) {board:"A", alight:""}
 *   " A → B "       trimmed                      NOT trimmed
 *
 * and `relabelWalkingInterchanges` compares `prevRail.alight === nextRail.board`,
 * so the difference reaches the output. The cases below pin rail-reconcile's
 * behaviour directly AND through the pass.
 *
 * Run: nix develop /Users/pippijn/Code/health --command npx tsx lean/experiments/rail-absorbers-refs.mts
 */

import type { EnrichedSegment } from "../../src/geo/enriched-segment.js";
import {
	absorbDriveStops,
	absorbInterchanges,
	relabelWalkingInterchanges,
} from "../../src/geo/passes/rail-absorbers.js";
import { parseRailWayName } from "../../src/geo/passes/rail-reconcile.js";
import type { TransportMode } from "../../src/geo/segments.js";

const show = (label: string, v: unknown): void => {
	// eslint-disable-next-line no-console
	console.log(`${label}: ${JSON.stringify(v)}`);
};

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
/* 1. parseRailWayName (rail-reconcile's)                              */
/* ------------------------------------------------------------------ */

const PARSE_CASES: Array<string | undefined> = [
	"Euston Square → Wembley Park · Metropolitan Line",
	// No line suffix at all.
	"Euston Square → Wembley Park",
	// No arrow: not a station pair.
	"Metropolitan Line",
	"",
	undefined,
	// The arrow is found FIRST, so a line separator BEFORE it stays in `board`
	// — where rail-snap's parser strips the suffix first and then finds no
	// arrow, returning null.
	"A · X → B",
	// Empty endpoints are ACCEPTED here and rejected by rail-snap's.
	" → B",
	"A → ",
	// Whitespace is NOT trimmed here.
	" A → B ",
	"A → B · ",
	// Both separators split on their FIRST occurrence with the tail rejoined.
	"A → B → C",
	"A → B · L1 · L2",
];
for (const w of PARSE_CASES) {
	show(`parse(${JSON.stringify(w)})`, parseRailWayName(w) ?? null);
}

/* ------------------------------------------------------------------ */
/* 2. absorbDriveStops                                                 */
/* ------------------------------------------------------------------ */

const stepsAt = (from: number, to: number, perMin: number): Array<{ ts: number; steps: number }> => {
	const out: Array<{ ts: number; steps: number }> = [];
	for (let ts = from; ts < to; ts += 60) out.push({ ts, steps: perMin });
	return out;
};

const DRIVE_CASES: Record<string, { segs: EnrichedSegment[]; steps: Array<{ ts: number; steps: number }> }> = {
	// The sandwich: drive → short zero-step stop → drive collapses to one drive
	// carrying all three point counts.
	absorbed: {
		segs: [seg(0, 600, "driving"), seg(600, 900, "stationary", { pointCount: 3 }), seg(900, 1500, "driving")],
		steps: [],
	},
	// Steps inside the stop mean the user got out — 6 steps is one over the bar.
	stepsVetoIt: {
		segs: [seg(0, 600, "driving"), seg(600, 900, "stationary", { pointCount: 3 }), seg(900, 1500, "driving")],
		steps: [{ ts: 650, steps: 6 }],
	},
	// 5 steps exactly is still absorbed (the test is `<=`).
	stepsExactlyAtBar: {
		segs: [seg(0, 600, "driving"), seg(600, 900, "stationary", { pointCount: 3 }), seg(900, 1500, "driving")],
		steps: [{ ts: 650, steps: 5 }],
	},
	// A step bucket exactly ON the stop's closing boundary DOES count — the
	// window is inclusive at both ends. Six steps there veto the absorb.
	stepsAtClosingBoundary: {
		segs: [seg(0, 600, "driving"), seg(600, 900, "stationary", { pointCount: 3 }), seg(900, 1500, "driving")],
		steps: [{ ts: 900, steps: 6 }],
	},
	// …and so does one exactly on the opening boundary.
	stepsAtOpeningBoundary: {
		segs: [seg(0, 600, "driving"), seg(600, 900, "stationary", { pointCount: 3 }), seg(900, 1500, "driving")],
		steps: [{ ts: 600, steps: 6 }],
	},
	// Steps OUTSIDE the stop window do not count.
	stepsOutsideWindow: {
		segs: [seg(0, 600, "driving"), seg(600, 900, "stationary", { pointCount: 3 }), seg(900, 1500, "driving")],
		steps: stepsAt(0, 600, 60),
	},
	// 901 s is past the 15-minute bar.
	tooLong: {
		segs: [seg(0, 600, "driving"), seg(600, 1501, "stationary"), seg(1501, 2000, "driving")],
		steps: [],
	},
	// 900 s exactly still absorbs.
	durationExactlyAtBar: {
		segs: [seg(0, 600, "driving"), seg(600, 1500, "stationary"), seg(1500, 2000, "driving")],
		steps: [],
	},
	// Not bracketed by two drives.
	notDriveOnBothSides: {
		segs: [seg(0, 600, "driving"), seg(600, 900, "stationary"), seg(900, 1500, "walking")],
		steps: [],
	},
	// A stop that ENDS the day is left alone — there is no closing drive.
	trailingStop: { segs: [seg(0, 600, "driving"), seg(600, 900, "stationary")], steps: [] },
	// TWO stops in a row: the pass re-runs to a fixpoint, so drive/stop/drive/
	// stop/drive collapses to ONE drive across all five.
	twoStopsFixpoint: {
		segs: [
			seg(0, 600, "driving"),
			seg(600, 900, "stationary", { pointCount: 3 }),
			seg(900, 1500, "driving"),
			seg(1500, 1800, "stationary", { pointCount: 2 }),
			seg(1800, 2400, "driving"),
		],
		steps: [],
	},
	// effectiveMode: a leg refined to driving participates.
	refinedToDriving: {
		segs: [
			seg(0, 600, "train", { refinedMode: "driving" }),
			seg(600, 900, "stationary", { pointCount: 3 }),
			seg(900, 1500, "driving"),
		],
		steps: [],
	},
	empty: { segs: [], steps: [] },
};
for (const [name, c] of Object.entries(DRIVE_CASES)) {
	show(
		`drive.${name}`,
		absorbDriveStops(c.segs, c.steps).map((s) => ({
			startTs: s.startTs,
			endTs: s.endTs,
			mode: s.mode,
			pointCount: s.pointCount,
		})),
	);
}

/* ------------------------------------------------------------------ */
/* 3. absorbInterchanges                                               */
/* ------------------------------------------------------------------ */

const INTERCHANGE_CASES: Record<string, EnrichedSegment[]> = {
	// A train followed by a short stationary run and then more movement: the
	// train is extended over the run and the run's segments are dropped.
	absorbed: [
		seg(0, 600, "train"),
		seg(600, 700, "stationary"),
		seg(700, 800, "stationary"),
		seg(800, 1400, "walking"),
	],
	// The run ENDS the day: not an interchange, it is where the journey stopped.
	runEndsDay: [seg(0, 600, "train"), seg(600, 700, "stationary")],
	// The run is stopped by a longer stay, which is a real destination.
	stoppedByLongStay: [
		seg(0, 600, "train"),
		seg(600, 700, "stationary"),
		seg(700, 2000, "stationary"),
		seg(2000, 2400, "walking"),
	],
	// 481 s is past the 8-minute per-segment bar, so the run is empty and the
	// train is left alone.
	segmentTooLong: [seg(0, 600, "train"), seg(600, 1081, "stationary"), seg(1081, 1600, "walking")],
	// 480 s exactly still counts as interchange-length.
	segmentExactlyAtBar: [seg(0, 600, "train"), seg(600, 1080, "stationary"), seg(1080, 1600, "walking")],
	// No run at all: train straight into a walk.
	noRun: [seg(0, 600, "train"), seg(600, 1200, "walking")],
	// Two trains with a platform run between them: absorbed into the first.
	betweenTrains: [
		seg(0, 600, "train"),
		seg(600, 700, "stationary"),
		seg(700, 1300, "train"),
	],
	// Not a train: nothing happens.
	notATrain: [seg(0, 600, "walking"), seg(600, 700, "stationary"), seg(700, 1300, "walking")],
	empty: [],
};
for (const [name, segs] of Object.entries(INTERCHANGE_CASES)) {
	show(
		`interchange.${name}`,
		absorbInterchanges(segs).map((s) => ({ startTs: s.startTs, endTs: s.endTs, mode: s.mode })),
	);
}

/* ------------------------------------------------------------------ */
/* 4. relabelWalkingInterchanges                                       */
/* ------------------------------------------------------------------ */

function walkBetween(prevWay: string | undefined, nextWay: string | undefined, walkEnd = 900): EnrichedSegment[] {
	return [
		seg(0, 600, "train", { wayName: prevWay }),
		seg(600, walkEnd, "walking", { wayName: "Allsop Place" }),
		seg(walkEnd, walkEnd + 600, "train", { wayName: nextWay }),
	];
}

const RELABEL_CASES: Record<string, EnrichedSegment[]> = {
	// The 2026-06-16 Baker Street case: leg A alights where leg B boards, so the
	// walk between them is the platform change — named after the street the fix
	// happened to see, and rewritten to the station.
	relabelled: walkBetween(
		"Euston Square → Baker Street · Metropolitan Line",
		"Baker Street → Wembley Park · Jubilee Line",
	),
	// Both lines present ⇒ the reason names the line change; with either missing
	// the parenthetical is dropped entirely.
	noLineOnOneSide: walkBetween("Euston Square → Baker Street", "Baker Street → Wembley Park · Jubilee Line"),
	noLineOnEither: walkBetween("Euston Square → Baker Street", "Baker Street → Wembley Park"),
	// The legs do not share a station: the user really did leave and come back.
	stationsDoNotMatch: walkBetween(
		"Euston Square → Baker Street · Metropolitan Line",
		"Bond Street → Wembley Park · Jubilee Line",
	),
	// 301 s is past the 5-minute bar — an out-of-station errand, not a change.
	walkTooLong: walkBetween(
		"Euston Square → Baker Street · Metropolitan Line",
		"Baker Street → Wembley Park · Jubilee Line",
		901,
	),
	// 300 s exactly still counts as an interchange.
	walkExactlyAtBar: walkBetween(
		"Euston Square → Baker Street · Metropolitan Line",
		"Baker Street → Wembley Park · Jubilee Line",
		900,
	),
	// An unparseable label on either side.
	unparseablePrev: walkBetween("Metropolitan Line", "Baker Street → Wembley Park · Jubilee Line"),
	missingPrevWay: walkBetween(undefined, "Baker Street → Wembley Park · Jubilee Line"),
	// THE PARSER DIFFERENCE, reaching the output: rail-reconcile's parser accepts
	// an empty board, so `" → Baker Street"` alights at "Baker Street" and pairs
	// with a leg boarding there. rail-snap's parser would return null and the
	// walk would be left alone — this case is the discriminator between them.
	emptyBoardStillPairs: walkBetween(" → Baker Street", "Baker Street → Wembley Park · Jubilee Line"),
	// And the other direction: a line separator BEFORE the arrow stays inside
	// `board`, so the alight is still clean and the pair still matches.
	lineSepBeforeArrow: walkBetween(
		"A · X → Baker Street",
		"Baker Street → Wembley Park · Jubilee Line",
	),
	// An EMPTY line suffix parses to `line: ""` — present but falsy — so the
	// `(A → B)` parenthetical is dropped. Discriminates a truthiness test from
	// a presence test.
	emptyLineSuffix: walkBetween("Euston Square → Baker Street · ", "Baker Street → Wembley Park · Jubilee Line"),
	// Not sandwiched by two trains.
	notBetweenTrains: [
		seg(0, 600, "walking"),
		seg(600, 900, "walking"),
		seg(900, 1500, "train", { wayName: "Baker Street → Wembley Park" }),
	],
	// At index 0 there is no previous segment.
	walkAtIndexZero: [
		seg(0, 300, "walking"),
		seg(300, 900, "train", { wayName: "Baker Street → Wembley Park" }),
	],
	empty: [],
};
for (const [name, segs] of Object.entries(RELABEL_CASES)) {
	show(
		`relabel.${name}`,
		relabelWalkingInterchanges(segs).map((s) => ({
			startTs: s.startTs,
			mode: s.mode,
			wayName: s.wayName ?? null,
			refinedReason: s.refinedReason ?? null,
		})),
	);
}
