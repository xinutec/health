#!/usr/bin/env -S npx tsx
/**
 * Reference-value generator for `spliceInterchanges`
 * (`src/geo/interchange-split.ts`), ported into `Verified/Geo/Interchange.lean`.
 *
 * The decision leaves (`findInterchangeBurst`, `pickInterchange`) were ported
 * and pinned earlier; this covers the orchestration — the leg filter, the
 * `wayName` arrow split, the endpoint-fix selection, the disjoint-line test,
 * and the three-way splice with its recomputed point counts.
 *
 * The pass is `async` only because the line lookups are injected, so a plain
 * object stands in for the adapter. Two things the stub has to reproduce
 * faithfully:
 *
 *   - `linesAtPoint` answers a **Set**, so the caller's `.size === 0` test and
 *     the `new Set([...linesA, ...linesB])` dedup both see deduplicated,
 *     insertion-ordered names.
 *   - the burst is computed BEFORE any lookup, so a leg with no burst makes
 *     zero adapter calls. The call counter below pins that.
 *
 * Run: npx tsx lean/experiments/splice-interchanges-refs.mts
 */

type Fix = { ts: number; lat: number; lon: number };
type Step = { ts: number; steps: number };
type Station = { name: string; lat: number; lon: number };

// --- the geometry ------------------------------------------------------------
// Same three stations the `pickInterchange` guards already use, so the timing
// arithmetic below is the arithmetic those guards pinned.
const BOARD: [number, number] = [51.5, -0.1];
const ALIGHT: [number, number] = [51.54, -0.02];
const change: Station = { name: "Change", lat: 51.52, lon: -0.06 };
const wrong: Station = { name: "Wrong", lat: 51.49, lon: -0.12 };

/** A 30-minute leg with fixes on both sides of the dark stretch. */
const points: Fix[] = [
	{ ts: 0, lat: BOARD[0], lon: BOARD[1] },
	{ ts: 300, lat: 51.51, lon: -0.08 },
	{ ts: 900, lat: 51.53, lon: -0.04 },
	{ ts: 1200, lat: 51.535, lon: -0.03 },
	{ ts: 1800, lat: ALIGHT[0], lon: ALIGHT[1] },
];
/** Walking-cadence minutes at 600/660/720 ⇒ one burst 600–780. */
const steps: Step[] = [
	{ ts: 60, steps: 5 },
	{ ts: 600, steps: 112 },
	{ ts: 660, steps: 113 },
	{ ts: 720, steps: 110 },
	{ ts: 1500, steps: 4 },
];
/** No minute clears the cadence bar. */
const quietSteps: Step[] = [{ ts: 600, steps: 5 }, { ts: 660, steps: 8 }];

/** A leg exactly at MIN_LEG_FOR_SPLIT_S, with its own burst inside the guards. */
const shortPoints: Fix[] = [
	{ ts: 0, lat: BOARD[0], lon: BOARD[1] },
	{ ts: 200, lat: 51.51, lon: -0.08 },
	{ ts: 600, lat: ALIGHT[0], lon: ALIGHT[1] },
];
const shortSteps: Step[] = [
	{ ts: 240, steps: 112 },
	{ ts: 300, steps: 113 },
];

const seg = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
	startTs: 0,
	endTs: 1800,
	mode: "train",
	wayName: "Board → Alight",
	pointCount: 5,
	confidence: 0.7,
	confidenceMargin: 0.2,
	avgSpeed: 12,
	maxSpeed: 20,
	linearity: 0.9,
	...over,
});

// --- the adapter stub --------------------------------------------------------
let calls = 0;
/** Every radius the pass asks for — the Lean stub refuses any other value, so
 *  the constant is pinned rather than ignored. */
const radii = new Set<number | undefined>();
const osmOf = (
	atBoard: string[],
	atAlight: string[],
	byLine: Record<string, Station[]>,
): object => ({
	linesAtPoint: async (lat: number, _lon: number, radiusM?: number): Promise<Set<string>> => {
		calls++;
		radii.add(radiusM);
		// The board end is the SOUTHERN fix; anything else is the alight end.
		return new Set(lat <= 51.505 ? atBoard : atAlight);
	},
	stationsOnLine: async (line: string): Promise<Station[]> => {
		calls++;
		return byLine[line] ?? [];
	},
});

const bothLines: Record<string, Station[]> = { A: [change, wrong], B: [change, wrong] };
/** A and B share no station ⇒ `pickInterchange` returns null. */
import * as I from "../../src/geo/interchange-split.js";
const noOverlap: Record<string, Station[]> = { A: [change], B: [wrong] };

const FIELDS = [
	"startTs",
	"endTs",
	"mode",
	"refinedMode",
	"wayName",
	"pointCount",
	"avgSpeed",
	"maxSpeed",
	"linearity",
	"refinedReason",
] as const;

