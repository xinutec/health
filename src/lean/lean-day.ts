/**
 * The `LEAN_DAY` tenant — the 38-pass cascade, served from a LIVE encoder.
 *
 * Every other tenant shadows one operation. This one shadows a chain, and what
 * kept it from existing was never the Lean side: `Verified.Geo`'s `SplitFold` /
 * `EnrichFold` / `PreFold` / `PassFold` / `DayChain` have been compared against
 * the TS day by `day-gate` for weeks. What was missing is an encoder that does
 * not read a `FoldCaptureFile` — a file written by the very run the fold would
 * replace, and which carries that run's OUTPUT (#431 gap 1).
 *
 * `DayRequestInputs` (2026-08-09) is the half of that file which is genuinely
 * INPUT, and every field of it is in scope at the cascade boundary in
 * `velocity.ts`. So this builds a request from live values and answers the
 * fold's lookups from the live adapter, with no capture anywhere.
 *
 * # Rounds, not callbacks
 *
 * The fold is a pure function of its tables and cannot call back into the shell
 * mid-run, so `converge` runs it against a table it lacks, lets it name what it
 * wanted, answers that, and runs it again. Measured over the corpus: depth 2-7,
 * median 6, 33/33 matching (#431 gap 4). That is why serving is possible at all,
 * and also most of why it is slow — the rounds are staging, and they go when the
 * shell and the fold share a process.
 *
 * # Read the cost as staging
 *
 * A shadow day is ~6 spawns of `verified_cli` and ~3.2x the covered region's TS
 * time. #433 split the fold into 9.3s request wire / 8.0s typed decode / 3.4s
 * response wire + algorithm, so 84% of that is what a Rust shell deletes, and
 * the residual is ~17ms against a TS compute of 3-27ms/day — the same order.
 *
 * # Scope, honestly
 *
 * `shadow` compares the CASCADE boundary only: Lean's `segs` against the TS
 * `withBiometrics`, under the same `encodeSeg` + `canon` equality `compare-day`
 * uses, so this and the gate cannot disagree about what "same" means. The day
 * chain's tail — states and episodes — is in the response and is not read here,
 * because the TS answers to compare it against are not in scope at this call
 * site. `day-gate` grades that boundary against a capture and keeps doing so.
 *
 * There is no `on` path yet. This module exists to prove a live encoder works
 * end to end; serving from it is the next step, and wants this quiet first.
 */

import path from "node:path";
import type { ClassificationInputs } from "../geo/classification-inputs.js";
import type { EnrichedSegment } from "../geo/enriched-segment.js";
import { canon, converge } from "./day-serve.js";
import type { DayRequestInputs } from "./fold-capture.js";
import { encodeSeg } from "./fold-payload.js";
import type { LedgerVerdict } from "./ledger-verdict.js";

export type LeanDayMode = "off" | "shadow" | "on";

export function leanDayMode(): LeanDayMode {
	const v = process.env.LEAN_DAY;
	return v === "on" || v === "shadow" ? v : "off";
}

/** The same resolution `compare-day` uses, and the same `LEAN_CLI` override the
 *  rest of the bridge honours. */
function cliPath(): string {
	return process.env.LEAN_CLI ?? path.join(process.cwd(), "lean", ".lake", "build", "bin", "verified_cli");
}

interface DayStat {
	/** Days the round loop converged on. */
	calls: number;
	/** Days it could not converge, or the bridge threw. Both are swallowed, so
	 *  this is the only place they are visible. */
	fails: number;
	/** Days where the arms agreed on the segment COUNT but some field differed. */
	segDiffs: number;
	/** Days where they disagreed about how many segments the cascade emits.
	 *  Structurally louder than a field difference: a count mismatch means the
	 *  two cascades took different branches, not that one rounded differently. */
	lenDiffs: number;
	/** Round depths seen — the staging cost this tenant is mostly made of. */
	rounds: number[];
	/** Per-day fingerprints of what differed, for the delta ceiling. */
	unexplained: string[];
}

const stats: DayStat = { calls: 0, fails: 0, segDiffs: 0, lenDiffs: 0, rounds: [], unexplained: [] };

export function resetLeanDayStats(): void {
	stats.calls = 0;
	stats.fails = 0;
	stats.segDiffs = 0;
	stats.lenDiffs = 0;
	stats.rounds = [];
	stats.unexplained = [];
}

/** Which encoded fields differ, and on how many segments.
 *
 *  Compares the ENCODED forms — `encodeSeg` on the TS side against what the
 *  fold emitted — because that is the comparison `compare-day` makes. A bespoke
 *  field list here could call a day EXACT that `day-gate` calls divergent, and
 *  a shadow that disagrees with the gate about equality is worse than none. */
function differingFields(want: readonly unknown[], got: readonly unknown[]): Map<string, number> {
	const counts = new Map<string, number>();
	const n = Math.min(want.length, got.length);
	for (let i = 0; i < n; i++) {
		const a = want[i] as Record<string, unknown>;
		const b = got[i] as Record<string, unknown>;
		for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
			if (canon(a[k]) !== canon(b[k])) counts.set(k, (counts.get(k) ?? 0) + 1);
		}
	}
	return counts;
}

