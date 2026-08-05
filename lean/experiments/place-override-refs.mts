#!/usr/bin/env -S npx tsx
/**
 * Reference-value generator for `src/hmm/place-override.ts`, ported into
 * `Verified/Geo/PlaceOverride.lean`.
 *
 * WHAT CHANGED, and why it matters. The first version of this generator
 * REIMPLEMENTED `findDominantTrainLineName` and `findDominantStationaryPlaceId`
 * verbatim from the source, because both are module-private, and guarded the
 * Lean port against those copies. That is not a reference test: it compares my
 * transcription against my transcription, and a shared misreading passes.
 *
 * Both are reachable through the public `applyHsmmPlaceOverride` — the line
 * name lands in `wayName` and `refinedReason`, and the place id decides `place`
 * — so the copies are GONE and every value below is what the real exported
 * function returned. Same defect shape as the walk pass's stub-key bug: an
 * expectation must not be built through the thing under test.
 *
 * The module is wholly pure. `places` is a `ReadonlyMap`, i.e. a lookup table
 * rather than I/O, so nothing here is injected and no stub exists at all.
 *
 * Emits the whole Lean guard BLOCK. Run:
 *   TMPDIR=/tmp npx tsx lean/experiments/place-override-refs.mts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));


type Hmm = { startTs: number; endTs: number; mode: TransportMode; lineName?: string | null; placeId?: number | null };
type Place = { displayName: string | null; lat: number; lon: number };
// biome-ignore lint/suspicious/noExplicitAny: reference harness feeds the real pass structural fixtures.
type Seg = any;

/* ---------------- Lean literal emission ---------------- */

const lf = (x: number): string => {
	const body = Number.isInteger(x) ? `${x}.0` : String(x);
	return x < 0 ? `(${body})` : body;
};
const li = (x: number): string => (x < 0 ? `(${x})` : `${x}`);
const ls = (s: string): string => JSON.stringify(s);
const lopt = (s: string | null | undefined): string => (s === null || s === undefined ? "none" : `(some ${ls(s)})`);
const loptf = (x: number | null | undefined): string => (x === null || x === undefined ? "none" : `(some ${lf(x)})`);

const out: string[] = [];
const w = (s = ""): void => {
	out.push(s);
};

/* ---------------- fixtures ---------------- */

const T0 = 1_751_000_000;

/** Places the HSMM can name. `Stay` is the generic clustering-bucket marker —
 *  a cluster KIND, not a venue — and must never overwrite a resolved name. */
const PLACES = new Map<number, Place>([
	[7, { displayName: "Work", lat: 51.5308, lon: -0.1238 }],
	[9, { displayName: "Home", lat: 51.5405, lon: -0.1425 }],
	[11, { displayName: "Stay", lat: 51.5308, lon: -0.1238 }], // the bucket marker
	[13, { displayName: null, lat: 51.5308, lon: -0.1238 }], // unnamed cluster
	[15, { displayName: "Far Clinic", lat: 51.56, lon: -0.1238 }], // ~3.2 km from Work
	[17, { displayName: "Mid Clinic", lat: 51.5416, lon: -0.1238 }], // ~1.2 km from Work: between a 1000 m bar and the real 1500 m one
]);

const hmmStay = (placeId: number | null, startTs: number, endTs: number): Hmm => ({
	startTs,
	endTs,
	mode: "stationary",
	placeId,
});
const hmmTrain = (lineName: string | null, startTs: number, endTs: number): Hmm => ({
	startTs,
	endTs,
	mode: "train",
	lineName,
});

const seg = (over: Partial<Seg>): Seg => ({
	startTs: T0,
	endTs: T0 + 600,
	mode: "stationary",
	confidence: 0.8,
	confidenceMargin: 2,
	avgSpeed: 0,
	maxSpeed: 0,
	linearity: 0.5,
	pointCount: 10,
	...over,
});

/**
 * What each case is supposed to demonstrate, stated per segment and CHECKED.
 *
 * `"unchanged"` | `{place}` | `{train}`. Without this a case can refuse for a
 * reason other than the one its note claims and still look like a passing
 * guard — which is exactly what happened to H2 on the first run: its centroid
 * sat 1.7 km from the winning place, so the doorstep gate refused and the
 * overlap rule the note was about never got to decide.
 */
type Expect = "unchanged" | { place: string } | { train: string };

type Case = { id: string; note: string; segs: Seg[]; hmm: Hmm[]; expect: Expect[] };

