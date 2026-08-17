#!/usr/bin/env -S npx tsx
/**
 * Reference-value generator for the `segments.ts` scoring cluster being ported
 * to `Verified/Geo/Segments.lean`. Run: npx tsx lean/experiments/segments-refs.mts
 */
import * as S from "../../src/geo/segments.js";

type WF = Parameters<typeof S.scoreWindow>[0];
const base: WF = {
	startTs: 0, endTs: 60, centroidLat: 51.5, centroidLon: -0.1,
	medianSpeed: 0, maxSpeed: 0, speedVariance: 0, headingChangeRate: 0,
	linearity: 0, accelerationBursts: 0, stopFraction: 0, netDisplacement: 0,
	boundingRadius: 0, pointCount: 10,
};
const stationary: WF = { ...base, medianSpeed: 0.5, maxSpeed: 2, boundingRadius: 10, netDisplacement: 5, stopFraction: 0.8 };
const walking: WF = { ...base, medianSpeed: 4.5, maxSpeed: 7, linearity: 0.5, headingChangeRate: 0.3, boundingRadius: 120, netDisplacement: 200 };
const train: WF = { ...base, medianSpeed: 120, maxSpeed: 160, linearity: 0.96, speedVariance: 5, headingChangeRate: 0.4, netDisplacement: 5000, boundingRadius: 3000 };
const driving: WF = { ...base, medianSpeed: 55, maxSpeed: 90, linearity: 0.72, speedVariance: 30, accelerationBursts: 3, headingChangeRate: 1.5, netDisplacement: 3000, boundingRadius: 2000 };

for (const [name, wf] of [["stationary", stationary], ["walking", walking], ["train", train], ["driving", driving]] as const) {
	const sw = S.scoreWindow(wf);
	console.log(`scoreWindow.${name}:`, JSON.stringify(sw.map((s) => [s.mode, s.score])));
	console.log(`normalizeScores.${name}:`, JSON.stringify(S.normalizeScores(sw)));
}

// roadSupportedConfidence
console.log("roadSupp driving frac1:", S.roadSupportedConfidence("driving", 0.9, 1.0));
console.log("roadSupp driving frac0:", S.roadSupportedConfidence("driving", 0.9, 0.0));
console.log("roadSupp driving frac0.3:", S.roadSupportedConfidence("driving", 0.88, 0.3));
console.log("roadSupp driving null:", S.roadSupportedConfidence("driving", 0.9, null));
console.log("roadSupp train:", S.roadSupportedConfidence("train", 0.9, 0.0));

// isStationaryIncoherent
console.log("incoh march:", S.isStationaryIncoherent({ linearity: 0.9, netDisplacementM: 400, coreDisplacementM: 400, durationS: 600 }));
console.log("incoh lowlin:", S.isStationaryIncoherent({ linearity: 0.5, netDisplacementM: 400, coreDisplacementM: 400, durationS: 600 }));
console.log("incoh smalldisp:", S.isStationaryIncoherent({ linearity: 0.9, netDisplacementM: 50, coreDisplacementM: 50, durationS: 600 }));
console.log("incoh dwelltail:", S.isStationaryIncoherent({ linearity: 0.9, netDisplacementM: 408, coreDisplacementM: 408, durationS: 9000 }));

// pedestrianCoreDisplacementM — a slow walk (one run) vs a stay with a departing teleport tail
type FP = { ts: number; lat: number; lon: number; speedKmh: number; bearing: number };
const fp = (ts: number, lat: number, lon: number): FP => ({ ts, lat, lon, speedKmh: 0, bearing: 0 });
const march: FP[] = [fp(0, 51.5000, -0.1000), fp(60, 51.5005, -0.1000), fp(120, 51.5010, -0.1000), fp(180, 51.5015, -0.1000)];
const stayTail: FP[] = [fp(0, 51.5000, -0.1000), fp(60, 51.5001, -0.1000), fp(120, 51.5002, -0.1000), fp(180, 51.6000, -0.1000)];
console.log("pedCore march:", S.pedestrianCoreDisplacementM(march as never));
console.log("pedCore stayTail:", S.pedestrianCoreDisplacementM(stayTail as never));

