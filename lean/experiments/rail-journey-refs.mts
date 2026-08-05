#!/usr/bin/env -S npx tsx
/**
 * Reference-value generator for `assembleRailJourney`
 * (`src/geo/passes/rail-reconcile.ts`), ported into
 * `Verified/Geo/RailJourney.lean`.
 *
 * Like `annotateWalkMatches`, this pass is an ORCHESTRATOR — but a discrete
 * one. It reasons over station names and line labels, not float geometry, and
 * every leaf it consults already has a Lean counterpart with its own pinned
 * references: `expandTubeLineNames` and `findRunAlightFix` in
 * `Verified/Geo/RailRuns.lean`, the haversine in `Verified/Geo/Metric.lean`,
 * `stationsOnLine`'s row decoding in `Verified/Geo/LineStations.lean`. So the
 * ONLY thing injected on the Lean side is the two-call OSM slice:
 *
 *     linesAtPoint(lat, lon, radiusM) -> Set<string>
 *     stationsOnLine(lineName)        -> LineStation[]
 *
 * Everything else is called for real, which means the guards assert the
 * orchestration itself: which fragments join a run, where a run is cut, and
 * what label the merged leg comes out with.
 *
 * Each case prints three things:
 *
 *   1. the OSM read trace — one line per `linesAtPoint` / `stationsOnLine`
 *      call. This pins the candidate ORDER (labels first, then leg
 *      neighbourhoods) and the memo: a line already fetched must not be
 *      fetched again, and a leg whose neighbourhood is never reached must not
 *      be queried at all;
 *   2. the output segment list — mode, window, wayName, pointCount, maxSpeed;
 *      and
 *   3. the merge verdict — how many fragments collapsed, and on what line.
 *
 * The five gates each get a fixture on which they ALONE decide, because they
 * mask each other freely: the through-line test and the line-label test both
 * reject a genuine interchange, and both reversal gates reject an out-and-back.
 * A fixture that trips two gates pins neither.
 *
 * Geometry is synthetic and collinear along a meridian at 0.020 deg spacing
 * (2223.9 m per hop), so the two reversal margins — REVERSAL_MIN_SPAN_M 1500,
 * TURNAROUND_MIN_GAIN_M 2000 — and the alight radius (400 m) all sit at
 * hand-checkable multiples rather than at whatever a real day happened to give.
 *
 * Run: npx tsx lean/experiments/rail-journey-refs.mts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FilteredPoint } from "../../src/geo/kalman.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// biome-ignore lint/suspicious/noExplicitAny: reference harness feeds the real pass structural fixtures.
type Seg = any;
/** The pipeline shape. `bearing` is unread on every path this harness drives,
 *  but the harness feeds what production feeds — a narrower local stand-in is
 *  how a harness stops tracking the type it is meant to mirror (#418). */
type Fix = FilteredPoint;
type LineStation = { name: string; lat: number; lon: number };

const n6 = (x: number): string => x.toFixed(6);

/* ------------------------------------------------------------------ *
 * Synthetic rail geography.
 *
 * Four stations on one meridian, 0.020 deg apart. Distances from A:
 *   B 2223.9 m · C 4447.8 m · D 6671.7 m
 * Both reversal margins fall strictly inside one hop, so a gate can be put
 * on either side of its threshold by moving a fixture one station.
 * ------------------------------------------------------------------ */
const LON = -0.1;
const ST: Record<string, LineStation> = {
	A: { name: "A", lat: 51.5, lon: LON },
	B: { name: "B", lat: 51.52, lon: LON },
	C: { name: "C", lat: 51.54, lon: LON },
	D: { name: "D", lat: 51.56, lon: LON },
	E: { name: "E", lat: 51.58, lon: LON },
};

/** Alpha and Gamma both serve A..D — that overlap is what lets the line-LABEL
 *  gate be pinned separately from the through-line gate. Beta serves only the
 *  far end, so a run touching A and E has no through line at all. */
const LINES: Record<string, string[]> = {
	"Alpha Line": ["A", "B", "C", "D"],
	"Gamma Line": ["A", "B", "C", "D"],
	"Beta Line": ["C", "D", "E"],
};

