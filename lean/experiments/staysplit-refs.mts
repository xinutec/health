#!/usr/bin/env -S npx tsx
/**
 * Reference-value generator for `stay-split.ts`'s pure leaf `scoreSplitEvidence`,
 * ported to `Verified/Geo/StaySplit.lean`.
 * Run: npx tsx lean/experiments/staysplit-refs.mts
 */
import * as SS from "../../src/geo/stay-split.js";

type Ev = Parameters<typeof SS.scoreSplitEvidence>[0];
const cases: [string, Ev][] = [
	["walkStrong", { gapDurationS: 1800, medianPriorGapS: 30, preGapFixCount: 10, stepsInGap: 900, hrMeanInGap: 120, hrSamplesInGap: 5, postGapDistFromCentroidM: 500 }],
	["sittingSilent", { gapDurationS: 3600, medianPriorGapS: 30, preGapFixCount: 10, stepsInGap: 0, hrMeanInGap: 60, hrSamplesInGap: 5, postGapDistFromCentroidM: 5 }],
	["ambiguousMid", { gapDurationS: 1200, medianPriorGapS: 60, preGapFixCount: 10, stepsInGap: 80, hrMeanInGap: 100, hrSamplesInGap: 5, postGapDistFromCentroidM: 300 }],
	["fidget", { gapDurationS: 1800, medianPriorGapS: 30, preGapFixCount: 10, stepsInGap: 45, hrMeanInGap: null, hrSamplesInGap: 0, postGapDistFromCentroidM: 300 }],
	["clearMove", { gapDurationS: 1800, medianPriorGapS: 30, preGapFixCount: 10, stepsInGap: 300, hrMeanInGap: 96, hrSamplesInGap: 4, postGapDistFromCentroidM: 300 }],
	["zeroGap", { gapDurationS: 0, medianPriorGapS: 30, preGapFixCount: 10, stepsInGap: 100, hrMeanInGap: 120, hrSamplesInGap: 5, postGapDistFromCentroidM: 300 }],
	["mildAnomaly", { gapDurationS: 1800, medianPriorGapS: 120, preGapFixCount: 10, stepsInGap: 500, hrMeanInGap: null, hrSamplesInGap: 0, postGapDistFromCentroidM: 300 }],
	["fewPreFix", { gapDurationS: 1800, medianPriorGapS: 30, preGapFixCount: 3, stepsInGap: 500, hrMeanInGap: null, hrSamplesInGap: 0, postGapDistFromCentroidM: 300 }],
];
for (const [name, ev] of cases) console.log(`${name}: ${SS.scoreSplitEvidence(ev)}`);
