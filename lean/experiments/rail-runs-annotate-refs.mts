/**
 * V8 reference values for `annotateRailRuns` — the rail-run annotator in
 * `src/geo/passes/rail-runs.ts`, and the third orchestrator of the OSM tranche.
 *
 * The pass takes the day's segments and fixes and does three things: find
 * maximal runs of rail-like segments (absorbing brief platform pauses), resolve
 * each run's `board → alight · line` label from OSM, and collapse each run into
 * a single train segment. Only the label step touches OSM, through two injected
 * lookups — `stationsLookup` and `linesLookup` — so the whole pass drives here
 * with stubs and every decision leaf runs for real.
 *
 * ## The two lookups are NOT memoised, and the order is the output
 *
 * Unlike the rail-journey assembler, neither lookup is cached: `resolveRailRunLabel`
 * asks for stations up to three times per run, and `lineUnderTheTrack` asks for
 * lines once per mid-ride fix. So the ORDERED read trace pins facts nothing else
 * can — which endpoint is looked up first, whether the boarding lookup is skipped
 * when a preceding stationary already answered, and how far the mid-ride vote
 * walks before it decides. Every case below prints its trace.
 *
 * WITHIN a run, `Promise.all([a, b])` reorders nothing: both lookups are invoked
 * synchronously as the array is built, in source order. ACROSS runs it does —
 * `annotateRailRuns` resolves every run through one `Promise.all(runs.map(…))`,
 * so the runs advance in lock-step by await depth. The `concurrentRuns` flag
 * marks the cases where that shows, and the emitted guard is the sorted multiset
 * for those, with V8's exact interleaved order recorded beside it.
 *
 * ## The geography
 *
 * Four stations 0.02° apart on the -0.1 meridian (~2224 m):
 *
 *     Deeham   51.56 ──┐ Alpha, Beta, Gamma
 *     Ceeford  51.54 ──┤ Alpha, Gamma          + "Ceeford Main" 282 m ENE (Delta)
 *     Beeston  51.52 ──┤ Alpha, Beta
 *     Ayton    51.50 ──┘ Alpha, Beta
 *
 * `linesAtPoint` is a real corridor test, not a table: a line is present at a
 * point when its polyline passes within 150 m. Alpha runs the meridian end to
 * end; Beta shares it from Ayton to Beeston, swings 0.005° east through the
 * middle, and rejoins at Deeham. That geometry is what makes a mid-ride fix
 * DISCRIMINATING — at the stations both lines answer, between Beeston and
 * Ceeford only Alpha does — which is the whole premise of `lineUnderTheTrack`.
 *
 * "Ceeford Main" is the #380 shape: a second station-tier node at the same
 * site, NEARER the street-reacquire fix than the tube node and served by a line
 * the boarding station has never heard of. `pickBestStation` picks it on
 * distance, the intersection empties, and the realisable-alight sweep has to
 * walk past it to the node a line can actually reach.
 *
 * Run: nix develop /Users/pippijn/Code/health --command npx tsx lean/experiments/rail-runs-annotate-refs.mts
 */

import type { EnrichedSegment } from "../../src/geo/enriched-segment.js";
import type { FilteredPoint } from "../../src/geo/kalman.js";
import type { NearbyStation } from "../../src/geo/osm.js";
import type { RailStopRelation } from "../../src/geo/osm-rail-stops.js";
import { annotateRailRuns } from "../../src/geo/passes/rail-runs.js";
import { haversineMeters } from "../../src/geo/place-snap.js";
import type { RefinedKind, TransportMode } from "../../src/geo/segments.js";

const show = (label: string, v: unknown): void => {
	// eslint-disable-next-line no-console
	console.log(`${label}: ${JSON.stringify(v)}`);
};
const emit = (line: string): void => {
	// eslint-disable-next-line no-console
	console.log(`  ${line}`);
};

/* ------------------------------------------------------------------ */
/* The geography                                                       */
/* ------------------------------------------------------------------ */

const LON0 = -0.1;

/** Station NODES the stub reports, with their own coordinates. */
type Node = { name: string; subtype: string; lat: number; lon: number };
const NODES: Node[] = [
	{ name: "Ayton", subtype: "subway", lat: 51.5, lon: LON0 },
	// A platform node metres from the Ayton node. Tier 2, so it never names the
	// site however near it sits — the #373 rule, exercised through the pass.
	{ name: "Ayton Platform 1", subtype: "stop_position", lat: 51.5001, lon: LON0 },
	{ name: "Beeston", subtype: "subway", lat: 51.52, lon: LON0 },
	{ name: "Ceeford", subtype: "subway", lat: 51.54, lon: LON0 },
	// The #380 node: same site, station tier, 282 m ENE of the tube node, and on
	// a corridor the boarding station does not share.
	{ name: "Ceeford Main", subtype: "rail", lat: 51.5405, lon: -0.096 },
	// An intermediate stop between Ceeford and Deeham that Alpha calls at and
	// Gamma runs through. Alpha and Gamma share this track completely, so the
	// mid-ride vote can never separate them — where they differ is where they
	// STOP, which is the whole premise of the stopping-pattern fallback.
	{ name: "Ceedee", subtype: "subway", lat: 51.55, lon: LON0 },
	{ name: "Deeham", subtype: "subway", lat: 51.56, lon: LON0 },
	// Out past Alpha's northern end, where the only relation is the DIRECTIONAL
	// one. Alpha's own corridor stops 556 m short, so a lookup here returns
	// "Alpha Line Northbound" and nothing else.
	{ name: "Effton", subtype: "subway", lat: 51.57, lon: LON0 },
	// A site of NOTHING BUT platforms, 0.03° west of Beeston. `pickBestStation`
	// still answers here (tiering demotes, it never discards) but every candidate
	// is tier 2, so the sweep's `#[chosen]` seed is the only entry it can have.
	{ name: "Gee Platform 1", subtype: "stop_position", lat: 51.52, lon: -0.13 },
	{ name: "Gee Platform 2", subtype: "stop_position", lat: 51.5202, lon: -0.13 },
	// The self-pair site, 1.4 km west of the meridian so no main corridor reaches
	// it. Three station-tier nodes around one reacquire fix at (51.5, -0.120),
	// at 174 m / 208 m / 243 m:
	//   Zedton  — nearest, so `pickBestStation` takes it. It sits on Zeta, which
	//             the boarding station does not share, so its retry is empty and
	//             the sweep moves on;
	//   Beeston — SECOND, and carries the BOARDING station's own name. It sits on
	//             an Alpha spur, so its retry WOULD match and only the self-pair
	//             skip stops the degenerate "Beeston → Beeston";
	//   Haldon  — third, on the same spur, and the pair the sweep should emit.
	{ name: "Zedton", subtype: "rail", lat: 51.5, lon: -0.1225 },
	{ name: "Beeston", subtype: "rail", lat: 51.5, lon: -0.117 },
	{ name: "Haldon", subtype: "rail", lat: 51.5, lon: -0.1165 },
];

const RAIL_RUN_STATION_RADIUS_M = 400;

