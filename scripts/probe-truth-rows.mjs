#!/usr/bin/env node
// Why a confirmed ground-truth row does or does not hold — the row-level view
// `golden.sh` only summarises.
//
// Mirrors golden-check EXACTLY: same `computeVelocityFromInputs(inputs)` call
// with default options, same `states` array, same midpoint lookup. That matters
// — probe-day-segments.mjs and probe-rail-legs.mjs pass `walkMatch: false`, so
// they can disagree with the gate about the drawn geometry. This one cannot.
//
// For each row it prints the truth cell, the verdict, the state the checker
// compared against, and (for a regressed row) every state overlapping the
// window — because "no longer holds" is usually a boundary that moved, and the
// midpoint alone will not show you that.
//
// Usage: nix develop . --command node scripts/probe-truth-rows.mjs <date> [...]
//        ALL=1 to print every row, not just the enforceable ones.
import { readFileSync } from "node:fs";
import { inputsFromFixture, parseCapturedDay } from "../dist/cli/fixture-day.js";
import { isEnforceableTruth, parseGroundTruth } from "../dist/eval/ground-truth.js";
import { classifyDay, parsePipelineState } from "../dist/eval/truth-check.js";
import { computeVelocityFromInputs } from "../dist/geo/velocity.js";

const t = (ts) => new Date(ts * 1000).toISOString().slice(11, 16);
const show = (s) =>
	s == null ? "(no state covers this window)" : `${s.mode.padEnd(10)} ${s.place ?? s.wayName ?? "—"}`;

for (const date of process.argv.slice(2)) {
	const captured = parseCapturedDay(readFileSync(`tests/golden/days/${date}-pippijn.json`, "utf8"));
	const { states } = await computeVelocityFromInputs(inputsFromFixture(captured));
	const gt = parseGroundTruth(readFileSync(`tests/golden/ground-truth/${date}.md`, "utf8"), date, captured.meta.tz);

	const stateAt = (startTs, endTs) => {
		const mid = (startTs + endTs) / 2;
		return states.find((s) => s.startTs <= mid && mid < s.endTs) ?? null;
	};
	const res = classifyDay(gt.rows, (row) => parsePipelineState(stateAt(row.startTs, row.endTs)));

	console.log(`\n=== ${date} (${captured.meta.tz}) ===`);
	for (const { row, verdict } of res.verdicts) {
		if (!process.env.ALL && !isEnforceableTruth(row)) continue;
		const mark = verdict === "regressed" ? "✗" : verdict === "verified" ? "✓" : "·";
		console.log(`\n${mark} ${row.windowText}  [${verdict}] {${row.provenance}}`);
		console.log(`    truth: ${row.truthText}`);
		console.log(`    got:   ${show(stateAt(row.startTs, row.endTs))}`);
		if (verdict !== "regressed") continue;
		// The whole window, not just its middle: a row breaks when a boundary
		// moves, and the state at the midpoint is the last thing to show it.
		console.log(`    states overlapping ${t(row.startTs)}–${t(row.endTs)}Z:`);
		for (const s of states) {
			if (s.endTs <= row.startTs || s.startTs >= row.endTs) continue;
			console.log(`      ${t(s.startTs)}-${t(s.endTs)}  ${show(s)}`);
		}
	}
}
