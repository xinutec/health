#!/usr/bin/env -S npx tsx
/**
 * Reference-value generator for `annotateRoadMatches`
 * (`src/geo/road-match-annotate.ts`) and the corridor fetch it reads through
 * (`src/geo/osm-corridor.ts`), ported into `Verified/Geo/RoadMatchAnnotate.lean`
 * and `Verified/Geo/OsmCorridor.lean`.
 *
 * The pass is an ORCHESTRATOR. Its matcher leaf is the one arm the Lean port
 * cannot call directly — `Verified.Geo.Match`'s `qMatchRoadSegment` is the
 * QUANTISED matcher, measured and ceilinged against the TS rather than
 * bit-identical to it (#395 / #403) — so the Lean module injects it, and this
 * generator records what the real V8 matcher returned for the exact fix array
 * the pass hands it. The mirror read is injected for the usual reason: it is
 * the shell.
 *
 * Injected lookups are replayed as ORACLE TABLES, not as a second stub: the
 * table holds every distinct `(lat, lon, radius)` the pass actually asked
 * about, with the answer. A query the Lean arm makes that this arm never did
 * misses the table and comes back empty — a visible divergence, not a silently
 * re-derived answer.
 *
 * Everything else the pass decides with is called directly in Lean (the spike
 * rejection, the speed cap, the corridor fetch, the display gate), so those are
 * pinned by the OUTPUT guards rather than by stubs.
 *
 * This generator emits the whole Lean guard BLOCK — comments, fixture defs and
 * `#guard` lines — for both modules, separated by `@@@FILE` markers, and
 * `splice-guards.py` puts each where it belongs.
 *
 * Run: npx tsx lean/experiments/road-match-annotate-refs.mts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

type LL = { lat: number; lon: number };
type Way = { osmId: number; name: string | null; subtype: string | null; coords: Array<[number, number]> };
type Fix = { ts: number; lat: number; lon: number; speed_kmh: number; bearing: number };
type MPt = { lat: number; lon: number; ts: number };
// biome-ignore lint/suspicious/noExplicitAny: reference harness feeds the real pass structural fixtures.
type Seg = any;

/* ------------------------------------------------------------------ *
 * Lean literal emission
 * ------------------------------------------------------------------ */

/** A Lean `Float` literal at V8's own precision, parenthesised when negative
 *  (bare `-0.14` parses as subtraction in argument position). */
const lf = (x: number): string => {
	if (Number.isNaN(x)) return "(0.0 / 0.0)";
	if (x === Number.POSITIVE_INFINITY) return "(1.0 / 0.0)";
	if (x === Number.NEGATIVE_INFINITY) return "(-1.0 / 0.0)";
	const body = Number.isInteger(x) ? `${x}.0` : String(x);
	return x < 0 ? `(${body})` : body;
};
const li = (x: number): string => (x < 0 ? `(${x})` : `${x}`);
const ls = (s: string): string => `"${s}"`;
const lopt = (s: string | null | undefined): string => (s === null || s === undefined ? "none" : `some ${ls(s)}`);

const out: string[] = [];
const w = (s = ""): void => {
	out.push(s);
};

/* ------------------------------------------------------------------ *
 * Synthetic geography
 * ------------------------------------------------------------------ */

const LAT0 = 51.5;
const LON0 = -0.14;
const MLAT = 1 / 111_320;
const MLON = 1 / (111_320 * Math.cos((LAT0 * Math.PI) / 180));

/** `n` metres north and `e` metres east of the base point. */
const P = (n: number, e: number): LL => ({ lat: LAT0 + n * MLAT, lon: LON0 + e * MLON });

const way = (osmId: number, name: string, pts: LL[]): Way => ({
	osmId,
	name,
	subtype: "residential",
	coords: pts.map((p) => [p.lat, p.lon] as [number, number]),
});

/** A straight N-S high street, vertices every ~200 m for 3.4 km. */
const MAIN = way(
	1,
	"Main Street",
	Array.from({ length: 18 }, (_, i) => P(i * 200, 0)),
);
/** An L: 400 m east along the base latitude, then 400 m north. */
const BENT = way(2, "Bent Lane", [P(0, 0), P(0, 200), P(0, 400), P(200, 400), P(400, 400)]);
/** 55 m east of and parallel to `MAIN`, over its first kilometre — the
 *  parallel-road snap the stray gate exists to reject. */
const PARALLEL = way(
	3,
	"Parallel Road",
	Array.from({ length: 6 }, (_, i) => P(i * 200, 55)),
);
/** An E-W cross street 1.4 km up `MAIN` — exactly one corridor sample reaches
 *  it, which is what makes the corridor union differ from any single disc. */
const CROSS = way(4, "Cross Street", [P(1400, -300), P(1400, 0), P(1400, 300)]);
/** A duplicate of `CROSS`'s id under a different name: two discs both return
 *  osmId 4, and FIRST WINS decides which record survives the union. */
const CROSS_DUP = way(4, "Cross Street (dup record)", [P(1600, 0), P(1600, 300)]);

const NETWORK: Way[] = [MAIN, BENT, PARALLEL, CROSS];

/** `osm-corridor`'s own `metersBetween`, to the bit — used to MEASURE a value a
 *  fixture needs to land on exactly rather than guessing a round number. */
const exactSegLen = (a: LL, b: LL): number => {
	const dLat = (b.lat - a.lat) * 111_320;
	const dLon = (b.lon - a.lon) * 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
	return Math.hypot(dLat, dLon);
};

/** Nearest vertex distance from a query point to a way, in metres. */
const nearestVertexM = (lat: number, lon: number, wy: Way): number => {
	let best = Number.POSITIVE_INFINITY;
	for (const [wlat, wlon] of wy.coords) {
		const d = MMC.metersBetween(lat, lon, wlat, wlon);
		if (d < best) best = d;
	}
	return best;
};

/** `drivableRoads`'s own box is this much wider than the asked-for radius —
 *  the internal margin the corridor's output-identity argument relies on. */
const QUERY_MARGIN_M = 60;

/** The recording mirror. Every call is appended to `reads`, and the answer is
 *  a deterministic function of the disc, so the Lean oracle table is complete
 *  by construction for the queries this arm made. */
type Read = { lat: number; lon: number; radiusM: number; ways: Way[] };
let reads: Read[] = [];
const drivableRoads = async (lat: number, lon: number, radiusM = 200): Promise<Way[]> => {
	const hit = NETWORK.filter((wy) => nearestVertexM(lat, lon, wy) <= radiusM + QUERY_MARGIN_M);
	// The 1.6 km cross street is mirrored twice, so a corridor whose discs both
	// reach it exercises the union's first-wins rule.
	const answer = hit.some((h) => h.osmId === 4) ? [...hit, CROSS_DUP] : hit;
	reads.push({ lat, lon, radiusM, ways: answer });
	return answer;
};
// biome-ignore lint/suspicious/noExplicitAny: the pass reads exactly one adapter method.
const osm: any = { drivableRoads };

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const f = (ts: number, p: LL, speed = 30): Fix => ({ ts, lat: p.lat, lon: p.lon, speed_kmh: speed, bearing: 0 });