const CASES: Case[] = [
	{
		id: "H1",
		expect: [{ place: "Home" }],
		note: "a stay the HSMM attributes to place 9 — overridden to its display name.",
		segs: [seg({ centroidLat: 51.5405, centroidLon: -0.1425 })],
		hmm: [hmmStay(9, T0, T0 + 600)],
	},
	{
		id: "H2",
		expect: [{ place: "Home" }],
		note: "two candidate places; the one with the most overlap SECONDS wins, not the first. The centroid sits at the WINNER, so the doorstep gate is not what decides.",
		segs: [seg({ centroidLat: 51.5405, centroidLon: -0.1425 })],
		hmm: [hmmStay(7, T0, T0 + 100), hmmStay(9, T0 + 100, T0 + 600)],
	},
	{
		id: "H3",
		expect: [{ place: "Work" }],
		note: "the same pair over a shorter window, where the ORDER of the winner flips — 7 now holds more of it.",
		segs: [seg({ endTs: T0 + 150, centroidLat: 51.5308, centroidLon: -0.1238 })],
		hmm: [hmmStay(7, T0, T0 + 100), hmmStay(9, T0 + 100, T0 + 600)],
	},
	{
		id: "H4",
		expect: ["unchanged"],
		note: "the dominant place is the generic bucket marker `Stay`. It names a cluster KIND, not a venue, so it must not overwrite anything — the pipeline's own place stands.",
		segs: [seg({ place: "Cleveland Clinic London", centroidLat: 51.5308, centroidLon: -0.1238 })],
		hmm: [hmmStay(11, T0, T0 + 600)],
	},
	{
		id: "H5",
		expect: ["unchanged"],
		note: "the dominant place has no display name — nothing to override with.",
		segs: [seg({ place: "Somewhere", centroidLat: 51.5308, centroidLon: -0.1238 })],
		hmm: [hmmStay(13, T0, T0 + 600)],
	},
	{
		id: "H6",
		expect: ["unchanged"],
		note: "the HSMM agrees with the pipeline — an override that changes nothing.",
		segs: [seg({ place: "Work", centroidLat: 51.5308, centroidLon: -0.1238 })],
		hmm: [hmmStay(7, T0, T0 + 600)],
	},
	{
		id: "H7",
		expect: ["unchanged"],
		note: "#244 doorstep gate: the HSMM's place sits ~3.2 km from the stay's own GPS centroid. That is a teleport, not a refinement — the decoder filled a GPS-dark interior with a prior and won on overlap. Refused.",
		segs: [seg({ place: "Work", centroidLat: 51.5308, centroidLon: -0.1238 })],
		hmm: [hmmStay(15, T0, T0 + 600)],
	},
	{
		id: "H8",
		expect: [{ place: "Far Clinic" }],
		note: "the SAME far place, but the stay has no centroid at all. A truly GPS-dark stay legitimately anchors via the prior, so the gate is skipped and the override lands.",
		segs: [seg({ place: "Work" })],
		hmm: [hmmStay(15, T0, T0 + 600)],
	},
	{
		id: "H9",
		expect: ["unchanged"],
		note: "the place id the HSMM names is not in the lookup — no override.",
		segs: [seg({ place: "Work", centroidLat: 51.5308, centroidLon: -0.1238 })],
		hmm: [hmmStay(99, T0, T0 + 600)],
	},
	{
		id: "H10",
		expect: ["unchanged"],
		note: "an off-network HSMM stay (no place id) and a walking one — neither is a candidate.",
		segs: [seg({ place: "Work", centroidLat: 51.5308, centroidLon: -0.1238 })],
		hmm: [hmmStay(null, T0, T0 + 300), { startTs: T0 + 300, endTs: T0 + 600, mode: "walking", placeId: 9 }],
	},
	{
		id: "H11",
		expect: [{ train: "Victoria" }],
		note: "a DRIVING leg the HSMM calls a train on a known line, at ride speed and off any road corridor. Promoted: mode AND refinedMode both become train, the reason is rewritten, the line becomes the wayName — and `vehicleKind` is CLEARED, because the day-state flattening ranks it above refinedMode and would otherwise render this train as a bus (#365).",
		segs: [
			seg({
				mode: "driving",
				vehicleKind: "bus",
				refinedReason: "cadence says vehicle",
				avgSpeed: 25,
				roadCorridorFraction: 0.1,
			}),
		],
		hmm: [hmmTrain("Victoria", T0, T0 + 600)],
	},
	{
		id: "H12",
		expect: ["unchanged"],
		note: "the 2026-05-25 taxi: the HSMM credits a line the vehicle merely drove past, but the trace hugs roads throughout. Line support 0.25 loses to road-following 0.8 — refused, and this is a WEIGHING, not a veto.",
		segs: [seg({ mode: "driving", avgSpeed: 25, roadCorridorFraction: 0.8 })],
		hmm: [hmmTrain("Circle", T0, T0 + 150)],
	},
	{
		id: "H13",
		expect: ["unchanged"],
		note: "walking pace under the 8 km/h split — movement to a tube entrance, not a ride.",
		segs: [seg({ mode: "walking", avgSpeed: 5, roadCorridorFraction: 0.1 })],
		hmm: [hmmTrain("Victoria", T0, T0 + 600)],
	},
	{
		id: "H14",
		expect: [{ train: "Victoria" }],
		note: "no GPS samples at all (an underground gap the HSMM reconstructed). The trace cannot contradict, so the HSMM stands.",
		segs: [seg({ mode: "driving", avgSpeed: 25 })],
		hmm: [hmmTrain("Victoria", T0, T0 + 300)],
	},
	{
		id: "H15",
		expect: ["unchanged"],
		note: "`unknown_rail` is not a line name — no candidate, no override.",
		segs: [seg({ mode: "driving", avgSpeed: 25, roadCorridorFraction: 0.1 })],
		hmm: [hmmTrain("unknown_rail", T0, T0 + 600)],
	},
	{
		id: "H16",
		expect: [{ train: "Northern" }],
		note: "two lines; the one holding more overlap SECONDS wins and becomes the wayName.",
		segs: [seg({ mode: "driving", avgSpeed: 25, roadCorridorFraction: 0.1 })],
		hmm: [hmmTrain("Victoria", T0, T0 + 100), hmmTrain("Northern", T0 + 100, T0 + 500)],
	},
	{
		id: "H16a",
		expect: [{ train: "Northern" }],
		note: "BRACKETING the private overlap fraction through the export. Northern holds 400 s of a 600 s segment, so the fraction is 0.666…; a road-corridor share of 0.66 loses to it and the override fires. With H16b just above, the fraction the caller never returns is pinned to an interval — the bus-matcher technique of reading a private value out of production code by bisecting its caller's threshold.",
		segs: [seg({ mode: "driving", avgSpeed: 25, roadCorridorFraction: 0.66 })],
		hmm: [hmmTrain("Victoria", T0, T0 + 100), hmmTrain("Northern", T0 + 100, T0 + 500)],
	},
	{
		id: "H16b",
		expect: ["unchanged"],
		note: "the same segment against 0.67, which beats the fraction — refused. So 0.66 < overlapFraction ≤ 0.67, without any test-only export.",
		segs: [seg({ mode: "driving", avgSpeed: 25, roadCorridorFraction: 0.67 })],
		hmm: [hmmTrain("Victoria", T0, T0 + 100), hmmTrain("Northern", T0 + 100, T0 + 500)],
	},
	{
		id: "H7a",
		expect: [{ place: "Mid Clinic" }],
		note: "the HSMM place sits ~1.2 km from the stay centroid — inside the 1500 m doorstep bar, outside a 1000 m one. With H7 at 3.2 km above, the bar is straddled.",
		segs: [seg({ place: "Work", centroidLat: 51.5308, centroidLon: -0.1238 })],
		hmm: [hmmStay(17, T0, T0 + 600)],
	},
	{
		id: "H2a",
		expect: [{ place: "Work" }],
		note: "two places holding EXACTLY equal overlap (300 s each of a 600 s window). The argmax keeps the FIRST — mirroring the JS Map insertion order — so place 7 wins. Under a last-wins tie-break place 9 would win and then FAIL the doorstep gate 1.7 km away, so the tie-break is observable through the output rather than only through the winner.",
		segs: [seg({ place: "Somewhere", centroidLat: 51.5308, centroidLon: -0.1238 })],
		hmm: [hmmStay(7, T0, T0 + 300), hmmStay(9, T0 + 300, T0 + 600)],
	},
	{
		id: "H13a",
		expect: ["unchanged"],
		note: "7 km/h — under the 8 km/h walk/ride split but over a 6 km/h one. With H13 (5 km/h) and the exact-8 decide case, the split is bracketed on both sides.",
		segs: [seg({ mode: "walking", avgSpeed: 7, roadCorridorFraction: 0.1 })],
		hmm: [hmmTrain("Victoria", T0, T0 + 600)],
	},
	{
		id: "H17",
		expect: ["unchanged"],
		note: "a leg the pipeline ALREADY calls a train is left alone — the pipeline's line attribution is finer-grained than per-line route-graph evidence, so train-vs-train is deliberately skipped.",
		segs: [seg({ mode: "train", wayName: "Piccadilly", avgSpeed: 25, roadCorridorFraction: 0.1 })],
		hmm: [hmmTrain("Victoria", T0, T0 + 600)],
	},
	{
		id: "H18",
		expect: [{ place: "Home" }],
		note: "`refinedMode` decides which arm runs, not `mode`: a leg classified `driving` but refined to `stationary` takes the PLACE arm.",
		segs: [
			seg({ mode: "driving", refinedMode: "stationary", place: "Work", centroidLat: 51.5405, centroidLon: -0.1425 }),
		],
		hmm: [hmmStay(9, T0, T0 + 600)],
	},
	{
		id: "H19",
		expect: [{ place: "Home" }, { train: "Northern" }],
		note: "several segments in one call — each decided independently, order preserved, count unchanged.",
		segs: [
			seg({ startTs: T0, endTs: T0 + 300, centroidLat: 51.5405, centroidLon: -0.1425 }),
			seg({ startTs: T0 + 300, endTs: T0 + 600, mode: "driving", avgSpeed: 25, roadCorridorFraction: 0.1 }),
		],
		hmm: [hmmStay(9, T0, T0 + 300), hmmTrain("Northern", T0 + 300, T0 + 600)],
	},
];

