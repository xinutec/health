#!/usr/bin/env node
// Dump every train leg a golden fixture replays to, with its wayName and the
// full refinedReason chain. The reason chain names the passes that touched the
// leg, so this answers "which pass wrote this board/alight station" without a
// DB or a live mirror — the question every invalid-rail-triple investigation
// starts from.
//
// Usage: nix develop . --command node scripts/probe-rail-legs.mjs <date> [...]
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
		if (mode !== "train") continue;
		console.log(`\n${t(s.startTs)}-${t(s.endTs)}  ${s.wayName ?? "(no wayName)"}`);
		for (const r of (s.refinedReason ?? "").split("; ")) if (r) console.log(`    · ${r}`);
	}
}
