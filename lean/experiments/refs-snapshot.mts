/**
 * Run every `*-refs.mts` and hold their output to a committed snapshot (#1003).
 *
 * # The hole this closes
 *
 * A Lean port that is SERVED is protected from TS drift by the day gate — that
 * gate exists because `feefb75` changed a constant in `velocity.ts` and the fold
 * never got it (#424). A port that is written but UNREACHABLE has no such
 * protection: the gate compares arms, and an orphan is in neither.
 *
 * What those orphans have instead is a `#guard` pinned to a CONSTANT, copied by
 * hand from a run of the sibling `*-refs.mts`. Those refs import the production
 * TypeScript — `import * as S from "../../src/geo/segments.js"` — so they are
 * real parity evidence. But nothing re-ran them. If the TS moved, the guard
 * still passed: it pins Lean to a number, and the number's provenance was a file
 * nobody executed. That is the #424 shape with the gate removed.
 *
 * Snapshotting makes the gate execute them. TS moves → the refs print something
 * else → this row goes red, naming the file and the line.
 *
 * # ⚠ What it does NOT close, stated so the row is not read as more than it is
 *
 * This proves the refs still SAY what they said. It does not prove any `#guard`
 * agrees with them — there is no machine-readable link from a guard to a ref
 * value, and building one means annotating thousands of guards across the tree.
 * So the residual failure is: someone blesses a changed snapshot and forgets to
 * carry the number into the `.lean`. The gate puts the diff in front of them at
 * exactly that moment, which is the whole of what it buys. #1003 stays open for
 * the guard-level half.
 *
 * # How much does it actually catch? Measured by ablation, not asserted
 *
 * A snapshot protects exactly what the generators PRINT, and "this refs file
 * calls that module" is a weaker claim than "that module's behaviour is pinned".
 * So every numeric constant in `src/geo/segments.ts` — the module whose Lean
 * twin, `Geo.Segments.classifySegments`, is one of the named orphans — was
 * perturbed one at a time and the check re-run:
 *
 *     gross (90 -> 901), all 17 constants        17/17 caught
 *     tuning-sized (+1, or +0.01), 13 of them    13/13 caught
 *       (the other 4 are expression-valued, `45 * 60`; covered by the gross pass)
 *     repeat trial on one constant, 5 runs        5/5 caught
 *
 * 36 perturbations, 36 caught. That is ONE module of the 77 the refs import;
 * the others are unmeasured, and this comment is not a claim about them.
 *
 * ⚠ ONE ANOMALY, RECORDED BECAUSE IT IS UNEXPLAINED. An early hand run of the
 * 90 -> 91 case reported agreement — the log shows the check ran fully and
 * printed "69 reference generator(s) still agree" while the source really did
 * hold 91. It has not reproduced in the 36 trials since, including 5 repeats of
 * that exact perturbation. The leading suspect is a stale `tsx`/esbuild
 * transpile cache serving the pre-edit module to the subprocesses, which the
 * sweeps would not hit because they restore-then-perturb each iteration. That
 * is a SUSPECT and not a diagnosis. If this row ever goes green over a change
 * you can see in the TS, do not bless the snapshot: that is this, and it means
 * the row can pass for the wrong reason.
 *
 * # Why spawn per file rather than import them all
 *
 * Three refs files (`place-override`, `reversal`, `road-match-annotate`) call
 * `process.exit(1)` on their own self-check failures. In one shared process the
 * first such failure would take the runner down and silence the other 68. It
 * also keeps module state from leaking between files, which is how an ordering
 * dependency gets born.
 *
 * A non-zero refs file is an IMMEDIATE red and is never snapshotted. Recording
 * its output would make "this file now fails its own self-check" look like
 * ordinary drift to be blessed.
 *
 * Run:  pnpm exec tsx lean/experiments/refs-snapshot.mts [--check]
 *   no flag   regenerate lean/experiments/refs.snapshot
 *   --check   regenerate in memory and diff; non-zero if it moved
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const snapshotPath = path.join(here, "refs.snapshot");
const CHECK = process.argv.includes("--check");

const files = readdirSync(here)
	.filter((f) => f.endsWith("-refs.mts"))
	.sort();

// `tsx` directly rather than through `pnpm exec`: same interpreter, without a
// package-manager start-up per file across 69 of them.
const tsx = path.join(repo, "node_modules", ".bin", "tsx");

const sections: string[] = [];
const broken: string[] = [];

for (const f of files) {
	const run = spawnSync(tsx, [path.join(here, f)], {
		cwd: repo,
		encoding: "utf8",
		maxBuffer: 1 << 28,
	});
	if (run.status !== 0) {
		broken.push(`${f}: exit ${run.status}\n${(run.stderr || run.stdout || "").trim().slice(0, 800)}`);
		continue;
	}
	// Trailing whitespace normalised; nothing else touched. The point is to hold
	// the VALUES, and reformatting them here would mean this file gets to decide
	// what a difference is.
	const body = run.stdout.replace(/[ \t]+$/gm, "").replace(/\n+$/, "");
	sections.push(`### ${f}\n${body}`);
}

if (broken.length > 0) {
	console.error(`refs-snapshot: ${broken.length} reference generator(s) FAILED — that is a finding, not drift:\n`);
	for (const b of broken) console.error(`${b}\n`);
	console.error("A refs file exits non-zero only from its own self-check. Fix the port or the fixture;");
	console.error("do not regenerate the snapshot around it.");
	process.exit(1);
}

// Provenance in the artefact itself, not only in the tool: a committed
// generated file that does not say what wrote it is one a reader edits by hand.
const header = [
	"# GENERATED — do not edit.",
	"#",
	"# Written by lean/experiments/refs-snapshot.mts from the output of every",
	"# lean/experiments/*-refs.mts. Those import the PRODUCTION TypeScript, so a",
	"# diff here means the TS moved (#1003).",
	"#",
	"# ⚠ The Lean #guards pinned to these numbers do NOT update themselves. Carry",
	"# the new value into the sibling .lean FIRST, then bless with:",
	"#     pnpm run refs-snapshot",
	"#",
	"# ⚠ GREEN MEANS THE REFS STILL SAY WHAT THEY SAID. It does not mean any Lean",
	"# #guard agrees with them, and it protects only what the refs EXERCISE.",
	"# Measured on src/geo/segments.ts: 17 of 17 numeric constants are caught, at",
	"# a tuning-sized edit as well as a gross one. Unmeasured on the other 76",
	"# modules the refs import. See refs-snapshot.mts's header.",
	"",
].join("\n");

const generated = `${header}\n${sections.join("\n\n")}\n`;

if (!CHECK) {
	writeFileSync(snapshotPath, generated);
	console.log(`refs-snapshot: wrote ${files.length} section(s) to ${path.relative(repo, snapshotPath)}`);
	process.exit(0);
}

let committed: string;
try {
	committed = readFileSync(snapshotPath, "utf8");
} catch {
	console.error(`refs-snapshot: no committed snapshot at ${path.relative(repo, snapshotPath)}.`);
	console.error("Generate it with: pnpm run refs-snapshot");
	process.exit(1);
}

if (committed === generated) {
	console.log(`refs-snapshot: ${files.length} reference generator(s) still agree with the committed snapshot`);
	process.exit(0);
}

// WHICH LINES, not just "it moved". A snapshot row that says only "differs"
// makes the reader re-run it by hand to find out what — which is the habit this
// whole task is about breaking.
const was = committed.split("\n");
const now = generated.split("\n");
let section = "(before the first section)";
let shown = 0;
const LIMIT = 40;
console.error("refs-snapshot: the reference values MOVED.\n");
for (let i = 0; i < Math.max(was.length, now.length); i++) {
	if (now[i]?.startsWith("### ")) section = now[i].slice(4);
	if (was[i] === now[i]) continue;
	if (shown++ >= LIMIT) {
		console.error(`  … and more (showing the first ${LIMIT})`);
		break;
	}
	console.error(`  ${section} line ${i + 1}`);
	console.error(`    was: ${was[i] ?? "(end of file)"}`);
	console.error(`    now: ${now[i] ?? "(end of file)"}`);
}
console.error("\nThese generators import the production TypeScript, so a change here means the TS moved.");
console.error("⚠ The Lean #guards pinned to these numbers do NOT update themselves. Carry the new value");
console.error("into the sibling .lean FIRST, then bless with: pnpm run refs-snapshot");
process.exit(1);
