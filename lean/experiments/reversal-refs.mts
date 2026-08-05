#!/usr/bin/env -S npx tsx
/**
 * Reference-value generator for `src/geo/passes/reversal.ts`, ported into
 * `Verified/Geo/Reversal.lean`.
 *
 * The module is wholly pure — segments and fixes in, segments out, no OSM and
 * no async — so unlike the orchestrators of the OSM tranche nothing here is
 * injected and every leaf runs for real on both arms. What that buys is that
 * the guards below are the TS's own answers, not a stub's.
 *
 * The two private helpers (`turnaroundOf`, `statsOver`) and `localOffset` are
 * reachable only THROUGH the two exports, so they are pinned that way: the cut
 * timestamp is `splitReversingLegs`' first half's `endTs`, and the recomputed
 * per-half speeds are the halves' own fields. No test-only export was added.
 *
 * One case per conjunct, each passing every other gate — the rule the
 * `reconstructUndergroundJourney` sweep cost me when I ignored it.
 *
 * This generator emits the whole Lean guard BLOCK — comments, fixture defs and
 * `#guard` lines — and `splice.mjs` puts it into the module.
 *
 * Run: TMPDIR=/tmp npx tsx lean/experiments/reversal-refs.mts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

type Fix = { ts: number; lat: number; lon: number; speed_kmh: number; bearing: number; accuracy: number };
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
const ls = (s: string): string => JSON.stringify(s);
const lopt = (s: string | null | undefined): string => (s === null || s === undefined ? "none" : `some ${ls(s)}`);
const lb = (b: boolean): string => (b ? "true" : "false");
const larr = (xs: readonly string[]): string => `#[${xs.join(", ")}]`;

const out: string[] = [];
const w = (s = ""): void => {
	out.push(s);
};

/* ------------------------------------------------------------------ *
 * Synthetic geography
 *
 * A DIAGONAL corridor, deliberately: every earlier reversal fixture I sketched
 * ran due north, where `localOffset`'s x is identically zero and a lat/lon
 * transposition moves nothing. Running north-EAST makes both components
 * load-bearing.
 * ------------------------------------------------------------------ */

const LAT0 = 51.5308; // King's Cross, near enough
const LON0 = -0.1238;
const MLAT = 1 / 111_320;
const MLON = 1 / (111_320 * Math.cos((LAT0 * Math.PI) / 180));

/** A point `n` metres north and `e` metres east of the origin. */
const pt = (n: number, e: number): { lat: number; lon: number } => ({ lat: LAT0 + n * MLAT, lon: LON0 + e * MLON });

/** A fix on the corridor at distance `d` metres out along the north-east
 *  diagonal (45°), at time `ts` and speed `kmh`. */
const on = (ts: number, d: number, kmh: number): Fix => {
	const p = pt(d * Math.SQRT1_2, d * Math.SQRT1_2);
	return { ts, lat: p.lat, lon: p.lon, speed_kmh: kmh, bearing: 45, accuracy: 10 };
};

/** A fix at an explicit north/east offset — for the spike and the tangent. */
const at = (ts: number, n: number, e: number, kmh: number): Fix => {
	const p = pt(n, e);
	return { ts, lat: p.lat, lon: p.lon, speed_kmh: kmh, bearing: 45, accuracy: 10 };
};

const T0 = 1_751_000_000;

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** The 2026-07-07 shape: out 6 km, a platform wait, back to 400 m from the
 *  start. Motorised throughout except at the turnaround. */
const OUT_AND_BACK: Fix[] = [
	on(T0 + 0, 0, 55),
	on(T0 + 120, 1500, 70),
	on(T0 + 240, 3500, 75),
	on(T0 + 360, 5600, 60),
	on(T0 + 420, 6000, 30), // the furthest fix — still rolling in
	on(T0 + 450, 5990, 2), // stopped on the platform: the cut
	on(T0 + 600, 5980, 1),
	on(T0 + 720, 4200, 65),
	on(T0 + 840, 2000, 70),
	on(T0 + 960, 400, 50),
];

/** Same track, but the rider never drops below the 5 km/h disembark bar inside
 *  the 180 s settle window — so the cut falls back to the furthest fix. */
const NO_SETTLE: Fix[] = [
	on(T0 + 0, 0, 55),
	on(T0 + 120, 1500, 70),
	on(T0 + 240, 3500, 75),
	on(T0 + 360, 5600, 60),
	on(T0 + 420, 6000, 30), // furthest
	on(T0 + 450, 5990, 20), // still moving
	on(T0 + 600, 5980, 12),
	on(T0 + 640, 5000, 40), // first sub-5 fix is beyond +180 s anyway
	on(T0 + 720, 4200, 65),
	on(T0 + 840, 2000, 70),
	on(T0 + 960, 400, 50),
];

/** The rider settles at the far end but so late that the second half would be
 *  under a minute — the fallback to `far` that keeps both halves rides. */
const LATE_SETTLE: Fix[] = [
	on(T0 + 0, 0, 55),
	on(T0 + 120, 1500, 70),
	on(T0 + 240, 3500, 75),
	on(T0 + 360, 5600, 60),
	on(T0 + 420, 6000, 30), // furthest, at +420
	on(T0 + 560, 5990, 2), // settles at +560; leg ends +600, so 40 s < 60 s
	on(T0 + 580, 3000, 70),
	on(T0 + 590, 1500, 70),
	on(T0 + 600, 400, 50),
];

/** A lone far-flung GPS spike, 3 km off the corridor.
 *
 *  The module's own docstring says this is what the direction test exists to
 *  refuse — "the track approaches and leaves a spike on the same heading, so
 *  its arms do not oppose". MEASURED, that is not what happens: this fixture
 *  SPLITS. Reaching a spike and leaving it IS an out-and-back at the scale the
 *  arms read, so the arms oppose. A sweep of 345 spike geometries clearing both
 *  distance gates (`lean/experiments/reversal-refs.mts` sibling sweep: corridor
 *  length × along-track offset × lateral offset × index) found the direction
 *  test accepting ALL 345 and refusing none. It refuses LOOPS, not spikes —
 *  see `LOOP`. */
