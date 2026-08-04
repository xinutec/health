/**
 * Does the Lean fold produce what the TS cascade produced?
 *
 * Task #424 step 3. `Verified.Geo.PassFold` wires all 38 passes (#419) and
 * `verified_cli day` executes them (#424 step 1) — this is the first run
 * against real days, with the golden corpus as the oracle.
 *
 * # How a day is measured
 *
 *   1. Replay the fixture through `computeVelocityFromInputs` with
 *      `FOLD_CAPTURE` set. That writes what the cascade was handed, what it
 *      produced, and the answers to the two callbacks no adapter sees
 *      (`fold-capture.ts`).
 *   2. Build the `day` request from that capture plus the fixture's own
 *      `osmTrace` and caches (`fold-payload.ts`).
 *   3. Run `verified_cli day` and compare its segments against the TS arm's,
 *      field by field.
 *
 * Both arms therefore start from the same input and answer from the same
 * recorded lookups. What is left is the computation, which is the point: the
 * wire format was sized first (0.35 MiB/day steady state) so that this
 * measurement would not be a measurement of the bridge.
 *
 * # A miss is a result, not an error
 *
 * `LEAN_ABORT_ON_PANIC=1` is set for the child: an unanswered lookup aborts
 * with the key in the message rather than returning an empty answer that would
 * read as a real one. If that fires, the Lean fold asked a question the TS
 * cascade did not — a wiring divergence, and one that comparing outputs alone
 * would not have localised. It is reported as its own outcome.
 *
 * Run: npx tsx lean/experiments/passfold-parity.mts [date …]
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inputsFromFixture, parseCapturedDay } from "../../src/cli/fixture-day.js";
import { computeVelocityFromInputs } from "../../src/geo/velocity.js";
import type { FoldCaptureFile } from "../../src/lean/fold-capture.js";
import { buildDayRequest, encodeSeg } from "../../src/lean/fold-payload.js";

const ROOT = path.join(import.meta.dirname, "../..");
const DAYS_DIR = path.join(ROOT, "tests/golden/days");
const CLI = path.join(ROOT, "lean/.lake/build/bin/verified_cli");

const only = new Set(process.argv.slice(2));

interface Outcome {
	date: string;
	verdict: "IDENTICAL" | "SHELL ONLY" | "DIVERGED" | "LOOKUP MISS" | "ERROR";
	detail: string;
}

/** Fields no `Env` supplies, so the fold cannot produce them and a difference
 *  here is structural rather than a divergence.
 *
 *  `PassFold.Env.walkEnv` / `.roadEnv` are declared SHELLS — the street-network
 *  reads and every solver leaf are stubbed (`fun _ _ _ => none`), because the
 *  matchers are the 4.31 MiB/day the wire measurement deliberately left
 *  shell-side (`passfold-env-size.mts`). The passes still RUN; handed no
 *  matcher they write nothing.
 *
 *  Reported, never hidden: a day whose only differences are these gets its own
 *  verdict and still prints them. Anything outside this set is a divergence.
 *
 *  `snappedPath` is deliberately NOT here: `railSnap` reads `railRouteCache`,
 *  which the payload does supply, so that one has to match. */
const SHELLED = new Set(["walkMatchedPath", "walkSmoothedPath", "matchedPath"]);

/** Key-sorted JSON, because `JSON.stringify` is ORDER-SENSITIVE on objects and
 *  the two arms build `biometrics` field by field in their own orders. Comparing
 *  raw renderings reported all 15 segments as differing when every value was
 *  identical — a defect in the comparator that would have been read as a
 *  divergence in the fold. */
function canon(v: unknown): string {
	const walk = (x: unknown): unknown =>
		Array.isArray(x)
			? x.map(walk)
			: x !== null && typeof x === "object"
				? Object.fromEntries(
						Object.entries(x as Record<string, unknown>)
							.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
							.map(([k, v2]) => [k, walk(v2)]),
					)
				: x;
	return JSON.stringify(walk(v));
}

