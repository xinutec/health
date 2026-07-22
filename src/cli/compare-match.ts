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
 * With `--gate` this becomes the MATCHER FLIP GATE (the analogue of
 * `shadow-passes` for the geometry passes). On top of the quant↔Lean check it
 * asserts the three honest flip conditions:
 *   1. COVERAGE   — legs were actually matched (legs > 0).
 *   2. NO FALLBACK — quant↔Lean is bit-exact on every leg (serving Lean == the
 *                   twin; nothing silently diverges from the verified core).
 *   3. AGREEMENT  — every float↔quant NEAR/DIFF leg is in the accepted manifest
 *                   (src/lean/accepted-match-deltas.ts). Serving Lean adopts the
 *                   quant decision on exactly these legs, so each must be
 *                   signed off; a new/unexplained one fails the gate.
 * All three green ⇒ the matcher is ready to serve Lean (LEAN_MATCH=on) in prod.
 *
 * Usage: node dist/cli/compare-match.js [--gate] [date ...]
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { beginWalkLegCapture, endWalkLegCapture } from "../geo/pedestrian-match-annotate.js";
import { computeVelocityFromInputs } from "../geo/velocity.js";
import { shadowWalkLeg } from "../geo/walk-shadow-core.js";
import { isAcceptedMatchDelta, type MatchLegClass } from "../lean/accepted-match-deltas.js";
import { inputsFromFixture, parseCapturedDay } from "./fixture-day.js";

/** The Lean arm binary — `LEAN_CLI` in the built image, else the local build. */
const LEAN_BIN = process.env.LEAN_CLI ?? path.join(process.cwd(), "lean", ".lake", "build", "bin", "verified_cli");

const allArgs = process.argv.slice(2);
const gate = allArgs.includes("--gate");
const argDates = allArgs.filter((a) => a !== "--gate");

/** Canonical vertex-count fingerprint of a leg's two matcher arms — the manifest
 *  `note` for a diverging leg, stable across runs. */
const legNote = (
	float: { coarsePath: unknown[]; path: unknown[] } | null,
	quant: { coarsePath: unknown[]; path: unknown[] } | null,
): string => {
	const c = (r: { coarsePath: unknown[]; path: unknown[] } | null, k: "coarsePath" | "path"): string =>
		r === null ? "null" : `${r[k].length}v`;
	return `coarse ${c(float, "coarsePath")} vs ${c(quant, "coarsePath")}, path ${c(float, "path")} vs ${c(quant, "path")}`;
};

/** A measured float↔quant divergence, for the --gate manifest check. */
interface DivergentLeg {
	date: string;
	hhmm: string;
	coarse: MatchLegClass;
	path: MatchLegClass;
	note: string;
}
const divergent: DivergentLeg[] = [];
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
	const capture = beginWalkLegCapture();
	await computeVelocityFromInputs(inputs, { walkMatch: true });
	const legInputs = endWalkLegCapture(capture);
	const perDay: string[] = [];
	for (const leg of legInputs) {
		const r = shadowWalkLeg(leg, LEAN_BIN);
		legs++;
		const date = file.slice(0, 10);
		const hhmm = new Date(leg.startTs * 1000).toISOString().slice(11, 16);
		if (r.exact) leanExact++;
		else leanMismatches.push(`${date} ${hhmm}`);
		coarseTotals[r.coarse]++;
		pathTotals[r.path]++;
		if (r.float === null && r.quant === null) nullBoth++;
		if ((r.float === null) !== (r.quant === null)) nullFlips++;
		const note = legNote(r.float, r.quant);
		if (r.coarse !== "EXACT" || r.path !== "EXACT") {
			divergent.push({ date, hhmm, coarse: r.coarse, path: r.path, note });
		}
		perDay.push(
			`${hhmm} coarse=${r.coarse}/path=${r.path}${r.coarse !== "EXACT" || r.path !== "EXACT" ? ` (${note})` : ""}`,
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

if (!gate) {
	// Pure-referee contract: gate only on quant↔Lean bit-exactness.
	process.exit(leanMismatches.length === 0 ? 0 : 1);
}

// --gate: the matcher FLIP gate. Three honest conditions, mirroring
// shadow-passes: coverage, no-fallback (quant↔Lean exact), manifest agreement.
console.log(`\n=== matcher flip gate ===`);
const unexplained = divergent.filter((d) => !isAcceptedMatchDelta(d.date, d.hhmm, d.coarse, d.path, d.note));
if (divergent.length > 0) {
	console.log(`float↔quant divergences (${divergent.length}; ${unexplained.length} unexplained):`);
	for (const d of divergent) {
		const tag = isAcceptedMatchDelta(d.date, d.hhmm, d.coarse, d.path, d.note) ? "accepted" : "UNEXPLAINED";
		console.log(`  [${tag}] ${d.date} ${d.hhmm} coarse=${d.coarse}/path=${d.path} (${d.note})`);
	}
}

const problems: string[] = [];
if (legs === 0) problems.push("NO COVERAGE — no legs matched; nothing was verified");
if (leanMismatches.length > 0)
	problems.push(`${leanMismatches.length} quant↔Lean mismatch(es) — Lean diverges from the verified twin`);
if (unexplained.length > 0)
	problems.push(`${unexplained.length} unexplained float↔quant divergence(s) — not in the accepted manifest`);

console.log(`\n${files.length} day(s), ${legs} leg(s), ${divergent.length} float↔quant delta(s).`);
if (problems.length === 0) {
	console.log("GATE GREEN — every leg matched the verified twin, all float↔quant deltas accepted. Ready to flip.");
	process.exit(0);
}
console.log("GATE RED:");
for (const p of problems) console.log(`  ✗ ${p}`);
process.exit(1);