const SPIKE: Fix[] = [
	on(T0 + 0, 0, 55),
	on(T0 + 120, 700, 70),
	on(T0 + 240, 1300, 75),
	at(T0 + 300, 400, 3000, 80), // the spike: 3 km east, way off the diagonal
	on(T0 + 360, 1500, 60),
	on(T0 + 480, 900, 65),
	on(T0 + 600, 300, 50),
];

/** Out and back, but the return stops well short — it ends further out than
 *  half the span, so "it came back" is not a thing you can say about it. */
const SHORT_RETURN: Fix[] = [
	on(T0 + 0, 0, 55),
	on(T0 + 120, 2000, 70),
	on(T0 + 240, 4000, 75),
	on(T0 + 420, 6000, 30),
	on(T0 + 450, 5990, 2),
	on(T0 + 720, 5000, 65),
	on(T0 + 960, 4000, 50), // ends 4 km out of a 6 km span: 0.667 > 0.5
];

/** Out and back inside 1.2 km — a real reversal, but under the span bar, so it
 *  is a manoeuvre rather than a journey with a change in it. */
const TIGHT: Fix[] = [
	on(T0 + 0, 0, 55),
	on(T0 + 120, 600, 70),
	on(T0 + 240, 1200, 45),
	on(T0 + 300, 1190, 2),
	on(T0 + 480, 600, 65),
	on(T0 + 600, 100, 50),
];

/** The turnaround comes 30 s in — under the minimum half. Everything else about
 *  it is a clean reversal. */
const EARLY_TURN: Fix[] = [
	on(T0 + 0, 0, 55),
	on(T0 + 20, 3000, 75),
	on(T0 + 30, 6000, 30), // furthest, 30 s in
	on(T0 + 45, 5990, 2),
	on(T0 + 300, 3000, 70),
	on(T0 + 600, 400, 50),
];

/** The turnaround comes 30 s before the end — the mirror bar. */
const LATE_TURN: Fix[] = [
	on(T0 + 0, 0, 55),
	on(T0 + 200, 2000, 70),
	on(T0 + 400, 4000, 75),
	on(T0 + 570, 6000, 30), // furthest, 30 s from the end
	on(T0 + 580, 3000, 70),
	on(T0 + 590, 1000, 70),
	on(T0 + 600, 400, 50),
];

/** Three fixes: under the arity floor, and a clean reversal otherwise. */
const THREE: Fix[] = [on(T0 + 0, 0, 55), on(T0 + 300, 6000, 30), on(T0 + 600, 400, 50)];

/** A LOOP — a circle of radius 1200 m, back to where it started.
 *
 *  This is the shape `REVERSAL_COS_MAX` exists for, and the ONLY shape measured
 *  to reach it: a ride that ends where it began (so the return bar passes) and
 *  reaches 2.4 km out (so the span bar passes) but never doubles back, because
 *  at every point the track is turning gently. A Circle-line ride, a bus loop, a
 *  drive round a one-way system. Splitting it would invent an interchange that
 *  never happened.
 *
 *  Sampled every 30° — at 1200 m radius the 500 m arm is ~24° of arc, so the
 *  arms subtend ~48° and the cosine is comfortably positive. */
const LOOP: Fix[] = (() => {
	const R = 1200;
	const n = 12;
	const fs: Fix[] = [];
	for (let i = 0; i <= n; i++) {
		const a = (2 * Math.PI * i) / n;
		const p = pt(R - R * Math.cos(a), R * Math.sin(a));
		fs.push({ ts: T0 + i * 120, lat: p.lat, lon: p.lon, speed_kmh: i === 6 ? 2 : 60, bearing: 0, accuracy: 10 });
	}
	return fs;
})();

/* ------------------------------------------------------------------ *
 * Bracketing fixtures
 *
 * The first probe sweep came back with 24 of 57 mutations SILENT, and nearly
 * every one was a constant that no fixture STRADDLED: the span bar sat between
 * a 1199 m refusal and a 5992 m acceptance, so any value in that gulf behaved
 * identically. A control that does not cross a fixture value is
 * indistinguishable from a broken harness.
 *
 * So the bracketing rides are generated rather than hand-written — one builder,
 * one knob turned per fixture, each landing just either side of a bar.
 * ------------------------------------------------------------------ */

/** A canonical out-and-back with every bar exposed as a parameter. Outbound in
 *  three steps to the turnaround, an optional slow fix after it, then home. */
const ride = (o: {
	span: number; // metres out to the turnaround
	back: number; // metres from the origin at the last fix
	turnAt: number; // seconds from the start to the furthest fix
	endAt: number; // seconds from the start to the last fix
	settleAt?: number; // seconds AFTER the furthest fix at which a slow fix sits
	settleKmh?: number;
	dupAtTurn?: boolean; // a second fix sharing the turnaround's timestamp
	speeds?: [number, number, number, number, number]; // outbound ×3, return ×2
}): Fix[] => {
	const s = o.speeds ?? [55, 70, 75, 65, 50];
	const fs: Fix[] = [
		on(T0, 0, s[0]),
		on(T0 + Math.round(o.turnAt / 3), o.span / 3, s[1]),
		on(T0 + Math.round((2 * o.turnAt) / 3), (2 * o.span) / 3, s[2]),
		on(T0 + o.turnAt, o.span, 30),
	];
	if (o.dupAtTurn === true) fs.push(on(T0 + o.turnAt, o.span - 400, o.settleKmh ?? 2));
	if (o.settleAt !== undefined) fs.push(on(T0 + o.turnAt + o.settleAt, o.span - 10, o.settleKmh ?? 2));
	fs.push(on(T0 + Math.round((o.turnAt + o.endAt) / 2), (o.span + o.back) / 2, s[3]));
	fs.push(on(T0 + o.endAt, o.back, s[4]));
	return fs.filter((f, i) => i === 0 || f.ts > fs[i - 1].ts || (o.dupAtTurn === true && f.ts === fs[i - 1].ts));
};