/** Field-by-field, so a divergence names the field rather than the segment. */
function diffSegs(want: unknown[], got: unknown[]): string[] {
	const out: string[] = [];
	if (want.length !== got.length) {
		out.push(`segment count: TS ${want.length}, Lean ${got.length}`);
	}
	const n = Math.min(want.length, got.length);
	const counts = new Map<string, number>();
	for (let i = 0; i < n; i++) {
		const a = want[i] as Record<string, unknown>;
		const b = got[i] as Record<string, unknown>;
		for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
			if (canon(a[k]) !== canon(b[k])) counts.set(k, (counts.get(k) ?? 0) + 1);
		}
	}
	for (const [field, c] of [...counts].sort((x, y) => y[1] - x[1])) {
		out.push(`${field}: ${c}/${n} segments differ`);
	}
	return out;
}

const outcomes: Outcome[] = [];

for (const file of readdirSync(DAYS_DIR)
	.filter((f) => f.endsWith(".json"))
	.sort()) {
	const date = file.slice(0, 10);
	if (only.size > 0 && !only.has(date)) continue;

	const captured = parseCapturedDay(readFileSync(path.join(DAYS_DIR, file), "utf8"));
	const capDir = mkdtempSync(path.join(tmpdir(), "foldcap-"));
	process.env.FOLD_CAPTURE = capDir;

	let cap: FoldCaptureFile;
	try {
		await computeVelocityFromInputs(inputsFromFixture(captured, "rows"));
		const written = readdirSync(capDir);
		if (written.length === 0) throw new Error("cascade wrote no capture (did it return early?)");
		cap = JSON.parse(readFileSync(path.join(capDir, written[0]), "utf8")) as FoldCaptureFile;
	} catch (e) {
		outcomes.push({ date, verdict: "ERROR", detail: `TS arm: ${(e as Error).message}` });
		continue;
	} finally {
		// `delete`, not `= undefined`: assigning to `process.env` coerces, so
		// `undefined` would leave the literal string "undefined" and the next
		// day would capture into a directory of that name.
		delete process.env.FOLD_CAPTURE;
	}

	const req = buildDayRequest(cap, captured);
	let raw: string;
	try {
		raw = execFileSync(CLI, ["day"], {
			input: JSON.stringify(req),
			env: { ...process.env, LEAN_ABORT_ON_PANIC: "1" },
			maxBuffer: 512 * 1024 * 1024,
			encoding: "utf8",
		});
	} catch (e) {
		const err = e as { stderr?: string };
		const panic = (err.stderr ?? "").split("\n").find((l) => l.includes("uncaptured"));
		outcomes.push({
			date,
			verdict: panic ? "LOOKUP MISS" : "ERROR",
			detail: panic ?? (err.stderr ?? "").split("\n")[0] ?? "no stderr",
		});
		continue;
	}

	const res = JSON.parse(raw) as { segs?: unknown[]; changed?: string[]; error?: string };
	if (res.error) {
		outcomes.push({ date, verdict: "ERROR", detail: `Lean arm: ${res.error}` });
		continue;
	}
	const diffs = diffSegs(cap.segsOut.map(encodeSeg), res.segs ?? []);
	// Shell-only is its own verdict, not a pass: the fields are still printed.
	const real = diffs.filter((d) => !SHELLED.has(d.split(":")[0]));
	outcomes.push({
		date,
		verdict: diffs.length === 0 ? "IDENTICAL" : real.length === 0 ? "SHELL ONLY" : "DIVERGED",
		// Real divergences first — a shell difference must never push one off the line.
		detail:
			diffs.length === 0
				? `${res.changed?.length ?? 0} passes fired`
				: [...real, ...diffs.filter((d) => !real.includes(d))].slice(0, 6).join("; "),
	});
}

// Every outcome, not just the ones that produced segments. The misses were the
// silent ones, and a miss key is the whole finding — printing only the days
// that got as far as a comparison hid 20 of 33 behind a tally.
for (const o of outcomes) console.log(`${o.date}  ${o.verdict.padEnd(11)} ${o.detail}`);

const tally = new Map<string, number>();
for (const o of outcomes) tally.set(o.verdict, (tally.get(o.verdict) ?? 0) + 1);
console.log(`\n=== ${outcomes.length} day(s) ===`);
for (const [v, c] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${v.padEnd(11)} ${c}`);