/** Every station node within the pass's 400 m radius, in NODES order — the
 *  adapter does not promise a sort, and `rankStations` is what imposes one. */
const stationsAt = (lat: number, lon: number): NearbyStation[] =>
	NODES.map((n) => ({
		name: n.name,
		subtype: n.subtype,
		distanceM: haversineMeters(lat, lon, n.lat, n.lon),
		lat: n.lat,
		lon: n.lon,
	})).filter((s) => s.distanceM <= RAIL_RUN_STATION_RADIUS_M);

/** A line's corridor, as an ordered polyline. */
const CORRIDORS: { line: string; pts: [number, number][] }[] = [
	{
		line: "Alpha Line",
		pts: [
			[51.495, LON0],
			[51.565, LON0],
		],
	},
	{
		line: "Beta Line",
		pts: [
			[51.495, LON0],
			[51.52, LON0],
			[51.53, -0.088],
			[51.55, -0.088],
			[51.56, LON0],
		],
	},
	{
		line: "Gamma Line",
		pts: [
			[51.535, LON0],
			[51.565, LON0],
		],
	},
	{
		line: "Delta Line",
		pts: [
			[51.538, -0.096],
			[51.543, -0.096],
		],
	},
	// A DIRECTIONAL relation name, which OSM really does tag separately from its
	// own reverse. Raw string intersection comes up empty against plain "Alpha
	// Line"; only canonicalisation makes them the same physical line. Placed on a
	// spur so it appears at exactly one lookup point.
	{
		line: "Alpha Line Northbound",
		pts: [
			[51.5698, -0.1],
			[51.5702, -0.1],
		],
	},
	// A line reachable only from the far spur, so a mid-ride fix out there names
	// something no endpoint does — the "names none of the candidates" arm.
	{
		line: "Epsilon Line",
		pts: [
			[51.5, -0.2],
			[51.57, -0.2],
		],
	},
	// Serves the self-pair site's NEAREST node and nothing the boarding station
	// touches, so that candidate's retry comes back empty and the sweep goes on.
	{
		line: "Zeta Line",
		pts: [
			[51.499, -0.123],
			[51.501, -0.123],
		],
	},
	// A second way carrying Alpha, out at the self-pair site. A line is many way
	// segments, and both the duplicate-named node and the one after it sit on
	// this one — which is what makes the skip decide the label.
	{
		line: "Alpha Line",
		pts: [
			[51.499, -0.117],
			[51.501, -0.117],
		],
	},
	// …and Beta alongside it, so the sweep's winning candidate shares TWO lines
	// with the boarding station. That is the retry-size branch: a two-element
	// retry must go through the ride's own evidence, not take the first entry.
	{
		line: "Beta Line",
		pts: [
			[51.499, -0.116],
			[51.501, -0.116],
		],
	},
];

const LINE_RADIUS_M = 150;

/** Distance from a point to a segment, in the local flat approximation the
 *  corridor test only needs to be monotone in. */
function distToSeg(lat: number, lon: number, a: [number, number], b: [number, number]): number {
	const kx = Math.cos((lat * Math.PI) / 180) * 111320;
	const ky = 110540;
	const px = (lon - a[1]) * kx;
	const py = (lat - a[0]) * ky;
	const bx = (b[1] - a[1]) * kx;
	const by = (b[0] - a[0]) * ky;
	const len2 = bx * bx + by * by;
	const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len2));
	const dx = px - t * bx;
	const dy = py - t * by;
	return Math.sqrt(dx * dx + dy * dy);
}

const linesAt = (lat: number, lon: number): Set<string> => {
	const out = new Set<string>();
	for (const c of CORRIDORS) {
		for (let i = 0; i + 1 < c.pts.length; i++) {
			if (distToSeg(lat, lon, c.pts[i], c.pts[i + 1]) <= LINE_RADIUS_M) {
				out.add(c.line);
				break;
			}
		}
	}
	return out;
};

/* ------------------------------------------------------------------ */
/* The traced lookups                                                  */
/* ------------------------------------------------------------------ */

type Read = { kind: "stations"; lat: number; lon: number } | { kind: "lines"; lat: number; lon: number };
let trace: Read[] = [];

/**
 * Every DISTINCT coordinate either lookup was asked about, with the answer.
 *
 * The Lean guards replay these as tables rather than re-deriving the geography,
 * so what they check is the PASS and not a second copy of the stub. A query the
 * Lean arm makes that this one never did misses the table and comes back empty,
 * which shows up immediately as a divergence rather than as a plausible answer
 * from a stub that drifted.
 */
const stationAnswers = new Map<string, { lat: number; lon: number; v: NearbyStation[] }>();
const lineAnswers = new Map<string, { lat: number; lon: number; v: string[] }>();

const stationsLookup = async (lat: number, lon: number): Promise<NearbyStation[]> => {
	trace.push({ kind: "stations", lat, lon });
	const v = stationsAt(lat, lon);
	stationAnswers.set(`${lat},${lon}`, { lat, lon, v });
	return v;
};
const linesLookup = async (lat: number, lon: number): Promise<Set<string>> => {
	trace.push({ kind: "lines", lat, lon });
	const v = linesAt(lat, lon);
	lineAnswers.set(`${lat},${lon}`, { lat, lon, v: [...v] });
	return v;
};

/* ------------------------------------------------------------------ */
/* Fixture builders                                                    */
/* ------------------------------------------------------------------ */

const fix = (ts: number, lat: number, speed_kmh: number, lon = LON0): FilteredPoint => ({
	ts,
	lat,
	lon,
	speed_kmh,
	bearing: 0,
});

type SegOpts = {
	refinedMode?: TransportMode;
	refinedReason?: string;
	refinedKinds?: RefinedKind[];
	avgSpeed?: number;
	maxSpeed?: number;
	pointCount?: number;
	confidence?: number;
	confidenceMargin?: number;
	linearity?: number;
	wayName?: string;
};

const seg = (startTs: number, endTs: number, mode: TransportMode, o: SegOpts = {}): EnrichedSegment =>
	({
		startTs,
		endTs,
		mode,
		confidence: o.confidence ?? 0.8,
		confidenceMargin: o.confidenceMargin ?? 2,
		avgSpeed: o.avgSpeed ?? 40,
		maxSpeed: o.maxSpeed ?? 60,
		linearity: o.linearity ?? 0.9,
		pointCount: o.pointCount ?? 10,
		...(o.refinedMode ? { refinedMode: o.refinedMode } : {}),
		...(o.refinedReason ? { refinedReason: o.refinedReason } : {}),
		...(o.refinedKinds ? { refinedKinds: o.refinedKinds } : {}),
		...(o.wayName ? { wayName: o.wayName } : {}),
	}) as EnrichedSegment;

/* ------------------------------------------------------------------ */
/* Lean literal emission — from RAW numbers, never re-parsed text      */
/* ------------------------------------------------------------------ */

/** A Lean float literal. NEGATIVES ARE PARENTHESISED: bare `some -0.1` parses
 *  as `some - 0.1`, a subtraction, and `.lines 51.5 -0.1` as `(.lines 51.5) -
 *  (0.1 …)`. Both are type errors rather than wrong answers, but only after a
 *  confusing detour. */