/** Reaches 1400 m — under the 1500 m span bar, over a 1300 m one. */
const SPAN_1400 = ride({ span: 1400, back: 100, turnAt: 300, endAt: 600, settleAt: 30 });
/** Reaches 1600 m — over the bar, under a 2000 m one. */
const SPAN_1600 = ride({ span: 1600, back: 100, turnAt: 300, endAt: 600, settleAt: 30 });
/** Ends 2 km out of a 5 km span: 0.4 — under the half bar, over a 0.3 one. */
const RETURN_40 = ride({ span: 5000, back: 2000, turnAt: 300, endAt: 600, settleAt: 30 });
/** Turns 50 s in — under the 60 s half bar, over a 45 s one. */
const HALF_50 = ride({ span: 5000, back: 200, turnAt: 50, endAt: 600, settleAt: 20 });
/** Turns 65 s in — over the bar, under a 75 s one. */
const HALF_65 = ride({ span: 5000, back: 200, turnAt: 65, endAt: 600, settleAt: 20 });
/** Settles 150 s after the turnaround — inside the 180 s window, outside 120. */
const SETTLE_150 = ride({ span: 5000, back: 200, turnAt: 300, endAt: 900, settleAt: 150 });
/** Settles 250 s after it — outside the window, inside a 300 s one. */
const SETTLE_250 = ride({ span: 5000, back: 200, turnAt: 300, endAt: 900, settleAt: 250 });
/** The slow fix reads 4 km/h — under the 5 km/h bar, over a 3 km/h one. */
const STOP_4 = ride({ span: 5000, back: 200, turnAt: 300, endAt: 900, settleAt: 60, settleKmh: 4 });
/** EXACTLY 5 km/h. `< 5` excludes it, `≤ 5` would not — the strictness, pinned
 *  by a fixture value rather than by a coordinate, so no float search is
 *  needed. */
const STOP_EXACT = ride({ span: 5000, back: 200, turnAt: 300, endAt: 900, settleAt: 60, settleKmh: 5 });
/** The slow fix sits EXACTLY on the 180 s window edge. `≤` admits it, `<` does
 *  not, and the two produce different cuts. */
const SETTLE_EDGE = ride({ span: 5000, back: 200, turnAt: 300, endAt: 900, settleAt: 180 });
/** A DUPLICATE timestamp at the turnaround: a second, slow fix sharing the
 *  furthest fix's second, AND another slow fix a minute later.
 *
 *  The `settleAt` is what makes this discriminate. A shared-second fix alone
 *  does not: admitting it gives a cut at `far.ts`, which is where the cut would
 *  be anyway, so `≥` and `>` agree and the probe reads SILENT. With a second
 *  slow fix behind it, `≥` stops at the shared second and `>` walks past to the
 *  later one — two different cuts. */
const DUP_TURN = ride({
	span: 5000,
	back: 200,
	turnAt: 300,
	endAt: 900,
	dupAtTurn: true,
	settleAt: 60,
	settleKmh: 2,
});
/** Fractional speeds, so `Math.round(x*10)/10` is observable at all. Every
 *  earlier fixture used whole km/h, under which rounding is the identity. */
const FRACTIONAL = ride({
	span: 5000,
	back: 200,
	turnAt: 300,
	endAt: 900,
	settleAt: 30,
	speeds: [55.55, 70.25, 63.34, 48.96, 51.07],
});

/** Two fixes at the SAME distance from the origin — bit-equal, because the
 *  second is the first mirrored through the origin, not merely near it. The
 *  max-fold's `>` keeps the EARLIER; `≥` would keep the later and move the cut,
 *  so unlike a plain maximum this tie is observable. */
const EQUIDISTANT: Fix[] = (() => {
	const d = 5000;
	const a = pt(d * Math.SQRT1_2, d * Math.SQRT1_2);
	const b = pt(d * Math.SQRT1_2, -d * Math.SQRT1_2);
	return [
		on(T0, 0, 55),
		on(T0 + 100, 2000, 70),
		{ ts: T0 + 200, lat: a.lat, lon: a.lon, speed_kmh: 30, bearing: 45, accuracy: 10 },
		{ ts: T0 + 260, lat: b.lat, lon: b.lon, speed_kmh: 30, bearing: 45, accuracy: 10 },
		on(T0 + 500, 2000, 65),
		on(T0 + 800, 200, 50),
	];
})();

/** The approach CURVES: the track runs north for 3 km, turns west for 2 km,
 *  then comes back east into the pivot. Several fixes qualify as the in-arm and
 *  they point in different directions, so taking the FIRST rather than the LAST
 *  changes the measured approach. Every earlier fixture ran straight, where the
 *  two agree. */
const CURVED_APPROACH: Fix[] = [
	at(T0, 3000, 0, 60),
	at(T0 + 120, 3000, -2000, 60),
	at(T0 + 240, 1200, -2600, 60),
	at(T0 + 360, 0, -600, 60), // approaching the pivot from the west
	at(T0 + 480, 0, 0, 3), // the pivot
	at(T0 + 600, 0, -900, 60), // departs back west — opposes the LAST approach arm
	at(T0 + 720, 0, -2200, 60),
];

const FIXTURES: Array<[string, Fix[]]> = [
	["OUT_AND_BACK", OUT_AND_BACK],
	["NO_SETTLE", NO_SETTLE],
	["LATE_SETTLE", LATE_SETTLE],
	["SPIKE", SPIKE],
	["SHORT_RETURN", SHORT_RETURN],
	["TIGHT", TIGHT],
	["EARLY_TURN", EARLY_TURN],
	["LATE_TURN", LATE_TURN],
	["THREE", THREE],
	["LOOP", LOOP],
	["SPAN_1400", SPAN_1400],
	["SPAN_1600", SPAN_1600],
	["RETURN_40", RETURN_40],
	["HALF_50", HALF_50],
	["HALF_65", HALF_65],
	["SETTLE_150", SETTLE_150],
	["SETTLE_250", SETTLE_250],
	["STOP_4", STOP_4],
	["STOP_EXACT", STOP_EXACT],
	["SETTLE_EDGE", SETTLE_EDGE],
	["DUP_TURN", DUP_TURN],
	["FRACTIONAL", FRACTIONAL],
	["EQUIDISTANT", EQUIDISTANT],
	["CURVED_APPROACH", CURVED_APPROACH],
];

/** A leg over the whole of a fixture's window. `maxSpeed` is stated rather than
 *  derived: it is what the classifier recorded, and the pass reads THAT, not
 *  the fixes — which is a real distinction the guards pin. */
const leg = (fixes: Fix[], over: Partial<Seg> = {}): Seg => ({
	startTs: fixes[0].ts,
	endTs: fixes[fixes.length - 1].ts,
	mode: "train",
	confidence: 0.8,
	confidenceMargin: 2,
	avgSpeed: 50,
	maxSpeed: 75,
	linearity: 0.9,
	pointCount: fixes.length,
	...over,
});