/** A neighbourhood lookup answers with the lines whose TRACK passes the point,
 *  not the lines with a station there — that is what the real `linesAtPoint`
 *  reads, and the distinction matters: a leg centroid sits between stations, so
 *  a station-keyed stub would answer empty at every centroid the pass actually
 *  asks about and no fixture could reach the fallback at all. Track presence
 *  here is "the point lies within the line's station span", which for collinear
 *  stations is exactly the segment the track occupies. */
const spanOf = (line: string): { lo: number; hi: number } => {
	const lats = (LINES[line] ?? []).map((n) => ST[n].lat);
	return { lo: Math.min(...lats), hi: Math.max(...lats) };
};

/** The read trace. `lat`/`lon` are kept as RAW numbers, not formatted strings:
 *  the Lean literals are generated from this, and a 6-decimal round-trip loses
 *  exactly the centroid dust the guards exist to pin. */
type Read = { kind: "lines"; lat: number; lon: number; r: number } | { kind: "stations"; line: string };
const trace: Read[] = [];

const osm = {
	async linesAtPoint(lat: number, lon: number, radiusM?: number): Promise<Set<string>> {
		const out = new Set<string>();
		for (const line of Object.keys(LINES)) {
			const { lo, hi } = spanOf(line);
			if (lat >= lo && lat <= hi && Math.abs(lon - LON) < 1e-3) out.add(line);
		}
		trace.push({ kind: "lines", lat, lon, r: radiusM ?? 0 });
		return out;
	},
	async stationsOnLine(lineName: string): Promise<readonly LineStation[]> {
		const names = LINES[lineName] ?? [];
		trace.push({ kind: "stations", line: lineName });
		return names.map((n) => ST[n]);
	},
};

/* ------------------------------------------------------------------ *
 * Fixture builders
 * ------------------------------------------------------------------ */

/** A station-pair train leg. `line` omitted leaves the label unlabelled, which
 *  is what makes the interchange-walk gate reachable. */
const train = (startTs: number, endTs: number, board: string, alight: string, line?: string, extra: Record<string, unknown> = {}): Seg => ({
	startTs,
	endTs,
	mode: "train",
	refinedMode: "train",
	confidence: 1,
	confidenceMargin: 2,
	avgSpeed: 30,
	maxSpeed: 60,
	linearity: 0.95,
	pointCount: 10,
	distance: 2000,
	wayName: line === undefined ? `${board} → ${alight}` : `${board} → ${alight} · ${line}`,
	...extra,
});

/** A non-train segment sitting between two train legs. */
const gap = (startTs: number, endTs: number, mode: TransportMode, maxSpeed: number, wayName?: string): Seg => ({
	startTs,
	endTs,
	mode,
	refinedMode: mode,
	confidence: 1,
	confidenceMargin: 2,
	avgSpeed: 3,
	maxSpeed,
	linearity: 0.4,
	pointCount: 4,
	distance: 100,
	wayName,
});

/** Fixes marching from `fromLat` to `toLat` over [t0, t1], at `speed`. */
const march = (t0: number, t1: number, fromLat: number, toLat: number, speed: number, n = 5): Fix[] => {
	const out: Fix[] = [];
	for (let i = 0; i < n; i++) {
		const f = n === 1 ? 0 : i / (n - 1);
		out.push({ ts: Math.round(t0 + (t1 - t0) * f), lat: fromLat + (toLat - fromLat) * f, lon: LON, speed_kmh: speed, bearing: 0 });
	}
	return out;
};

/* ------------------------------------------------------------------ *
 * Case runner
 * ------------------------------------------------------------------ */

const describe = (s: Seg): string =>
	`${s.mode}/${s.refinedMode ?? "-"} [${s.startTs}, ${s.endTs}] ${JSON.stringify(s.wayName)} pc=${s.pointCount} max=${s.maxSpeed}`;

/** Lean literal for a float, at V8's shortest round-tripping precision. Lean
 *  needs a decimal point on every Float literal, so integers gain one. */
const lf = (x: number): string => (Number.isInteger(x) ? `${x}.0` : String(x));

/** Emit the case as pasteable Lean: the fix array, and the output tuples the
 *  `#guard`s compare against. Transcribing these by hand loses the low bits that
 *  pin the centroid summation order, so they are generated. */