const lf = (x: number): string => {
	const body = Number.isInteger(x) ? `${x}.0` : String(x);
	return x < 0 ? `(${body})` : body;
};
const ls = (s: string | undefined): string => (s === undefined ? '""' : JSON.stringify(s));
const lopt = (s: string | undefined): string => (s === undefined ? "none" : `some ${JSON.stringify(s)}`);

const leanFix = (p: FilteredPoint): string => `⟨${p.ts}, ${lf(p.lat)}, ${lf(p.lon)}, ${lf(p.speed_kmh)}⟩`;

const leanSeg = (s: EnrichedSegment): string =>
	`{ startTs := ${s.startTs}, endTs := ${s.endTs}, mode := ${ls(s.mode)}` +
	`, refinedMode := ${lopt(s.refinedMode)}` +
	`, refinedReason := ${lopt(s.refinedReason)}` +
	`, refinedKinds := #[${(s.refinedKinds ?? []).map((k) => JSON.stringify(k)).join(", ")}]` +
	`, wayName := ${lopt(s.wayName)}` +
	`, confidence := ${lf(s.confidence)}, confidenceMargin := ${lf(s.confidenceMargin)}` +
	`, avgSpeed := ${lf(s.avgSpeed)}, maxSpeed := ${lf(s.maxSpeed)}` +
	`, linearity := ${lf(s.linearity)}, pointCount := ${s.pointCount} }`;

const leanRead = (r: Read): string => `.${r.kind} ${lf(r.lat)} ${lf(r.lon)}`;

/** The projection the Lean guards compare. Everything `applyRailRuns` can
 *  write must appear, or a mutation to it is invisible. */
const leanOut = (s: EnrichedSegment): string =>
	`(${s.startTs}, ${s.endTs}, ${ls(s.wayName)}, ${ls(s.mode)}, ${ls(s.refinedMode)}, ${ls(s.refinedReason)}` +
	`, #[${(s.refinedKinds ?? []).map((k) => JSON.stringify(k)).join(", ")}]` +
	`, ${lf(s.confidence)}, ${lf(s.confidenceMargin)}, ${lf(s.avgSpeed)}, ${lf(s.maxSpeed)}` +
	`, ${lf(s.linearity)}, ${s.pointCount})`;

/* ------------------------------------------------------------------ */
/* Cases                                                               */
/* ------------------------------------------------------------------ */

type Case = {
	id: string;
	why: string;
	segments: EnrichedSegment[];
	points: FilteredPoint[];
	railStops?: RailStopRelation[];
	/** Set on a day with more than one LABEL-RESOLVING run.
	 *
	 * `annotateRailRuns` resolves every run through one
	 * `Promise.all(runs.map(resolveRailRunLabel))`, so the runs advance in
	 * lock-step by await depth: every run's station pair, then every run's line
	 * pair. A sequential model issues the same reads in the same order within
	 * each run but groups them run-by-run instead, so for these cases the guard
	 * compares the trace as a sorted multiset and the exact interleaved order is
	 * recorded beside it. */
	concurrentRuns?: true;
};

/** A clean Ayton → Ceeford ride: fixes on the meridian, slow at both ends. */
const rideFixes = (opts: { alightLat?: number; alightLon?: number; midLon?: number } = {}): FilteredPoint[] => [
	fix(1000, 51.5, 2),
	fix(1060, 51.5, 2),
	fix(1120, 51.505, 45),
	fix(1180, 51.515, 50),
	fix(1240, 51.53, 50, opts.midLon ?? LON0),
	fix(1300, 51.5395, 20),
	fix(1360, opts.alightLat ?? 51.54, 2, opts.alightLon ?? LON0),
	fix(1420, opts.alightLat ?? 51.54, 2, opts.alightLon ?? LON0),
];

/**
 * A Ceeford → Deeham ride, dense enough that no stop can hide between fixes,
 * standing once at Ceedee. Alpha calls there and Gamma does not, so the ride's
 * ONE observed pause is what separates them — the track cannot, since both run
 * this stretch of meridian.
 */
const SHARED_TRACK_RIDE: FilteredPoint[] = [
	fix(1000, 51.54, 2),
	fix(1020, 51.541, 40),
	fix(1040, 51.543, 40),
	fix(1060, 51.545, 40),
	fix(1080, 51.547, 40),
	fix(1100, 51.55, 3),
	fix(1120, 51.55, 3),
	fix(1140, 51.552, 40),
	fix(1160, 51.554, 40),
	fix(1180, 51.556, 40),
	fix(1200, 51.558, 40),
	fix(1220, 51.559, 40),
	fix(1240, 51.5595, 40),
	fix(1260, 51.5598, 40),
	fix(1280, 51.5599, 40),
	fix(1300, 51.56, 2),
];

/** Alpha calls at Ceedee; Gamma runs through it. */
const RAIL_STOPS: RailStopRelation[] = [
	{
		osmRelationId: 1,
		routeType: "subway",
		lineRef: null,
		lineName: "Alpha Line",
		stops: [
			{ name: "Ayton", lat: 51.5, lon: LON0, seq: 0 },
			{ name: "Beeston", lat: 51.52, lon: LON0, seq: 1 },
			{ name: "Ceeford", lat: 51.54, lon: LON0, seq: 2 },
			{ name: "Ceedee", lat: 51.55, lon: LON0, seq: 3 },
			{ name: "Deeham", lat: 51.56, lon: LON0, seq: 4 },
		],
	},
	{
		osmRelationId: 3,
		routeType: "subway",
		lineRef: null,
		lineName: "Gamma Line",
		stops: [
			{ name: "Ceeford", lat: 51.54, lon: LON0, seq: 0 },
			{ name: "Deeham", lat: 51.56, lon: LON0, seq: 1 },
		],
	},
];