/* ------------------------------------------------------------------ *
 * Emission helpers
 * ------------------------------------------------------------------ */

const emitFix = (f: Fix): string => `⟨${li(f.ts)}, ${lf(f.lat)}, ${lf(f.lon)}, ${lf(f.speed_kmh)}⟩`;
const emitFixes = (fs: readonly Fix[]): string => `#[${fs.map(emitFix).join(", ")}]`;

/** One line per segment: Lean's structure-instance fields must sit to the RIGHT
 *  of the opening brace, so a wrapped field would not parse. */
const emitSeg = (s: Seg): string =>
	`{ startTs := ${li(s.startTs)}, endTs := ${li(s.endTs)}, mode := ${ls(s.mode)}` +
	`, refinedMode := ${lopt(s.refinedMode)}` +
	`, avgSpeed := ${lf(s.avgSpeed ?? 0)}, maxSpeed := ${lf(s.maxSpeed ?? 0)}` +
	`, linearity := ${lf(s.linearity ?? 0.5)}, pointCount := ${li(s.pointCount ?? 0)}` +
	`, refinedReason := ${lopt(s.refinedReason)}` +
	`, refinedKinds := ${larr((s.refinedKinds ?? []).map(ls))} }`;

/** The projection the guards compare. Everything `splitReversingLegs` can
 *  change, and nothing it cannot — a wider tuple makes a mutation visible that
 *  a narrower one hides (the tranche-9 lesson), but a tuple carrying fields the
 *  pass copies verbatim just makes the guard longer. */
const proj = (s: Seg): string =>
	`(${li(s.startTs)}, ${li(s.endTs)}, ${li(s.pointCount)}, ${lf(s.avgSpeed)}, ${lf(s.maxSpeed)}` +
	`, ${lopt(s.refinedReason)}, ${larr((s.refinedKinds ?? []).map(ls))})`;

const projList = (segs: readonly Seg[]): string => `#[${segs.map(proj).join(", ")}]`;

/* ------------------------------------------------------------------ *
 * Guard block
 * ------------------------------------------------------------------ */

w("/-! ## Guards");
w();
w("GENERATED by `lean/experiments/reversal-refs.mts` — do not hand-edit. Every");
w("number below is V8's own answer from the real `src/geo/passes/reversal.ts`,");
w("transcribed at full precision.");
w("-/");
w();
w("namespace Guards");
w();

for (const [name, fixes] of FIXTURES) {
	w(`private def ${name} : Array PointF := ${emitFixes(fixes)}`);
}
w();

/* ---- the constants ---- */
w("-- The two EXPORTED constants, read by the rail-run pass as well as here.");
w(`#guard DIRECTION_ARM_M == ${lf(REV.DIRECTION_ARM_M)}`);
w(`#guard REVERSAL_COS_MAX == ${lf(REV.REVERSAL_COS_MAX)}`);
w();

/* ---- splitReversingLegs scenarios ---- */
type Scenario = { id: string; note: string; fixes: Fix[]; seg: Seg };

