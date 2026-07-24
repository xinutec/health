/**
 * V8 reference values for the Lean port of the Tier-5 day-assembly cluster:
 *
 *   - `src/sleep/day-state.ts`      — segmentsToDayStates, clipInferredFuture
 *   - `src/sleep/known-place-stays.ts` — detectKnownPlaceStays
 *   - `src/sleep/load.ts`           — derivePlaceForSleep
 *   - `src/infer/day-grammar.ts`    — parseStationPair, checkDayConstraints
 *   - `src/geo/inferred-stay.ts`    — bracketedStayPlaceId, buildInferredStayState
 *
 * Run:
 *   nix develop /Users/pippijn/Code/health --command \
 *     npx tsx /Users/pippijn/Code/health/lean/experiments/day-state-refs.mts
 */

import { segmentsToDayStates, clipInferredFuture, type DayState, type SleepWindow } from "../../src/sleep/day-state.js";
import { detectKnownPlaceStays, type StayFix, type StayKnownPlace } from "../../src/sleep/known-place-stays.js";
import { derivePlaceForSleep } from "../../src/sleep/load.js";
import { checkDayConstraints, parseStationPair } from "../../src/infer/day-grammar.js";
import { bracketedStayPlaceId, buildInferredStayState } from "../../src/geo/inferred-stay.js";
import type { EnrichedSegment } from "../../src/geo/velocity.js";
import type { TransportMode } from "../../src/geo/segments.js";

const f = (x: number): string => (Number.isFinite(x) ? x.toPrecision(17) : String(x));

const T0 = 1778457600; // 2026-05-11T00:00:00Z

/** Only the fields these functions read; the rest of EnrichedSegment is inert. */
function seg(
	startTs: number,
	endTs: number,
	opts: {
		mode?: TransportMode;
		refinedMode?: TransportMode;
		vehicleKind?: "bus";
		place?: string;
		wayName?: string;
		displayTz?: string;
	} = {},
): EnrichedSegment {
	const base = {
		startTs,
		endTs,
		mode: opts.mode ?? "stationary",
		confidence: 0.9,
		confidenceMargin: 3,
		avgSpeed: 0,
		maxSpeed: 0,
		linearity: 0.1,
		pointCount: 10,
	};
	const extra: Record<string, unknown> = {};
	if (opts.refinedMode !== undefined) extra.refinedMode = opts.refinedMode;
	if (opts.vehicleKind !== undefined) extra.vehicleKind = opts.vehicleKind;
	if (opts.place !== undefined) extra.place = opts.place;
	if (opts.wayName !== undefined) extra.wayName = opts.wayName;
	if (opts.displayTz !== undefined) extra.displayTz = opts.displayTz;
	return { ...base, ...extra } as EnrichedSegment;
}

function sw(startTs: number, endTs: number, place: string | null, minutesAsleep = 0, tz: string | null = null): SleepWindow {
	return { startTs, endTs, place, minutesAsleep, tz };
}

const showState = (s: DayState): string => {
	const bits = [`${s.startTs - T0}..${s.endTs - T0}`, s.mode];
	if (s.place !== undefined) bits.push(`place=${s.place}`);
	if (s.wayName !== undefined) bits.push(`way=${s.wayName}`);
	if (s.asleep !== undefined) bits.push(`asleep=${s.asleep}`);
	if (s.tz !== undefined) bits.push(`tz=${s.tz}`);
	if (s.minutesAsleep !== undefined) bits.push(`mins=${s.minutesAsleep}`);
	if (s.inferred !== undefined) bits.push(`inferred=${s.inferred}`);
	return `[${bits.join(" ")}]`;
};

function showStates(label: string, segs: EnrichedSegment[], sleeps: SleepWindow[]): void {
	const out = segmentsToDayStates(segs, sleeps);
	console.log(`${label}: ${out.length} -> ${out.map(showState).join(" ")}`);
}

