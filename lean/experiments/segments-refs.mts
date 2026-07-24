#!/usr/bin/env -S npx tsx
/**
 * Reference-value generator for the `segments.ts` scoring cluster being ported
 * to `Verified/Geo/Segments.lean`. Run: npx tsx lean/experiments/segments-refs.mts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const S = await import(path.join(repo, "src/geo/segments.ts"));

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
