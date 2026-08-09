/**
 * Could `verified_cli day` ever SERVE? — the fourth gap of #431, measured.
 *
 * The gate is retrospective by construction. Its six lookup tables are the
 * answers THIS RUN gave (#428), which is exactly what makes a miss a finding
 * rather than a narrower oracle. Serving inverts that: the Lean arm has to ask
 * before the TS arm has asked, so there is no run to record and the tables
 * cannot be built in advance.
 *
 * #431 named two ways out, and both are expensive. Either the OSM callbacks
 * become live shells — a different contract, and a re-entrancy problem, because
 * the adapter is async and the bridge is not — or the day mode never serves and
 * stays a referee.
 *
 * There is a third way and it needs no async bridge: ask the fold what it wants
 * until it stops wanting. `src/lean/day-serve.ts` is that loop and explains why it
 * works. This file is the VERDICT half — does the demand-driven day equal the
 * gate's day — and `day-arm-cost.mts` is the cost half.
 *
 * # Reading the result
 *
 *   rounds        how many bridge crossings a live day would need
 *   asked         lookups the converged run made
 *   recorded      lookups the TS arm made — over-fetch is the difference
 *   verdict       MATCH iff the converged output equals the gate's own
 *
 * MATCH is the load-bearing one. It says the demand-driven tables produce the
 * same day as the recorded ones, which is what "this could serve" has to mean.
 *
 * Run: TMPDIR=/tmp npx tsx lean/experiments/day-serve-rounds.mts [date...]
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inputsFromFixture, parseCapturedDay } from "../../src/cli/fixture-day.js";
import type { FoldCaptureFile } from "../../src/lean/fold-capture.js";
import { buildDayRequest } from "../../src/lean/fold-payload.js";
import { computeVelocityFromInputs } from "../../src/geo/velocity.js";
import { canon, converge } from "../../src/lean/day-serve.js";
import { recordedLookups } from "./day-serve-lib.mjs";

const ROOT = path.join(import.meta.dirname, "../..");
const DAYS_DIR = path.join(ROOT, "tests/golden/days");
const CLI = path.join(ROOT, "lean/.lake/build/bin/verified_cli");

/** `spawnSync`, not `execFileSync`: the whole measurement is on STDERR, and
 *  `execFileSync` returns stdout alone on a zero exit. A round with an
 *  incomplete table exits 0 — `panic!` prints and continues — so the successful
 *  case is exactly the one whose stderr matters. */
function run(req: unknown, abort: boolean): { out: string; err: string } {
	const r = spawnSync(CLI, ["day"], {
		input: JSON.stringify(req),
		env: abort ? { ...process.env, LEAN_ABORT_ON_PANIC: "1" } : { ...process.env },
		maxBuffer: 512 * 1024 * 1024,
		encoding: "utf8",
	});
	return { out: r.stdout ?? "", err: r.stderr ?? "" };
}

interface Outcome {
	date: string;
	rounds: number;
	asked: number;
	unanswerable: number;
	recorded: number;
	verdict: string;
}

async function measure(file: string): Promise<Outcome> {
	const date = file.slice(0, 10);
	const captured = parseCapturedDay(readFileSync(path.join(DAYS_DIR, file), "utf8"));
	const capDir = mkdtempSync(path.join(tmpdir(), "serverounds-"));
	process.env.FOLD_CAPTURE = capDir;
	const inputs = inputsFromFixture(captured, "rows");
	let cap: FoldCaptureFile;
	try {
		await computeVelocityFromInputs(inputs);
		const written = readdirSync(capDir);
		cap = JSON.parse(readFileSync(path.join(capDir, written[0]), "utf8")) as FoldCaptureFile;
	} finally {
		delete process.env.FOLD_CAPTURE;
	}

	const c = await converge(cap, inputs, inputs.osm, async (req) => run(req, false));
	const recorded = recordedLookups(cap, captured);
	if (c.failure !== undefined) {
		return { date, rounds: c.rounds, asked: c.asked, unanswerable: c.unanswerable, recorded, verdict: c.failure };
	}

	// The reference: the same converged tables, but aborting on a miss. If the
	// loop really converged this cannot miss, and its output is the gate's.
	const { tzAt, bestPlace, partial } = c.tables;
	const ref = run(buildDayRequest({ ...cap, tzAt, bestPlace }, inputs, partial), true);
	const verdict =
		ref.out === ""
			? `ABORTED: ${ref.err.split("\n")[0]}`
			: canon(JSON.parse(c.out)) === canon(JSON.parse(ref.out))
				? "MATCH"
				: "DIFFERS";
	return { date, rounds: c.rounds, asked: c.asked, unanswerable: c.unanswerable, recorded, verdict };
}

const only = new Set(process.argv.slice(2));
const files = readdirSync(DAYS_DIR)
	.filter((f) => f.endsWith(".json"))
	.filter((f) => only.size === 0 || only.has(f.slice(0, 10)))
	.sort();

const outcomes: Outcome[] = [];
for (const f of files) outcomes.push(await measure(f));

console.log("\ndate        rounds  asked  unans  recorded  verdict");
for (const o of outcomes) {
	console.log(
		`${o.date}  ${String(o.rounds).padStart(6)}  ${String(o.asked).padStart(5)}  ${String(o.unanswerable).padStart(5)}  ${String(o.recorded).padStart(8)}  ${o.verdict}`,
	);
}
const ok = outcomes.filter((o) => o.verdict === "MATCH");
const maxR = Math.max(...outcomes.map((o) => o.rounds));
console.log(`\n${ok.length}/${outcomes.length} MATCH; deepest dependency chain ${maxR} round(s)`);
