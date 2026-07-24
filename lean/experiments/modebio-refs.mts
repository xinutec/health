#!/usr/bin/env -S npx tsx
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const M = await import(path.join(repo, "src/geo/mode-biometrics.ts"));

type Obs = { hr: number | null; cadence: number | null; speed: number | null };
const O = (hr: number | null, cadence: number | null, speed: number | null): Obs => ({ hr, cadence, speed });

// labelMinuteByHeuristic
const labelCases: [string, Obs][] = [
	["stationary", O(65, 0, 0.5)], ["walking", O(90, 110, 5)], ["cycling", O(130, 0, 18)],
	["driving", O(80, 0, 55)], ["train", O(70, 0, 120)], ["plane", O(60, 0, 600)],
	["nullSpeed", O(70, 0, null)], ["ambiguous", O(90, 0, 40) /* HR>=? driving needs hr<95: 90<95 ok */],
	["ambiguousMid", O(120, 50, 40)],
];
for (const [n, o] of labelCases) console.log(`label ${n}: ${M.labelMinuteByHeuristic(o)}`);

// aggregateModeStats
const samples = [
	{ mode: "walking", obs: O(95, 110, 5) }, { mode: "walking", obs: O(105, 120, 6) }, { mode: "walking", obs: O(100, 100, 4) },
	{ mode: "driving", obs: O(80, 0, 50) }, { mode: "driving", obs: O(82, 0, 60) },
	{ mode: "cycling", obs: O(140, null, 18) },
];
const stats = M.aggregateModeStats(samples);
console.log("stats:", JSON.stringify(stats));

// scoreModeLogLikelihood
const walkStat = stats.find((s) => s.mode === "walking")!;
console.log("LL walk obs(100,110,5):", M.scoreModeLogLikelihood(O(100, 110, 5), walkStat));
console.log("LL walk obs allnull:", M.scoreModeLogLikelihood(O(null, null, null), walkStat));

// isHrImplausibleForMode / isCadenceImplausibleForMode
console.log("hrImpl walking obs50:", M.isHrImplausibleForMode("walking", 50, stats));
console.log("hrImpl walking obs100:", M.isHrImplausibleForMode("walking", 100, stats));
console.log("cadImpl driving cad90 spd50:", M.isCadenceImplausibleForMode("driving", 90, 50, stats));
console.log("cadImpl driving cad90 spd120:", M.isCadenceImplausibleForMode("driving", 90, 120, stats));
console.log("cadImpl driving cad90 spd10:", M.isCadenceImplausibleForMode("driving", 90, 10, stats));
console.log("cadImpl walking cad90 spd10:", M.isCadenceImplausibleForMode("walking", 90, 10, stats));

// gateCycling
console.log("gate good:", JSON.stringify(M.gateCycling({ mode: "cycling", obsCadence: 5, obsSpeed: 18 })));
console.log("gate tooFast:", JSON.stringify(M.gateCycling({ mode: "cycling", obsCadence: 5, obsSpeed: 40 })));
console.log("gate walkCadence:", JSON.stringify(M.gateCycling({ mode: "cycling", obsCadence: 90, obsSpeed: 18 })));
console.log("gate nonCycling:", JSON.stringify(M.gateCycling({ mode: "walking", obsCadence: 90, obsSpeed: 5 })));

// correctModeBySignature
console.log("correct hrVeto:", JSON.stringify(M.correctModeBySignature({ mode: "cycling", confidenceMargin: 1, obsHr: 55, obsCadence: 100, obsSpeed: 5 }, stats)));
console.log("correct stationary:", JSON.stringify(M.correctModeBySignature({ mode: "stationary", confidenceMargin: 1, obsHr: 55, obsCadence: 0, obsSpeed: 0 }, stats)));
console.log("correct highMargin:", JSON.stringify(M.correctModeBySignature({ mode: "walking", confidenceMargin: 5, obsHr: 100, obsCadence: 110, obsSpeed: 5 }, stats)));