const run = async (
	label: string,
	segs: object[],
	opts: {
		pts?: Fix[];
		stp?: Step[];
		atBoard?: string[];
		atAlight?: string[];
		byLine?: Record<string, Station[]>;
	} = {},
): Promise<void> => {
	calls = 0;
	// Partial fixtures and partial stubs, converted once at the boundary: the
	// stub answers only the two adapter methods this pass calls, and the segments
	// carry only the fields it reads (#418).
	const out = await I.spliceInterchanges(
		segs as unknown as Parameters<typeof I.spliceInterchanges>[0],
		opts.pts ?? points,
		opts.stp ?? steps,
		osmOf(opts.atBoard ?? ["A"], opts.atAlight ?? ["B"], opts.byLine ?? bothLines) as Parameters<typeof I.spliceInterchanges>[3],
	);
	const rows = out.map((s) =>
		FIELDS.map((f) => ((s as unknown as Record<string, unknown>)[f] === undefined ? null : (s as unknown as Record<string, unknown>)[f])),
	);
	console.log(`${label.padEnd(26)} calls=${String(calls).padEnd(2)} ${JSON.stringify(rows)}`);
};

console.log(`-- fields: ${FIELDS.join(", ")}`);
console.log("");
await run("splits", [seg()]);
await run("refinedTrain", [seg({ mode: "driving", refinedMode: "train" })]);
await run("notTrain", [seg({ mode: "driving" })]);
await run("refinedAwayFromTrain", [seg({ mode: "train", refinedMode: "driving" })]);
await run("legTooShort", [seg({ endTs: 599 })], { pts: shortPoints, stp: shortSteps });
await run("legExactlyMinLength", [seg({ endTs: 600 })], { pts: shortPoints, stp: shortSteps });
await run("noWayName", [seg({ wayName: undefined })]);
await run("emptyWayName", [seg({ wayName: "" })]);
await run("wayNameNoArrow", [seg({ wayName: "Board" })]);
await run("wayNameThreeParts", [seg({ wayName: "Board → Mid → Alight" })]);
await run("oneFixInLeg", [seg()], { pts: [{ ts: 0, lat: BOARD[0], lon: BOARD[1] }] });
await run("noBurst", [seg()], { stp: quietSteps });
await run("sharedLine", [seg()], { atAlight: ["A", "B"] });
await run("noBoardLines", [seg()], { atBoard: [] });
await run("noAlightLines", [seg()], { atAlight: [] });
await run("noPickFits", [seg()], { byLine: noOverlap });
await run("existingReason", [seg({ refinedReason: "earlier" })]);
await run("twoSegments", [seg(), seg({ startTs: 1800, endTs: 3600, mode: "walking" })]);

// The window boundaries of the recomputed point counts: the FIRST leg is
// `[segStart, burstStart)` and the SECOND `[burstEnd, segEnd + 1)` — the second
// includes a fix landing exactly on the segment end, the first excludes one
// landing exactly on the burst start.
console.log("\n-- point-count boundaries (fixes at burst start and at leg end)");
await run("fixOnBurstStart", [seg()], {
	pts: [
		{ ts: 0, lat: BOARD[0], lon: BOARD[1] },
		{ ts: 600, lat: 51.51, lon: -0.08 },
		{ ts: 780, lat: 51.53, lon: -0.04 },
		{ ts: 1800, lat: ALIGHT[0], lon: ALIGHT[1] },
	],
});

// The trail anchor is the first in-leg fix more than a MINUTE past the burst,
// not the first one past it. A fix at 800 (20 s after the 780 burst end) is
// therefore skipped, and the anchor stays the fix at 900.
console.log("\n-- the trail anchor's one-minute gap");
await run("fixInsideTrailGap", [seg()], {
	pts: [
		{ ts: 0, lat: BOARD[0], lon: BOARD[1] },
		{ ts: 800, lat: 51.525, lon: -0.055 },
		{ ts: 900, lat: 51.53, lon: -0.04 },
		{ ts: 1800, lat: ALIGHT[0], lon: ALIGHT[1] },
	],
});

console.log(`\n-- radii asked of linesAtPoint: ${JSON.stringify([...radii])}`);

console.log("\n-- the pick behind the split (station, lines, slop)");
const boardFix = points[0];
const alightFix = points[points.length - 1];
const burst = I.findInterchangeBurst(steps, 0, 1800);
console.log(`burst ${JSON.stringify(burst)}`);
console.log(`trailFix ${JSON.stringify(points.find((p) => p.ts > (burst?.endTs ?? 0) + 60))}`);
console.log(
	`pick ${JSON.stringify(
		I.pickInterchange({
			boardLat: boardFix.lat,
			boardLon: boardFix.lon,
			alightLat: alightFix.lat,
			alightLon: alightFix.lon,
			legStartTs: 0,
			burstStartTs: burst?.startTs ?? 0,
			burstEndTs: burst?.endTs,
			trailFix: points.find((p) => p.ts > (burst?.endTs ?? 0) + 60),
			linesA: ["A"],
			linesB: ["B"],
			stationsByLine: new Map(Object.entries(bothLines)),
		}),
	)}`,
);