function emitLean(tag: string, points: Fix[], out: Seg[], reads: Read[]): void {
	console.log(`  LEAN fixes ${tag} := #[${points.map((p) => `⟨${p.ts}, ${lf(p.lat)}, ${lf(p.lon)}, ${lf(p.speed_kmh)}⟩`).join(", ")}]`);
	console.log(
		`  LEAN out   ${tag} := #[${out
			.map(
				(s: Seg) =>
					`(${s.startTs}, ${s.endTs}, ${JSON.stringify(s.wayName ?? "")}, ${s.pointCount}, ${lf(s.maxSpeed)}, ${JSON.stringify(s.mode)}, ${JSON.stringify(s.refinedMode ?? "")}, ${JSON.stringify(s.refinedReason ?? "")})`,
			)
			.join(", ")}]`,
	);
	const asRead = reads.map((r) =>
		r.kind === "lines" ? `.lines ${lf(r.lat)} (${lf(r.lon)}) ${r.r}` : `.stations ${JSON.stringify(r.line)}`,
	);
	console.log(`  LEAN trace ${tag} := #[${asRead.join(", ")}]`);
}

async function run(name: string, segments: Seg[], points: Fix[]): Promise<void> {
	trace.length = 0;
	const out = await RR.assembleRailJourney(segments, points, osm);
	console.log(`\n=== ${name} ===`);
	console.log(`in  ${segments.length} seg(s), ${points.length} fix(es)`);
	for (const r of trace) {
		console.log(`  osm  ${r.kind === "lines" ? `linesAtPoint ${n6(r.lat)} ${n6(r.lon)} r=${r.r}` : `stationsOnLine ${JSON.stringify(r.line)}`}`);
	}
	console.log(`out ${out.length} seg(s)`);
	for (const s of out) console.log(`  ${describe(s)}`);
	const merged = out.filter((s: Seg) => typeof s.refinedReason === "string" && s.refinedReason.includes("rail-journey assembly"));
	for (const m of merged) console.log(`  reason ${JSON.stringify(m.refinedReason)}`);
	emitLean(name.split(" ")[0], points, out, [...trace]);
}

/* ------------------------------------------------------------------ *
 * S1 — three fragments, one line, slivers between: the 2026-06-23 shape.
 * ------------------------------------------------------------------ */
await run(
	"S1 THROUGH three fragments one line",
	[
		train(1000, 1200, "A", "B", "Alpha Line"),
		gap(1200, 1260, "walking", 5),
		train(1260, 1460, "B", "C", "Alpha Line"),
		gap(1460, 1520, "stationary", 2),
		train(1520, 1720, "C", "D", "Alpha Line"),
	],
	// Ride out A -> D, then the rider walks off slowly near D.
	[...march(1000, 1720, 51.5, 51.56, 50, 9), ...march(1780, 1900, 51.5601, 51.5605, 4, 3)],
);

/* ------------------------------------------------------------------ *
 * S2 — genuine interchange: NO single line serves {A, C, E}.
 * Gate 1 alone decides. Alpha misses E, Beta misses A.
 * ------------------------------------------------------------------ */
await run(
	"S2 INTERCHANGE no through line",
	[
		train(1000, 1200, "A", "C", "Alpha Line"),
		gap(1200, 1260, "walking", 5),
		train(1260, 1460, "C", "E", "Beta Line"),
	],
	[...march(1000, 1460, 51.5, 51.58, 50, 9), ...march(1520, 1640, 51.5801, 51.5805, 4, 3)],
);

/* ------------------------------------------------------------------ *
 * S3 — LINE-LABEL gate alone. Gamma serves A, B and C, so gate 1 passes;
 * the labels say Alpha then Gamma, which is a physical line change.
 * Remove gate 2 and this merges on Gamma.
 * ------------------------------------------------------------------ */
await run(
	"S3 LABEL incompatible labels one serving line",
	[
		train(1000, 1200, "A", "B", "Alpha Line"),
		gap(1200, 1260, "stationary", 2),
		train(1260, 1460, "B", "C", "Gamma Line"),
	],
	[...march(1000, 1460, 51.5, 51.54, 50, 9), ...march(1520, 1640, 51.5401, 51.5405, 4, 3)],
);

/* ------------------------------------------------------------------ *
 * S4 — INTERCHANGE-WALK gate alone. Both fragments unlabelled, Alpha serves
 * all three, so gates 1 and 2 both pass; only the "(interchange)" marker
 * says the rider changed trains.
 * ------------------------------------------------------------------ */