/* ---------------- emission ---------------- */

const emitHmm = (h: Hmm): string =>
	`⟨${li(h.startTs)}, ${li(h.endTs)}, ${ls(h.mode)}, ${lopt(h.lineName)}, ${h.placeId === null || h.placeId === undefined ? "none" : `(some ${li(h.placeId)})`}⟩`;

const emitSeg = (s: Seg): string =>
	`{ startTs := ${li(s.startTs)}, endTs := ${li(s.endTs)}, mode := ${ls(s.mode)}` +
	`, refinedMode := ${lopt(s.refinedMode)}, avgSpeed := ${lf(s.avgSpeed)}` +
	`, place := ${lopt(s.place)}, wayName := ${lopt(s.wayName)}` +
	`, refinedReason := ${lopt(s.refinedReason)}` +
	`, centroidLat := ${loptf(s.centroidLat)}, centroidLon := ${loptf(s.centroidLon)}` +
	`, vehicleKind := ${lopt(s.vehicleKind)}, roadCorridorFraction := ${loptf(s.roadCorridorFraction)} }`;

/** Every field the pass can touch — `place` from the stay arm, and
 *  mode/refinedMode/reason/wayName/vehicleKind from the train arm. */
const proj = (s: Seg): string =>
	`(${ls(s.mode)}, ${lopt(s.refinedMode)}, ${lopt(s.place)}, ${lopt(s.wayName)}` +
	`, ${lopt(s.refinedReason)}, ${lopt(s.vehicleKind)})`;