console.log("=== segmentsToDayStates ===");
showStates("empty", [], []);
showStates("single stationary", [seg(T0, T0 + 3600, { place: "Home" })], []);
// Adjacent same-state runs merge into one row.
showStates(
	"adjacent same place merges",
	[seg(T0, T0 + 3600, { place: "Home" }), seg(T0 + 3600, T0 + 7200, { place: "Home" })],
	[],
);
showStates(
	"adjacent different place does not merge",
	[seg(T0, T0 + 3600, { place: "Home" }), seg(T0 + 3600, T0 + 7200, { place: "Work" })],
	[],
);
// refinedMode wins over mode; vehicleKind:"bus" flattens a driving leg to bus.
showStates("refinedMode wins", [seg(T0, T0 + 3600, { mode: "driving", refinedMode: "train", wayName: "A → B · Line" })], []);
showStates(
	"vehicleKind bus beats refinedMode",
	[seg(T0, T0 + 3600, { mode: "driving", refinedMode: "driving", vehicleKind: "bus", wayName: "Rt 38" })],
	[],
);
// A sleep window with no segment coverage synthesizes a sleeping state.
showStates("synthesized sleep, no segments", [], [sw(T0, T0 + 3600, "Home", 55, "Europe/London")]);
showStates("synthesized sleep, null place drops", [], [sw(T0, T0 + 3600, null, 55)]);
showStates("synthesized sleep, zero minutesAsleep omits", [], [sw(T0, T0 + 3600, "Home", 0)]);
// Stationary at the sleep place is rewritten to sleeping.
showStates(
	"stationary at sleep place -> sleeping",
	[seg(T0, T0 + 3600, { place: "Home", displayTz: "Europe/London" })],
	[sw(T0, T0 + 3600, "Home", 55, "Europe/London")],
);
// Sleep tz preferred over the segment's displayTz.
showStates(
	"sleep tz beats segment displayTz",
	[seg(T0, T0 + 3600, { place: "Home", displayTz: "Europe/Dublin" })],
	[sw(T0, T0 + 3600, "Home", 55, "Europe/London")],
);
showStates(
	"segment displayTz used when sleep tz null",
	[seg(T0, T0 + 3600, { place: "Home", displayTz: "Europe/Dublin" })],
	[sw(T0, T0 + 3600, "Home", 55, null)],
);
// Stationary at a DIFFERENT place: GPS wins, no sleeping rewrite.
showStates(
	"stationary elsewhere defers to GPS",
	[seg(T0, T0 + 3600, { place: "Work" })],
	[sw(T0, T0 + 3600, "Home", 55)],
);
// Moving during a sleep window keeps its mode and gains asleep=true.
showStates(
	"moving during sleep -> asleep attribute",
	[seg(T0, T0 + 3600, { mode: "train", wayName: "Night train" })],
	[sw(T0, T0 + 3600, "Home", 55)],
);
// The half-covered case: one sleep window, a segment covering only its tail.
// The synthesized half and the rewritten half must merge into ONE row, and
// because the merged row spans the full window minutesAsleep survives.
showStates(
	"split sleep halves merge, full window keeps mins",
	[seg(T0 + 1800, T0 + 3600, { place: "Home", displayTz: "Europe/London" })],
	[sw(T0, T0 + 3600, "Home", 55, "Europe/London")],
);
// Partial row: the merged sleeping row is SHORTER than its window, so
// minutesAsleep is stripped (the UI must not claim the whole asleep total).
showStates(
	"partial sleep row strips minutesAsleep",
	[seg(T0 + 1800, T0 + 3600, { place: "Work" })],
	[sw(T0, T0 + 3600, "Home", 55)],
);
// Boundary sweep: a gap between segments with no sleep yields nothing.
showStates(
	"gap between segments emits nothing",
	[seg(T0, T0 + 1800, { place: "Home" }), seg(T0 + 3600, T0 + 5400, { place: "Work" })],
	[],
);
showStates(
	"overlapping sleep + segments, three boundaries",
	[seg(T0, T0 + 7200, { place: "Home", displayTz: "Europe/London" })],
	[sw(T0 + 1800, T0 + 5400, "Home", 40, "Europe/London")],
);