await run(
	"S4 IXWALK unlabelled fragments split by interchange marker",
	[
		train(1000, 1200, "A", "B"),
		gap(1200, 1260, "walking", 5, "B (interchange)"),
		train(1260, 1460, "B", "C"),
	],
	[...march(1000, 1460, 51.5, 51.54, 50, 9), ...march(1520, 1640, 51.5401, 51.5405, 4, 3)],
);

/* ------------------------------------------------------------------ *
 * S5 — the interchange marker OVERRIDDEN. Same shape as S4 but both
 * fragments explicitly name one line, which proves the marker spurious.
 * ------------------------------------------------------------------ */
await run(
	"S5 IXWALK overridden by proven same line",
	[
		train(1000, 1200, "A", "B", "Alpha Line"),
		gap(1200, 1260, "walking", 5, "B (interchange)"),
		train(1260, 1460, "B", "C", "Alpha Line"),
	],
	[...march(1000, 1460, 51.5, 51.54, 50, 9), ...march(1520, 1640, 51.5401, 51.5405, 4, 3)],
);

/* ------------------------------------------------------------------ *
 * S6 — FIX-BASED reversal (gate 4) alone. Labels march outward A -> C -> D,
 * so the label gate sees no turnaround; the fixes go out to D and come back
 * to A, so the observed span doubles back.
 * ------------------------------------------------------------------ */
await run(
	"S6 DOUBLEBACK fixes return to the board",
	[
		train(1000, 1200, "A", "C", "Alpha Line"),
		gap(1200, 1260, "stationary", 2),
		train(1260, 1460, "C", "D", "Alpha Line"),
	],
	// out to D by mid-window, back to A by the end: maxD 6671.7, endD ~0.
	[...march(1000, 1230, 51.5, 51.56, 50, 5), ...march(1260, 1460, 51.56, 51.5, 50, 5)],
);

/* ------------------------------------------------------------------ *
 * S7 — LABEL-BASED turnaround (gate 5) alone. The fixes never come back
 * (they stop out at D), so gate 4 cannot see it; the second fragment's own
 * label says D -> B, which is 4447.8 m back toward the board.
 * ------------------------------------------------------------------ */
await run(
	"S7 TURNAROUND label rides back toward the board",
	[
		train(1000, 1200, "A", "D", "Alpha Line"),
		gap(1200, 1260, "stationary", 2),
		train(1260, 1460, "D", "B", "Alpha Line"),
	],
	// Observed only on the way out — the return has not been seen yet.
	[...march(1000, 1200, 51.5, 51.56, 50, 5)],
);

/* ------------------------------------------------------------------ *
 * S8 — a long slow middle BREAKS the run (a real stopover).
 * ------------------------------------------------------------------ */
await run(
	"S8 SLIVER long slow walk breaks the run",
	[
		train(1000, 1200, "A", "B", "Alpha Line"),
		gap(1200, 1900, "walking", 5),
		train(1900, 2100, "B", "C", "Alpha Line"),
	],
	[...march(1000, 2100, 51.5, 51.54, 50, 9), ...march(2160, 2280, 51.5401, 51.5405, 4, 3)],
);

/* ------------------------------------------------------------------ *
 * S9 — the SAME long middle, absorbed because it carries a motorised peak:
 * the tunnel surfaced, it is not a street walk.
 * ------------------------------------------------------------------ */
await run(
	"S9 SLIVER long middle with motorised peak is absorbed",
	[
		train(1000, 1200, "A", "B", "Alpha Line"),
		gap(1200, 1900, "walking", 45),
		train(1900, 2100, "B", "C", "Alpha Line"),
	],
	[...march(1000, 2100, 51.5, 51.54, 50, 9), ...march(2160, 2280, 51.5401, 51.5405, 4, 3)],
);

/* ------------------------------------------------------------------ *
 * S10 — a TRAILING sliver is not part of the run: with no train after it,
 * the run never extends and the lone leg passes through.
 * ------------------------------------------------------------------ */
await run(
	"S10 TRAILING sliver after a lone leg",
	[train(1000, 1200, "A", "B", "Alpha Line"), gap(1200, 1260, "walking", 5)],
	[...march(1000, 1200, 51.5, 51.52, 50, 5), ...march(1320, 1440, 51.5201, 51.5205, 4, 3)],
);

