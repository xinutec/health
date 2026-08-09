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
 * `shadow` compares the three boundaries the response carries — the cascade's
 * `segs`, the state timeline, and the episodes — against the TS arm's own, under
 * `day-compare.ts`'s rule, which `compare-day` imports too. Neither states a
 * rule of its own, because a shadow that disagrees with its gate about equality
 * is worse than no shadow. This ran at the cascade boundary alone at first, when
 * it was called before the timeline existed; it runs at the TAIL now, where all
 * three TS answers are in scope, so `DayChain`'s output is measured rather than
 * inferred from the fold's.
 *
 * What the gate still has that this does not: the three INTERIOR boundaries
 * (`split.` / `enrich.` / `pre.`). Those need oracles only a `FoldCapture`
 * carries, so a live request cannot produce them — the asymmetry is structural,
 * and it is why `day-gate` stays the finer instrument rather than a duplicate.
 *
 * There is no `on` path yet. This module exists to prove a live encoder works
 * end to end; serving from it is the next step, and wants this quiet first.
 */

import path from "node:path";
import type { ClassificationInputs } from "../geo/classification-inputs.js";
import type { EnrichedSegment } from "../geo/enriched-segment.js";
import type { EpisodeGeometry } from "../geo/episode-geometry.js";
import type { DayState } from "../sleep/day-state.js";
import { classify, diffEpisodes, diffSegs } from "./day-compare.js";
import { converge } from "./day-serve.js";
import type { DayRequestInputs } from "./fold-capture.js";
import { encodeEpisode, encodeSeg, encodeState } from "./fold-payload.js";
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
	/** Days whose ONLY differences are the declared shells — the two solvers the
	 *  fold is not fed. `day-gate` calls these SHELL ONLY and passes them; so does
	 *  this, and counting them keeps EXACT from claiming more than it measured. */
	shellOnly: number;
	/** Round depths seen — the staging cost this tenant is mostly made of. */
	rounds: number[];
	/** Per-day fingerprints of what differed, for the delta ceiling. */
	unexplained: string[];
}

const stats: DayStat = { calls: 0, fails: 0, segDiffs: 0, lenDiffs: 0, shellOnly: 0, rounds: [], unexplained: [] };

export function resetLeanDayStats(): void {
	stats.calls = 0;
	stats.fails = 0;
	stats.segDiffs = 0;
	stats.lenDiffs = 0;
	stats.shellOnly = 0;
	stats.rounds = [];
	stats.unexplained = [];
}

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
	ts: { segs: readonly EnrichedSegment[]; states: readonly DayState[]; episodes: readonly EpisodeGeometry[] },
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
		const res = JSON.parse(c.out) as { segs?: unknown[]; states?: unknown[]; episodes?: unknown[]; error?: string };
		if (res.error !== undefined) {
			stats.fails += 1;
			console.log(`lean-day[shadow] ${label}: LEAN ERROR — ${res.error}`);
			return;
		}
		stats.calls += 1;
		stats.rounds.push(c.rounds);

		// The WHOLE chain, at the three boundaries the response carries — the
		// cascade's segments and the two stages after it. The tail was left out
		// while this ran before the timeline was built, which made the tenant
		// measure less of the day than its name claimed; it runs at the tail now,
		// so `DayChain`'s own output is compared rather than assumed from the
		// fold's. `day-gate` also grades the three INTERIOR boundaries
		// (`split.` / `enrich.` / `pre.`), which need capture oracles that do not
		// exist on a live request — that asymmetry is deliberate and is why the
		// gate stays the finer instrument.
		const eps = diffEpisodes(ts.episodes.map(encodeEpisode), res.episodes ?? []);
		const all = [
			...diffSegs(ts.segs.map(encodeSeg), res.segs ?? []),
			...diffSegs(ts.states.map(encodeState), res.states ?? []).map((d) => `states.${d}`),
			...eps.real,
		];
		// `classify` is `compare-day`'s own rule, imported rather than restated.
		// The list this replaced also excused `snappedPath`, which the gate does
		// NOT — inert while both were green, and precisely the divergence the two
		// would have reported differently.
		const { real, shell } = classify(all, eps.fallback);
		if (shell.length > 0) stats.shellOnly += 1;
		if (real.length > 0) {
			// A count difference is structurally louder than a field one — the two
			// chains took different branches rather than rounding differently — so it
			// is tallied apart even though both are divergences.
			if (real.some((d) => d.includes("count:"))) stats.lenDiffs += 1;
			else stats.segDiffs += 1;
			for (const d of real) stats.unexplained.push(`${label}/${d}`);
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
	//
	// A SHELL-ONLY day is clean and says so on its own line rather than inside
	// "EXACT": the two solvers really are absent from the fold, and a verdict that
	// silently absorbed their absence would be claiming agreement about geometry
	// nobody compared. `day-gate` prints the same distinction.
	const verdict = s.calls === 0 ? "NOT EXERCISED" : clean ? "EXACT" : `${s.segDiffs + s.lenDiffs} DIVERGED`;
	const depth = s.rounds.length === 0 ? "" : ` — rounds ${Math.min(...s.rounds)}-${Math.max(...s.rounds)}`;
	const shells = s.shellOnly === 0 ? "" : ` — ${s.shellOnly} shell-only`;
	const detail = clean ? "" : ` — len=${s.lenDiffs} segs=${s.segDiffs}`;
	console.log(
		`lean-day[${mode}] ${label}: ${verdict} (${s.calls} day(s), ${s.fails} failed)${depth}${shells}${detail}`,
	);
	return {
		tenant: "day",
		mode,
		calls: s.calls,
		fails: s.fails,
		klass: s.calls === 0 ? "not-exercised" : clean ? "exact" : "diverged",
		unexplained: [...s.unexplained],
	};
}