console.log("");
console.log("=== clipInferredFuture ===");
const NOW = T0 + 3600;
function showClip(label: string, states: DayState[]): void {
	const out = clipInferredFuture(states, NOW);
	console.log(`${label}: ${out.length} -> ${out.map(showState).join(" ")}`);
}
showClip("observed future untouched", [{ startTs: T0, endTs: T0 + 7200, mode: "stationary", place: "Home" }]);
showClip("inferred past kept", [{ startTs: T0, endTs: T0 + 1800, mode: "stationary", place: "Home", inferred: true }]);
showClip("inferred ending exactly at now kept", [
	{ startTs: T0, endTs: NOW, mode: "stationary", place: "Home", inferred: true },
]);
showClip("inferred straddling now truncated", [
	{ startTs: T0, endTs: T0 + 7200, mode: "stationary", place: "Home", inferred: true },
]);
showClip("inferred starting exactly at now dropped", [
	{ startTs: NOW, endTs: T0 + 7200, mode: "stationary", place: "Home", inferred: true },
]);
showClip("inferred wholly future dropped", [
	{ startTs: NOW + 60, endTs: T0 + 7200, mode: "stationary", place: "Home", inferred: true },
]);

console.log("");
console.log("=== derivePlaceForSleep ===");
function showDerive(label: string, w: { startTs: number; endTs: number }, segs: EnrichedSegment[]): void {
	console.log(`${label}: ${derivePlaceForSleep(w, segs) ?? "null"}`);
}
const WIN = { startTs: T0 + 10000, endTs: T0 + 30000 };
showDerive("no segments", WIN, []);
showDerive("moving segment ignored", WIN, [seg(T0 + 12000, T0 + 20000, { mode: "walking", place: "Home" })]);
showDerive("segment without place ignored", WIN, [seg(T0 + 12000, T0 + 20000, {})]);
showDerive("overlap wins", WIN, [seg(T0 + 12000, T0 + 20000, { place: "Hospital" })]);
// The 2026-06-24 case: a bedtime-side home must beat a NEARER wake-side place.
showDerive("bedtime beats nearer wake", WIN, [
	seg(T0 + 30060, T0 + 34000, { place: "Hospital" }), // wake side, gap 60
	seg(T0 + 2000, T0 + 6000, { place: "Home" }), // bedtime side, gap 4000
]);
showDerive("overlap beats bedtime", WIN, [
	seg(T0 + 2000, T0 + 6000, { place: "Home" }),
	seg(T0 + 12000, T0 + 20000, { place: "Ward" }),
]);
showDerive("within side, smallest gap wins", WIN, [
	seg(T0 + 2000, T0 + 6000, { place: "Far" }), // gap 4000
	seg(T0 + 2000, T0 + 9000, { place: "Near" }), // gap 1000
]);
// 6h cap: a stay farther than PLACE_FALLBACK_MAX_GAP_SEC is out of range.
showDerive("beyond 6h gap rejected", WIN, [seg(T0, T0 + 10000 - 6 * 3600 - 1, { place: "TooFar" })]);
showDerive("exactly 6h gap accepted", WIN, [seg(T0, T0 + 10000 - 6 * 3600, { place: "JustInRange" })]);
showDerive("refinedMode stationary counts", WIN, [
	seg(T0 + 12000, T0 + 20000, { mode: "walking", refinedMode: "stationary", place: "Rewritten" }),
]);
// Ties keep the FIRST candidate (strict < on gap).
showDerive("tie keeps first", WIN, [
	seg(T0 + 2000, T0 + 6000, { place: "First" }),
	seg(T0 + 3000, T0 + 6000, { place: "Second" }),
]);