/* ------------------------------------------------------------------ *
 * S11 — ALIGHT RESOLUTION overrides the last fragment's label. The fixes
 * run past C and stop at D, so the ride alights at D even though the last
 * fragment says C — the 2026-06-28 shape.
 * ------------------------------------------------------------------ */
await run(
	"S11 ALIGHT resolved past the last fragment label",
	[
		train(1000, 1200, "A", "B", "Alpha Line"),
		gap(1200, 1260, "stationary", 2),
		train(1260, 1460, "B", "C", "Alpha Line"),
	],
	// Ride carries on to D after the labelled fragments end, then slows there.
	[...march(1000, 1460, 51.5, 51.5599, 50, 9), ...march(1520, 1640, 51.56, 51.5601, 4, 3)],
);

/* ------------------------------------------------------------------ *
 * S12 — the degenerate guard: the ride's end resolves to the BOARD, which
 * would make an "A -> A" leg, so the fragment's own label is kept instead.
 * ------------------------------------------------------------------ */
await run(
	"S12 ALIGHT degenerate resolution falls back",
	[
		train(1000, 1200, "A", "B", "Alpha Line"),
		gap(1200, 1260, "stationary", 2),
		train(1260, 1460, "B", "C", "Alpha Line"),
	],
	// The post-ride fixes sit back at A.
	[...march(1000, 1460, 51.5, 51.54, 50, 9), ...march(1520, 1640, 51.5, 51.5001, 4, 3)],
);

/* ------------------------------------------------------------------ *
 * S13 — the ride ends nowhere near the line (beyond 400 m of every
 * station), so nothing is resolved and the fragment's label stands.
 * ------------------------------------------------------------------ */
await run(
	"S13 ALIGHT unresolvable keeps the fragment label",
	[
		train(1000, 1200, "A", "B", "Alpha Line"),
		gap(1200, 1260, "stationary", 2),
		train(1260, 1460, "B", "C", "Alpha Line"),
	],
	// Ends midway between C and D — 1112 m from each, past JOURNEY_ALIGHT_MAX_M.
	[...march(1000, 1460, 51.5, 51.54, 50, 9), ...march(1520, 1640, 51.55, 51.5501, 4, 3)],
);

/* ------------------------------------------------------------------ *
 * S14 — a run that spans a genuine interchange splits into TWO sub-runs,
 * each merged on its own line, with the interchange sliver passed through.
 * A -> B -> C on Alpha, then C -> D -> E on Beta.
 * ------------------------------------------------------------------ */
await run(
	"S14 SUBRUNS two single-line rides either side of an interchange",
	[
		train(1000, 1200, "A", "B", "Alpha Line"),
		gap(1200, 1260, "stationary", 2),
		train(1260, 1460, "B", "C", "Alpha Line"),
		gap(1460, 1560, "walking", 5, "C (interchange)"),
		train(1560, 1760, "C", "D", "Beta Line"),
		gap(1760, 1820, "stationary", 2),
		train(1820, 2020, "D", "E", "Beta Line"),
	],
	[...march(1000, 2020, 51.5, 51.58, 50, 13), ...march(2080, 2200, 51.5801, 51.5805, 4, 3)],
);

/* ------------------------------------------------------------------ *
 * S15 — a non-train segment before and after leaves the surrounding
 * sequence untouched, and a train leg that is NOT a station pair (a road
 * name) is not a run member at all.
 * ------------------------------------------------------------------ */
await run(
	"S15 PASSTHROUGH non-pair train and surrounding segments",
	[
		gap(900, 1000, "walking", 5, "Some Street"),
		train(1000, 1200, "A", "B", "Alpha Line"),
		gap(1200, 1260, "stationary", 2),
		{ ...train(1260, 1460, "B", "C", "Alpha Line"), wayName: "Some Other Street" },
		gap(1460, 1560, "walking", 5, "Third Street"),
	],
	[...march(1000, 1460, 51.5, 51.54, 50, 9), ...march(1620, 1740, 51.5401, 51.5405, 4, 3)],
);

/* ------------------------------------------------------------------ *
 * S16 — CANDIDATE ORDER. Both fragments are labelled "Beta Line", which
 * does NOT serve A or B, so every label candidate fails and the through
 * line can only come from the neighbourhood fallback. The merged leg is
 * therefore labelled with a line NEITHER fragment named.
 * ------------------------------------------------------------------ */
