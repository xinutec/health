#!/usr/bin/env node
// Every NON-VEHICLE segment in the golden corpus whose own fixes sustain a
// vehicle-paced run — a segment that has swallowed part of a ride.
//
// This is the shared shape behind #445 and #810: a ride's continuation is left
// in the segment that follows it, which then reports the ride's motion as its
// own. 2026-06-16 has it twice in a row — a "walk" peaking at 112 km/h and then
// a "stationary" at 77, which together are the missing Baker Street → Green
// Park leg.
//
// The run test is `worstVehiclePacedRun`, the SAME scan the kinematic invariant
// uses (>= 15 km/h per step, >= 250 m net, >= 2 consecutive steps). Reused
// rather than restated so this probe cannot drift from the gate. The invariant
// asserts on `walking` only and says why — a stationary leg's sparse blackout
// fixes can teleport in consistent pairs. Measuring a mode and asserting on it
// are different decisions, so this probe asks every non-vehicle mode and
// reports what it finds.
//
// Usage: nix develop . --command node scripts/probe-swallowed-rides.mjs
import { readdirSync, readFileSync } from "node:fs";
import { inputsFromFixture, parseCapturedDay } from "../dist/cli/fixture-day.js";
import { worstVehiclePacedRun } from "../dist/eval/worldline-feasibility.js";
import { computeVelocityFromInputs } from "../dist/geo/velocity.js";

/** Modes that cannot themselves be a ride. `cycling` is here because the
 *  kinematic ceiling that matters is motorised pace, well above a bicycle. */
const NON_VEHICLE = new Set(["walking", "stationary", "cycling"]);
/** A segment on either side that IS a ride. Adjacency to one is what separates
 *  "swallowed a ride" from "a lone teleport in the middle of a stay". */
const VEHICLE = new Set(["train", "driving", "bus", "plane"]);

const hm = (ts) => new Date(ts * 1000).toISOString().slice(11, 16);
const mode = (s) => s.refinedMode ?? s.mode;

const days = readdirSync("tests/golden/days")
	.filter((f) => f.endsWith(".json"))
	.sort();

const hits = [];
let considered = 0;
for (const file of days) {
	const date = file.slice(0, 10);
	const captured = parseCapturedDay(readFileSync(`tests/golden/days/${file}`, "utf8"));
	const { segments, points } = await computeVelocityFromInputs(inputsFromFixture(captured), { walkMatch: false });
	for (const [i, s] of segments.entries()) {
		const m = mode(s);
		if (!NON_VEHICLE.has(m)) continue;
		considered++;
		const run = worstVehiclePacedRun((points ?? []).filter((p) => p.ts >= s.startTs && p.ts <= s.endTs));
		if (!run) continue;
		const prev = segments[i - 1];
		const next = segments[i + 1];
		hits.push({
			date,
			seg: s,
			m,
			run,
			prevMode: prev ? mode(prev) : null,
			nextMode: next ? mode(next) : null,
		});
	}
}

console.log(`\n${hits.length} of ${considered} non-vehicle segments sustain a vehicle-paced run (${days.length} days)\n`);

const byMode = new Map();
for (const h of hits) byMode.set(h.m, (byMode.get(h.m) ?? 0) + 1);
console.log("by mode: " + [...byMode].map(([k, v]) => `${k}=${v}`).join("  "));

const adjacent = hits.filter((h) => VEHICLE.has(h.prevMode) || VEHICLE.has(h.nextMode));
console.log(`beside a ride: ${adjacent.length} of ${hits.length} (the rest are isolated — teleports, not handoffs)\n`);

for (const { date, seg, m, run, prevMode, nextMode } of hits.sort((a, b) => b.run.netM - a.run.netM)) {
	const near = VEHICLE.has(prevMode) || VEHICLE.has(nextMode) ? "" : "   (isolated)";
	console.log(
		`${date} ${hm(seg.startTs)}-${hm(seg.endTs)} ${m.padEnd(10)} ` +
			`${String(Math.round(run.netM)).padStart(5)} m net over ${run.steps} step(s), peak ${String(Math.round(run.peakKmh)).padStart(3)} km/h  ` +
			`[${prevMode ?? "—"} | ${nextMode ?? "—"}]${near}`,
	);
	for (const r of (seg.refinedReason ?? "").split(";").filter((x) => x.trim())) console.log(`      · ${r.trim()}`);
}