// enforcePhysicalConstraints
const seg = (mode: string, avgSpeed: number, maxSpeed: number) => ({
	startTs: 0, endTs: 100, mode, confidence: 1, confidenceMargin: 5,
	avgSpeed, maxSpeed, linearity: 0.9, pointCount: 10,
});
console.log("enforce drive->train:", JSON.stringify(S.enforcePhysicalConstraints(seg("driving", 100, 320) as never)));
console.log("enforce train->plane:", JSON.stringify(S.enforcePhysicalConstraints(seg("train", 420, 500) as never)));
console.log("enforce noop:", JSON.stringify(S.enforcePhysicalConstraints(seg("driving", 60, 90) as never)));

// ---------------------------------------------------------------------------
// Window → segment assembly. extractFeatures and mergeWindows are module-
// PRIVATE, so they are driven through classifySegments — its only caller —
// exactly as the Lean port pins them.
// ---------------------------------------------------------------------------

const P = (ts: number, lat: number, lon: number, speed_kmh: number, bearing = 0) =>
	({ ts, lat, lon, speed_kmh, bearing }) as never;

// A walk: 8 fixes, 60 s apart, heading steadily north at ~4.5 km/h. One window.
const walk = Array.from({ length: 8 }, (_, i) => P(i * 60, 51.5 + i * 0.0007, -0.1, 4.5, 10));
console.log("walk:", JSON.stringify(S.classifySegments(walk)));

// Two stationary clusters 280 m apart inside one mode run — the locationSplit
// branch of mergeWindows, which exists so two stays do not collapse into one.
const stayA = Array.from({ length: 6 }, (_, i) => P(i * 60, 51.5, -0.1, 0.2, 0));
const stayB = Array.from({ length: 6 }, (_, i) => P(360 + i * 60, 51.5025, -0.1, 0.2, 0));
console.log("twoStays:", JSON.stringify(S.classifySegments([...stayA, ...stayB])));

// smoothSegments: a 60 s "fast" blip between two walks is under MIN_SEGMENT_SEC
// and must be absorbed by its predecessor (its mode discarded, maxSpeed kept).
const blip = [
	...Array.from({ length: 6 }, (_, i) => P(i * 60, 51.5 + i * 0.0007, -0.1, 4.5, 10)),
	P(360, 51.512, -0.1, 90, 10),
	...Array.from({ length: 6 }, (_, i) => P(420 + i * 60, 51.52 + i * 0.0007, -0.1, 4.5, 10)),
];
console.log("blip:", JSON.stringify(S.classifySegments(blip)));

// findStays over a gap between two classified segments, via the stayPoints arm.
// The two runs must classify DIFFERENTLY, or mergeWindows joins them into one
// segment and there is no gap for findStays to work in — the fixture would then
// pass while pinning nothing.
const movePts = [
	...Array.from({ length: 6 }, (_, i) => P(i * 60, 51.5 + i * 0.0007, -0.1, 4.5, 10)),
	...Array.from({ length: 6 }, (_, i) => P(7200 + i * 60, 51.6 + i * 0.012, -0.1, 60, 10)),
];
const dwell = Array.from({ length: 20 }, (_, i) => ({ ts: 1200 + i * 180, lat: 51.55, lon: -0.1 }));
console.log("stays:", JSON.stringify(S.classifySegments(movePts, [...movePts, ...dwell] as never)));

// inferTransitGaps directly: a 12-minute blackout across 8 km => train by speed,
// and a 40-minute blackout across 250 m => honest `unknown`.
const gapSeg = (startTs: number, endTs: number, mode: string, linearity = 0.5, maxSpeed = 5) => ({
	startTs, endTs, mode, confidence: 0.9, confidenceMargin: 3,
	avgSpeed: 4, maxSpeed, linearity, pointCount: 5,
});
const fastPts = [P(0, 51.5, -0.1, 4), P(60, 51.5, -0.1, 4), P(780, 51.572, -0.1, 4), P(840, 51.572, -0.1, 4)];
console.log("gapTrain:", JSON.stringify(S.inferTransitGaps(
	[gapSeg(0, 60, "stationary"), gapSeg(780, 840, "stationary")] as never, fastPts as never)));
const slowPts = [P(0, 51.5, -0.1, 0), P(60, 51.5, -0.1, 0), P(2460, 51.5023, -0.1, 0), P(2520, 51.5023, -0.1, 0)];
console.log("gapUnknown:", JSON.stringify(S.inferTransitGaps(
	[gapSeg(0, 60, "stationary"), gapSeg(2460, 2520, "stationary")] as never, slowPts as never)));