await run(
	"S16 CANDIDATES label fails, neighbourhood supplies the line",
	[
		train(1000, 1200, "A", "B", "Beta Line"),
		gap(1200, 1260, "stationary", 2),
		train(1260, 1460, "B", "C", "Beta Line"),
	],
	[...march(1000, 1460, 51.5, 51.54, 50, 9), ...march(1520, 1640, 51.5401, 51.5405, 4, 3)],
);

/* ------------------------------------------------------------------ *
 * S17 — LAZY STOP and the memo asymmetry. Three unlabelled fragments that
 * do merge: `findThroughLine` is re-entered once per candidate prefix, and
 * each entry asks the FIRST leg's neighbourhood, finds the line, and never
 * queries the later legs. `stationsOnLine` is memoised across those entries
 * (one fetch for the whole case); `linesAtPoint` is NOT (one call per
 * entry). The trace is where that asymmetry is visible.
 * ------------------------------------------------------------------ */
await run(
	"S17 LAZY first leg answers, stationsOnLine memoised, linesAtPoint not",
	[
		train(1000, 1200, "A", "B"),
		gap(1200, 1260, "stationary", 2),
		train(1260, 1460, "B", "C"),
		gap(1460, 1520, "stationary", 2),
		train(1520, 1720, "C", "D"),
	],
	[...march(1000, 1720, 51.5, 51.56, 50, 9), ...march(1780, 1900, 51.5601, 51.5605, 4, 3)],
);

/* ------------------------------------------------------------------ *
 * S18 — GATE 2 needs the EXPANSION, not just the raw label. A combined
 * shared-track relation name and the plain name of one of its components
 * are the same physical line, so the run merges. Compare labels literally
 * and this splits.
 * ------------------------------------------------------------------ */
await run(
	"S18 SHAREDTRACK combined label is compatible with its component",
	[
		train(1000, 1200, "A", "B", "Alpha, Beta and Gamma Lines"),
		gap(1200, 1260, "stationary", 2),
		train(1260, 1460, "B", "C", "Gamma Line"),
	],
	[...march(1000, 1460, 51.5, 51.54, 50, 9), ...march(1520, 1640, 51.5401, 51.5405, 4, 3)],
);

/* ------------------------------------------------------------------ *
 * S19 / S20 — GATE 3's "proven same line" needs BOTH halves of its test.
 * S19: the run has a prior label but the joining fragment does not.
 * S20: the joining fragment has a label but the run has none.
 * Neither proves one shared line, so the interchange marker stands in both.
 * ------------------------------------------------------------------ */
await run(
	"S19 IXWALK labelled then unlabelled is not proven",
	[
		train(1000, 1200, "A", "B", "Alpha Line"),
		gap(1200, 1260, "walking", 5, "B (interchange)"),
		train(1260, 1460, "B", "C"),
	],
	[...march(1000, 1460, 51.5, 51.54, 50, 9), ...march(1520, 1640, 51.5401, 51.5405, 4, 3)],
);
await run(
	"S20 IXWALK unlabelled then labelled is not proven",
	[
		train(1000, 1200, "A", "B"),
		gap(1200, 1260, "walking", 5, "B (interchange)"),
		train(1260, 1460, "B", "C", "Alpha Line"),
	],
	[...march(1000, 1460, 51.5, 51.54, 50, 9), ...march(1520, 1640, 51.5401, 51.5405, 4, 3)],
);

/* ------------------------------------------------------------------ *
 * S21 — the reversal gates are asked only once a SECOND fragment is on
 * the table. The FIRST fragment's own fixes double back here, but the run
 * as a whole does not, so the merge stands. Ask the gate at the first
 * fragment and this run never starts.
 * ------------------------------------------------------------------ */
await run(
	"S21 JOINING first fragment doubles back, the run does not",
	[
		train(1000, 1200, "A", "C", "Alpha Line"),
		gap(1200, 1260, "stationary", 2),
		train(1260, 1460, "C", "D", "Alpha Line"),
	],
	[...march(1000, 1100, 51.5, 51.56, 50, 4), ...march(1130, 1200, 51.56, 51.5, 50, 3), ...march(1260, 1460, 51.5, 51.56, 50, 5)],
);

