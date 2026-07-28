#!/usr/bin/env node
// Does the watch-timed step burst actually DISCRIMINATE a real change of
// train from a ride that merely paused? #382's remaining lead rests on the
// claim that it does; this asks the detector directly rather than assuming.
//
// Prints, for one ride window: every minute at or above the burst cadence,
// and what `findInterchangeBurst` makes of them. A real platform change is a
// walk with steps; a train sitting at a station is not.
//
// Usage: nix develop . --command node scripts/probe-interchange-burst.mjs <date> <fromZ> <toZ>
import { readFileSync } from "node:fs";
import { parseCapturedDay } from "../dist/cli/fixture-day.js";
import { findInterchangeBurst } from "../dist/geo/interchange-split.js";

const [date, fromZ, toZ] = process.argv.slice(2);
const t = (ts) => new Date(ts * 1000).toISOString().slice(11, 19);
const captured = parseCapturedDay(readFileSync(`tests/golden/days/${date}-pippijn.json`, "utf8"));
const steps = captured.inputs.biometrics.steps ?? [];
const lo = Date.parse(`${date}T${fromZ}Z`) / 1000;
const hi = Date.parse(`${date}T${toZ}Z`) / 1000;

console.log(`\n=== ${date} ride ${fromZ}–${toZ} (${Math.round((hi - lo) / 60)} min) ===`);
const inWindow = steps.filter((s) => s.ts > lo && s.ts < hi).sort((a, b) => a.ts - b.ts);
console.log(`steps minutes in window: ${inWindow.length}`);
for (const s of inWindow) {
	const mark = s.steps >= 40 ? " <<< burst-cadence" : "";
	if (s.steps > 0) console.log(`  ${t(s.ts)}  ${String(s.steps).padStart(3)} steps/min${mark}`);
}
const burst = findInterchangeBurst(steps, lo, hi);
console.log(
	burst
		? `\n=> BURST ${t(burst.startTs)}–${t(burst.endTs)} (${Math.round((burst.endTs - burst.startTs) / 60)} min)`
		: "\n=> no burst (none, ambiguous, or hugging a leg edge)",
);