/** The drawn-geometry fields the day request cannot carry, so a difference in
 *  them says nothing about the cascade.
 *
 *  The walk and road matchers are SHELLED — their inputs are 4.31 MiB/day of
 *  road and building rows (#431 gap 2) — so the fold never sees them and emits
 *  whatever its own defaults are. `day-gate` reports exactly these as SHELL
 *  ONLY, on 35/35 days, and this list is why the two agree. */
const SHELL_ONLY_FIELDS = new Set(["snappedPath", "matchedPath", "walkMatchedPath", "walkSmoothedPath"]);

/**
 * Run the Lean day beside the TS cascade and record what differed.
 *
 * Never throws and never changes its caller's output: a bridge failure, a
 * non-convergent round loop and a divergence are all recorded and swallowed.
 * That is what makes it safe to stage before anything serves.
 */
export async function shadowLeanDay(
	req: DayRequestInputs,
	inputs: ClassificationInputs,
	tsSegsOut: readonly EnrichedSegment[],
	label: string,
): Promise<void> {
	const { spawnSync } = await import("node:child_process");
	try {
		const c = await converge(req, inputs, inputs.osm, async (payload) => {
			// `spawnSync`, and BOTH streams every time.
			//
			// The request goes in on stdin, which the promisified `execFile` cannot
			// do — it ignores `input`, leaves the child's stdin open, and the fold
			// waits forever: a hang with no spawn completing and no CPU burnt, which
			// reads exactly like a slow disk and is not one.
			//
			// STDERR IS THE POINT, and is why `execFileSync` is wrong here too. A
			// round with an incomplete table PANICS AND CONTINUES, printing the keys
			// it wanted to stderr and still EXITING ZERO. `execFileSync` returns
			// stdout alone on success, so those keys are lost, the loop sees no
			// misses, and it "converges" in one round on an answer the fold built
			// entirely from defaults. That reads as a clean run and is the opposite
			// of one — measured depth on this corpus is 2-7 rounds, so a reported
			// depth of 1 is the shape of this mistake.
			const r = spawnSync(cliPath(), ["day"], {
				input: JSON.stringify(payload),
				maxBuffer: 512 * 1024 * 1024,
				encoding: "utf8",
			});
			return { out: r.stdout ?? "", err: r.stderr ?? "" };
		});
		if (c.rounds < 0) {
			stats.fails += 1;
			console.log(`lean-day[shadow] ${label}: NOT CONVERGED — ${c.failure ?? "no reason given"}`);
			return;
		}
		const res = JSON.parse(c.out) as { segs?: unknown[]; error?: string };
		if (res.error !== undefined) {
			stats.fails += 1;
			console.log(`lean-day[shadow] ${label}: LEAN ERROR — ${res.error}`);
			return;
		}
		stats.calls += 1;
		stats.rounds.push(c.rounds);

		const leanSegs = res.segs ?? [];
		if (leanSegs.length !== tsSegsOut.length) {
			stats.lenDiffs += 1;
			stats.unexplained.push(`${label}/len=${tsSegsOut.length}v${leanSegs.length}`);
			return;
		}
		const counts = differingFields(tsSegsOut.map(encodeSeg), leanSegs);
		const real = [...counts].filter(([k]) => !SHELL_ONLY_FIELDS.has(k));
		if (real.length > 0) {
			stats.segDiffs += 1;
			for (const [field, n] of real.sort((x, y) => y[1] - x[1])) {
				stats.unexplained.push(`${label}/${field}=${n}`);
			}
		}
	} catch (e) {
		stats.fails += 1;
		console.log(`lean-day[shadow] ${label}: BRIDGE FAILED — ${e instanceof Error ? e.message : "non-Error throw"}`);
	}
}

/** Print the run's accounting and return it as the gate's data. `null` when the
 *  tenant is off, so an unstaged tenant can never fail a gate. */
export function logLeanDayLedger(label: string): LedgerVerdict | null {
	const mode = leanDayMode();
	if (mode === "off") return null;
	const s = stats;
	const clean = s.segDiffs === 0 && s.lenDiffs === 0;
	// Zero calls is NOT a pass — the trap every other tenant carries (#392). A
	// day tenant that never ran and one that agreed everywhere print the same
	// line unless this says otherwise.
	const verdict = s.calls === 0 ? "NOT EXERCISED" : clean ? "EXACT" : `${s.segDiffs + s.lenDiffs} DIVERGED`;
	const depth = s.rounds.length === 0 ? "" : ` — rounds ${Math.min(...s.rounds)}-${Math.max(...s.rounds)}`;
	const detail = clean ? "" : ` — len=${s.lenDiffs} segs=${s.segDiffs}`;
	console.log(`lean-day[${mode}] ${label}: ${verdict} (${s.calls} day(s), ${s.fails} failed)${depth}${detail}`);
	return {
		tenant: "day",
		mode,
		calls: s.calls,
		fails: s.fails,
		klass: s.calls === 0 ? "not-exercised" : clean ? "exact" : "diverged",
		unexplained: [...s.unexplained],
	};
}