/* ------------------------------------------------------------------ *
 * S22 — and the span they read runs from the RUN's start, not the joining
 * fragment's. The whole span doubles back; the fragment's own window sits
 * still at the boarding station and cannot see it.
 * ------------------------------------------------------------------ */
await run(
	"S22 SPAN reversal is read from the run start",
	[
		train(1000, 1200, "A", "C", "Alpha Line"),
		gap(1200, 1260, "stationary", 2),
		train(1260, 1460, "C", "D", "Alpha Line"),
	],
	[...march(1000, 1100, 51.5, 51.56, 50, 4), ...march(1130, 1200, 51.56, 51.5, 50, 3), ...march(1260, 1460, 51.5, 51.5, 50, 5)],
);

/* ------------------------------------------------------------------ *
 * S23 — the alight is resolved at the RUN's end, not the first fragment's.
 * Every fix here is at transit speed, so the resolver falls to its last
 * arm — the first fix after the window — and the two windows land at
 * different stations.
 * ------------------------------------------------------------------ */
await run(
	"S23 ALIGHT resolved at the run end, not the first fragment",
	[
		train(1000, 1200, "A", "B", "Alpha Line"),
		gap(1200, 1260, "stationary", 2),
		train(1260, 1460, "B", "C", "Alpha Line"),
	],
	[
		{ ts: 1000, lat: 51.5, lon: LON, speed_kmh: 50, bearing: 0 },
		{ ts: 1230, lat: 51.54, lon: LON, speed_kmh: 50, bearing: 0 },
		{ ts: 1460, lat: 51.55, lon: LON, speed_kmh: 50, bearing: 0 },
		{ ts: 1520, lat: 51.56, lon: LON, speed_kmh: 50, bearing: 0 },
	],
);

/* ------------------------------------------------------------------ *
 * S24 — the merged leg is FORCED to train on both mode fields, whatever
 * the first fragment carried. Here it was classified driving and only
 * refined to train.
 * ------------------------------------------------------------------ */
await run(
	"S24 MODE merged leg is forced to train on both fields",
	[
		{ ...train(1000, 1200, "A", "B", "Alpha Line"), mode: "driving", refinedReason: "prior note" },
		gap(1200, 1260, "stationary", 2),
		train(1260, 1460, "B", "C", "Alpha Line"),
	],
	[...march(1000, 1460, 51.5, 51.54, 50, 9), ...march(1520, 1640, 51.5401, 51.5405, 4, 3)],
);

/* ------------------------------------------------------------------ *
 * S25 / S26 — the two sliver thresholds at their exact boundaries.
 * A middle of EXACTLY 600 s is not short enough (strict <); a peak of
 * EXACTLY 40 km/h is fast enough (>=).
 * ------------------------------------------------------------------ */
await run(
	"S25 BOUNDARY middle of exactly 600 s breaks the run",
	[
		train(1000, 1200, "A", "B", "Alpha Line"),
		gap(1200, 1800, "walking", 5),
		train(1800, 2000, "B", "C", "Alpha Line"),
	],
	[...march(1000, 2000, 51.5, 51.54, 50, 9), ...march(2060, 2180, 51.5401, 51.5405, 4, 3)],
);
await run(
	"S26 BOUNDARY long middle peaking at exactly 40 km/h is absorbed",
	[
		train(1000, 1200, "A", "B", "Alpha Line"),
		gap(1200, 1900, "walking", 40),
		train(1900, 2100, "B", "C", "Alpha Line"),
	],
	[...march(1000, 2100, 51.5, 51.54, 50, 9), ...march(2160, 2280, 51.5401, 51.5405, 4, 3)],
);

/* ------------------------------------------------------------------ *
 * S27 — a road-labelled `train` INSIDE a run is absorbed as a sliver but
 * is not a fragment: the merge reports two fragments, not three.
 * ------------------------------------------------------------------ */
await run(
	"S27 NONPAIR train inside a run is a sliver, not a fragment",
	[
		train(1000, 1200, "A", "B", "Alpha Line"),
		{ ...train(1200, 1400, "B", "C", "Alpha Line"), wayName: "Some Street" },
		train(1400, 1600, "B", "C", "Alpha Line"),
	],
	[...march(1000, 1600, 51.5, 51.54, 50, 9), ...march(1660, 1780, 51.5401, 51.5405, 4, 3)],
);