// Rail-shaped neighbour upgrades a 38 km/h gap from driving to train.
const railPts = [P(0, 51.5, -0.1, 40), P(60, 51.5, -0.1, 40), P(660, 51.5570, -0.1, 40), P(720, 51.5570, -0.1, 40)];
console.log("gapRailNeighbour:", JSON.stringify(S.inferTransitGaps(
	[gapSeg(0, 60, "train", 0.99, 80), gapSeg(660, 720, "stationary")] as never, railPts as never)));

// --- smoothSegments / findStays: the two members of this cluster that no ref
// exercised (#1003). They are reached TRANSITIVELY via classifySegments above,
// so they were covered on whatever inputs that one fixture happens to produce
// and pinned independently nowhere. These call them directly.

const TS_ = (startTs: number, endTs: number, mode: string, maxSpeed: number, pointCount: number) => ({
	startTs, endTs, mode, confidence: 0.8, confidenceMargin: 5,
	avgSpeed: 4, maxSpeed, linearity: 0.5, pointCount,
});

// A 60 s middle segment is under the 120 s floor, so it is absorbed by the one
// before it. What survives the merge is the discriminating part: end, point
// count and peak speed move; the absorbed segment's MODE is discarded.
console.log("smooth.merge:", JSON.stringify(S.smoothSegments(
	[TS_(0, 300, "walking", 6, 10), TS_(300, 360, "driving", 80, 4), TS_(360, 900, "walking", 5, 20)] as never, 120)));
// Two consecutive shorts fold into the SAME predecessor, not into each other.
console.log("smooth.twoShorts:", JSON.stringify(S.smoothSegments(
	[TS_(0, 300, "walking", 6, 10), TS_(300, 350, "driving", 80, 4), TS_(350, 400, "cycling", 25, 3)] as never, 120)));
// A single segment is returned untouched, whatever the floor.
console.log("smooth.single:", JSON.stringify(S.smoothSegments([TS_(0, 30, "walking", 6, 2)] as never, 120)));
// Nothing is under the floor: identity, and the copy must not renumber anything.
console.log("smooth.noop:", JSON.stringify(S.smoothSegments(
	[TS_(0, 300, "walking", 6, 10), TS_(300, 900, "driving", 80, 20)] as never, 120)));

const SP = (ts: number, lat: number, lon: number) => ({ ts, lat, lon });

// No classified segments => one gap spanning every point. Five fixes at one
// place over 1200 s clear both bars (>= 2 fixes, >= 900 s).
console.log("stays.one:", JSON.stringify(S.findStays(
	[SP(0, 51.5, -0.1), SP(300, 51.5, -0.1), SP(600, 51.5001, -0.1), SP(900, 51.5, -0.1), SP(1200, 51.5, -0.1)] as never,
	[] as never)));
// Two places ~1.1 km apart: the second fix beyond CLUSTER_RADIUS_M closes the
// first cluster and opens a second, so this must yield TWO stays and not one
// spanning both — the regression that motivated trajectory segmentation.
console.log("stays.two:", JSON.stringify(S.findStays(
	[SP(0, 51.5, -0.1), SP(450, 51.5, -0.1), SP(900, 51.5, -0.1),
	 SP(1200, 51.51, -0.1), SP(1700, 51.51, -0.1), SP(2200, 51.51, -0.1)] as never,
	[] as never)));
// Spans only 600 s: under SEGMENT_STAY_MIN_S, so no stay at all.
console.log("stays.tooShort:", JSON.stringify(S.findStays(
	[SP(0, 51.5, -0.1), SP(300, 51.5, -0.1), SP(600, 51.5, -0.1)] as never, [] as never)));
// An existing segment splits the day: only the stretches around it are searched,
// and a gap shorter than SEGMENT_STAY_MIN_S is not searched at all.
console.log("stays.withExisting:", JSON.stringify(S.findStays(
	[SP(0, 51.5, -0.1), SP(450, 51.5, -0.1), SP(900, 51.5, -0.1),
	 SP(1000, 51.52, -0.1), SP(2000, 51.53, -0.1),
	 SP(2100, 51.54, -0.1), SP(2700, 51.54, -0.1), SP(3300, 51.54, -0.1)] as never,
	[TS_(1000, 2000, "walking", 6, 5)] as never)));