const CASES: Case[] = [
	{
		id: "S1",
		why: "One train segment, one run, unambiguous line. Trace: two station lookups then two line lookups, board before alight in both pairs.",
		segments: [seg(1100, 1300, "train")],
		points: rideFixes(),
	},
	{
		id: "S2",
		why: "Not rail-like at all — no run, no lookup, segment passes through byte-identical.",
		segments: [seg(1100, 1300, "walking", { avgSpeed: 4 })],
		points: rideFixes(),
	},
	{
		id: "S3",
		why: "refinedMode train alone makes a segment rail-like, even with mode driving.",
		segments: [seg(1100, 1300, "driving", { refinedMode: "train" })],
		points: rideFixes(),
	},
	{
		id: "S4",
		why: "The inferred-vehicle-gap arm: gps-gap-inferred, non-stationary, avgSpeed >= 7.",
		segments: [seg(1100, 1300, "driving", { refinedKinds: ["gps-gap-inferred"], avgSpeed: 7 })],
		points: rideFixes(),
	},
	{
		id: "S5",
		why: "…and its speed floor is a floor: avgSpeed 6.9 is not rail-like.",
		segments: [seg(1100, 1300, "driving", { refinedKinds: ["gps-gap-inferred"], avgSpeed: 6.9 })],
		points: rideFixes(),
	},
	{
		id: "S6",
		why: "…and stationary is excluded from it however fast the average claims to be.",
		segments: [seg(1100, 1300, "stationary", { refinedKinds: ["gps-gap-inferred"], avgSpeed: 40 })],
		points: rideFixes(),
	},
	{
		id: "S7",
		why: "Two adjacent train segments collapse into one, with weighted confidence/avgSpeed and summed pointCount.",
		segments: [
			seg(1100, 1200, "train", { avgSpeed: 30, confidence: 0.6, pointCount: 10, maxSpeed: 50, linearity: 0.8 }),
			seg(1200, 1300, "train", { avgSpeed: 50, confidence: 0.9, pointCount: 30, maxSpeed: 70, linearity: 0.95 }),
		],
		points: rideFixes(),
	},
	{
		id: "S8",
		why: "A short stationary between two trains is ABSORBED — one segment out, and the pause vanishes.",
		segments: [
			seg(1100, 1200, "train"),
			seg(1200, 1260, "stationary", { avgSpeed: 0, pointCount: 4 }),
			seg(1260, 1300, "train"),
		],
		points: rideFixes(),
	},
	{
		id: "S9",
		why: "…but only when a rail-like segment FOLLOWS it. A trailing stationary is left alone — arriving home is not a platform pause.",
		segments: [seg(1100, 1300, "train"), seg(1300, 1400, "stationary", { avgSpeed: 0, pointCount: 4 })],
		points: rideFixes(),
	},
	{
		id: "S10",
		why: "The pause duration ceiling: 5 min exactly still absorbs.",
		segments: [seg(1100, 1200, "train"), seg(1200, 1500, "stationary", { avgSpeed: 0 }), seg(1500, 1600, "train")],
		points: rideFixes(),
	},
	{
		id: "S11",
		why: "…and one second past it does not, so the run splits in two.",
		segments: [seg(1100, 1200, "train"), seg(1200, 1501, "stationary", { avgSpeed: 0 }), seg(1501, 1600, "train")],
		points: rideFixes(),
	},
	{
		id: "S12",
		why: "A non-stationary middle segment absorbs on the avgSpeed arm (<= 10 km/h) without being stationary.",
		segments: [
			seg(1100, 1200, "train"),
			seg(1200, 1260, "walking", { avgSpeed: 10, pointCount: 4 }),
			seg(1260, 1300, "train"),
		],
		points: rideFixes(),
	},
	{
		id: "S13",
		concurrentRuns: true,
		why: "…and above it falls to the GPS-cluster arm, which here also fails (the fixes span the whole ride), so the run splits.",
		segments: [
			seg(1100, 1200, "train"),
			seg(1200, 1260, "walking", { avgSpeed: 10.1, pointCount: 4 }),
			seg(1260, 1300, "train"),
		],
		points: rideFixes(),
	},
	{
		id: "S14",
		why: "The GPS-cluster arm SUCCEEDING: avgSpeed over the bar, but the segment's own fixes sit within 100 m of their centroid.",
		segments: [
			seg(1100, 1200, "train"),
			seg(1200, 1260, "walking", { avgSpeed: 40, pointCount: 4 }),
			seg(1260, 1300, "train"),
		],
		points: [
			fix(1000, 51.5, 2),
			fix(1060, 51.5, 2),
			fix(1120, 51.505, 45),
			fix(1210, 51.52, 40),
			fix(1230, 51.5202, 40),
			fix(1250, 51.5201, 40),
			fix(1300, 51.5395, 20),
			fix(1360, 51.54, 2),
			fix(1420, 51.54, 2),
		],
	},
	{
		id: "S15",
		concurrentRuns: true,
		why: "A turnaround-board tag BREAKS the run — what follows is the ride back, not more of this ride.",
		segments: [seg(1100, 1200, "train"), seg(1200, 1300, "train", { refinedKinds: ["turnaround-board"] })],
		points: rideFixes(),
	},
	{
		id: "S16",
		why: "Board and alight resolve to the SAME station: no label, and the line lookups are never made.",
		segments: [seg(1100, 1300, "train")],
		points: [fix(1000, 51.5, 2), fix(1120, 51.5005, 45), fix(1360, 51.5, 2)],
	},
	{
		id: "S17",
		why: "A preceding STATIONARY segment supplies the boarding station, and its own lookup replaces the slowBefore one — the apparent velocity from the stay to slowBefore is tunnel-noise fast.",
		segments: [seg(900, 1090, "stationary", { avgSpeed: 0 }), seg(1100, 1300, "train")],
		points: [
			fix(950, 51.5, 1),
			fix(1080, 51.5, 1),
			// 1.5 km away 20 s later: 270 km/h apparent, far past the 15 km/h bar.
			fix(1090, 51.5135, 2),
			fix(1180, 51.53, 50),
			fix(1360, 51.54, 2),
		],
	},
	{
		id: "S18",
		why: "…and at realistic WALKING pace the stay is not trusted: the rider genuinely moved to another station, so slowBefore's own lookup stands.",
		segments: [seg(900, 1090, "stationary", { avgSpeed: 0 }), seg(1100, 1300, "train")],
		points: [
			fix(950, 51.5, 1),
			fix(1080, 51.5, 1),
			// 222 m in 400 s: 2 km/h, plainly a walk.
			fix(1480, 51.502, 2),
			fix(1500, 51.53, 50),
			fix(1560, 51.54, 2),
		],
	},
	{
		id: "S19",
		why: "The walk-back stops at a non-walking, non-stationary mode: a preceding DRIVING segment is not walked through, so the previous journey's destination is not claimed as this boarding.",
		segments: [
			seg(800, 900, "stationary", { avgSpeed: 0 }),
			seg(900, 1090, "driving", { avgSpeed: 30 }),
			seg(1100, 1300, "train"),
		],
		points: [fix(850, 51.5, 1), fix(1090, 51.5135, 2), fix(1180, 51.53, 50), fix(1360, 51.54, 2)],
	},
	{
		id: "S20",
		why: "Ambiguous endpoints resolved by the TRACK: both lines serve Ayton and Deeham, and the mid-ride fix on the meridian names only Alpha.",
		segments: [seg(1100, 1500, "train")],
		points: [
			fix(1000, 51.5, 2),
			fix(1120, 51.505, 45),
			fix(1240, 51.53, 50),
			fix(1400, 51.555, 20),
			fix(1560, 51.56, 2),
		],
	},
	{
		id: "S21",
		why: "Alpha and Gamma share the Ceeford→Deeham track completely, so every mid-ride fix names BOTH and the vote is a tie by construction. With no stop data the honest answer is the bare pair.",
		segments: [seg(1020, 1290, "train")],
		points: SHARED_TRACK_RIDE,
	},
	{
		id: "S22",
		why: "…and with the stop lists in hand the tie the track could not break is broken by which line CALLS at Ceedee: one observed dwell inside the running span, and only Alpha's pattern allows exactly one.",
		segments: [seg(1020, 1290, "train")],
		points: SHARED_TRACK_RIDE,
		railStops: RAIL_STOPS,
	},
	{
		id: "S23",
		why: "The #380 shape: the alight reacquire lands NEARER a mainline node on a corridor Ayton never touches. The primary intersection empties and the realisable-alight sweep walks past it to the node a line can reach.",
		segments: [seg(1100, 1300, "train")],
		points: rideFixes({ alightLat: 51.5404, alightLon: -0.0975 }),
	},
	{
		id: "S24",
		why: "A run with NO fix at or before its start resolves nothing — no boarding fix, no label, and the segment still collapses to train.",
		segments: [seg(1100, 1300, "train")],
		points: [fix(1360, 51.54, 2), fix(1420, 51.54, 2)],
	},
	{
		id: "S25",
		why: "A single-segment run whose mode is NOT train gets the station-pair upgrade, and the previous refinedReason is carried into the new one.",
		segments: [seg(1100, 1300, "driving", { refinedKinds: ["gps-gap-inferred"], avgSpeed: 40, refinedReason: "gap" })],
		points: rideFixes(),
	},
	{
		id: "S26",
		why: "…and with no previous reason the parenthetical is absent entirely.",
		segments: [seg(1100, 1300, "driving", { refinedKinds: ["gps-gap-inferred"], avgSpeed: 40 })],
		points: rideFixes(),
	},
	{
		id: "S27",
		concurrentRuns: true,
		why: "Two runs in one day, each labelled independently, with an ordinary walk between them left untouched.",
		segments: [
			seg(1100, 1300, "train"),
			seg(1300, 2000, "walking", { avgSpeed: 4 }),
			seg(2100, 2300, "train"),
		],
		points: [
			...rideFixes(),
			fix(2000, 51.54, 2),
			fix(2120, 51.545, 45),
			fix(2240, 51.55, 50),
			fix(2360, 51.56, 2),
		],
	},
	{
		id: "S28",
		why: "The collapse UNIONS refinedKinds across the run's RAIL segments — a downstream pass asking whether rule X touched this run must not get 'no'. The absorbed stationary's own tag is not among them: it is not a rail segment.",
		segments: [
			seg(1100, 1200, "train", { refinedKinds: ["gps-gap-inferred"] }),
			seg(1200, 1260, "stationary", { avgSpeed: 0, refinedKinds: ["gps-jitter"] }),
			seg(1260, 1300, "train", { refinedKinds: ["low-cadence", "gps-gap-inferred"] }),
		],
		points: rideFixes(),
	},
	{
		id: "S29",
		why: "A stationary INSIDE a collapsing run contributes nothing to the weighted averages — the train's own numbers survive undiluted.",
		segments: [
			seg(1100, 1200, "train", { avgSpeed: 40, confidence: 0.8, pointCount: 10, linearity: 0.9, maxSpeed: 60 }),
			seg(1200, 1260, "stationary", { avgSpeed: 0, confidence: 0.1, pointCount: 90, linearity: 0.1, maxSpeed: 1 }),
			seg(1260, 1300, "train", { avgSpeed: 40, confidence: 0.8, pointCount: 10, linearity: 0.9, maxSpeed: 60 }),
		],
		points: rideFixes(),
	},
	{
		id: "S30",
		why: "A run tagged turnaround-alight takes the fix NEAREST its endTs rather than scanning forward. Standing on the platform the rider has already come back past the outermost point, so the forward scan would name a station from the return journey.",
		segments: [seg(1100, 1300, "train", { refinedKinds: ["turnaround-alight"] })],
		points: rideFixes(),
	},
	{
		id: "S31",
		why: "…and the mirror on the boarding side: turnaround-board takes the fix nearest startTs, so the platform walkback cannot stride back across the turnaround into the outbound journey.",
		segments: [seg(1100, 1300, "train", { refinedKinds: ["turnaround-board"] })],
		points: [
			// A fix at Beeston 15 minutes earlier, which the walkback would reach
			// and name — the 2026-07-07 Baker Street shape.
			fix(300, 51.52, 1),
			fix(360, 51.52, 1),
			fix(420, 51.52, 40),
			fix(1080, 51.5, 2),
			fix(1180, 51.53, 50),
			fix(1360, 51.54, 2),
		],
	},
	{
		id: "S32",
		why: "…and WITHOUT the tag the same fixes do stride back: the platform-train-platform walkback reaches the Beeston cluster and names the ride after it.",
		segments: [seg(1100, 1300, "train")],
		points: [
			fix(300, 51.52, 1),
			fix(360, 51.52, 1),
			fix(420, 51.52, 40),
			fix(1080, 51.5, 2),
			fix(1180, 51.53, 50),
			fix(1360, 51.54, 2),
		],
	},

	/* --------------------------------------------------------------- *
	 * Cases added after the first mutation sweep, each closing a probe
	 * the earlier fixtures could not see. Every threshold below is
	 * BRACKETED — one case just inside and one just outside — because a
	 * threshold pinned on one side is not pinned.
	 * --------------------------------------------------------------- */

	{
		id: "S33",
		why: "The boarding-noise bar from JUST ABOVE: 44.4 m in 10 s is 16 km/h, so the stay is still trusted and its own lookup replaces slowBefore's.",
		segments: [seg(900, 1085, "stationary", { avgSpeed: 0 }), seg(1100, 1300, "train")],
		points: [
			fix(950, 51.5, 1),
			fix(1080, 51.5, 1),
			// 0.000399° north of the stay = 44.4 m; over 10 s that is 16.0 km/h.
			fix(1090, 51.500399, 2),
			fix(1180, 51.53, 50),
			fix(1360, 51.54, 2),
		],
	},
	{
		id: "S34",
		why: "…and from JUST BELOW: 38.9 m in the same 10 s is 14 km/h, plainly a walk, so the stay is NOT trusted and slowBefore gets its own station lookup — one extra read in the trace.",
		segments: [seg(900, 1085, "stationary", { avgSpeed: 0 }), seg(1100, 1300, "train")],
		points: [
			fix(950, 51.5, 1),
			fix(1080, 51.5, 1),
			fix(1090, 51.500349, 2),
			fix(1180, 51.53, 50),
			fix(1360, 51.54, 2),
		],
	},
	{
		id: "S35",
		concurrentRuns: true,
		why: "The GPS-tightness radius bracketed from ABOVE: the pause's fixes sit ~150 m from their centroid, so 100 m rejects them and any looser bar would not.",
		segments: [
			seg(1100, 1200, "train"),
			seg(1200, 1260, "walking", { avgSpeed: 40, pointCount: 4 }),
			seg(1260, 1300, "train"),
		],
		points: [
			fix(1000, 51.5, 2),
			fix(1120, 51.505, 45),
			// ±0.00135° = ±150 m about the centroid at 51.52.
			fix(1210, 51.51865, 40),
			fix(1230, 51.52135, 40),
			fix(1250, 51.51865, 40),
			fix(1300, 51.5395, 20),
			fix(1360, 51.54, 2),
		],
	},
	{
		id: "S36",
		concurrentRuns: true,
		why: "The percentile INDEX, which only an outlier can expose: four fixes within 20 m and one 400 m out. At 0.8 the index lands on the outlier and the pause is rejected; at 0.0 it lands on the nearest and the pause absorbs.",
		segments: [
			seg(1100, 1200, "train"),
			seg(1200, 1260, "walking", { avgSpeed: 40, pointCount: 5 }),
			seg(1260, 1300, "train"),
		],
		points: [
			fix(1000, 51.5, 2),
			fix(1120, 51.505, 45),
			fix(1205, 51.52, 40),
			fix(1215, 51.5201, 40),
			fix(1225, 51.5202, 40),
			fix(1235, 51.5203, 40),
			// 0.0036° ≈ 400 m north of the cluster.
			fix(1245, 51.5238, 40),
			fix(1300, 51.5395, 20),
			fix(1360, 51.54, 2),
		],
	},
	{
		id: "S37",
		why: "…and the same shape at TEN fixes, where floor(10 × 0.8) = 8 and the clamped index would be 9: the 9th-nearest is inside 100 m and the 10th is not, so 0.8 absorbs and 1.0 does not.",
		segments: [
			seg(1100, 1200, "train"),
			seg(1200, 1260, "walking", { avgSpeed: 40, pointCount: 10 }),
			seg(1260, 1300, "train"),
		],
		points: [
			fix(1000, 51.5, 2),
			fix(1120, 51.505, 45),
			fix(1202, 51.52, 40),
			fix(1206, 51.5201, 40),
			fix(1210, 51.5202, 40),
			fix(1214, 51.5203, 40),
			fix(1218, 51.5204, 40),
			fix(1222, 51.5205, 40),
			fix(1226, 51.5206, 40),
			fix(1230, 51.5207, 40),
			fix(1234, 51.5208, 40),
			// The lone far one: 0.0045° ≈ 500 m from the cluster's centre.
			fix(1238, 51.5249, 40),
			fix(1300, 51.5395, 20),
			fix(1360, 51.54, 2),
		],
	},
	{
		id: "S38",
		why: "The stationary SHORTCUT doing work no other arm can: mode stationary but avgSpeed 40 and fixes spread over kilometres, so only 'it says stationary' absorbs it. The April-29 shape — 7 fixes covering 2.8 km at a claimed 4.7 km/h.",
		segments: [
			seg(1100, 1200, "train"),
			seg(1200, 1260, "stationary", { avgSpeed: 40, pointCount: 4 }),
			seg(1260, 1300, "train"),
		],
		points: rideFixes(),
	},
	{
		id: "S39",
		why: "The two-fix floor: a pause with EXACTLY two fixes reaches the cluster arm, so `< 2` admits it and `< 3` would not.",
		segments: [
			seg(1100, 1200, "train"),
			seg(1200, 1260, "walking", { avgSpeed: 40, pointCount: 2 }),
			seg(1260, 1300, "train"),
		],
		points: [
			fix(1000, 51.5, 2),
			fix(1120, 51.505, 45),
			fix(1210, 51.52, 40),
			fix(1250, 51.5201, 40),
			fix(1300, 51.5395, 20),
			fix(1360, 51.54, 2),
		],
	},
	{
		id: "S40",
		why: "The centroid is the MEAN, not the first fix. Three fixes 89 m apart: from their mean the outermost are 89 m out and the pause absorbs; measured from the FIRST fix the farthest is 178 m and it would not.",
		segments: [
			seg(1100, 1200, "train"),
			seg(1200, 1260, "walking", { avgSpeed: 40, pointCount: 3 }),
			seg(1260, 1300, "train"),
		],
		points: [
			fix(1000, 51.5, 2),
			fix(1120, 51.505, 45),
			fix(1210, 51.52, 40),
			fix(1230, 51.5208, 40),
			fix(1250, 51.5216, 40),
			fix(1300, 51.5395, 20),
			fix(1360, 51.54, 2),
		],
	},
	{
		id: "S41",
		why: "Absorbing skips the CONFIRMING segment too: without that the walk would re-examine it, and here it carries a turnaround-board tag that would break the run a segment later.",
		segments: [
			seg(1100, 1200, "train"),
			seg(1200, 1260, "stationary", { avgSpeed: 0, pointCount: 4 }),
			seg(1260, 1300, "train", { refinedKinds: ["turnaround-board"] }),
			seg(1300, 1400, "train"),
		],
		points: rideFixes(),
	},
	{
		id: "S42",
		why: "The walk-back passes THROUGH a walking segment to reach the stay behind it — the rider walked from the platform bench to the carriage door.",
		segments: [
			seg(800, 1000, "stationary", { avgSpeed: 0 }),
			seg(1000, 1090, "walking", { avgSpeed: 4 }),
			seg(1100, 1300, "train"),
		],
		points: [fix(850, 51.5, 1), fix(990, 51.5, 1), fix(1090, 51.5135, 2), fix(1180, 51.53, 50), fix(1360, 51.54, 2)],
	},
	{
		id: "S43",
		why: "The stay's LAST fix is the one looked up, not its first: the rider sat down at Beeston and left from Ayton, and only the last fix names the boarding station.",
		segments: [seg(900, 1090, "stationary", { avgSpeed: 0 }), seg(1100, 1300, "train")],
		points: [
			fix(950, 51.52, 1),
			fix(1080, 51.5, 1),
			fix(1090, 51.5135, 2),
			fix(1180, 51.53, 50),
			fix(1360, 51.54, 2),
		],
	},
	{
		id: "S44",
		why: "`max 1` on the elapsed time: the stay's closing fix is LATER than slowBefore, so the raw difference is −150 s and the apparent speed comes out NEGATIVE — below the bar, and the stay would be distrusted for having moved impossibly fast.",
		segments: [seg(900, 1160, "stationary", { avgSpeed: 0 }), seg(1100, 1300, "train")],
		points: [
			fix(950, 51.5, 1),
			fix(1000, 51.5135, 2),
			fix(1150, 51.5, 1),
			fix(1180, 51.53, 50),
			fix(1360, 51.54, 2),
		],
	},
	{
		id: "S45",
		why: "A DIRECTIONAL relation name at one endpoint: 'Alpha Line Northbound' and 'Alpha Line' are one physical line, and a raw string intersection of the two is empty.",
		segments: [seg(1100, 1300, "train")],
		points: [
			fix(1000, 51.57, 2),
			fix(1120, 51.565, 45),
			fix(1240, 51.55, 50),
			fix(1360, 51.54, 2),
			fix(1420, 51.54, 2),
		],
	},
	{
		id: "S46",
		why: "A mid-ride fix naming NONE of the candidates — off-corridor, or outside the mirror's coverage. It must not vote, and it must not be read as evidence against either.",
		segments: [seg(1100, 1500, "train")],
		points: [
			fix(1000, 51.5, 2),
			fix(1120, 51.505, 45),
			// Far west, on Epsilon's corridor and nobody else's.
			fix(1200, 51.53, 50, -0.2),
			fix(1240, 51.53, 50),
			fix(1400, 51.555, 20),
			fix(1560, 51.56, 2),
		],
	},
	{
		id: "S47",
		why: "The track backing MORE THAN ONE candidate: one mid fix names only Alpha, another only Beta. Both have votes, nothing is a clean winner, and a guessed line is worse than none.",
		segments: [seg(1100, 1500, "train")],
		points: [
			fix(1000, 51.5, 2),
			fix(1120, 51.505, 45),
			fix(1200, 51.53, 50),
			fix(1300, 51.54, 50, -0.088),
			fix(1400, 51.555, 20),
			fix(1560, 51.56, 2),
		],
	},
	{
		id: "S48",
		why: "A rail segment with NO fixes of its own inside a collapsing run: its pointCount 0 weighs ONE in the averages but contributes zero to the emitted count — two expressions two lines apart in the TS, and they differ.",
		segments: [
			seg(1100, 1200, "train", { pointCount: 0, avgSpeed: 10, confidence: 0.2, linearity: 0.1, maxSpeed: 20 }),
			seg(1200, 1260, "stationary", { avgSpeed: 0, pointCount: 4 }),
			seg(1260, 1300, "train", { pointCount: 30, avgSpeed: 50, confidence: 0.9, linearity: 0.95, maxSpeed: 70 }),
		],
		points: rideFixes(),
	},
	{
		id: "S49",
		why: "Rounding places: weights of 10 and 30 over speeds 40 and 45 give 43.75, which is 43.8 at one decimal and 43.75 at two. avgSpeed takes one, confidence two.",
		segments: [
			seg(1100, 1200, "train", { pointCount: 10, avgSpeed: 40, confidence: 0.625, linearity: 0.625, maxSpeed: 60 }),
			seg(1200, 1300, "train", { pointCount: 30, avgSpeed: 45, confidence: 0.875, linearity: 0.875, maxSpeed: 70 }),
		],
		points: rideFixes(),
	},
	{
		id: "S50",
		why: "The boarding slow-fix arm is a SPEED test, not merely the latest fix: a transit-speed fix sits after the platform one and before the classifier's start, and taking it would resolve the boarding station to wherever the train was passing.",
		segments: [seg(1100, 1300, "train")],
		points: [
			fix(900, 51.5, 2),
			// Later, but at transit speed and well down the line: the arm must skip it.
			fix(1000, 51.5135, 20),
			fix(1180, 51.53, 50),
			fix(1360, 51.54, 2),
		],
	},
	{
		id: "S51",
		why: "The sweep must SKIP a candidate carrying the boarding station's own name. Boarding at Beeston, the alight site's SECOND candidate is a through-station also tagged 'Beeston', and its retry would match — so without the skip the run is labelled with the degenerate pair 'Beeston → Beeston'. The candidate it settles on shares TWO lines, and every mid-ride fix is on the stretch Alpha and Beta share, so nothing separates them and the bare pair stands: a two-element retry must not simply take its first entry.",
		segments: [seg(1100, 1300, "train")],
		points: [
			fix(1000, 51.52, 2),
			fix(1120, 51.515, 45),
			fix(1240, 51.505, 50),
			// A street reacquire 1.4 km west, where the nearest corridor is 208 m
			// away: the primary intersection empties and the sweep runs.
			fix(1360, 51.5, 2, -0.12),
			fix(1420, 51.5, 2, -0.12),
		],
	},
	{
		id: "S54",
		concurrentRuns: true,
		why: "The pause window is INCLUSIVE at its start: a fix sitting exactly on `startTs` belongs to the pause. Here it is the one far fix, and admitting it drags the centroid out and rejects the pause; excluding it would leave two fixes 6 m apart and absorb.",
		segments: [
			seg(1100, 1200, "train"),
			seg(1200, 1260, "walking", { avgSpeed: 40, pointCount: 3 }),
			seg(1260, 1300, "train"),
		],
		points: [
			fix(1000, 51.5, 2),
			fix(1120, 51.505, 45),
			// Exactly on the pause's startTs, and 290 m from where the other two sit.
			fix(1200, 51.524, 40),
			fix(1230, 51.52, 40),
			fix(1250, 51.5201, 40),
			fix(1300, 51.5395, 20),
			fix(1360, 51.54, 2),
		],
	},
	{
		id: "S52",
		why: "An alight site of nothing but PLATFORMS: `pickBestStation` still answers, but every candidate is tier 2, so the sweep's list is exactly the one node it seeded with — the tier filter and the `#[chosen]` seed are both load-bearing here.",
		segments: [seg(1100, 1300, "train")],
		points: [
			fix(1000, 51.5, 2),
			fix(1120, 51.505, 45),
			fix(1240, 51.51, 50),
			fix(1360, 51.52, 2, -0.13),
			fix(1420, 51.52, 2, -0.13),
		],
	},
	{
		id: "S53",
		why: "The back-compat stay fallback: the walking-pace gate declined to trust the stay, and slowBefore then resolves to NOTHING, so without the fallback the run loses its label entirely. The original 'rider noisy at the platform' case, from before the velocity gate existed.",
		segments: [
			seg(400, 600, "stationary", { avgSpeed: 0 }),
			seg(600, 1090, "walking", { avgSpeed: 4 }),
			seg(1100, 1300, "train"),
		],
		points: [
			fix(450, 51.5, 1),
			fix(590, 51.5, 1),
			// 1669 m from the stay over 505 s is 11.9 km/h — under the bar, so the
			// stay is NOT trusted. And 51.515 has no station within 400 m, so
			// slowBefore's own lookup comes back empty.
			fix(1095, 51.515, 2),
			fix(1180, 51.53, 50),
			fix(1360, 51.54, 2),
		],
	},
];

