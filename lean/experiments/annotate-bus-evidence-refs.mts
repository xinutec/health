#!/usr/bin/env -S npx tsx
/**
 * Reference-value generator for `annotateBusEvidence`
 * (`src/geo/bus-evidence.ts`), ported into `Verified/Geo/Bus.lean`.
 *
 * The scoring leaves (`detectBoardingWait`, `detectVehicleDwells`,
 * `scoreBusEvidence`) were ported and pinned earlier; this covers the
 * orchestration — the leg filter, the per-dwell stop resolution, and the
 * threshold that decides `vehicleKind: "bus"`.
 *
 * The pass is `async` only because `nearbyTransitStops` is injected, so a
 * plain object stands in for the adapter. What the stub has to reproduce
 * faithfully is the SUBTYPE FILTER + `Math.min`: the TS asks for everything
 * within 50 m and picks the nearest of the requested subtype, which is not the
 * same as "nearest stop, if it happens to be a bus stop".
 *
 * Run: npx tsx lean/experiments/annotate-bus-evidence-refs.mts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const B = await import(path.join(repo, "src/geo/bus-evidence.ts"));

type Fix = { ts: number; lat: number; lon: number };
type Stop = { subtype: string; distanceM: number };

/** The stub adapter answers the SAME stop list everywhere. That is enough:
 *  what the orchestration decides is which subtype it asks for and how it
 *  reduces the answer, not where the query lands. Keeping the lookup
 *  coordinate-independent also keeps the Lean fixture off float-keyed lookup —
 *  the boarding centroid lands on -0.19999999999999998, not -0.2. */
const osmOf = (stops: Stop[]) => ({ nearbyTransitStops: async () => stops });

/** A standstill long enough to be a boarding wait, then a steady ride with two
 *  dwells in it. Coordinates are held constant so the stub table is small; the
 *  stop resolution is what varies between cases. */
const LAT = 51.5;
const LON = -0.2;
const fixes: Fix[] = [];
for (let t = 0; t < 300; t += 30) fixes.push({ ts: t, lat: LAT, lon: LON }); // pre-leg standstill
// The leg: move away, dwell, move, dwell, move.
const legStart = 300;
let lat = LAT;
for (let t = legStart; t <= legStart + 900; t += 30) {
	const dwelling = (t >= legStart + 180 && t <= legStart + 240) || (t >= legStart + 480 && t <= legStart + 540);
	if (!dwelling) lat += 0.003; // ~333 m per 30 s ≈ 40 km/h
	fixes.push({ ts: t, lat, lon: LON });
}
const legEnd = legStart + 900;

const seg = (mode: string, refinedMode?: string, startTs = legStart, endTs = legEnd) => ({
	startTs,
	endTs,
	mode,
	...(refinedMode !== undefined ? { refinedMode } : {}),
});

console.log("-- what the leaves see (so the Lean fixture can be checked against the same input)");
const wait = B.detectBoardingWait(fixes, legStart);
console.log(`boardingWait ${JSON.stringify(wait)}`);
const dwells = B.detectVehicleDwells(fixes, legStart, legEnd);
console.log(`dwells       ${JSON.stringify(dwells)}`);

const atStop: Stop[] = [{ subtype: "bus_stop", distanceM: 10 }];
/** Nothing but signals — the taxi reading of the same track. */
const signalsOnly: Stop[] = [{ subtype: "traffic_signals", distanceM: 8 }];
/** A NEARER signal alongside a further bus stop: the subtype filter must pick
 *  the bus stop, not the nearest thing. */
const mixed: Stop[] = [
	{ subtype: "traffic_signals", distanceM: 3 },
	{ subtype: "bus_stop", distanceM: 30 },
];
/** Two bus stops: `Math.min` takes the nearer, which is the one inside the bar. */
const twoStops: Stop[] = [
	{ subtype: "bus_stop", distanceM: 40 },
	{ subtype: "bus_stop", distanceM: 12 },
];
/** A bus stop, but beyond `TRANSIT_STOP_NEAR_M` — present is not near. */
const farStop: Stop[] = [{ subtype: "bus_stop", distanceM: 40 }];

const run = async (label: string, segs: object[], stops: Stop[]): Promise<void> => {
	const out = await B.annotateBusEvidence(segs, fixes, osmOf(stops));
	console.log(`${label.padEnd(24)} ${JSON.stringify(out.map((s: { vehicleKind?: string }) => s.vehicleKind ?? null))}`);
};