const SCENARIOS: Scenario[] = [
	{
		id: "S1",
		note: "the 2026-07-07 shape: out 6 km, platform wait, back. Splits at the SETTLED fix, not the furthest one — the furthest fix is 10 m further out and still rolling.",
		fixes: OUT_AND_BACK,
		seg: leg(OUT_AND_BACK),
	},
	{
		id: "S2",
		note: "never settles inside the 180 s window, so the cut falls back to the furthest fix.",
		fixes: NO_SETTLE,
		seg: leg(NO_SETTLE),
	},
	{
		id: "S3",
		note: "settles, but too late to leave a minute of ride behind it — falls back to `far` rather than slicing a tail off.",
		fixes: LATE_SETTLE,
		seg: leg(LATE_SETTLE),
	},
	{
		id: "S4",
		note: "a lone far-flung spike. The distance test ACCEPTS it (out 3 km, back to 300 m); only the direction test refuses, because the track approaches and leaves the spike on the same heading.",
		fixes: SPIKE,
		seg: leg(SPIKE),
	},
	{
		id: "S5",
		note: "the return stops 4 km out of a 6 km span — 0.667 of the way, over the half bar.",
		fixes: SHORT_RETURN,
		seg: leg(SHORT_RETURN),
	},
	{
		id: "S6",
		note: "a genuine reversal inside 1.2 km — under the span bar, so it is a manoeuvre, not a journey with a change in it.",
		fixes: TIGHT,
		seg: leg(TIGHT),
	},
	{
		id: "S7",
		note: "turnaround 30 s in: the first half would not be a ride.",
		fixes: EARLY_TURN,
		seg: leg(EARLY_TURN),
	},
	{
		id: "S8",
		note: "turnaround 30 s from the end: the mirror bar, on the second half.",
		fixes: LATE_TURN,
		seg: leg(LATE_TURN),
	},
	{ id: "S9", note: "three fixes — under the arity floor.", fixes: THREE, seg: leg(THREE) },
	{
		id: "S10",
		note: "a LOOP: out 2.4 km and back to the start, turning gently the whole way. The span and return bars both PASS — the direction test is the only thing refusing, and the only measured shape that reaches it.",
		fixes: LOOP,
		seg: leg(LOOP),
	},
	{
		id: "S11",
		note: "the same track the classifier called `stationary` — only a motorised leg is split.",
		fixes: OUT_AND_BACK,
		seg: leg(OUT_AND_BACK, { mode: "stationary" }),
	},
	{
		id: "S12",
		note: "`refinedMode` decides, not `mode`: a leg the classifier called `train` and a later pass refined to `stationary` is NOT split.",
		fixes: OUT_AND_BACK,
		seg: leg(OUT_AND_BACK, { refinedMode: "stationary" }),
	},
	{
		id: "S13",
		note: "peak 39.9 km/h — under the motorised bar. An out-and-back stroll is one walk.",
		fixes: OUT_AND_BACK,
		seg: leg(OUT_AND_BACK, { mode: "walking", maxSpeed: 39.9 }),
	},
	{
		id: "S14",
		note: "peak exactly 40 — the bar is `< 40`, so this one splits.",
		fixes: OUT_AND_BACK,
		seg: leg(OUT_AND_BACK, { maxSpeed: 40 }),
	},
	{
		id: "S15",
		note: "an existing reason and an existing kind: both halves APPEND rather than replace, and each half gets its OWN kind.",
		fixes: OUT_AND_BACK,
		seg: leg(OUT_AND_BACK, { refinedReason: "prior finding", refinedKinds: ["boarding-platform"] }),
	},
	{
		id: "S16",
		note: "`maxSpeed` is read off the SEGMENT, not derived from the fixes — the classifier's record is what the bar tests. Here the fixes peak at 75 and the record says 20, and the leg is left alone.",
		fixes: OUT_AND_BACK,
		seg: leg(OUT_AND_BACK, { maxSpeed: 20 }),
	},

	// ---- the bracketing pairs. Each constant gets a fixture just either side
	// ---- of it, because a bar with no fixture in reach of it is unpinned.
	{ id: "B1", note: "reaches 1400 m — under the span bar.", fixes: SPAN_1400, seg: leg(SPAN_1400) },
	{ id: "B2", note: "reaches 1600 m — over it. B1/B2 straddle 1500.", fixes: SPAN_1600, seg: leg(SPAN_1600) },
	{
		id: "B3",
		note: "ends 2 km out of a 5 km span — 0.4 of the way, under the half bar. With SHORT_RETURN's 0.667 above it, the fraction is straddled.",
		fixes: RETURN_40,
		seg: leg(RETURN_40),
	},
	{ id: "B4", note: "turns 50 s in — under the 60 s half bar.", fixes: HALF_50, seg: leg(HALF_50) },
	{ id: "B5", note: "turns 65 s in — over it. B4/B5 straddle 60.", fixes: HALF_65, seg: leg(HALF_65) },
	{
		id: "B6",
		note: "settles 150 s after the turnaround — inside the 180 s window, so the cut moves to the platform.",
		fixes: SETTLE_150,
		seg: leg(SETTLE_150),
	},
	{
		id: "B7",
		note: "settles 250 s after it — outside the window, so the cut stays at the furthest fix. B6/B7 straddle 180.",
		fixes: SETTLE_250,
		seg: leg(SETTLE_250),
	},
	{
		id: "B8",
		note: "the slow fix reads 4 km/h — under the 5 km/h disembark bar, over a 3 km/h one.",
		fixes: STOP_4,
		seg: leg(STOP_4),
	},
	{
		id: "B9",
		note: "EXACTLY 5 km/h. The test is `< 5`, so this fix does NOT count as stopped and the cut stays at the furthest fix — the strictness pinned by a fixture value rather than by hunting a coordinate.",
		fixes: STOP_EXACT,
		seg: leg(STOP_EXACT),
	},
	{
		id: "B10",
		note: "the slow fix sits EXACTLY on the 180 s window edge; `≤` admits it, so the cut moves.",
		fixes: SETTLE_EDGE,
		seg: leg(SETTLE_EDGE),
	},
	{
		id: "B11",
		note: "a DUPLICATE timestamp at the turnaround — a slow fix sharing the furthest fix's second. `p.ts ≥ far.ts` admits it.",
		fixes: DUP_TURN,
		seg: leg(DUP_TURN),
	},
	{
		id: "B12",
		note: "fractional speeds, so `Math.round(x*10)/10` is observable at all — every other fixture uses whole km/h, under which the rounding is the identity.",
		fixes: FRACTIONAL,
		seg: leg(FRACTIONAL),
	},
	{
		id: "B13",
		note: "two fixes the SAME distance from the origin. The max-fold keeps the EARLIER, so the cut lands on it; `≥` would keep the later one and move the cut — unlike a plain maximum, this tie is observable.",
		fixes: EQUIDISTANT,
		seg: leg(EQUIDISTANT),
	},
];

w("/-! Every scenario's whole output list, projected to the fields the pass can");
w("change. `statsOver` is pinned through the halves' own `pointCount` /");
w("`avgSpeed` / `maxSpeed` — the TS recomputes them per half rather than copying");
w("the leg's, so a half's peak is one that happened in ITS window. -/");
w();

function nameOf(fixes: Fix[]): string {
	const hit = FIXTURES.find(([, f]) => f === fixes);
	if (hit === undefined) throw new Error("unknown fixture array");
	return hit[0];
}

/**
 * WHICH gate decided this scenario — re-derived here in the TS's own order and
 * emitted into the guard comment.
 *
 * A hand-written note is how a fixture ends up refusing for the wrong reason
 * and pinning nothing; three of this session's first-draft notes were already
 * wrong (the spike, the tangent, and S3's cut). Deriving the verdict makes the
 * comment a measurement rather than a claim — and it CROSS-CHECKS the port,
 * because if this reconstruction and the real pass ever disagree about whether
 * a leg splits, the generator aborts below.
 */
const gateOf = (sc: Scenario): string => {
	const seg = sc.seg;
	const fixes = sc.fixes;
	const mode = seg.refinedMode ?? seg.mode;
	if (mode === "stationary") return "mode: not motorised";
	if (seg.maxSpeed < 40) return `peak: maxSpeed ${seg.maxSpeed} < 40`;
	const win = fixes.filter((p) => p.ts >= seg.startTs && p.ts <= seg.endTs);
	if (win.length < 4) return `arity: ${win.length} fixes < 4`;
	const origin = win[0];
	let far = win[0];
	let maxD = 0;
	for (const p of win) {
		const d = PS.haversineMeters(p.lat, p.lon, origin.lat, origin.lon);
		if (d > maxD) {
			maxD = d;
			far = p;
		}
	}
	if (maxD < 1500) return `span: reached only ${maxD.toFixed(0)} m < 1500`;
	const last = win[win.length - 1];
	const endD = PS.haversineMeters(last.lat, last.lon, origin.lat, origin.lon);
	if (endD >= maxD * 0.5) return `return: ended ${endD.toFixed(0)} m out of a ${maxD.toFixed(0)} m span`;
	if (far.ts - seg.startTs < 60) return `first half: ${far.ts - seg.startTs} s < 60`;
	if (seg.endTs - far.ts < 60) return `second half: ${seg.endTs - far.ts} s < 60`;
	if (!REV.reversesAtPoint(fixes, { ts: far.ts, lat: far.lat, lon: far.lon }, seg.startTs, seg.endTs))
		return "DIRECTION: the arms do not oppose";
	const settled = win.find((p) => p.ts >= far.ts && p.ts <= far.ts + 180 && p.speed_kmh < 5);
	if (settled === undefined) return `SPLITS at the furthest fix (+${far.ts - seg.startTs} s) — never settled`;
	if (seg.endTs - settled.ts < 60)
		return `SPLITS at the furthest fix (+${far.ts - seg.startTs} s) — settled too late (+${settled.ts - seg.startTs} s leaves ${seg.endTs - settled.ts} s)`;
	return `SPLITS at the settled fix (+${settled.ts - seg.startTs} s), ${((far.ts - seg.startTs) as number) === settled.ts - seg.startTs ? "which is also the furthest" : `not the furthest (+${far.ts - seg.startTs} s)`}`;
};