console.log("");
console.log("=== detectKnownPlaceStays ===");
const HOME_LAT = 51.5205;
const HOME_LON = -0.1275;
function fixes(startTs: number, n: number, stepSec: number, lat: number, lon: number): StayFix[] {
	return Array.from({ length: n }, (_, i) => ({ ts: startTs + i * stepSec, lat, lon }));
}
const HOME_PLACE: StayKnownPlace = { centroidLat: HOME_LAT, centroidLon: HOME_LON, displayName: "Home" };
function showStays(label: string, fs: StayFix[], places: StayKnownPlace[]): void {
	const out = detectKnownPlaceStays(fs, places);
	console.log(
		`${label}: ${out.length} -> ${out
			.map((c) => `[${c.startTs - T0}..${c.endTs - T0} ${c.place} ${f(c.centroidLat)} ${f(c.centroidLon)}]`)
			.join(" ")}`,
	);
}
showStays("empty fixes", [], [HOME_PLACE]);
showStays("empty places", fixes(T0, 10, 120, HOME_LAT, HOME_LON), []);
showStays("null displayName filtered", fixes(T0, 10, 120, HOME_LAT, HOME_LON), [
	{ centroidLat: HOME_LAT, centroidLon: HOME_LON, displayName: null },
]);
// 10 fixes x 120 s = 1080 s dwell — under the 600 s floor? No: 1080 >= 600.
showStays("dwell at home", fixes(T0, 10, 120, HOME_LAT, HOME_LON), [HOME_PLACE]);
// Exactly MIN_DWELL_SEC (600) is accepted; one second short is not.
showStays("exactly 600s dwell accepted", fixes(T0, 2, 600, HOME_LAT, HOME_LON), [HOME_PLACE]);
showStays("599s dwell rejected", fixes(T0, 2, 599, HOME_LAT, HOME_LON), [HOME_PLACE]);
// A single fix can never form a run (needs >= 2).
showStays("single fix rejected", fixes(T0, 1, 120, HOME_LAT, HOME_LON), [HOME_PLACE]);
// Cluster far from any known place is dropped.
showStays("unmatched cluster dropped", fixes(T0, 10, 120, 51.6, -0.3), [HOME_PLACE]);
// Two clusters separated by a jump beyond CLUSTER_RADIUS_M (100 m).
showStays(
	"two clusters, second unmatched",
	[...fixes(T0, 10, 120, HOME_LAT, HOME_LON), ...fixes(T0 + 5000, 10, 120, 51.6, -0.3)],
	[HOME_PLACE],
);
// Closer place wins when two are in range.
showStays("closer place wins", fixes(T0, 10, 120, HOME_LAT, HOME_LON), [
	{ centroidLat: HOME_LAT + 0.0003, centroidLon: HOME_LON, displayName: "Farther" },
	{ centroidLat: HOME_LAT + 0.0001, centroidLon: HOME_LON, displayName: "Closer" },
]);
// Custom radius: default is 50 m, so a 60 m-away place needs an explicit one.
showStays("default 50m radius excludes", fixes(T0, 10, 120, HOME_LAT + 0.0006, HOME_LON), [HOME_PLACE]);
showStays("explicit radius includes", fixes(T0, 10, 120, HOME_LAT + 0.0006, HOME_LON), [
	{ ...HOME_PLACE, radiusM: 150 },
]);
// Running-centroid drift: fixes creeping away stay in one run while each
// step is under the radius of the RUNNING mean.
showStays(
	"creeping fixes stay one run",
	Array.from({ length: 10 }, (_, i) => ({ ts: T0 + i * 120, lat: HOME_LAT + i * 0.0001, lon: HOME_LON })),
	[{ ...HOME_PLACE, radiusM: 150 }],
);

console.log("");
console.log("=== parseStationPair ===");
for (const w of [
	undefined,
	"",
	"Baker Street",
	"Euston → Kings Cross",
	"Euston → Kings Cross · Northern",
	"  Euston  →  Kings Cross  · Northern",
	"Euston → Kings Cross · Northern · Extra",
	" → Kings Cross",
	"Euston → ",
	"A → B → C",
]) {
	const r = parseStationPair(w);
	console.log(`${JSON.stringify(w ?? null)}: ${r === null ? "null" : `${JSON.stringify(r.board)}/${JSON.stringify(r.alight)}`}`);
}

