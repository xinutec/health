#!/usr/bin/env -S npx tsx
/**
 * Reference-value generator for `dwell-continuation.ts`'s pure exports ported to
 * `Verified/Geo/DwellContinuation.lean`. Run: npx tsx lean/experiments/dwell-refs.mts
 */
import * as D from "../../src/geo/dwell-continuation.js";

console.log("meanDwell ok:", D.meanDwellSec({ totalDwellSec: 72000, visitCount: 24, uniqueDays: 30 }));
console.log("meanDwell zeroVisits:", D.meanDwellSec({ totalDwellSec: 72000, visitCount: 0, uniqueDays: 30 }));
console.log("meanDwell zeroDwell:", D.meanDwellSec({ totalDwellSec: 0, visitCount: 24, uniqueDays: 30 }));

console.log("survival 1800/3600:", D.dwellSurvival(1800, 3600));
console.log("survival 0/3600:", D.dwellSurvival(0, 3600));
console.log("survival tau0:", D.dwellSurvival(3600, 0));
console.log("survival negElapsed:", D.dwellSurvival(-500, 3600));

const home = { totalDwellSec: 1080000, visitCount: 30, uniqueDays: 30 }; // tau = 36000
console.log("cont home:", JSON.stringify(D.dwellContinuation({ place: home, lastEndTs: 1000, dayEndTs: 100000 })));
console.log("cont clampedDay:", JSON.stringify(D.dwellContinuation({ place: home, lastEndTs: 1000, dayEndTs: 10000 })));
console.log("cont fewDays:", JSON.stringify(D.dwellContinuation({ place: { totalDwellSec: 1080000, visitCount: 30, uniqueDays: 3 }, lastEndTs: 1000, dayEndTs: 100000 })));
console.log("cont pastDay:", JSON.stringify(D.dwellContinuation({ place: home, lastEndTs: 100000, dayEndTs: 100000 })));
console.log("cont badTau:", JSON.stringify(D.dwellContinuation({ place: { totalDwellSec: 0, visitCount: 30, uniqueDays: 30 }, lastEndTs: 1000, dayEndTs: 100000 })));
const cafe = { totalDwellSec: 108000, visitCount: 30, uniqueDays: 10 }; // tau = 3600
console.log("cont cafe floor0.8:", JSON.stringify(D.dwellContinuation({ place: cafe, lastEndTs: 1000, dayEndTs: 100000, floor: 0.8 })));