w("/-! ## Guards");
w();
w("GENERATED by `lean/experiments/place-override-refs.mts` — do not hand-edit.");
w("Every value is what the real exported `applyHsmmPlaceOverride` returned.");
w("-/");
w();
w("namespace Guards");
w();
w("private def PLACES : List (Int × PlaceLookup) := [");
const placeRows: string[] = [];
for (const [id, p] of PLACES) {
	placeRows.push(`  (${li(id)}, ⟨${lopt(p.displayName)}, ${loptf(p.lat)}, ${loptf(p.lon)}⟩)`);
}
w(`${placeRows.join(",\n")}]`);
w();

/** Did the pass do what the case claims? Checked, not assumed. */
const check = (id: string, before: Seg, after: Seg, want: Expect): void => {
	const fail = (why: string): never => {
		console.error(`${id}: ${why}`);
		process.exit(1);
	};
	if (want === "unchanged") {
		if (after.place !== before.place || after.mode !== before.mode || after.refinedMode !== before.refinedMode)
			fail(`expected no change, got place=${after.place} mode=${after.mode}/${after.refinedMode}`);
		return;
	}
	if ("place" in want) {
		if (after.place !== want.place) fail(`expected place ${want.place}, got ${after.place}`);
		if (after.mode !== before.mode) fail(`the place arm must not touch mode (${before.mode} -> ${after.mode})`);
		return;
	}
	if (after.mode !== "train" || after.refinedMode !== "train")
		fail(`expected a train promotion, got ${after.mode}/${after.refinedMode}`);
	if (after.wayName !== want.train) fail(`expected wayName ${want.train}, got ${after.wayName}`);
	if (after.vehicleKind !== undefined) fail(`vehicleKind must be CLEARED (#365), got ${after.vehicleKind}`);
};

