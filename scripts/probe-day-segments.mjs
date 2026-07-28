#!/usr/bin/env node
// Dump every segment a golden fixture replays to — mode, window, label and the
// refinedReason chain. The whole-day view probe-rail-legs.mjs deliberately does
// not give you: when a ride goes MISSING, the question is what took its place.
//
// Usage: nix develop . --command node scripts/probe-day-segments.mjs <date> [...]
import { readFileSync } from "node:fs";
import { inputsFromFixture, parseCapturedDay } from "../dist/cli/fixture-day.js";
import { computeVelocityFromInputs } from "../dist/geo/velocity.js";

const t = (ts) => new Date(ts * 1000).toISOString().slice(11, 16);

for (const date of process.argv.slice(2)) {
	const captured = parseCapturedDay(readFileSync(`tests/golden/days/${date}-pippijn.json`, "utf8"));
	const { segments } = await computeVelocityFromInputs(inputsFromFixture(captured), { walkMatch: false });
	console.log(`\n=== ${date} ===`);
	for (const s of segments) {
		const mode = s.refinedMode ?? s.mode;
		console.log(`${t(s.startTs)}-${t(s.endTs)}  ${mode.padEnd(10)} ${s.wayName ?? s.placeName ?? ""}`);
		for (const r of (s.refinedReason ?? "").split("; ")) if (r) console.log(`      · ${r}`);
	}
}