const seg = (startTs: number, endTs: number, mode: string, refinedMode?: string): Seg => ({
	startTs,
	endTs,
	mode,
	...(refinedMode === undefined ? {} : { refinedMode }),
	confidence: 1,
	confidenceMargin: 2,
	avgSpeed: 30,
	maxSpeed: 50,
	linearity: 0.95,
	pointCount: 10,
});

/** A 3.4 km run up `MAIN`: every fix on the carriageway, centroid 1.7 km from
 *  both ends, so the corridor arm fires and the match cannot improve on a line
 *  that is already exactly the road. */
const LONG_ONROAD: Fix[] = Array.from({ length: 18 }, (_, i) => f(1000 + i * 60, P(i * 200, 0)));

/** Fixes that cut diagonally across `BENT`'s L rather than following either
 *  leg: the raw drawn line strays 95 m off the network, so the needs-match bar
 *  clears, but the match lands 60 m from the fixes and the p85 stray bar is the
 *  SOLE blocker. Short: the single-disc arm. */
const CORNER_CUT: Fix[] = [
	f(2000, P(0, 0)),
	f(2060, P(20, 120)),
	f(2120, P(60, 260)),
	f(2180, P(140, 350)),
	f(2240, P(260, 395)),
	f(2300, P(400, 400)),
];

/** Fixes that FOLLOW `BENT`'s L, sparsely enough that the chord across the
 *  corner strays ~40 m off the carriageway. Every fix is on a road, so the
 *  match stays faithful and all three bars clear — the one fixture in which the
 *  pass actually attaches a `matchedPath`. */
const CORNER_TIGHT: Fix[] = [
	f(8000, P(0, 0)),
	f(8060, P(0, 200)),
	f(8120, P(0, 350)),
	f(8180, P(200, 400)),
	f(8240, P(350, 400)),
	f(8300, P(400, 400)),
];

/** Six fixes riding `PARALLEL` with a stray first fix on `MAIN`: the matcher
 *  cannot place the jump between two parallel carriageways and returns null, so
 *  this is the "matcher declines" branch — the gate never runs at all. */
const NEAR_PARALLEL: Fix[] = [
	f(3000, P(0, 0)),
	f(3060, P(100, 55)),
	f(3120, P(200, 55)),
	f(3180, P(300, 55)),
	f(3240, P(400, 55)),
	f(3300, P(500, 55)),
];

/** A lone teleport out and back: `rejectSpikes` drops the middle fix, so the
 *  matcher sees five, not six. */
const SPIKED: Fix[] = [
	f(4000, P(0, 0)),
	f(4060, P(100, 0)),
	f(4120, P(120, 900)),
	f(4180, P(200, 0)),
	f(4240, P(300, 0)),
	f(4300, P(400, 0)),
];

/** Four fixes of which two exceed the cycling cap: after the filter only two
 *  remain, which is under `MIN_LEG_FIXES`. */
const FAST_CYCLE: Fix[] = [
	f(5000, P(0, 0), 12),
	f(5060, P(100, 0), 40),
	f(5120, P(200, 0), 44),
	f(5180, P(300, 0), 15),
];

/** The same four fixes as a BUS leg: `MAX_SPEED_FOR_MODE` has no bus entry, so
 *  every one survives however fast. */
const FAST_BUS: Fix[] = FAST_CYCLE.map((p) => ({ ...p }));

/** The corner-following leg with a lone teleport spliced into the middle at a
 *  timestamp the surviving fixes do not use. `rejectSpikes` drops it, so `clean`
 *  is EXACTLY `CORNER_TIGHT` again — same corridor reads, same matcher key, same
 *  accepted match. Feeding the matcher the unfiltered `plausible` set instead
 *  would change its input and lose the match, which is what makes this the
 *  fixture that separates the two. */
const CORNER_SPIKED: Fix[] = [
	f(8000, P(0, 0)),
	f(8060, P(0, 200)),
	f(8120, P(0, 350)),
	f(8150, P(2000, 3000)),
	f(8180, P(200, 400)),
	f(8240, P(350, 400)),
	f(8300, P(400, 400)),
];

/** One fix sits EXACTLY on the 35 km/h cycling cap. Under `<=` four fixes
 *  survive and the leg reads; under `<` three do and it bails before any read.
 *  The bar's inclusivity is not otherwise observable — no real speed lands on
 *  a whole number by accident. */
const CAP_EXACT: Fix[] = [
	f(9000, P(0, 0), 12),
	f(9060, P(100, 0), 35),
	f(9120, P(200, 0), 12),
	f(9180, P(300, 0), 12),
];

/** Three fixes — under `MIN_LEG_FIXES` before anything else runs, so the leg
 *  makes NO mirror read at all. */
const TOO_FEW: Fix[] = [f(6000, P(0, 0)), f(6060, P(100, 0)), f(6120, P(200, 0))];

/** Off in a field 20 km east: the mirror answers with nothing, so the leg
 *  bails after exactly one read and never reaches the matcher. */
const NOWHERE: Fix[] = Array.from({ length: 5 }, (_, i) => f(7000 + i * 60, P(i * 100, 20_000)));

/* ------------------------------------------------------------------ *
 * Scenarios
 * ------------------------------------------------------------------ */

/** `pointsLit` is the Lean expression naming the same fix array, so a scenario
 *  and its guard cannot drift apart silently. */
type Scenario = { id: string; note: string; segs: Seg[]; points: Fix[]; pointsLit: string };

