/**
 * CLI: the request-path flip gate for the verified geometry passes.
 *
 * Replays golden days through `computeVelocityFromInputs` with the verified
 * passes active (default `LEAN_PASSES=shadow`; pass `--on` to serve the Lean
 * output instead). Every wired pass (simplify, rejectSpikes) executes the
 * proved Lean implementation via the in-process bridge alongside the TS,
 * records calls / bridge-failures / divergences, and this CLI adjudicates the
 * result against three honest conditions:
 *
 *   1. COVERAGE   — the bridge actually ran (total calls > 0). A dead bridge
 *                   or an unwired pass is NOT "clean"; it means nothing was
 *                   verified.
 *   2. NO FALLBACK — zero bridge failures (every call was served by Lean, none
 *                   silently fell back to TS).
 *   3. AGREEMENT  — every divergence is in the accepted near-tie manifest
 *                   (src/lean/accepted-deltas.ts). A new/unexplained
 *                   divergence fails the gate.
 *
 * All three green ⇒ the passes are ready to serve Lean in production. Exit 0
 * on green, exit 1 otherwise.
 *
 * Usage: node dist/cli/shadow-passes.js [--on] [date ...]
 */

import { readdirSync, readFileSync } from "node:fs";
import { computeVelocityFromInputs } from "../geo/velocity.js";
import { isAcceptedDelta } from "../lean/accepted-deltas.js";
import { leanPassDivergences, leanPassStats, resetLeanPassStats } from "../lean/lean-passes.js";
import { inputsFromFixture, parseCapturedDay } from "./fixture-day.js";

const args = process.argv.slice(2);
const serveLean = args.includes("--on");
const argDates = args.filter((a) => a !== "--on");

// `leanPassMode()` reads the env per call, so setting it before the run loop
// (after imports) is sufficient to put the wired passes into the chosen mode.
// Both modes take the same measurements; `on` additionally serves Lean.
process.env.LEAN_PASSES = serveLean ? "on" : "shadow";

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
console.log(`\n=== lean-passes ${serveLean ? "SERVE-LEAN" : "shadow"} gate ===`);
let totalCalls = 0;
let totalFails = 0;
for (const [op, s] of Object.entries(stats)) {
	totalCalls += s.calls;
	totalFails += s.fails;
	console.log(`  ${op}: ${s.calls} calls, ${s.fails} bridge-failure(s), ${s.diffs} divergence(s)`);
}

const divs = leanPassDivergences();
const unexplained = divs.filter((d) => !isAcceptedDelta(d.op, d.n, d.note));
if (divs.length > 0) {
	console.log(`\ndivergences (${divs.length}; ${unexplained.length} unexplained):`);
	for (const d of divs) {
		const tag = isAcceptedDelta(d.op, d.n, d.note) ? "accepted" : "UNEXPLAINED";
		console.log(`  [${tag}] ${d.op} n=${d.n}: ${d.note}`);
	}
}

// Three honest conditions — all must hold to call the passes ready to flip.
const problems: string[] = [];
if (totalCalls === 0) problems.push("NO COVERAGE — the bridge never ran (0 calls); nothing was verified");
if (totalFails > 0) problems.push(`${totalFails} bridge-failure(s) — calls silently fell back to TS`);
if (unexplained.length > 0)
	problems.push(`${unexplained.length} unexplained divergence(s) — not in the accepted manifest`);

console.log(`\n${files.length} day(s), ${totalCalls} verified call(s).`);
if (problems.length === 0) {
	console.log("GATE GREEN — bridge covered every call, zero fallback, all divergences accepted. Ready to flip.");
	process.exit(0);
} else {
	console.log("GATE RED:");
	for (const p of problems) console.log(`  ✗ ${p}`);
	process.exit(1);
}
