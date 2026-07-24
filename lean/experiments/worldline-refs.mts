#!/usr/bin/env -S npx tsx
/**
 * Reference-value generator for `worldline-feasibility.ts` being ported to
 * `Verified/Geo/Worldline.lean`. Run: npx tsx lean/experiments/worldline-refs.mts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const W = await import(path.join(repo, "src/eval/worldline-feasibility.ts"));
const RR = await import(path.join(repo, "src/geo/passes/rail-reconcile.ts"));

// parseRailWayName
for (const wn of ["A → B · Victoria", "A → B", "no arrow here", undefined] as const) {
	console.log(`parseRailWayName ${JSON.stringify(wn)}:`, JSON.stringify(RR.parseRailWayName(wn as never)));
}

// meanCadenceSpm — buckets are per-minute (ts = bucket start; covers [ts, ts+60))
const steps = [{ ts: 0, steps: 100 }, { ts: 60, steps: 110 }, { ts: 120, steps: 0 }];
console.log("meanCadence 0..180:", W.meanCadenceSpm(steps, 0, 180));
console.log("meanCadence 0..120:", W.meanCadenceSpm(steps, 0, 120));
console.log("meanCadence 1000..2000 (no overlap):", W.meanCadenceSpm(steps, 1000, 2000));

type Leg = { startTs: number; endTs: number; mode: string; wayName?: string };
type Fix = { ts: number; lat: number; lon: number };
type Step = { ts: number; steps: number };

// --- checkModeKinematics: a walking leg with a vehicle-paced run (64 km/h down a corridor) ---
// steps ~64 km/h: ~0.0053 deg lat per 30s ≈ 590 m/30s. Build 4 fast fixes.
const walkLeg: Leg[] = [{ startTs: 0, endTs: 200, mode: "walking" }];
const fastFixes: Fix[] = [
	{ ts: 0, lat: 51.5000, lon: -0.1000 },
	{ ts: 30, lat: 51.5053, lon: -0.1000 },
	{ ts: 60, lat: 51.5106, lon: -0.1000 },
	{ ts: 90, lat: 51.5159, lon: -0.1000 },
];
console.log("checkWL walking-kinematics:", JSON.stringify(W.checkWorldlineFeasibility(walkLeg, fastFixes)));

// --- checkVehiclePedestrianRuns: a train leg at pedestrian pace WITH walking cadence ---
const trainLeg: Leg[] = [{ startTs: 0, endTs: 200, mode: "train", wayName: "A → A" }]; // also degenerate
const slowFixes: Fix[] = [
	{ ts: 0, lat: 51.5000, lon: -0.1000 },
	{ ts: 60, lat: 51.5008, lon: -0.1000 }, // ~89 m/60s ≈ 5.3 km/h
	{ ts: 120, lat: 51.5016, lon: -0.1000 },
	{ ts: 180, lat: 51.5024, lon: -0.1000 },
];
const walkCadence: Step[] = [
	{ ts: 0, steps: 100 }, { ts: 60, steps: 100 }, { ts: 120, steps: 100 },
];
console.log("checkWL train-pedestrian+degenerate:", JSON.stringify(W.checkWorldlineFeasibility(trainLeg, slowFixes, walkCadence)));

// --- checkRailTriples + continuity/degenerate over a multi-leg timeline ---
const timeline: Leg[] = [
	{ startTs: 0, endTs: 100, mode: "train", wayName: "Victoria → Highbury · Victoria" },
	{ startTs: 100, endTs: 200, mode: "train", wayName: "Kings Cross → Farringdon · Metropolitan" }, // discontinuity (no relocate)
];
const lineStations = new Map<string, { name: string }[]>([
	["Victoria", [{ name: "Victoria" }, { name: "Highbury" }]],
	["Metropolitan", [{ name: "Farringdon" }]], // Kings Cross NOT served -> invalid-rail-triple (board)
]);
console.log("checkWL triples+continuity:", JSON.stringify(W.checkWorldlineFeasibility(timeline, undefined, undefined, lineStations)));

// --- relocating leg severs continuity (no rail-discontinuity) ---
const relocated: Leg[] = [
	{ startTs: 0, endTs: 100, mode: "train", wayName: "A → B · L1" },
	{ startTs: 100, endTs: 150, mode: "walking" },
	{ startTs: 150, endTs: 200, mode: "train", wayName: "C → D · L1" },
];
console.log("checkWL relocated (no discontinuity):", JSON.stringify(W.checkWorldlineFeasibility(relocated)));