const SCENARIOS: Scenario[] = [
	{
		id: "S1",
		note: "a walking leg is not a road mode — untouched, and it reads nothing",
		segs: [seg(2000, 2300, "walking")],
		points: CORNER_CUT,
		pointsLit: "CORNER_CUT",
	},
	{
		id: "S2",
		note: "three in-window fixes: under MIN_LEG_FIXES before any read",
		segs: [seg(6000, 6120, "driving")],
		points: TOO_FEW,
		pointsLit: "TOO_FEW",
	},
	{
		id: "S3",
		note: "the p85 stray bar is the SOLE blocker: 95 m off-road, match 60 m away",
		segs: [seg(2000, 2300, "driving")],
		points: CORNER_CUT,
		pointsLit: "CORNER_CUT",
	},
	{
		id: "S4",
		note: "the same leg as bus: same verdict, so the mode only gates eligibility",
		segs: [seg(2000, 2300, "bus")],
		points: CORNER_CUT,
		pointsLit: "CORNER_CUT",
	},
	{
		id: "S5",
		note: "refinedMode makes a walking-classified leg eligible",
		segs: [seg(2000, 2300, "walking", "driving")],
		points: CORNER_CUT,
		pointsLit: "CORNER_CUT",
	},
	{
		id: "S6",
		note: "refinedMode takes a driving-classified leg OUT of scope",
		segs: [seg(2000, 2300, "driving", "walking")],
		points: CORNER_CUT,
		pointsLit: "CORNER_CUT",
	},
	{
		id: "S7",
		note: "a 3.4 km run on the carriageway — the corridor arm, many reads",
		segs: [seg(1000, 2020, "driving")],
		points: LONG_ONROAD,
		pointsLit: "LONG_ONROAD",
	},
	{
		id: "S8",
		note: "the matcher declines outright — the gate never runs",
		segs: [seg(3000, 3300, "driving")],
		points: NEAR_PARALLEL,
		pointsLit: "NEAR_PARALLEL",
	},
	{
		id: "S9",
		note: "a lone teleport: the matcher sees the despiked five, not six",
		segs: [seg(4000, 4300, "driving")],
		points: SPIKED,
		pointsLit: "SPIKED",
	},
	{
		id: "S10",
		note: "cycling caps at 35 km/h — two fixes survive, under MIN_LEG_FIXES",
		segs: [seg(5000, 5180, "cycling")],
		points: FAST_CYCLE,
		pointsLit: "FAST_CYCLE",
	},
	{
		id: "S11",
		note: "the same fixes as bus: no cap entry, so all four survive",
		segs: [seg(5000, 5180, "bus")],
		points: FAST_BUS,
		pointsLit: "FAST_CYCLE",
	},
	{
		id: "S12",
		note: "empty corridor: one read, then a bail before the matcher",
		segs: [seg(7000, 7240, "driving")],
		points: NOWHERE,
		pointsLit: "NOWHERE",
	},
	{
		id: "S13",
		note: "two legs — the trace is leg-by-leg, not interleaved",
		segs: [seg(2000, 2300, "driving"), seg(3000, 3300, "driving")],
		points: [...CORNER_CUT, ...NEAR_PARALLEL],
		pointsLit: "(CORNER_CUT ++ NEAR_PARALLEL)",
	},
	{
		id: "S14",
		note: "an ineligible leg between two eligible ones contributes no reads",
		segs: [seg(2000, 2300, "driving"), seg(6000, 6120, "driving"), seg(3000, 3300, "driving")],
		points: [...CORNER_CUT, ...TOO_FEW, ...NEAR_PARALLEL],
		pointsLit: "(CORNER_CUT ++ TOO_FEW ++ NEAR_PARALLEL)",
	},
	{
		id: "S15",
		note: "the window is INCLUSIVE at both ends: a boundary fix is in",
		segs: [seg(2060, 2240, "driving")],
		points: CORNER_CUT,
		pointsLit: "CORNER_CUT",
	},
	{
		id: "S16",
		note: "all three bars clear — the pass attaches a matchedPath",
		segs: [seg(8000, 8300, "driving")],
		points: CORNER_TIGHT,
		pointsLit: "CORNER_TIGHT",
	},
	{
		id: "S17",
		note: "the accepting leg beside a rejecting one: only the first is rewritten",
		segs: [seg(8000, 8300, "driving"), seg(2000, 2300, "driving")],
		points: [...CORNER_TIGHT, ...CORNER_CUT],
		pointsLit: "(CORNER_TIGHT ++ CORNER_CUT)",
	},
	{
		id: "S18",
		note: "a spike inside the accepting leg: despiked, so the match still lands",
		segs: [seg(8000, 8300, "driving")],
		points: CORNER_SPIKED,
		pointsLit: "CORNER_SPIKED",
	},
	{
		id: "S19",
		note: "a fix exactly ON the cycling cap survives — the bar is inclusive",
		segs: [seg(9000, 9180, "cycling")],
		points: CAP_EXACT,
		pointsLit: "CAP_EXACT",
	},
];

/* ------------------------------------------------------------------ *
 * Reconstruct what the pass hands its leaves, and self-check
 * ------------------------------------------------------------------ */

type LegTrace = {
	clean: Fix[];
	fixes: MPt[];
	ways: Way[];
	match: MPt[] | null;
	decision: { use: boolean; rawOffRoadM: number; matchedOffRoadM: number; strayM: number } | null;
};

/** Replay one leg exactly as `annotateRoadMatches` does, using the same
 *  exported leaves, so the recorded matcher input is the pass's own. */
const replayLeg = async (s: Seg, points: Fix[]): Promise<LegTrace | null> => {
	const mode = SU.effectiveMode(s);
	if (!["driving", "bus", "cycling"].includes(mode)) return null;
	const cap = MB.MAX_SPEED_FOR_MODE[mode];
	const windowFixes = SU.samplesInWindow(points, s);
	const plausible = cap === undefined ? windowFixes : windowFixes.filter((p: Fix) => p.speed_kmh <= cap);
	const clean = EG.rejectSpikes(plausible);
	if (clean.length < 4) return null;
	const ways = await OC.corridorWays(
		clean.map((p: Fix) => ({ lat: p.lat, lon: p.lon })),
		(la: number, lo: number, r: number) => osm.drivableRoads(la, lo, r),
		700,
		50,
	);
	if (ways.length === 0) return { clean, fixes: [], ways, match: null, decision: null };
	const fixes: MPt[] = clean.map((p: Fix) => ({ lat: p.lat, lon: p.lon, ts: p.ts }));
	const result = RM.matchRoadSegment(fixes, { ways });
	if (!result) return { clean, fixes, ways, match: null, decision: null };
	const decision = MMC.matchImprovesDisplay(fixes, result.path, { ways }, 25, 40);
	return { clean, fixes, ways, match: result.path, decision };
};

type Run = { sc: Scenario; reads: Read[]; legs: Array<LegTrace | null>; result: Seg[] };
const RUNS: Run[] = [];