/* ------------------------------------------------------------------ */
/* Drive                                                               */
/* ------------------------------------------------------------------ */

/** Wrap a comment to 78 columns so the emitted Lean reads like written Lean. */
const wrap = (s: string, prefix: string): string => {
	const words = s.split(" ");
	const lines: string[] = [];
	let cur = prefix;
	for (const w of words) {
		if (cur.length + w.length + 1 > 78 && cur !== prefix) {
			lines.push(cur);
			cur = `${prefix}${w}`;
		} else {
			cur = cur === prefix ? prefix + w : `${cur} ${w}`;
		}
	}
	lines.push(cur);
	return lines.join("\n");
};

const guards: string[] = [];

for (const c of CASES) {
	trace = [];
	const out = await annotateRailRuns(c.segments, c.points, stationsLookup, linesLookup, c.railStops ?? []);
	// eslint-disable-next-line no-console
	console.log(`\n=== ${c.id} — ${c.why}`);
	show(`${c.id}.trace`, trace);
	show(
		`${c.id}.out`,
		out.map((s) => ({
			startTs: s.startTs,
			endTs: s.endTs,
			wayName: s.wayName,
			mode: s.mode,
			refinedMode: s.refinedMode,
			refinedReason: s.refinedReason,
			refinedKinds: s.refinedKinds,
			pointCount: s.pointCount,
		})),
	);
	const stops = c.railStops ? " RAIL_STOPS" : "";
	const exact = `#[${trace.map(leanRead).join(", ")}]`;
	// A day with concurrent label-resolving runs interleaves its reads by await
	// depth. See `concurrentRuns` and the module header: the sorted multiset is
	// still checked against V8, and V8's exact order is recorded beside it.
	const traceGuard = c.concurrentRuns
		? `${wrap(
				`V8's exact order, which this arm does not reproduce across runs — every run's station pair, then every run's line pair: ${exact}`,
				"-- ",
			)}\n#guard ((traceOf segs${c.id} fixes${c.id}${stops}).map reprStr).qsort (· < ·)` +
			` == (((${exact} : Array Read).map reprStr).qsort (· < ·))`
		: `#guard traceOf segs${c.id} fixes${c.id}${stops} == ${exact}`;
	guards.push(
		`\n${wrap(c.why, "-- ")}\n` +
			`private def segs${c.id} : Array Seg := #[\n  ${c.segments.map(leanSeg).join(",\n  ")}]\n` +
			`private def fixes${c.id} : Array Fix := #[${c.points.map(leanFix).join(", ")}]\n` +
			`#guard outOf segs${c.id} fixes${c.id}${stops} == #[${out.map(leanOut).join(", ")}]\n` +
			traceGuard,
	);
}

