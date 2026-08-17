#!/usr/bin/env -S npx tsx
/**
 * Reference-value generator for the velocity-owned pure kernels being ported
 * to `Verified/Geo/Velocity.lean`. Prints Node/V8 outputs for the fixed inputs
 * baked into the Lean `#guard`s. Run: npx tsx lean/experiments/velocity-refs.mts
 */
import * as V from "../../src/geo/velocity.js";
import * as FP from "../../src/geo/focus-places.js";
import * as RRP from "../../src/geo/rail-road-proximity.js";

// --- localSolarHour / hasOvernightPresence ---
// hasOvernightPresence is module-private; re-implement its call over localSolarHour
// exactly (it only uses the exported localSolarHour), so the reference is faithful.
function hasOvernightPresence(startTs: number, endTs: number, lon: number): boolean {
	const stepSec = 30 * 60;
	let overnight = 0;
	for (let t = startTs; t <= endTs; t += stepSec) {
		const h = FP.localSolarHour(t, lon);
		if (h >= 0 && h < 6) overnight += stepSec / 3600;
	}
	return overnight >= 1;
}

// A London-ish lon (~ -0.1) and a UTC window spanning local deep night.
// 2026-01-15 00:00:00 UTC = 1768435200.
const t0 = 1768435200;
console.log("localSolarHour:");
for (const [ts, lon] of [
	[t0, -0.1],
	[t0 + 3 * 3600, -0.1],
	[t0 + 12 * 3600, -0.1],
	[t0 + 6 * 3600, 100.0], // far east lon wraps
	[t0, -120.0], // far west lon wraps
] as const) {
	console.log(`  ${ts} ${lon} -> ${FP.localSolarHour(ts, lon)}`);
}
console.log("hasOvernightPresence:");
// window covering 00:00..05:00 UTC at lon -0.1 (solar ~ same) -> plenty overnight
console.log(`  overnight5h -> ${hasOvernightPresence(t0, t0 + 5 * 3600, -0.1)}`);
// window 12:00..14:00 UTC -> no overnight
console.log(`  midday -> ${hasOvernightPresence(t0 + 12 * 3600, t0 + 14 * 3600, -0.1)}`);
// exactly 1h of overnight (00:00..00:30 gives 2 samples in [0,6) -> 1.0h) boundary
// two samples at 02:00 and 02:30 UTC (both solar h=2 ∈ [0,6)) -> exactly 1.0h
console.log(`  exactly1h -> ${hasOvernightPresence(t0 + 2 * 3600, t0 + 2 * 3600 + 30 * 60, -0.1)}`);

// computeRailRoadProximity is module-private; faithful reimplementation over the
// same shared subtype sets it imports.
function computeRailRoadProximity(wr: { type: string; subtype: string; distanceM?: number }[][]) {
	const railDists: number[] = [];
	const roadDists: number[] = [];
	// ⚠ CALL the real per-sample reducer, do not restate it. This loop used to be
	// a verbatim copy of `railRoadDistFromWays`'s body, sharing its two constant
	// sets but not its logic — so the "reference" values for the Lean guards were
	// produced by a SECOND implementation that merely looked like the one being
	// ported. A change to the real function would not have moved these numbers,
	// and the guard would have gone on pinning the copy (#1003). It was the only
	// orphan in the port with no ref exercising it, and it read as covered.
	for (const sample of wr) {
		const { railDistM, roadDistM } = RRP.railRoadDistFromWays(sample as never);
		if (railDistM !== null) railDists.push(railDistM);
		if (roadDistM !== null) roadDists.push(roadDistM);
	}
	const mean = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length);
	return { meanRailDistM: mean(railDists), meanDrivableRoadDistM: mean(roadDists) };
}

// --- computeRailRoadProximity / computeRoadNearestFraction ---
type NW = { type: string; subtype: string; distanceM?: number };
const wayResults: NW[][] = [
	[
		{ type: "railway", subtype: "rail", distanceM: 100 },
		{ type: "railway", subtype: "subway", distanceM: 60 },
		{ type: "highway", subtype: "primary", distanceM: 40 },
		{ type: "railway", subtype: "tram", distanceM: 5 }, // excluded
		{ type: "highway", subtype: "footway", distanceM: 3 }, // excluded
	],
	[
		{ type: "highway", subtype: "motorway", distanceM: 20 },
		{ type: "railway", subtype: "rail", distanceM: 200 },
	],
	[
		{ type: "highway", subtype: "service" }, // no distance -> skipped
		{ type: "waterway", subtype: "river", distanceM: 10 }, // neither
	],
	[
		{ type: "railway", subtype: "light_rail", distanceM: 15 }, // rail only, no road
	],
];
console.log("computeRailRoadProximity:", JSON.stringify(computeRailRoadProximity(wayResults)));
console.log("computeRoadNearestFraction:", V.computeRoadNearestFraction(wayResults));
// fewer than 3 usable samples -> null
console.log("computeRoadNearestFraction thin:", V.computeRoadNearestFraction(wayResults.slice(0, 2)));

// --- batterySeries / appendBatteryTail ---
const pts = [
	{ ts: 0, battery: 90 },
	{ ts: 10, battery: 90 }, // flat run interior -> dropped
	{ ts: 20, battery: 90 },
	{ ts: 30, battery: 85 }, // change
	{ ts: 30, battery: 84 }, // same ts -> collapsed (kept first at ts 30 which is 85)
	{ ts: 40, battery: null }, // dropped
	{ ts: 50, battery: 84 },
	{ ts: 60, battery: 80 },
];
const series = V.batterySeries(pts);
console.log("batterySeries:", JSON.stringify(series));
console.log("appendBatteryTail:", JSON.stringify(V.appendBatteryTail(series, { ts: 120, level: 60 }, 90)));
console.log("appendBatteryTail noop(tail<=last):", JSON.stringify(V.appendBatteryTail(series, { ts: 55, level: 60 }, 90)));