console.log("");
console.log("=== checkDayConstraints ===");
function showViolations(label: string, states: DayState[]): void {
	const v = checkDayConstraints(states);
	console.log(`${label}: ${v.length} -> ${v.map((x) => `[${x.constraint}@${x.index} ${x.detail}]`).join(" ")}`);
}
showViolations("empty", []);
showViolations("clean day", [
	{ startTs: T0, endTs: T0 + 3600, mode: "stationary", place: "Home" },
	{ startTs: T0 + 3600, endTs: T0 + 4000, mode: "walking" },
	{ startTs: T0 + 4000, endTs: T0 + 6000, mode: "train", wayName: "Euston → Kings Cross · Northern" },
]);
showViolations("transit same endpoint", [
	{ startTs: T0, endTs: T0 + 3600, mode: "train", wayName: "Euston → Euston · Northern" },
]);
showViolations("bus same endpoint", [{ startTs: T0, endTs: T0 + 3600, mode: "bus", wayName: "Stop A → Stop A" }]);
showViolations("non-station wayName is not a pair", [
	{ startTs: T0, endTs: T0 + 3600, mode: "train", wayName: "Some Sidings" },
]);
showViolations("vehicle handoff", [
	{ startTs: T0, endTs: T0 + 3600, mode: "driving" },
	{ startTs: T0 + 3600, endTs: T0 + 5400, mode: "train" },
]);
showViolations("same vehicle mode is fine", [
	{ startTs: T0, endTs: T0 + 3600, mode: "train" },
	{ startTs: T0 + 3600, endTs: T0 + 5400, mode: "train" },
]);
// A real gap is unobserved time, not an impossibility.
showViolations("handoff across 121s gap is not a violation", [
	{ startTs: T0, endTs: T0 + 3600, mode: "driving" },
	{ startTs: T0 + 3600 + 121, endTs: T0 + 5400, mode: "train" },
]);
showViolations("handoff across exactly 120s gap IS a violation", [
	{ startTs: T0, endTs: T0 + 3600, mode: "driving" },
	{ startTs: T0 + 3600 + 120, endTs: T0 + 5400, mode: "train" },
]);
showViolations("stay teleport", [
	{ startTs: T0, endTs: T0 + 3600, mode: "stationary", place: "Home" },
	{ startTs: T0 + 3600, endTs: T0 + 5400, mode: "stationary", place: "Work" },
]);
showViolations("sleeping counts as at-rest for teleport", [
	{ startTs: T0, endTs: T0 + 3600, mode: "sleeping", place: "Home" },
	{ startTs: T0 + 3600, endTs: T0 + 5400, mode: "stationary", place: "Work" },
]);
showViolations("teleport needs both places named", [
	{ startTs: T0, endTs: T0 + 3600, mode: "stationary", place: "Home" },
	{ startTs: T0 + 3600, endTs: T0 + 5400, mode: "stationary" },
]);
showViolations("same place is not a teleport", [
	{ startTs: T0, endTs: T0 + 3600, mode: "stationary", place: "Home" },
	{ startTs: T0 + 3600, endTs: T0 + 5400, mode: "sleeping", place: "Home" },
]);
// Several laws firing in one day, reported in timeline order.
showViolations("multiple violations in order", [
	{ startTs: T0, endTs: T0 + 3600, mode: "train", wayName: "A → A · L" },
	{ startTs: T0 + 3600, endTs: T0 + 5400, mode: "bus" },
	{ startTs: T0 + 5400, endTs: T0 + 7200, mode: "stationary", place: "Home" },
	{ startTs: T0 + 7200, endTs: T0 + 9000, mode: "stationary", place: "Work" },
]);

console.log("");
console.log("=== bracketedStayPlaceId / buildInferredStayState ===");
console.log(`both null: ${bracketedStayPlaceId(null, null)}`);
console.log(`prev null: ${bracketedStayPlaceId(null, 7)}`);
console.log(`next null: ${bracketedStayPlaceId(7, null)}`);
console.log(`agree: ${bracketedStayPlaceId(7, 7)}`);
console.log(`disagree: ${bracketedStayPlaceId(7, 8)}`);
console.log(`zero id agrees: ${bracketedStayPlaceId(0, 0)}`);
console.log(
	`with tz: ${showState(buildInferredStayState({ place: "Ward 12", tz: "Europe/London", startTs: T0, endTs: T0 + 86400 }))}`,
);
console.log(
	`null tz: ${showState(buildInferredStayState({ place: "Ward 12", tz: null, startTs: T0, endTs: T0 + 86400 }))}`,
);