for (const sc of SCENARIOS) {
	const res = REV.splitReversingLegs([sc.seg], sc.fixes);
	const verdict = gateOf(sc);
	// The reconstruction above and the real pass must agree about whether the
	// leg split, or one of them is wrong and the comment is fiction.
	if (verdict.startsWith("SPLITS") !== (res.length === 2)) {
		console.error(`${sc.id}: gateOf says "${verdict}" but the pass returned ${res.length} segment(s)`);
		process.exit(1);
	}
	w(`-- ${sc.id}: ${sc.note}`);
	w(`--     MEASURED: ${verdict}`);
	w(`#guard (splitReversingLegs #[${emitSeg(sc.seg)}] ${nameOf(sc.fixes)}).map projSeg ==`);
	w(`  ${projList(res)}`);
	w();
}

/* ---- the multi-segment fold ---- */
{
	// Legs laid end to end on a single stream, each with its own disjoint window.
	const shift = (fs: Fix[], dt: number): Fix[] => fs.map((f) => ({ ...f, ts: f.ts + dt }));
	const a = TIGHT;
	const b = shift(OUT_AND_BACK, 2000);
	const c = shift(THREE, 4000);
	const stream = [...a, ...b, ...c];
	const segs = [leg(a), leg(b), leg(c)];
	const res = REV.splitReversingLegs(segs, stream);
	w("-- S17: three legs on one stream — only the middle one reverses, and the");
	w("-- pass preserves ORDER while growing the list from 3 to 4.");
	w(`private def S17_FIXES : Array PointF := ${emitFixes(stream)}`);
	w(`#guard (splitReversingLegs #[${segs.map(emitSeg).join(", ")}] S17_FIXES).map projSeg ==`);
	w(`  ${projList(res)}`);
	w();
}

/* ---- statsOver, through an empty half ---- */
{
	// A leg whose second half owns no fixes at all: the cut lands on the LAST
	// fix, and `samplesInWindow` is inclusive, so the second half owns exactly
	// that one fix. To reach the zero-fix arm the cut must fall strictly after
	// every fix — which `turnaroundOf` never produces. Recorded as unreachable
	// rather than guarded; see the module note.
}

/* ---- reversesAtPoint ---- */
w("/-! ### `reversesAtPoint` — the direction test, called directly. -/");
w();

type PointCase = { id: string; note: string; fixes: Fix[]; pivot: Fix; from: number; to: number };

const PIVOT_CASES: PointCase[] = [
	{
		id: "P1",
		note: "the real turnaround: arms oppose.",
		fixes: OUT_AND_BACK,
		pivot: OUT_AND_BACK[4],
		from: OUT_AND_BACK[0].ts,
		to: OUT_AND_BACK[OUT_AND_BACK.length - 1].ts,
	},
	{
		id: "P2",
		note: "the spike, and the answer is TRUE. The module docstring says a spike fails this test because the track leaves it on the same heading; it does not — the track must come BACK from a spike, and coming back is exactly what the arms read as opposing.",
		fixes: SPIKE,
		pivot: SPIKE[3],
		from: SPIKE[0].ts,
		to: SPIKE[SPIKE.length - 1].ts,
	},
	{
		id: "P3",
		note: "the far side of a loop: the track is turning, but over the 500 m arms it has turned only ~48°, nowhere near a doubling-back.",
		fixes: LOOP,
		pivot: LOOP[6],
		from: LOOP[0].ts,
		to: LOOP[LOOP.length - 1].ts,
	},
	{
		id: "P4",
		note: "the window CUTS OFF the approach: `fromTs` sits after every fix 500 m back, so the in-arm is unobserved and the answer is false. A test that cannot see is not evidence of a reversal.",
		fixes: OUT_AND_BACK,
		pivot: OUT_AND_BACK[4],
		from: OUT_AND_BACK[3].ts + 1,
		to: OUT_AND_BACK[OUT_AND_BACK.length - 1].ts,
	},
	{
		id: "P5",
		note: "the window cuts off the DEPARTURE — the mirror of P4.",
		fixes: OUT_AND_BACK,
		pivot: OUT_AND_BACK[4],
		from: OUT_AND_BACK[0].ts,
		to: OUT_AND_BACK[6].ts,
	},
	{
		id: "P6",
		note: "the pivot's own fix is EXCLUDED from both arms (`< pivot.ts` / `> pivot.ts`) — the two nearest fixes are inside the arm radius anyway, and the arms are read from the first fix at least 500 m out on each side.",
		fixes: OUT_AND_BACK,
		pivot: OUT_AND_BACK[5],
		from: OUT_AND_BACK[0].ts,
		to: OUT_AND_BACK[OUT_AND_BACK.length - 1].ts,
	},
	{
		id: "P9",
		note: "a CURVED approach: the track comes down from the north, swings west, and reaches the pivot heading east. Several fixes qualify as the in-arm and they point in different directions, so the LAST one — the nearest — is the approach, and taking the first instead reads a different heading. On a straight track the two agree, which is why no earlier fixture reached this.",
		fixes: CURVED_APPROACH,
		pivot: CURVED_APPROACH[4],
		from: CURVED_APPROACH[0].ts,
		to: CURVED_APPROACH[CURVED_APPROACH.length - 1].ts,
	},
];

