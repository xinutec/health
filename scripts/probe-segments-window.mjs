#!/usr/bin/env node
// Every segment a golden fixture replays to, inside a time window, with the
// pass chain that wrote it. `probe-rail-legs.mjs` prints TRAIN legs only, which
// cannot answer "what ENDED this ride" — the answer is usually the segment that
// follows, and it is not a train.
//
// Usage: nix develop . --command node scripts/probe-segments-window.mjs <date> <fromZ> <toZ>
//   e.g. ... 2026-04-29 17:20 18:00
import { readFileSync } from "node:fs";
import { inputsFromFixture, parseCapturedDay } from "../dist/cli/fixture-day.js";
import { computeVelocityFromInputs } from "../dist/geo/velocity.js";

const [, , date, fromHm, toHm] = process.argv;
if (!date || !fromHm || !toHm) {
	console.error("usage: probe-segments-window.mjs <date> <HH:MM> <HH:MM>");
	process.exit(2);
}

const hm = (ts) => new Date(ts * 1000).toISOString().slice(11, 19);
const at = (hhmm) => {
	const [h, m] = hhmm.split(":").map(Number);
	return Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000) + h * 3600 + m * 60;
};
const from = at(fromHm);
const to = at(toHm);

const captured = parseCapturedDay(readFileSync(`tests/golden/days/${date}-pippijn.json`, "utf8"));
const { segments } = await computeVelocityFromInputs(inputsFromFixture(captured), { walkMatch: false });

console.log(`\n=== ${date} ${fromHm}-${toHm}Z ===`);
for (const s of segments) {
	if (s.endTs < from || s.startTs > to) continue;
	const mode = s.refinedMode ?? s.mode;
	console.log(
		`${hm(s.startTs)}-${hm(s.endTs)} ${String(s.endTs - s.startTs).padStart(4)}s ` +
			`${mode.padEnd(10)} avg=${String(s.avgSpeed).padStart(6)} max=${String(s.maxSpeed).padStart(6)} ` +
			`pts=${String(s.pointCount).padStart(4)}  ${s.wayName ?? ""}`,
	);
	for (const r of (s.refinedReason ?? "").split(";").filter((x) => x.trim())) console.log(`      · ${r.trim()}`);
	if (s.refinedKinds?.length) console.log(`      [${s.refinedKinds.join(", ")}]`);
}