/* ------------------------------------------------------------------ */
/* Reachability of the two float boundaries                            */
/* ------------------------------------------------------------------ */

/**
 * `d <= TRAIN_DWELL_RADIUS_M` and `apparentKmh > BOARDING_NOISE_SPEED_KMH` can
 * only be told from their strict/non-strict twins by an output landing EXACTLY
 * on 100 m or 15 km/h. Measure whether the reachable outputs can: step one
 * latitude ulp and see how far the distance moves, against the ulp of the
 * distance itself. If one input step skips thousands of output values, the
 * boundary is not a value the fixtures can be made to hit.
 */
const ulpOf = (x: number): number => {
	const b = new DataView(new ArrayBuffer(8));
	b.setFloat64(0, x);
	const hi = b.getUint32(0);
	const lo = b.getUint32(4);
	const nlo = (lo + 1) >>> 0;
	b.setUint32(0, nlo === 0 ? hi + 1 : hi);
	b.setUint32(4, nlo);
	return b.getFloat64(0) - x;
};
const nextUp = (x: number): number => x + ulpOf(x);

for (const [label, target, lat0] of [
	["dwellRadius100m", 100, 51.52],
	["boardingNoise150m", 150, 51.5],
] as const) {
	// A latitude offset that puts the haversine near the target.
	const dLat = target / 111320;
	const d0 = haversineMeters(lat0, LON0, lat0 + dLat, LON0);
	const d1 = haversineMeters(lat0, LON0, nextUp(lat0 + dLat), LON0);
	show(`reach.${label}`, {
		distance: d0,
		stepPerLatUlp: d1 - d0,
		ulpOfDistance: ulpOf(d0),
		outputsSkippedPerInputStep: Math.round((d1 - d0) / ulpOf(d0)),
	});
}

