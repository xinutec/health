/**
 * Constraint score: replay every frozen golden fixture through the real
 * pipeline and count how many physically-impossible things the rendered day
 * contains, per {@link checkDayConstraints}. Zero-DB and deterministic — same
 * input closure as `golden-check`.
 *
 * This is the objective the joint-inference rebuild drives to zero: "how often
 * does the pipeline emit a day that could not have happened?" Run before and
 * after a change to see whether it removed impossibilities or introduced them.
 *
 * Usage: scripts/score-constraints.sh   (builds, then runs this, no DB)
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { computeVelocityFromInputs } from "../geo/velocity.js";
import { type ConstraintId, checkDayConstraints } from "../infer/day-grammar.js";
import { type CapturedDay, inputsFromFixture, parseCapturedDay } from "./fixture-day.js";
import { normalizeStates, stateLine } from "./state-diff.js";

const DAYS_DIR = path.join(process.cwd(), "tests", "golden", "days");

async function main(): Promise<void> {
	let files: string[];
	try {
		files = (await readdir(DAYS_DIR)).filter((f) => f.endsWith(".json")).sort();
	} catch {
		console.error("no golden corpus — capture one with scripts/capture-golden.sh");
		process.exit(2);
	}
	if (files.length === 0) {
		console.error("no golden fixtures found");
		process.exit(2);
	}

	const totals = new Map<ConstraintId, number>();
	let daysWithViolations = 0;

	for (const file of files) {
		const captured: CapturedDay = parseCapturedDay(await readFile(path.join(DAYS_DIR, file), "utf8"));
		const { states } = await computeVelocityFromInputs(inputsFromFixture(captured));
		const violations = checkDayConstraints(states);
		const label = file.replace(/\.json$/, "");
		if (violations.length === 0) {
			console.log(`ok    ${label}`);
			continue;
		}
		daysWithViolations++;
		console.log(`VIOL  ${label}  (${violations.length})`);
		const norm = normalizeStates(states, captured.meta.tz);
		for (const v of violations) {
			totals.set(v.constraint, (totals.get(v.constraint) ?? 0) + 1);
			console.log(`        [${v.constraint}] ${v.detail}`);
			console.log(`          ${stateLine(norm[v.index])}`);
		}
	}

	const total = [...totals.values()].reduce((a, b) => a + b, 0);
	console.log(`\n${total} violation(s) across ${files.length} day(s); ${daysWithViolations} day(s) affected`);
	for (const [id, n] of [...totals.entries()].sort((a, b) => b[1] - a[1])) {
		console.log(`  ${String(n).padStart(3)}  ${id}`);
	}
	// Exit non-zero if any impossibility is present — lets CI/loops gate on it.
	process.exit(total > 0 ? 1 : 0);
}

await main();