for (const sc of SCENARIOS) {
	reads = [];
	const result = await RMA.annotateRoadMatches(sc.segs, sc.points, osm);
	const passReads = reads;

	reads = [];
	const legs: Array<LegTrace | null> = [];
	for (const s of sc.segs) legs.push(await replayLeg(s, sc.points));
	const replayReads = reads;

	// The replay must be the pass, not a model of it: same reads, same output.
	const key = (rs: Read[]): string => rs.map((r) => `${r.lat},${r.lon},${r.radiusM}`).join("|");
	if (key(passReads) !== key(replayReads)) {
		console.error(`FAIL ${sc.id}: replay read trace differs from the pass's`);
		console.error(`  pass:   ${key(passReads)}`);
		console.error(`  replay: ${key(replayReads)}`);
		process.exit(1);
	}
	for (let i = 0; i < sc.segs.length; i++) {
		const wantPath = legs[i]?.decision?.use ? legs[i]?.match : undefined;
		const gotPath = result[i].matchedPath;
		const same = wantPath === undefined ? gotPath === undefined : JSON.stringify(wantPath) === JSON.stringify(gotPath);
		if (!same) {
			console.error(`FAIL ${sc.id} leg ${i}: replay verdict differs from the pass's output`);
			process.exit(1);
		}
	}
	RUNS.push({ sc, reads: passReads, legs, result });
}

/* ------------------------------------------------------------------ *
 * Measurement: does `sqrt(dx²+dy²)` diverge from `Math.hypot` here?
 * ------------------------------------------------------------------ */

const hypotVsSqrt = (): { calls: number; diffs: number; worstUlpDeg: number } => {
	let calls = 0;
	let diffs = 0;
	let worst = 0;
	const probe = (a: LL, b: LL): void => {
		const dLat = (b.lat - a.lat) * 111_320;
		const dLon = (b.lon - a.lon) * 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
		const h = Math.hypot(dLat, dLon);
		const s = Math.sqrt(dLat * dLat + dLon * dLon);
		calls++;
		if (h !== s) {
			diffs++;
			worst = Math.max(worst, Math.abs(h - s));
		}
	};
	for (const run of RUNS) {
		for (const leg of run.legs) {
			if (!leg) continue;
			const t = leg.clean.map((p) => ({ lat: p.lat, lon: p.lon }));
			for (let i = 1; i < t.length; i++) probe(t[i - 1], t[i]);
			const c = {
				lat: t.reduce((a, p) => a + p.lat, 0) / t.length,
				lon: t.reduce((a, p) => a + p.lon, 0) / t.length,
			};
			for (const p of t) probe(c, p);
		}
	}
	return { calls, diffs, worstUlpDeg: worst };
};
const HVS = hypotVsSqrt();

/* ------------------------------------------------------------------ *
 * Emit — OsmCorridor
 * ------------------------------------------------------------------ */

const emitPt = (p: LL): string => `p ${lf(p.lat)} ${lf(p.lon)}`;
const emitPts = (ps: LL[]): string => `#[${ps.map(emitPt).join(", ")}]`;
/** One line per way: Lean's structure-instance fields must sit to the RIGHT of
 *  the opening brace, so a wrapped `coords :=` would not parse. */
const emitWay = (wy: Way): string =>
	`{ osmId := ${li(wy.osmId)}, name := ${lopt(wy.name)}, subtype := ${lopt(wy.subtype)}, coords := ${emitPts(wy.coords.map(([la, lo]) => ({ lat: la, lon: lo })))} }`;

w("@@@FILE Verified/Geo/OsmCorridor.lean");
w("/-! ## Guards (V8 reference values)");
w("");
w("Every number below is `lean/experiments/road-match-annotate-refs.mts`'s output");
w("on the same fixture, transcribed at V8's own precision.");
w("");
w("The `metersBetween` wobble is MEASURED, not assumed: across every distance");
w(`this file's fixtures compute, \`Math.hypot\` and \`sqrt(dx² + dy²)\` agreed on`);
w(`${HVS.calls - HVS.diffs} of ${HVS.calls} calls, worst disagreement ${HVS.worstUlpDeg} m. The`);
w("sample positions are therefore pinned exactly, not approximately — but the");
w("guards still compare through `approx`, because that agreement is a fact about");
w("these magnitudes, not a theorem.");
w("-/");
w("");
w("section Guards");
w("");
w("private def approx (a b : Float) : Bool := Float.abs (a - b) < 1e-9");
w("private def p (la lo : Float) : Pt := ⟨la, lo⟩");
w("private def approxPt (a b : Pt) : Bool := approx a.lat b.lat && approx a.lon b.lon");
w("private def approxPts (a b : Array Pt) : Bool :=");
w("  a.size == b.size && (Array.range a.size).all fun i => approxPt a[i]! b[i]!");
w("private def approxRead (a b : Read) : Bool :=");
w("  approx a.lat b.lat && approx a.lon b.lon && approx a.radiusM b.radiusM");
w("private def approxReads (a b : Array Read) : Bool :=");
w("  a.size == b.size && (Array.range a.size).all fun i => approxRead a[i]! b[i]!");
w("private def r (la lo rad : Float) : Read := ⟨la, lo, rad⟩");
w("");

/* --- resamplePolyline cases --- */

type ResampleCase = { id: string; note: string; track: LL[]; step: number; maxSamples?: number };
const RESAMPLE: ResampleCase[] = [
	{ id: "R1", note: "an empty track resamples to nothing", track: [], step: 700 },
	{ id: "R2", note: "one vertex is copied, not measured", track: [P(0, 0)], step: 700 },
	{
		id: "R3",
		note: "a track shorter than one step keeps only its two endpoints",
		track: [P(0, 0), P(300, 0)],
		step: 700,
	},
	{
		id: "R4",
		note: "3.4 km at 700 m: five walked samples, then the far end pushed",
		track: Array.from({ length: 18 }, (_, i) => P(i * 200, 0)),
		step: 700,
	},
	{
		id: "R5",
		note: "a repeated vertex contributes no length and is skipped entirely",
		track: [P(0, 0), P(400, 0), P(400, 0), P(800, 0)],
		step: 300,
	},
	{
		id: "R6",
		note: "the last vertex is NOT pushed when a sample already landed within 1 m",
		track: [P(0, 0), P(600, 0)],
		step: 300,
	},
	{
		id: "R7",
		note: "48 km at 700 m: the cap widens the step instead of firing 68 queries",
		track: Array.from({ length: 25 }, (_, i) => P(i * 2000, 0)),
		step: 700,
	},
	{
		id: "R8",
		note: "a two-vertex L — the samples interpolate inside each leg, not across",
		track: [P(0, 0), P(0, 1000), P(1000, 1000)],
		step: 400,
	},
	{
		id: "R9",
		note: "maxSamples = 2 forces one step for the whole track",
		track: Array.from({ length: 6 }, (_, i) => P(i * 200, 0)),
		step: 100,
		maxSamples: 2,
	},
	{
		id: "R10",
		note: "the far end sits 0.5 m past the last sample — under the 1 m bar, NOT pushed",
		track: [P(0, 0), P(600.5, 0)],
		step: 300,
		maxSamples: 48,
	},
	{
		id: "R11",
		note: "…and 1.5 m past it, over the bar, so it IS pushed",
		track: [P(0, 0), P(601.5, 0)],
		step: 300,
		maxSamples: 48,
	},
	{
		// `step` is the segment's OWN measured length, so the walk's first
		// `nextAt` lands exactly on `acc + segLen`. That equality is what
		// separates `<=` from `<`; it is not reachable by choosing a round
		// number, only by measuring one.
		id: "R12",
		note: "nextAt lands EXACTLY on the segment end (see the unpinned note below)",
		track: [P(0, 0), P(600, 0)],
		step: exactSegLen(P(0, 0), P(600, 0)),
		maxSamples: 48,
	},
];

