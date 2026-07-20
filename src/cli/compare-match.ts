/**
 * CLI: the matcher-level parity gate (the V4 matcher arc of
 * `docs/proposals/2026-07-verified-core-lean.md`).
 *
 * For every walking leg of every golden day fixture (zero DB — the
 * `score-walk-match` replay chassis): run the production `matchWalkSegment`
 * (float), the BigInt twin `qMatchWalkSegment`, and the verified Lean matcher
 * (`verified_cli match`) on identical leg-windowed input, via the shared
 * `walk-shadow-core` (the same per-leg A/B the `decode-day` cron shadow runs
 * on live days). Reports the float↔quant decision classes and GATES on
 * quant↔Lean bit-exactness.
 *
 * float↔quant classes per leg:
 *   EXACT — both null, or bit-identical quantised vertex rows;
 *   NEAR  — same null-ness + vertex counts, coords within 30 cm;
 *   DIFF  — different null-ness or geometry (a genuine decision flip).
 *
 * Exit 0 = every leg's Lean output matches the twin bit-for-bit; exit 1 on any
 * quant↔Lean mismatch. (The float↔quant classes are diagnostic, never gated.)
 *
 * Usage: node dist/cli/compare-match.js [date ...]
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { computeVelocityFromInputs } from "../geo/velocity.js";
import {
	extractWalkLegs,
	flattenBuildings,
	flattenWalkable,
	shadowWalkLeg,
	type WalkEpisode,
} from "../geo/walk-shadow-core.js";
import { inputsFromFixture, parseCapturedDay } from "./fixture-day.js";

/** The Lean arm binary — `LEAN_CLI` in the built image, else the local build. */
const LEAN_BIN = process.env.LEAN_CLI ?? path.join(process.cwd(), "lean", ".lake", "build", "bin", "verified_cli");

const argDates = process.argv.slice(2);
const files = readdirSync("tests/golden/days")
	.filter((f) => f.endsWith(".json"))
	.filter((f) => argDates.length === 0 || argDates.some((d) => f.startsWith(d)))
	.sort();

let legs = 0;
const coarseTotals = { EXACT: 0, NEAR: 0, DIFF: 0 };
const pathTotals = { EXACT: 0, NEAR: 0, DIFF: 0 };
let nullBoth = 0;
let nullFlips = 0;
let leanExact = 0;
const leanMismatches: string[] = [];

for (const file of files) {
	const captured = parseCapturedDay(readFileSync(`tests/golden/days/${file}`, "utf8"));
	const inputs = inputsFromFixture(captured);
	const run = await computeVelocityFromInputs(inputs, { walkMatch: true });
	const legInputs = extractWalkLegs(
		run.episodes as WalkEpisode[],
		inputs.phonetrack.today,
		flattenWalkable(captured.inputs.osmTrace),
		flattenBuildings(captured.inputs.osmTrace),
	);
	const perDay: string[] = [];
	for (const leg of legInputs) {
		const r = shadowWalkLeg(leg, LEAN_BIN);
		legs++;
		const hhmm = new Date(leg.startTs * 1000).toISOString().slice(11, 16);
		if (r.exact) leanExact++;
		else leanMismatches.push(`${file.slice(0, 10)} ${hhmm}`);
		coarseTotals[r.coarse]++;
		pathTotals[r.path]++;
		if (r.float === null && r.quant === null) nullBoth++;
		if ((r.float === null) !== (r.quant === null)) nullFlips++;
		perDay.push(
			`${hhmm} coarse=${r.coarse}/path=${r.path}` +
				`${r.float === null ? " float=null" : ""}${r.quant === null ? " quant=null" : ""}` +
				((r.coarse === "DIFF" || r.path === "DIFF") && r.float !== null && r.quant !== null
					? ` (coarse ${r.float.coarsePath.length}v vs ${r.quant.coarsePath.length}v, path ${r.float.path.length}v vs ${r.quant.path.length}v)`
					: ""),
		);
	}
	console.log(`${file.slice(0, 10)}: ${perDay.length} leg(s) — ${perDay.join(", ") || "none"}`);
}

console.log(
	`\ncompare-match: ${legs} legs — coarse EXACT=${coarseTotals.EXACT} NEAR=${coarseTotals.NEAR} ` +
		`DIFF=${coarseTotals.DIFF}; path EXACT=${pathTotals.EXACT} NEAR=${pathTotals.NEAR} ` +
		`DIFF=${pathTotals.DIFF} (both-null ${nullBoth}, null-flips ${nullFlips})`,
);
console.log(
	`compare-match: quant↔lean ${leanExact}/${legs} EXACT, ${leanMismatches.length} mismatch` +
		(leanMismatches.length > 0 ? ` — ${leanMismatches.join(", ")}` : ""),
);
process.exit(leanMismatches.length === 0 ? 0 : 1);