/* ------------------------------------------------------------------ *
 * S28 — the RETURN FRACTION itself. The ride reaches D and comes back as
 * far as B: 2223.9 m of a 6671.7 m maximum, a third of the way out. Every
 * other reversal fixture returns essentially to zero, where any fraction
 * between 0 and 1 gives the same verdict; only a partial return can tell
 * one fraction from another.
 * ------------------------------------------------------------------ */
await run(
	"S28 FRACTION a partial return, a third of the way out",
	[
		train(1000, 1200, "A", "C", "Alpha Line"),
		gap(1200, 1260, "stationary", 2),
		train(1260, 1460, "C", "D", "Alpha Line"),
	],
	[...march(1000, 1230, 51.5, 51.56, 50, 5), ...march(1260, 1460, 51.56, 51.52, 50, 5)],
);

/* ------------------------------------------------------------------ *
 * S29 — the fraction from ABOVE. S28 puts a return inside 0.5; this one
 * puts it outside, coming back only as far as C (two thirds of the way
 * out). Together they bracket the constant: raise it or lower it and one
 * of the two flips.
 * ------------------------------------------------------------------ */
await run(
	"S29 FRACTION a shallow return, two thirds of the way out",
	[
		train(1000, 1200, "A", "C", "Alpha Line"),
		gap(1200, 1260, "stationary", 2),
		train(1260, 1460, "C", "D", "Alpha Line"),
	],
	[...march(1000, 1230, 51.5, 51.56, 50, 5), ...march(1260, 1460, 51.56, 51.54, 50, 5)],
);

/* ------------------------------------------------------------------ *
 * Leaf references — the values the Lean guards replay directly.
 * ------------------------------------------------------------------ */
import * as RR from "../../src/geo/passes/rail-reconcile.js";
import * as RUNS from "../../src/geo/passes/rail-runs.js";
import * as PS from "../../src/geo/place-snap.js";
import type { TransportMode } from "../../src/geo/segments.js";

console.log("\n=== LEAF parseRailWayName ===");
for (const w of [
	"A → B · Alpha Line",
	"A → B",
	"Some Street",
	undefined,
	"A → B · Circle, Hammersmith & City and Metropolitan Lines",
	" → ",
	"A →  · L",
]) {
	console.log(`  ${JSON.stringify(w)} -> ${JSON.stringify(RR.parseRailWayName(w))}`);
}

console.log("\n=== LEAF expandTubeLineNames ===");
for (const l of [
	"Alpha Line",
	"Metropolitan Line",
	"Victoria Line Northbound",
	"Circle, Hammersmith & City and Metropolitan Lines",
	"Circle and District Lines",
	"Hammersmith & City Line",
]) {
	console.log(`  ${JSON.stringify(l)} -> ${JSON.stringify(RUNS.expandTubeLineNames(l))}`);
}

console.log("\n=== LEAF station distances (haversine, m) ===");
for (const [a, b] of [
	["A", "B"],
	["A", "C"],
	["A", "D"],
	["A", "E"],
	["B", "C"],
	["C", "D"],
]) {
	console.log(`  ${a}->${b} ${PS.haversineMeters(ST[a].lat, ST[a].lon, ST[b].lat, ST[b].lon)}`);
}

console.log("\n=== LEAF findRunAlightFix ===");
{
	const pts = [...march(1000, 1460, 51.5, 51.54, 50, 9), ...march(1520, 1640, 51.56, 51.5601, 4, 3)];
	for (const endTs of [1460, 1500, 1640]) {
		// Project the fields the Lean guard pins, rather than stringifying the
		// whole fix. `bearing` is part of `FilteredPoint` and so part of what the
		// harness must FEED, but it is unread here and pinning it would widen the
		// guard to a value this case says nothing about.
		const f = RUNS.findRunAlightFix(pts, endTs);
		// `== null` because the miss case returns `undefined`, and the guard pins
		// the literal `undefined` that `JSON.stringify` then renders — not `null`.
		const shown = f == null ? f : { ts: f.ts, lat: f.lat, lon: f.lon, speed_kmh: f.speed_kmh };
		console.log(`  endTs=${endTs} -> ${JSON.stringify(shown)}`);
	}
}
