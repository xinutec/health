#!/usr/bin/env -S npx tsx
/**
 * Reference-value generator for the `interchange-split.ts` pure exports being
 * ported to `Verified/Geo/Interchange.lean`.
 * Run: npx tsx lean/experiments/interchange-refs.mts
 */
import * as IC from "../../src/geo/interchange-split.js";

type Step = { ts: number; steps: number };
// --- findInterchangeBurst ---
// clean mid-leg burst: walking cadence at 300,360,420 → burst [300,480], 3 min
const cleanSteps: Step[] = [
	{ ts: 60, steps: 5 }, { ts: 300, steps: 112 }, { ts: 360, steps: 113 }, { ts: 420, steps: 110 },
	{ ts: 600, steps: 4 }, { ts: 1140, steps: 8 },
];
console.log("burst clean:", JSON.stringify(IC.findInterchangeBurst(cleanSteps, 0, 1200)));
// two separate mid bursts → ambiguous → null
const twoSteps: Step[] = [
	{ ts: 300, steps: 112 }, { ts: 360, steps: 113 },
	{ ts: 700, steps: 110 }, { ts: 760, steps: 111 },
];
console.log("burst ambiguous:", JSON.stringify(IC.findInterchangeBurst(twoSteps, 0, 1200)));
// burst hugging the leg start edge (within 180 s guard) → null
const edgeSteps: Step[] = [{ ts: 60, steps: 112 }, { ts: 120, steps: 113 }, { ts: 180, steps: 110 }];
console.log("burst edge:", JSON.stringify(IC.findInterchangeBurst(edgeSteps, 0, 1200)));
// no walking minutes → null
console.log("burst none:", JSON.stringify(IC.findInterchangeBurst([{ ts: 300, steps: 5 }], 0, 1200)));

// --- pickInterchange ---
type Station = { name: string; lat: number; lon: number };
const change: Station = { name: "Change", lat: 51.52, lon: -0.06 };
const wrong: Station = { name: "Wrong", lat: 51.49, lon: -0.12 }; // backtrack (dot<=0)
const stationsByLine = new Map<string, Station[]>([
	["A", [change, wrong]],
	["B", [change, wrong]],
]);
const pick = IC.pickInterchange({
	boardLat: 51.5, boardLon: -0.1, alightLat: 51.54, alightLon: -0.02,
	legStartTs: 0, burstStartTs: 600,
	linesA: ["A"], linesB: ["B"], stationsByLine,
});
console.log("pick basic:", JSON.stringify(pick));

// with trailFix (second-leg anchor adds to slop)
const pick2 = IC.pickInterchange({
	boardLat: 51.5, boardLon: -0.1, alightLat: 51.54, alightLon: -0.02,
	legStartTs: 0, burstStartTs: 600, burstEndTs: 780,
	trailFix: { ts: 1000, lat: 51.535, lon: -0.03 },
	linesA: ["A"], linesB: ["B"], stationsByLine,
});
console.log("pick trail:", JSON.stringify(pick2));

// no candidate on both lines → null
const pickNone = IC.pickInterchange({
	boardLat: 51.5, boardLon: -0.1, alightLat: 51.54, alightLon: -0.02,
	legStartTs: 0, burstStartTs: 600,
	linesA: ["A"], linesB: ["B"], stationsByLine: new Map([["A", [change]], ["B", [wrong]]]),
});
console.log("pick none:", JSON.stringify(pickNone));

// diagnostics for the Lean guards
const R = 6_371_000;
const hav = (a: Station, bLat: number, bLon: number) => {
	const dLat = ((bLat - a.lat) * Math.PI) / 180;
	const dLon = ((bLon - a.lon) * Math.PI) / 180;
	const x = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
	return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
};
console.log("diag rideM board→Change:", hav(change, 51.5, -0.1));
