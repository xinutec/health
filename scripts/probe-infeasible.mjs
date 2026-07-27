#!/usr/bin/env node
// Locate a day's worldline-feasibility violations on the timeline: the offending
// window, the leg it belongs to, and the fixes inside it with their step speeds.
// The golden gate reports a violation's TEXT but not which leg it sits in nor
// which fixes drive it, which is where every investigation has to start.
//
// Usage: nix develop . --command node scripts/probe-infeasible.mjs <date> [...]
import { readFileSync } from "node:fs";
import { inputsFromFixture, parseCapturedDay } from "../dist/cli/fixture-day.js";
import { checkWorldlineFeasibility } from "../dist/eval/worldline-feasibility.js";
import { segmentsToDayStates } from "../dist/sleep/day-state.js";
import { computeVelocityFromInputs } from "../dist/geo/velocity.js";

const t = (ts) => new Date(ts * 1000).toISOString().slice(11, 19);
const R = 6371000;
const D = Math.PI / 180;
const metres = (a, b) =>
	Math.hypot((b.lon - a.lon) * D * Math.cos(((a.lat + b.lat) / 2) * D), (b.lat - a.lat) * D) * R;

for (const date of process.argv.slice(2)) {
	const captured = parseCapturedDay(readFileSync(`tests/golden/days/${date}-pippijn.json`, "utf8"));
	const inputs = inputsFromFixture(captured);
	const { segments, points } = await computeVelocityFromInputs(inputs, { walkMatch: false });
	const states = segmentsToDayStates(segments, [], captured.meta.tz);
	const violations = checkWorldlineFeasibility(
		states,
		points,
		inputs.biometrics.steps,
		new Map(Object.entries(captured.inputs.osmTrace.stationsOnLine ?? {})),
	);
	console.log(`\n=== ${date}: ${violations.length} violation(s) ===`);
	for (const v of violations) {
		console.log(`\n${v.kind}  ${t(v.startTs)}-${t(v.endTs)}`);
		console.log(`  ${v.detail}`);
		const leg = segments.find((s) => s.startTs <= v.startTs && s.endTs >= v.endTs);
		if (leg) {
			console.log(
				`  leg ${t(leg.startTs)}-${t(leg.endTs)} ${leg.refinedMode ?? leg.mode} ${leg.wayName ?? ""}`,
			);
			for (const r of (leg.refinedReason ?? "").split("; ")) if (r) console.log(`      · ${r}`);
		}
		const win = points.filter((p) => p.ts >= v.startTs - 120 && p.ts <= v.endTs + 120);
		for (let i = 1; i < win.length; i++) {
			const dt = win[i].ts - win[i - 1].ts;
			const m = metres(win[i - 1], win[i]);
			const kmh = dt > 0 ? (m / dt) * 3.6 : 0;
			const mark = kmh >= 15 ? " <<<" : "";
			console.log(`    ${t(win[i].ts)}  ${m.toFixed(0).padStart(5)} m  ${dt.toString().padStart(4)} s  ${kmh.toFixed(1).padStart(6)} km/h${mark}`);
		}
	}
}