/* ------------------------------------------------------------------ */
/* The oracle tables the Lean guards replay                            */
/* ------------------------------------------------------------------ */

const leanStation = (s: NearbyStation): string =>
	`⟨${JSON.stringify(s.name)}, ${JSON.stringify(s.subtype)}, ${lf(s.distanceM)}` +
	`, some ${lf(s.lat ?? 0)}, some ${lf(s.lon ?? 0)}⟩`;

const leanStop = (s: { name: string | null; lat: number; lon: number; seq: number }): string =>
	`⟨${s.name === null ? "none" : `some ${JSON.stringify(s.name)}`}, ${lf(s.lat)}, ${lf(s.lon)}, ${s.seq}⟩`;

const leanRelation = (r: RailStopRelation): string =>
	`{ stops := #[${r.stops.map(leanStop).join(", ")}]` +
	`, lineRef := ${r.lineRef === null ? "none" : `some ${JSON.stringify(r.lineRef)}`}` +
	`, lineName := ${r.lineName === null ? "none" : `some ${JSON.stringify(r.lineName)}`}` +
	`, osmRelationId := ${r.osmRelationId}, routeType := ${JSON.stringify(r.routeType)} }`;

/* The whole guards section, ready to paste. Generated, never transcribed: a
 * six-decimal round trip through formatted text is what destroyed the centroid
 * dust in the previous tranche, and re-typing a 1e-13 difference is not
 * something a human eye catches. */