console.log("\n-- annotateBusEvidence (printing vehicleKind per segment)");
await run("atStopClearsBar", [seg("driving")], atStop);
await run("refinedDriving", [seg("stationary", "driving")], atStop);
await run("notDriving", [seg("walking")], atStop);
await run("refinedAwayFromDriving", [seg("driving", "train")], atStop);
await run("legTooShort", [seg("driving", undefined, legStart, legStart + 179)], atStop);
await run("legExactlyMinLength", [seg("driving", undefined, legStart, legStart + 180)], atStop);
await run("noStopsAtAll", [seg("driving")], []);
await run("signalsOnly", [seg("driving")], signalsOnly);
await run("subtypeFilterNotNearest", [seg("driving")], mixed);
await run("twoStopsTakesNearer", [seg("driving")], twoStops);
await run("stopBeyondNearBar", [seg("driving")], farStop);
// The dwell window is the SEGMENT's, not the day's. Under `mixed` one dwell
// scores 1.9 and two score 2.3, so a leg cut before the second dwell flips.
await run("windowExcludesDwell2", [seg("driving", undefined, legStart, 700)], mixed);
await run("windowIncludesDwell2", [seg("driving", undefined, legStart, 900)], mixed);
await run("twoSegments", [seg("driving"), seg("walking")], atStop);

console.log("\n-- the scores behind those verdicts");
for (const [label, stops] of [
	["atStop", atStop],
	["none", []],
	["signalsOnly", signalsOnly],
	["mixed", mixed],
	["twoStops", twoStops],
	["farStop", farStop],
] as Array<[string, Stop[]]>) {
	const nearest = (sub: string): number | null => {
		const m = stops.filter((s) => s.subtype === sub);
		return m.length > 0 ? Math.min(...m.map((s) => s.distanceM)) : null;
	};
	const ev = {
		boardingWaitS: wait?.durationS ?? null,
		boardingNearestBusStopM: wait ? nearest("bus_stop") : null,
		dwells: dwells.map((d: { durationS: number }) => ({
			durationS: d.durationS,
			nearestBusStopM: nearest("bus_stop"),
			nearestSignalM: nearest("traffic_signals"),
		})),
	};
	console.log(`${label.padEnd(14)} ${JSON.stringify(B.scoreBusEvidence(ev))}`);
}
console.log(`\nBUS_EVIDENCE_THRESHOLD_NATS ${B.BUS_EVIDENCE_THRESHOLD_NATS}`);

// --- the threshold exactly AT the bar -----------------------------------------
// `DWELL_AT_STOP_AND_SIGNAL_NATS` REPLACES the stop credit rather than adding
// to it (0.4 instead of 0.8 — a signal is an alternative explanation for the
// dwell), so the reachable totals are a coarse grid. The only combination that
// lands on exactly 2.0 is: no boarding wait (0) + stop, stop, stop-and-signal
// (0.8 + 0.8 + 0.4, which sums to exactly 2 in that order). Anything else
// leaves the `>= vs >` decision at the bar unpinned.
console.log("\n-- exactly at the threshold");
const barFixes: Fix[] = [];
{
	let la = LAT;
	for (let t = legStart; t <= legStart + 1200; t += 30) {
		const dwelling =
			(t >= legStart + 180 && t <= legStart + 240) ||
			(t >= legStart + 480 && t <= legStart + 540) ||
			(t >= legStart + 780 && t <= legStart + 840);
		if (!dwelling) la += 0.003;
		barFixes.push({ ts: t, lat: la, lon: LON });
	}
}
const barEnd = legStart + 1200;
const barDwells = B.detectVehicleDwells(barFixes, legStart, barEnd);
console.log(`boarding  ${JSON.stringify(B.detectBoardingWait(barFixes, legStart))}`);
console.log(`dwellLats ${JSON.stringify(barDwells.map((d: { lat: number }) => d.lat))}`);
/** Stop everywhere; a signal only at the LAST dwell. */
const SIGNAL_FROM_LAT = 51.55;
const perDwell = {
	nearbyTransitStops: async (lat: number): Promise<Stop[]> =>
		lat < SIGNAL_FROM_LAT
			? [{ subtype: "bus_stop", distanceM: 10 }]
			: [{ subtype: "bus_stop", distanceM: 10 }, { subtype: "traffic_signals", distanceM: 5 }],
};
console.log(
	`score     ${JSON.stringify(
		B.scoreBusEvidence({
			boardingWaitS: null,
			boardingNearestBusStopM: null,
			dwells: barDwells.map((d: { durationS: number; lat: number }) => ({
				durationS: d.durationS,
				nearestBusStopM: 10,
				nearestSignalM: d.lat < SIGNAL_FROM_LAT ? null : 5,
			})),
		}),
	)}`,
);
const atBar = await B.annotateBusEvidence([seg("driving", undefined, legStart, barEnd)], barFixes, perDwell);
console.log(`verdict   ${JSON.stringify(atBar.map((s: { vehicleKind?: string }) => s.vehicleKind ?? null))}`);