for (const pc of PIVOT_CASES) {
	const got = REV.reversesAtPoint(pc.fixes, { ts: pc.pivot.ts, lat: pc.pivot.lat, lon: pc.pivot.lon }, pc.from, pc.to);
	w(`-- ${pc.id}: ${pc.note}`);
	w(
		`#guard reversesAtPoint ${nameOf(pc.fixes)} ⟨${li(pc.pivot.ts)}, ${lf(pc.pivot.lat)}, ${lf(pc.pivot.lon)}⟩ ${li(pc.from)} ${li(pc.to)} == ${lb(got)}`,
	);
	w();
}

/* ---- the arm radius, pinned on both sides ---- */
{
	// `far` is `>= DIRECTION_ARM_M`, so pinning the strictness needs a fix whose
	// haversine distance from the pivot is EXACTLY the bar. A coordinate landing
	// on a round metre is not findable (tranche 9/10: one latitude ULP moves the
	// output ~7.9e-10 m). The technique that DOES work is the OsmSpatial one
	// inverted: build the pair, measure it, and set the fixture's own numbers so
	// the reader can see which side of the bar each sits on.
	const pivot = pt(0, 0);
	const armFixes: Fix[] = [];
	// SOLVE for the offsets rather than assuming the metre conversion. The first
	// version of this fixture used `pt()`'s nominal metres and landed BOTH
	// candidates at 499.44 m — on the same side of the bar, so it bracketed
	// nothing and the constant was unpinned while looking pinned. `pt()` is a
	// flat-earth approximation; the bar is a haversine.
	const solve = (target: number): { lat: number; lon: number } => {
		let lo = 0;
		let hi = 2000;
		for (let i = 0; i < 200; i++) {
			const mid = (lo + hi) / 2;
			const p = pt(-mid * Math.SQRT1_2, -mid * Math.SQRT1_2);
			if (PS.haversineMeters(p.lat, p.lon, pivot.lat, pivot.lon) < target) lo = mid;
			else hi = mid;
		}
		return pt(-lo * Math.SQRT1_2, -lo * Math.SQRT1_2);
	};
	// The nearer candidate must be SKIPPED and the further one used.
	const near = solve(499.9);
	const far = solve(500.1);
	armFixes.push({ ts: T0 + 0, lat: far.lat, lon: far.lon, speed_kmh: 60, bearing: 45, accuracy: 10 });
	armFixes.push({ ts: T0 + 60, lat: near.lat, lon: near.lon, speed_kmh: 60, bearing: 45, accuracy: 10 });
	armFixes.push({ ts: T0 + 120, lat: pivot.lat, lon: pivot.lon, speed_kmh: 5, bearing: 45, accuracy: 10 });
	// Departure back the way it came, well past the arm.
	const back = pt(-800 * Math.SQRT1_2, -800 * Math.SQRT1_2);
	armFixes.push({ ts: T0 + 180, lat: back.lat, lon: back.lon, speed_kmh: 60, bearing: 225, accuracy: 10 });
	const dNear = PS.haversineMeters(near.lat, near.lon, pivot.lat, pivot.lon);
	const dFar = PS.haversineMeters(far.lat, far.lon, pivot.lat, pivot.lon);
	const got = REV.reversesAtPoint(armFixes, { ts: T0 + 120, lat: pivot.lat, lon: pivot.lon }, T0, T0 + 180);
	w("-- P7: the arm radius. The nearest candidate sits at");
	w(`--     ${dNear} m and is SKIPPED; the one used is at`);
	w(`--     ${dFar} m. Both are within 1 cm of the 500 m`);
	w("--     bar, which is as close as a haversine over real coordinates gets to");
	w("--     it — an output landing exactly on 500.0 is not reachable by search");
	w("--     (one latitude ULP moves the distance ~8e-10 m against an output ULP");
	w("--     of ~1e-13 m). So the CONSTANT is pinned and the strictness is not.");
	w(`private def ARM : Array PointF := ${emitFixes(armFixes)}`);
	w(
		`#guard reversesAtPoint ARM ⟨${li(T0 + 120)}, ${lf(pivot.lat)}, ${lf(pivot.lon)}⟩ ${li(T0)} ${li(T0 + 180)} == ${lb(got)}`,
	);
	w(`#guard approx (haversineMeters ${lf(near.lat)} ${lf(near.lon)} ${lf(pivot.lat)} ${lf(pivot.lon)}) ${lf(dNear)}`);
	w(`#guard approx (haversineMeters ${lf(far.lat)} ${lf(far.lon)} ${lf(pivot.lat)} ${lf(pivot.lon)}) ${lf(dFar)}`);
	w();
}

/* ---- the cosine bar, bracketed ---- */
{
	// Bracket REVERSAL_COS_MAX = -0.5 from both sides: a turn of 119° must NOT
	// read as a reversal and one of 121° must. A control that does not CROSS a
	// fixture value reads SILENT and looks exactly like a broken harness
	// (tranche 7), so both sides are here.
	const cases: Array<[string, number]> = [
		["119", 119],
		["121", 121],
	];
	// A turn of 120.002° with 600 m arms, where the projection's OWN choice
	// decides. `cos` at the midpoint of each pair gives -0.4999997 (not a
	// reversal); `cos` at the moving point gives -0.5000055 (a reversal). The
	// two differ by up to 9.4e-5 over arms of 600 m to 8 km, which is far too
	// small to see anywhere except within a thousandth of a degree of the bar —
	// so the fixture had to be SEARCHED for, not guessed. Without it, using the
	// wrong latitude for the projection is invisible.
	cases.push(["MIDCOS", 120.002]);
	for (const [label, deg] of cases) {
		const rad = (deg * Math.PI) / 180;
		// Approach from due south-west; depart at `deg` from the approach heading.
		const pivot = pt(0, 0);
		const inP = pt(-700 * Math.SQRT1_2, -700 * Math.SQRT1_2);
		// approach heading is north-east (45°); departure heading = 45° + deg
		const dep = (45 * Math.PI) / 180 + rad;
		const outP = pt(700 * Math.cos(dep), 700 * Math.sin(dep));
		const fs: Fix[] = [
			{ ts: T0, lat: inP.lat, lon: inP.lon, speed_kmh: 60, bearing: 45, accuracy: 10 },
			{ ts: T0 + 60, lat: pivot.lat, lon: pivot.lon, speed_kmh: 5, bearing: 45, accuracy: 10 },
			{ ts: T0 + 120, lat: outP.lat, lon: outP.lon, speed_kmh: 60, bearing: 45, accuracy: 10 },
		];
		const got = REV.reversesAtPoint(fs, { ts: T0 + 60, lat: pivot.lat, lon: pivot.lon }, T0, T0 + 120);
		w(`-- P8/${label}: a ${label}° turn — ${got ? "past" : "short of"} the 120° bar.`);
		w(`private def TURN${label} : Array PointF := ${emitFixes(fs)}`);
		w(
			`#guard reversesAtPoint TURN${label} ⟨${li(T0 + 60)}, ${lf(pivot.lat)}, ${lf(pivot.lon)}⟩ ${li(T0)} ${li(T0 + 120)} == ${lb(got)}`,
		);
		w();
	}
}