w("/-! ### `resamplePolyline` -/");
w("");
for (const c of RESAMPLE) {
	const got = OC.resamplePolyline(c.track, c.step, c.maxSamples);
	const args = c.maxSamples === undefined ? "" : ` ${c.maxSamples}`;
	w(`-- ${c.id}: ${c.note}`);
	w(`private def ${c.id}_TRACK : Array Pt := ${emitPts(c.track)}`);
	w(`#guard (resamplePolyline ${c.id}_TRACK ${lf(c.step)}${args}).size == ${got.length}`);
	w(`#guard approxPts (resamplePolyline ${c.id}_TRACK ${lf(c.step)}${args}) ${emitPts(got)}`);
	w("");
}

/* --- corridorWays cases --- */

type CorridorCase = { id: string; note: string; track: LL[]; step: number; radius: number };
const CORRIDOR: CorridorCase[] = [
	{ id: "C1", note: "an empty track reads nothing at all", track: [], step: 700, radius: 50 },
	{
		id: "C2",
		note: "a short leg: ONE centroid disc, radius Math.round(maxDist + 150)",
		track: CORNER_CUT.map((p) => ({ lat: p.lat, lon: p.lon })),
		step: 700,
		radius: 50,
	},
	{
		id: "C3",
		note: "a 3.4 km leg: the corridor arm, one disc per resampled sample",
		track: LONG_ONROAD.map((p) => ({ lat: p.lat, lon: p.lon })),
		step: 700,
		radius: 50,
	},
	{
		id: "C4",
		note: "just inside the single-disc bar (max fix-to-centroid 599.4 m)",
		track: [P(-599, 0), P(0, 0), P(599, 0)],
		step: 700,
		radius: 50,
	},
	{
		id: "C5",
		note: "just past it (601.5 m) — the same shape takes the corridor arm",
		track: [P(-601, 0), P(0, 0), P(601, 0)],
		step: 700,
		radius: 50,
	},
	{
		id: "C6",
		note: "the single-disc arm does NOT dedupe — it returns the query verbatim",
		track: [P(1400, -50), P(1400, 0), P(1400, 50)],
		step: 700,
		radius: 50,
	},
];

/**
 * A two-point N-S track whose max fix-to-centroid distance is EXACTLY the
 * 600 m arm bar, found by sweeping the far endpoint one latitude ULP at a time.
 *
 * Why search instead of picking a round number: at 600 m one latitude ULP moves
 * the distance by ~7.9e-10 m while the output's own ULP is ~1.14e-13 m, so each
 * input step skips ~6900 representable outputs — landing on 600.0 exactly is
 * not something a round coordinate does. The sweep also requires `Math.hypot`
 * and `sqrt(dx² + dy²)` to BOTH give 600, because the Lean arm computes the
 * second and the guard has to hold for it too.
 */