// eslint-disable-next-line no-console
console.log("\n=== LEAN GUARDS\n");
const parts: string[] = [];
parts.push(`/-! ## Guards (V8 reference values)

Generated by \`lean/experiments/rail-runs-annotate-refs.mts\`.

The two lookups replay as TABLES of what V8's stub actually answered rather than
as a second copy of its geography. What the guards then check is the PASS: a
query this arm makes that the reference arm never did misses the table and comes
back empty, which reads as a divergence instead of as a plausible answer from a
stub that drifted. -/

private def STATION_TABLE : Array (Float × Float × Array NearbyStation) := #[
    ${[...stationAnswers.values()]
			.map((a) => `(${lf(a.lat)}, ${lf(a.lon)}, #[${a.v.map(leanStation).join(", ")}])`)
			.join(",\n    ")}]

private def LINE_TABLE : Array (Float × Float × Array String) := #[
    ${[...lineAnswers.values()]
			.map((a) => `(${lf(a.lat)}, ${lf(a.lon)}, #[${a.v.map((l) => JSON.stringify(l)).join(", ")}])`)
			.join(",\n    ")}]

private def lookIn {α : Type} (table : Array (Float × Float × Array α))
    (lat lon : Float) : Array α :=
  match table.find? (fun e => e.1 == lat && e.2.1 == lon) with
  | some e => e.2.2
  | none => #[]

private def ENV : Env :=
  { stationsLookup := lookIn STATION_TABLE, linesLookup := lookIn LINE_TABLE }

private def RAIL_STOPS : Array RailStopRelation := #[
    ${RAIL_STOPS.map(leanRelation).join(",\n    ")}]

/-- Everything \`applyRailRuns\` can write. A field outside this tuple is a field
no mutation to it can be seen through. -/
private def outOf (segs : Array Seg) (fixes : Array Fix)
    (stops : Array RailStopRelation := #[]) :
    Array (Int × Int × String × String × String × String × Array String
      × Float × Float × Float × Float × Float × Nat) :=
  (annotateRailRuns ENV segs fixes stops).map fun s =>
    (s.startTs, s.endTs, s.wayName.getD "", s.mode, s.refinedMode.getD "",
     s.refinedReason.getD "", s.refinedKinds,
     s.confidence, s.confidenceMargin, s.avgSpeed, s.maxSpeed, s.linearity, s.pointCount)

/-- The ORDERED reads. Neither lookup is memoised, so this is observable
behaviour and not an implementation detail. -/
private def traceOf (segs : Array Seg) (fixes : Array Fix)
    (stops : Array RailStopRelation := #[]) : Array Read :=
  (annotateRailRunsTraced ENV segs fixes stops).2`);
parts.push(...guards);
// eslint-disable-next-line no-console
console.log(parts.join("\n"));
