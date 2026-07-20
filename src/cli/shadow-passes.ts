/**
 * CLI: the request-path shadow ledger for the verified geometry passes.
 *
 * Replays golden days through `computeVelocityFromInputs` with
 * `LEAN_PASSES=shadow`, so every wired pass (simplify, rejectSpikes) executes
 * the proved Lean implementation via the in-process bridge alongside the TS,
 * serves the TS output (zero behaviour change), and records where the two
 * diverge. Prints the per-op tally plus every diverging leg.
 *
 * This is the measurement that gates the serve-Lean flip: a pass may go
 * `LEAN_PASSES=on` once its ledger is either empty or a small, understood set
 * of near-tie legs that have been re-blessed against the quantised output.
 *
 * Usage: node dist/cli/shadow-passes.js [date ...]
 */

import { readdirSync, readFileSync } from "node:fs";
import { computeVelocityFromInputs } from "../geo/velocity.js";
import { leanPassDivergences, leanPassStats, resetLeanPassStats } from "../lean/lean-passes.js";
import { inputsFromFixture, parseCapturedDay } from "./fixture-day.js";

// `leanPassMode()` reads the env per call, so setting it before the run loop
// (after imports) is sufficient to put the wired passes into shadow mode.
process.env.LEAN_PASSES = "shadow";

const argDates = process.argv.slice(2);
const files = readdirSync("tests/golden/days")
	.filter((f) => f.endsWith(".json"))
	.filter((f) => argDates.length === 0 || argDates.some((d) => f.startsWith(d)))
	.sort();

resetLeanPassStats();
for (const file of files) {
	const inputs = inputsFromFixture(parseCapturedDay(readFileSync(`tests/golden/days/${file}`, "utf8")));
	await computeVelocityFromInputs(inputs, { walkMatch: true });
}

const stats = leanPassStats();
console.log("\n=== lean-passes shadow ledger ===");
for (const [op, s] of Object.entries(stats)) {
	console.log(`  ${op}: ${s.calls} calls, ${s.diffs} divergence(s)`);
}

const divs = leanPassDivergences();
if (divs.length > 0) {
	console.log(`\ndiverging legs (${divs.length}):`);
	for (const d of divs) console.log(`  ${d.op} n=${d.n}: ${d.note}`);
}

const totalDiffs = Object.values(stats).reduce((a, s) => a + s.diffs, 0);
console.log(
	`\n${files.length} day(s); ${totalDiffs} divergence(s) — ${totalDiffs === 0 ? "CLEAN (ready to flip)" : "near-tie ledger above (re-bless or accept before flip)"}`,
);
process.exit(0);