for (const c of CASES) {
	// Partial HMM fixtures — each case sets only the field its branch reads (#418).
	const res = PO.applyHsmmPlaceOverride(c.segs, c.hmm as unknown as Parameters<typeof PO.applyHsmmPlaceOverride>[1], PLACES);
	if (res.length !== c.segs.length) {
		console.error(`${c.id}: the pass changed the segment count (${c.segs.length} -> ${res.length})`);
		process.exit(1);
	}
	if (c.expect.length !== c.segs.length) {
		console.error(`${c.id}: ${c.expect.length} expectations for ${c.segs.length} segments`);
		process.exit(1);
	}
	res.forEach((after: Seg, i: number) => check(c.id, c.segs[i], after, c.expect[i]));
	w(`-- ${c.id}: ${c.note}`);
	w(`#guard (applyHsmmPlaceOverride #[${c.segs.map(emitSeg).join(", ")}]`);
	w(`    #[${c.hmm.map(emitHmm).join(", ")}] PLACES).map projSeg ==`);
	w(`  #[${res.map(proj).join(", ")}]`);
	w();
}

/* ---- decideHsmmTrainOverride: exported, so called directly ---- */
w("/-! ### `decideHsmmTrainOverride` — exported, so called for real. -/");
w();
const dcases: Array<[string, { avgSpeedKmh: number; lineOverlapFraction: number; roadCorridorFraction: number | null }]> =
	[
		["a confident line over a rail-consistent trace", { avgSpeedKmh: 25, lineOverlapFraction: 0.9, roadCorridorFraction: 0.2 }],
		["walking pace", { avgSpeedKmh: 5, lineOverlapFraction: 0.9, roadCorridorFraction: 0.2 }],
		["no line support at all", { avgSpeedKmh: 25, lineOverlapFraction: 0.0, roadCorridorFraction: null }],
		["a thin line over a road-hugging trace", { avgSpeedKmh: 25, lineOverlapFraction: 0.3, roadCorridorFraction: 0.8 }],
		["no samples, so nothing contradicts", { avgSpeedKmh: 25, lineOverlapFraction: 0.5, roadCorridorFraction: null }],
		["EXACTLY equal — the test is strictly greater, so no", { avgSpeedKmh: 25, lineOverlapFraction: 0.4, roadCorridorFraction: 0.4 }],
		["EXACTLY at the speed split — the bar is `< 8`, so this rides", { avgSpeedKmh: 8, lineOverlapFraction: 0.9, roadCorridorFraction: 0.2 }],
	];
for (const [note, c] of dcases) {
	const got = PO.decideHsmmTrainOverride(c);
	w(`-- ${note}`);
	w(
		`#guard decideHsmmTrainOverride ${lf(c.avgSpeedKmh)} ${lf(c.lineOverlapFraction)} ${loptf(c.roadCorridorFraction)} == ${got ? "true" : "false"}`,
	);
}
w();

/* ---- the doorstep gate distance ---- */
import * as PO from "../../src/hmm/place-override.js";
import * as PS from "../../src/geo/place-snap.js";
import type { TransportMode } from "../../src/geo/segments.js";
w("/-! ### The #244 doorstep gate, at its own bar. -/");
w();
{
	const near = PS.haversineMeters(51.5, -0.1, 51.5009, -0.1);
	const far = PS.haversineMeters(51.5, -0.1, 51.52, -0.1);
	w(`-- ${near} m and ${far} m — the 1500 m bar sits between them.`);
	w(`#guard doorstepConsistent 51.5 (-0.1) 51.5009 (-0.1) == true`);
	w(`#guard doorstepConsistent 51.5 (-0.1) 51.52 (-0.1) == false`);
}
w();
w("end Guards");
w();

console.log(out.join("\n"));