const findExactArmBar = (): {
	track: LL[] | null;
	scanned: number;
	distinct: number;
	below: number;
	above: number;
} => {
	const buf = new ArrayBuffer(8);
	const f64 = new Float64Array(buf);
	const u64 = new BigUint64Array(buf);
	const bump = (x: number, k: number): number => {
		f64[0] = x;
		u64[0] = u64[0] + BigInt(k);
		return f64[0];
	};
	const sqrtLen = (a: LL, b: LL): number => {
		const dLat = (b.lat - a.lat) * 111_320;
		const dLon = (b.lon - a.lon) * 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
		return Math.sqrt(dLat * dLat + dLon * dLon);
	};
	const a = { lat: LAT0, lon: LON0 };
	const base = LAT0 + 1200 / 111_320;
	const LIMIT = 4_000_000;
	const seen = new Set<number>();
	let below = Number.NEGATIVE_INFINITY;
	let above = Number.POSITIVE_INFINITY;
	for (let k = 0; k < LIMIT; k++) {
		const step = k % 2 === 0 ? k / 2 : -(k + 1) / 2;
		const b = { lat: bump(base, step), lon: LON0 };
		const c = { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
		const h = Math.max(exactSegLen(c, a), exactSegLen(c, b));
		seen.add(h);
		if (h < 600 && h > below) below = h;
		if (h > 600 && h < above) above = h;
		if (h !== 600) continue;
		const s = Math.max(sqrtLen(c, a), sqrtLen(c, b));
		if (s !== 600) continue;
		return { track: [a, b], scanned: k + 1, distinct: seen.size, below, above };
	}
	return { track: null, scanned: LIMIT, distinct: seen.size, below, above };
};
const ARM_BAR = findExactArmBar();
const EXACT_BAR = ARM_BAR.track === null ? null : { track: ARM_BAR.track, scanned: ARM_BAR.scanned };
if (EXACT_BAR) {
	CORRIDOR.push({
		id: "C7",
		note: `max fix-to-centroid is EXACTLY 600 m (found after ${EXACT_BAR.scanned} ULP steps) — the bar is inclusive`,
		track: EXACT_BAR.track,
		step: 700,
		radius: 50,
	});
}

w("/-! ### `corridorWays` — the arm choice, the read trace, the union -/");
w("");
w("private def wy (id : Int) (name subtype : String) (cs : Array Pt) : Way :=");
w("  { osmId := id, name := some name, subtype := some subtype, coords := cs }");
w("");

/** Collect every distinct read across the corridor cases and the pass runs. */
const ORACLE = new Map<string, Read>();
const rkey = (r: { lat: number; lon: number; radiusM: number }): string => `${r.lat}|${r.lon}|${r.radiusM}`;

for (const c of CORRIDOR) {
	reads = [];
	const got = await OC.corridorWays(
		c.track,
		(la: number, lo: number, rr: number) => osm.drivableRoads(la, lo, rr),
		c.step,
		c.radius,
	);
	const trace = reads;
	for (const rd of trace) if (!ORACLE.has(rkey(rd))) ORACLE.set(rkey(rd), rd);
	(c as CorridorCase & { got: Way[]; trace: Read[] }).got = got;
	(c as CorridorCase & { got: Way[]; trace: Read[] }).trace = trace;
}
for (const run of RUNS) for (const rd of run.reads) if (!ORACLE.has(rkey(rd))) ORACLE.set(rkey(rd), rd);

/** The oracle table, emitted once and shared by both modules' guards. */
const emitOracle = (indent: string): string[] => {
	const lines: string[] = [];
	lines.push(`${indent}private structure RoadsEntry where`);
	lines.push(`${indent}  lat : Float`);
	lines.push(`${indent}  lon : Float`);
	lines.push(`${indent}  radiusM : Float`);
	lines.push(`${indent}  ways : Array Way`);
	lines.push("");
	lines.push(`${indent}/-- Every \`(lat, lon, radius)\` the V8 arm was asked about, with its answer.`);
	lines.push(`${indent}A query this table does not hold is a query the reference arm never made —`);
	lines.push(`${indent}it comes back EMPTY, which shows up as a leg that bails. -/`);
	lines.push(`${indent}private def ROADS : Array RoadsEntry := #[`);
	const entries = [...ORACLE.values()];
	entries.forEach((rd, i) => {
		const tail = i === entries.length - 1 ? "" : ",";
		lines.push(`${indent}  { lat := ${lf(rd.lat)}, lon := ${lf(rd.lon)}, radiusM := ${lf(rd.radiusM)},`);
		lines.push(`${indent}    ways := #[${rd.ways.map((wy) => `\n${indent}      ${emitWay(wy)}`).join(",")}] }${tail}`);
	});
	lines.push(`${indent}]`);
	lines.push("");
	lines.push(`${indent}private def stubRoads (la lo rad : Float) : Array Way :=`);
	lines.push(`${indent}  match ROADS.find? fun e => approx e.lat la && approx e.lon lo && approx e.radiusM rad with`);
	lines.push(`${indent}  | some e => e.ways`);
	lines.push(`${indent}  | none => #[]`);
	return lines;
};

for (const line of emitOracle("")) w(line);
w("");

for (const c of CORRIDOR) {
	const cc = c as CorridorCase & { got: Way[]; trace: Read[] };
	w(`-- ${c.id}: ${c.note}`);
	w(`private def ${c.id}_TRACK : Array Pt := ${emitPts(c.track)}`);
	w(
		`private def ${c.id}_RUN := (corridorWays stubRoads ${c.id}_TRACK ${lf(c.step)} ${lf(c.radius)}).run #[]`,
	);
	w(`#guard approxReads ${c.id}_RUN.2 #[${cc.trace.map((rd) => `r ${lf(rd.lat)} ${lf(rd.lon)} ${lf(rd.radiusM)}`).join(", ")}]`);
	w(`#guard ${c.id}_RUN.1.map (·.osmId) == #[${cc.got.map((wy) => li(wy.osmId)).join(", ")}]`);
	w(`#guard ${c.id}_RUN.1.map (·.name) == #[${cc.got.map((wy) => lopt(wy.name)).join(", ")}]`);
	w("");
}

/* --- unionById --- */
w("/-! ### `unionById` — first record wins, insertion order kept -/");
w("");
{
	const a = [MAIN, CROSS];
	const b = [CROSS_DUP, PARALLEL];
	// The TS union is `Map.set` guarded by `!has`, i.e. first wins in insertion order.
	const byId = new Map<number, Way>();
	for (const wy of [...a, ...b]) if (!byId.has(wy.osmId)) byId.set(wy.osmId, wy);
	const got = [...byId.values()];
	w("private def U_A : Array Way := #[");
	w(`  ${emitWay(MAIN)},`);
	w(`  ${emitWay(CROSS)}]`);
	w("private def U_B : Array Way := #[");
	w(`  ${emitWay(CROSS_DUP)},`);
	w(`  ${emitWay(PARALLEL)}]`);
	w(`#guard (unionById U_A U_B).map (·.osmId) == #[${got.map((wy) => li(wy.osmId)).join(", ")}]`);
	w(`#guard (unionById U_A U_B).map (·.name) == #[${got.map((wy) => lopt(wy.name)).join(", ")}]`);
	w(`#guard (unionById #[] U_B).map (·.osmId) == #[${[...new Set(b.map((x) => x.osmId))].map(li).join(", ")}]`);
	w("");
}

/* --- jsRound --- */
w("/-! ### `Math.round` — halves go UP, towards +∞ -/");
w("");
for (const x of [0, 0.5, 1.5, 2.5, -0.5, -1.5, 399.4, 399.5, 400.5]) {
	w(`#guard jsRound ${lf(x)} == ${lf(Math.round(x))}`);
}
w("");
w("/-! ### Deliberately unpinned");
w("");
w("A mutation sweep over this module leaves four comparisons that no guard can");
w("distinguish. Each survives for a reason, not for want of a fixture.");
w("");
w("* **`nextAt ≤ acc + segLen` vs `<`.** When the walk lands exactly on a");
w("  segment's end, BOTH spellings emit that point: `≤` emits it as this");
w("  segment's `t = 1`, and `<` emits it as the next segment's `t = 0` — the");
w("  same coordinate, at the same position in the array, because the segments");
w("  share the vertex. On the FINAL segment `<` instead leaves it to the");
w("  endpoint push, which fires whenever the gap exceeds 1 m; the gap there is a");
w("  whole `step`, and every caller's step is 700 m. `R12` is the fixture that");
w("  lands on the boundary — its step is the segment's own MEASURED length, not");
w("  a round number — and it shows the two agreeing.");
w("* **`segLen > 0` vs `≥ 0`.** The zero-length branch can never iterate:");
w("  `nextAt > acc` holds on entry to every segment (it starts at `step > 0`");
w("  with `acc = 0`, and each segment exits with `nextAt > acc + segLen`), so a");
w("  segment of length zero fails `nextAt ≤ acc + 0` immediately. It becomes");
w("  reachable only at `step = 0`, which `max stepM …` cannot produce for a");
w("  caller passing a positive `stepM` — the only caller passes 700.");
w("* **`d > best` vs `d ≥ best`** in the farthest-fix fold. The two differ only");
w("  in which of two EQUAL values is retained, and the retained number is the");
w("  same either way.");
w(`* **\`maxDist ≤ 600\` vs \`<\`.** This one needs \`maxDist\` to be exactly 600.0,`);
w("  and a sweep of the two-point N-S family — the endpoint moved one latitude");
w(`  ULP at a time, ${ARM_BAR.scanned.toLocaleString("en-GB")} steps, ${ARM_BAR.distinct.toLocaleString("en-GB")} distinct distances — never landed on it.`);
w(`  The closest approaches were ${ARM_BAR.below} below and ${ARM_BAR.above} above.`);
w("  The reason is granularity: at 600 m one latitude ULP moves the distance by");
w("  ~7.9e-10 m while the result's own ULP is ~1.14e-13 m, so each input step");
w("  skips thousands of representable outputs. UNPINNED, and measured to be so.");
w("-/");
w("");
w("end Guards");
w("");

/* ------------------------------------------------------------------ *
 * Emit — RoadMatchAnnotate
 * ------------------------------------------------------------------ */

w("@@@FILE Verified/Geo/RoadMatchAnnotate.lean");
w("/-! ## Guards (V8 reference values)");
w("");
w("Every number below is `lean/experiments/road-match-annotate-refs.mts`'s output");
w("on the same fixture, transcribed at V8's own precision.");
w("");
w("The two shell values are ORACLE TABLES, not stubs that re-derive an answer.");
w("`stubRoads` holds every `(lat, lon, radius)` the V8 arm was actually asked");
w("about; `stubMatcher` holds every fix array the V8 matcher was actually handed.");
w("A query outside either table is a query this arm never made: the roads table");
w("answers EMPTY and the matcher table answers `MISS`, an off-Africa vertex that");
w("no output guard can accept. Neither can silently agree with a wrong caller.");
w("-/");
w("");
w("section Guards");
w("");
w("private def approx (a b : Float) : Bool := Float.abs (a - b) < 1e-9");
w("private def p (la lo : Float) : Pt := ⟨la, lo⟩");
w("private def m (la lo ts : Float) : MPt := ⟨la, lo, ts⟩");
w("private def fx (ts : Int) (la lo sp : Float) : Fix := ⟨ts, la, lo, sp⟩");
w("private def sg (a b : Int) (mode : Mode) (refined : Option Mode := none) : Seg :=");
w("  { startTs := a, endTs := b, mode := mode, refinedMode := refined }");
w("private def approxRead (a b : Verified.Geo.OsmCorridor.Read) : Bool :=");
w("  approx a.lat b.lat && approx a.lon b.lon && approx a.radiusM b.radiusM");
w("private def approxReads (a b : Array Verified.Geo.OsmCorridor.Read) : Bool :=");
w("  a.size == b.size && (Array.range a.size).all fun i => approxRead a[i]! b[i]!");
w("private def r (la lo rad : Float) : Verified.Geo.OsmCorridor.Read := ⟨la, lo, rad⟩");
w("private def approxM (a b : MPt) : Bool :=");
w("  approx a.lat b.lat && approx a.lon b.lon && approx a.ts b.ts");
w("private def approxPath : Option (Array MPt) → Option (Array MPt) → Bool");
w("  | none, none => true");
w("  | some a, some b => a.size == b.size && (Array.range a.size).all fun i => approxM a[i]! b[i]!");
w("  | _, _ => false");
w("private def approxOut (a b : Array Seg) : Bool :=");
w("  a.size == b.size && (Array.range a.size).all fun i =>");
w("    a[i]!.startTs == b[i]!.startTs && a[i]!.endTs == b[i]!.endTs");
w("      && a[i]!.mode == b[i]!.mode && a[i]!.refinedMode == b[i]!.refinedMode");
w("      && approxPath a[i]!.matchedPath b[i]!.matchedPath");
w("");
w("private def wy (id : Int) (name subtype : String) (cs : Array Pt) : Way :=");
w("  { osmId := id, name := some name, subtype := some subtype, coords := cs }");
w("");
for (const line of emitOracle("")) w(line);
w("");

/* --- the matcher oracle --- */
const MATCHES = new Map<string, { fixes: MPt[]; path: MPt[] | null }>();
const mkey = (fixes: MPt[]): string => fixes.map((x) => `${x.lat},${x.lon},${x.ts}`).join("|");
for (const run of RUNS) {
	for (const leg of run.legs) {
		if (!leg || leg.fixes.length === 0) continue;
		if (!MATCHES.has(mkey(leg.fixes))) MATCHES.set(mkey(leg.fixes), { fixes: leg.fixes, path: leg.match });
	}
}

const emitMPts = (ps: MPt[]): string => `#[${ps.map((x) => `m ${lf(x.lat)} ${lf(x.lon)} ${lf(x.ts)}`).join(", ")}]`;

w("private structure MatchEntry where");
w("  fixes : Array MPt");
w("  path : Option (Array MPt)");
w("");
w("/-- The answer a table MISS returns: a line 2 km southwest of every fixture,");
w("which no output guard accepts. It is deliberately LOCAL rather than at (0, 0)");
w("— `DisplayGate.NearGrid.nearestDist` scans rings outward to the occupied");
w("bounding box, so a null-island sentinel would make the gate scan ~90,000 rings");
w("(the same shape as #416, where a (0, 0) centroid met a spatial index).");
w("");
w("A miss is a second net, not the only one: the matcher key is derived from the");
w("same despiked fix set that builds the corridor track, so any divergence in the");
w("fixes already shows up in the READ TRACE guard before it reaches here. -/");
w("private def MISS : Array MPt := #[m 51.487 (-0.16) 0.0, m 51.487 (-0.159) 0.0]");
w("");
w("private def MATCHES : Array MatchEntry := #[");
{
	const entries = [...MATCHES.values()];
	entries.forEach((e, i) => {
		const tail = i === entries.length - 1 ? "" : ",";
		w(`  { fixes := ${emitMPts(e.fixes)},`);
		w(`    path := ${e.path === null ? "none" : `some ${emitMPts(e.path)}`} }${tail}`);
	});
}
w("]");
w("");
w("private def stubMatcher (fixes : Array MPt) (_ways : Array Way) : Option (Array MPt) :=");
w("  match MATCHES.find? fun e => e.fixes == fixes with");
w("  | some e => e.path");
w("  | none => some MISS");
w("");
w("private def ENV : Env := { drivableRoads := stubRoads, matcher := stubMatcher }");
w("");

/* --- the fix fixtures --- */
const FIXTURES: Array<[string, Fix[]]> = [
	["LONG_ONROAD", LONG_ONROAD],
	["CORNER_CUT", CORNER_CUT],
	["CORNER_TIGHT", CORNER_TIGHT],
	["CORNER_SPIKED", CORNER_SPIKED],
	["CAP_EXACT", CAP_EXACT],
	["NEAR_PARALLEL", NEAR_PARALLEL],
	["SPIKED", SPIKED],
	["FAST_CYCLE", FAST_CYCLE],
	["TOO_FEW", TOO_FEW],
	["NOWHERE", NOWHERE],
];
const emitFixes = (fs: Fix[]): string =>
	`#[${fs.map((x) => `fx ${li(x.ts)} ${lf(x.lat)} ${lf(x.lon)} ${lf(x.speed_kmh)}`).join(",\n    ")}]`;
for (const [name, fs] of FIXTURES) {
	w(`private def ${name} : Array Fix :=`);
	w(`  ${emitFixes(fs)}`);
}
w("");

/* --- the leaf-level guards --- */
w("/-! ### The fix pipeline — window, cap, despike -/");
w("");
{
	const cases: Array<[string, Fix[], number, number, string]> = [
		["CORNER_CUT", CORNER_CUT, 2000, 2300, "driving"],
		["CORNER_CUT", CORNER_CUT, 2060, 2240, "driving"],
		["SPIKED", SPIKED, 4000, 4300, "driving"],
		["FAST_CYCLE", FAST_CYCLE, 5000, 5180, "cycling"],
		["FAST_CYCLE", FAST_CYCLE, 5000, 5180, "bus"],
		["TOO_FEW", TOO_FEW, 6000, 6120, "driving"],
	];
	for (const [name, fs, a, b, mode] of cases) {
		const wf = SU.samplesInWindow(fs, { startTs: a, endTs: b });
		const cap = MB.MAX_SPEED_FOR_MODE[mode];
		const pl = cap === undefined ? wf : wf.filter((x: Fix) => x.speed_kmh <= cap);
		const cl = EG.rejectSpikes(pl);
		w(`-- ${name} ${a}-${b} as ${mode}: window ${wf.length} -> cap ${pl.length} -> despike ${cl.length}`);
		w(`#guard (samplesInWindow ${name} ${li(a)} ${li(b)}).size == ${wf.length}`);
		w(`#guard (despike ((samplesInWindow ${name} ${li(a)} ${li(b)}).filter fun q =>`);
		w(`  match speedCapFor ${ls(mode)} with | none => true | some c => q.speedKmh ≤ c)).map (·.ts)`);
		w(`  == #[${cl.map((x: Fix) => li(x.ts)).join(", ")}]`);
	}
	w("");
	for (const mode of ["driving", "bus", "cycling", "walking", "stationary"]) {
		const cap = MB.MAX_SPEED_FOR_MODE[mode];
		w(`#guard speedCapFor ${ls(mode)} == ${cap === undefined ? "none" : `some ${lf(cap)}`}`);
	}
	w("");
	for (const [mode, refined] of [
		["driving", undefined],
		["walking", "driving"],
		["driving", "walking"],
	] as Array<[string, string | undefined]>) {
		const s = seg(0, 1, mode, refined);
		w(
			`#guard effectiveMode (sg 0 1 ${ls(mode)} ${refined === undefined ? "none" : `(some ${ls(refined)})`}) == ${ls(SU.effectiveMode(s))}`,
		);
	}
	w("");
}

/* --- the scenario guards --- */
import * as RMA from "../../src/geo/road-match-annotate.js";
import * as OC from "../../src/geo/osm-corridor.js";
import * as RM from "../../src/geo/road-match.js";
import * as MMC from "../../src/geo/map-match-core.js";
import * as EG from "../../src/geo/episode-geometry.js";
import * as SU from "../../src/geo/segment-util.js";
import * as MB from "../../src/geo/mode-biometrics.js";
w("/-! ### The pass -/");
w("");
w("private def outOf (segs : Array Seg) (fixes : Array Fix) : Array Seg :=");
w("  annotateRoadMatches ENV segs fixes");
w("");

const emitSeg = (s: Seg, matched: MPt[] | undefined): string => {
	const base = `sg ${li(s.startTs)} ${li(s.endTs)} ${ls(s.mode)} ${s.refinedMode === undefined ? "none" : `(some ${ls(s.refinedMode)})`}`;
	if (matched === undefined) return base;
	return `{ ${base} with matchedPath := some ${emitMPts(matched)} }`;
};

for (const run of RUNS) {
	const { sc, reads: rd, result, legs } = run;
	w(`-- ${sc.id}: ${sc.note}`);
	const segsLit = `#[${sc.segs.map((s: Seg) => `sg ${li(s.startTs)} ${li(s.endTs)} ${ls(s.mode)} ${s.refinedMode === undefined ? "none" : `(some ${ls(s.refinedMode)})`}`).join(", ")}]`;
	const pointsLit = sc.pointsLit;
	w(`private def ${sc.id}_SEGS : Array Seg := ${segsLit}`);
	w(`private def ${sc.id}_FIXES : Array Fix := ${pointsLit}`);
	// The decisions, as a comment: what drove each leg's verdict.
	legs.forEach((leg, i) => {
		if (!leg) {
			w(`--   leg ${i}: ineligible or too sparse — no match attempted`);
			return;
		}
		if (leg.ways.length === 0) {
			w(`--   leg ${i}: empty corridor after ${1} read — no match attempted`);
			return;
		}
		if (leg.match === null) {
			w(`--   leg ${i}: matcher returned null`);
			return;
		}
		const d = leg.decision;
		w(
			`--   leg ${i}: use=${d?.use} rawOff=${d?.rawOffRoadM} matchedOff=${d?.matchedOffRoadM} stray=${d?.strayM}`,
		);
	});
	w(`#guard approxReads (readsOf ENV ${sc.id}_SEGS ${sc.id}_FIXES)`);
	w(`  #[${rd.map((x) => `r ${lf(x.lat)} ${lf(x.lon)} ${lf(x.radiusM)}`).join(",\n    ")}]`);
	w(`#guard approxOut (outOf ${sc.id}_SEGS ${sc.id}_FIXES) #[`);
	w(
		`  ${result.map((s: Seg, i: number) => emitSeg(sc.segs[i], s.matchedPath)).join(",\n  ")}]`,
	);
	w("");
}

w("/-! ### Deliberately unpinned");
w("");
w("One branch of this pass survives a mutation sweep, and it survives because it");
w("cannot change the answer:");
w("");
w("* **the `ways.isEmpty` bail.** Deleting it sends an empty corridor on to the");
w("  matcher and then to the gate — and the gate cannot accept there.");
w("  `matchImprovesDisplay` computes `rawOffRoadM` as the worst distance from the");
w("  drawn line to the network, which is 0 when there IS no network, and its");
w("  first conjunct needs `rawOffRoadM > 25`. `DisplayGate`'s own `dNoWays`");
w("  guard pins that. So the bail is a COST decision (do not run a matcher over");
w("  nothing) and not a correctness one, and no output guard can see it.");
w("");
w("What WOULD see it is a trace of matcher calls, the way the mirror reads are");
w("traced. That is not modelled: the matcher is a pure `Env` field, and giving");
w("it a call log would put a test-only channel into the pass's shape.");
w("-/");
w("");
w("end Guards");

console.log(out.join("\n"));
console.error(`hypot-vs-sqrt: ${HVS.calls} calls, ${HVS.diffs} disagreed, worst ${HVS.worstUlpDeg} m`);