/* ---- reversesAt ---- */
w("/-! ### `reversesAt` — the boundary form the rail-run pass calls. -/");
w();

type AtCase = { id: string; note: string; fixes: Fix[]; runStart: number; boundary: number; lookAhead: number };

const AT_CASES: AtCase[] = [
	{
		id: "A1",
		note: "the boundary lands on the turnaround: the run pass must not grow across it.",
		fixes: OUT_AND_BACK,
		runStart: OUT_AND_BACK[0].ts,
		boundary: OUT_AND_BACK[4].ts,
		lookAhead: OUT_AND_BACK[OUT_AND_BACK.length - 1].ts,
	},
	{
		id: "A2",
		note: "the pivot is chosen by |ts − boundary|, so a boundary BETWEEN fixes still picks the nearest one — here 20 s after the turnaround fix and 10 s before the settled one, so the settled fix wins.",
		fixes: OUT_AND_BACK,
		runStart: OUT_AND_BACK[0].ts,
		boundary: OUT_AND_BACK[4].ts + 20,
		lookAhead: OUT_AND_BACK[OUT_AND_BACK.length - 1].ts,
	},
	{
		id: "A3",
		note: "a boundary out on the straight outbound run — no reversal there.",
		fixes: OUT_AND_BACK,
		runStart: OUT_AND_BACK[0].ts,
		boundary: OUT_AND_BACK[2].ts,
		lookAhead: OUT_AND_BACK[OUT_AND_BACK.length - 1].ts,
	},
	{
		id: "A4",
		note: "the look-ahead stops short of the return, so the departure arm is unobserved.",
		fixes: OUT_AND_BACK,
		runStart: OUT_AND_BACK[0].ts,
		boundary: OUT_AND_BACK[4].ts,
		lookAhead: OUT_AND_BACK[6].ts,
	},
];

for (const ac of AT_CASES) {
	const got = REV.reversesAt(ac.fixes, ac.runStart, ac.boundary, ac.lookAhead);
	w(`-- ${ac.id}: ${ac.note}`);
	w(
		`#guard reversesAt ${nameOf(ac.fixes)} ${li(ac.runStart)} ${li(ac.boundary)} ${li(ac.lookAhead)} == ${lb(got)}`,
	);
	w();
}

w("-- A5: no fixes at all — no pivot, so no reversal.");
w(`#guard reversesAt #[] ${li(T0)} ${li(T0 + 100)} ${li(T0 + 200)} == ${lb(REV.reversesAt([], T0, T0 + 100, T0 + 200))}`);
w();

/* ---- the tie in the pivot sort ---- */
{
	// `[...points].sort(...)` is V8's stable sort, so a boundary exactly between
	// two fixes keeps the EARLIER one.
	//
	// The first version of this fixture put both tied fixes at the SAME place,
	// which makes the choice unobservable — the probe read SILENT and looked like
	// an unpinnable guard. The two candidates must sit somewhere DIFFERENT, and
	// far enough apart that the arms read from them disagree.
	const fs: Fix[] = [
		on(T0 + 0, -1000, 60), // behind the origin
		on(T0 + 100, 0, 60), // candidate pivot A — first of the tied pair
		on(T0 + 200, 3000, 60), // candidate pivot B — second
		on(T0 + 300, -1000, 60), // back behind the origin
	];
	const boundary = T0 + 150; // 50 s from each of the middle pair
	const got = REV.reversesAt(fs, T0, boundary, T0 + 300);
	w("-- A6: a boundary EXACTLY between two fixes, which sit 3 km apart. V8's");
	w("--     `sort` is stable, so the EARLIER of the tied pair is the pivot — and");
	w("--     at that pivot the track is running straight through, while at the");
	w("--     later one it doubles back. So the tie-break decides the answer.");
	w(`private def TIE : Array PointF := ${emitFixes(fs)}`);
	w(`#guard reversesAt TIE ${li(T0)} ${li(boundary)} ${li(T0 + 300)} == ${lb(got)}`);
	w();
}

/* ---- a fix sharing the pivot's timestamp ---- */
import * as REV from "../../src/geo/passes/reversal.js";
import * as PS from "../../src/geo/place-snap.js";
{
	// The arms exclude the pivot's own second (`< pivot.ts` / `> pivot.ts`).
	// That is invisible unless some OTHER fix shares that second and sits far
	// enough away to qualify as an arm — ordinary in this data, and the only
	// thing that separates `<` from `≤` here.
	const fs: Fix[] = [
		on(T0 + 0, -800, 60), // the approach, from the south-west
		on(T0 + 60, 900, 60), // shares the pivot's second, to the north-east
		on(T0 + 120, -900, 60), // the departure, back to the south-west
	];
	const p = pt(0, 0);
	const got = REV.reversesAtPoint(fs, { ts: T0 + 60, lat: p.lat, lon: p.lon }, T0, T0 + 120);
	w("-- P10: a fix sharing the pivot's SECOND. Excluded from both arms, so the");
	w("--      approach is read from the south-west fix and the departure from the");
	w("--      south-west one — they oppose. Admitting the shared-second fix into");
	w("--      either arm would make that arm point north-east and the two agree,");
	w("--      so this one fixture pins both exclusions.");
	w(`private def DUP_PIVOT : Array PointF := ${emitFixes(fs)}`);
	w(
		`#guard reversesAtPoint DUP_PIVOT ⟨${li(T0 + 60)}, ${lf(p.lat)}, ${lf(p.lon)}⟩ ${li(T0)} ${li(T0 + 120)} == ${lb(got)}`,
	);
	w();
}

w("end Guards");
w();

console.log(out.join("\n"));
