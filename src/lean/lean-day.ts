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
 * # `on`
 *
 * `serveLeanDay` returns the chain's own answer for `velocity.ts` to return in
 * place of the TS one. It runs the SAME comparison `shadow` does and records
 * into the same ledger — serving is not a reason to grade a day more loosely,
 * it is a reason to grade it at all.
 *
 * Two things it does NOT do, both deliberate. It does not delete the TS
 * cascade — the TS run still happens, because the comparison above needs both
 * arms. That is the whole of why: the graft that used to be the other reason is
 * gone (#959, 2026-08-16), so nothing on the serve path reads a TS field any
 * more. Deleting the TS arm is #975, and it is a different change. And it does
 * not serve through a failure: a bridge error, a non-convergent loop or a count
 * mismatch falls back to TS, counted and warned, the way `LEAN_STATIONCHAIN=on`
 * does.
 */

import { appendFileSync } from "node:fs";
import path from "node:path";
import type { ClassificationInputs } from "../geo/classification-inputs.js";
import type { EnrichedSegment } from "../geo/enriched-segment.js";
import type { EpisodeGeometry } from "../geo/episode-geometry.js";
import type { DayState } from "../sleep/day-state.js";
import { classify, diffEpisodes, diffSegs, type Sample } from "./day-compare.js";
import { decodeEpisode, decodeSeg, decodeState } from "./day-decode.js";
import { converge } from "./day-serve.js";
import type { DayRequestInputs } from "./fold-capture.js";
import { encodeEpisode, encodeSeg, encodeState } from "./fold-payload.js";
import { LeanBridgeError } from "./lean-core.js";
import type { LedgerVerdict } from "./ledger-verdict.js";

export type LeanDayMode = "off" | "shadow" | "on" | "solo";

export function leanDayMode(): LeanDayMode {
	const v = process.env.LEAN_DAY;
	return v === "on" || v === "shadow" || v === "solo" ? v : "off";
}

/** How long ONE round of the day fold may take before the bridge is called
 *  wedged. Per round, not per day: `converge` runs 2-7 of them, each measured
 *  at ~1-3 s, so this is generous and only a deadlock reaches it.
 *
 *  Deliberately separate from the gate's `DAY_BRIDGE_TIMEOUT_MS`: this one runs
 *  inside a CronJob where nobody is watching, and it should be able to be
 *  tightened without loosening a developer's gate. */
const DAY_TENANT_TIMEOUT_MS = Number(process.env.LEAN_DAY_TIMEOUT_MS ?? 60_000);

/**
 * The binary this tenant spawns, most specific first.
 *
 * `LEAN_DAY_HOST` is `rust/day-shell` — the in-process host, which links the
 * same Lean fold and speaks the same stdin/stdout contract (proved byte for
 * byte by `scripts/rust-host-check.sh`) but can also ANSWER the fold's
 * `walkableRoads` / `buildingsNear` / `drivableRoads` callbacks from the OSM
 * mirror as they are generated. `verified_cli` structurally cannot: it is a
 * spawned pure function, its externs resolve to `lean/c/osm-host-stub.c`, and a
 * walking leg whose ways come back empty is skipped before any solver leaf
 * runs.
 *
 * ⚠ So this variable is now LOAD-BEARING, not an optimisation. The graft that
 * used to repair an undrawn fold was deleted in #959 on the evidence that the
 * host makes it unnecessary. A caller that serves `on` WITHOUT the host would
 * now serve raw chords where a solver should have drawn. `Dockerfile` sets it
 * (`ENV LEAN_DAY_HOST=/app/lean/day-shell`) — note that a Docker `ENV` is
 * invisible to `kubectl get pod -o jsonpath`, so check the image, not the
 * manifest, before concluding it is unset.
 *
 * ⚠ It is a SEPARATE variable rather than a change to `LEAN_CLI`, and that is
 * not a preference. `LEAN_CLI` is read by `lean-core.ts`, `lean-hsmm.ts` and
 * `compare-match.ts` as well, `Dockerfile` sets it for all of them, and
 * `day-shell` serves the `day` mode ONLY — it ignores argv and reads a day
 * request on stdin. Repointing the shared variable would break three tenants to
 * fix one. `compare-day.ts`'s `DAY_HOST_BIN` is the same override under the
 * gate's own name.
 *
 * Unset, this is exactly what it was: `LEAN_CLI`, else the local `lake` build.
 */
function cliPath(): string {
	return (
		process.env.LEAN_DAY_HOST ??
		process.env.LEAN_CLI ??
		path.join(process.cwd(), "lean", ".lake", "build", "bin", "verified_cli")
	);
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
	/** Days whose ONLY differences are "TS drew, Lean did not" — `day-compare`'s
	 *  `shell` class. `day-gate` calls these SHELL ONLY and passes them; so does
	 *  this, and counting them keeps EXACT from claiming more than it measured.
	 *
	 *  ⚠ Since 2026-08-16 this should stay ZERO under `LEAN_DAY_HOST`: the shells
	 *  are filled and the fold draws, so a non-zero count means the fold FAILED to
	 *  draw something, not that it was never asked to. That inverts what the
	 *  number means — it used to be the expected case and is now a finding. Seven
	 *  live days measured 0. */
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
	await runLeanDay(req, inputs, ts, label);
}

/**
 * The chain, the comparison and the accounting — everything every mode shares.
 *
 * Returns the response's three arrays, still in wire shape, or `{ failure }`
 * when nothing usable came back. `shadow` drops the arrays on the floor and `on`
 * decodes them, so the two modes cannot diverge in what they MEASURE: a served
 * day is graded by the same rule and lands in the same ledger as a shadowed one.
 * Splitting the comparison out per mode is how a tenant ends up serving under a
 * looser definition of agreement than it stages under.
 *
 * ⚠ `ts === null` IS `solo`, and it is a null rather than a second function so
 * that the accounting cannot drift. With no TS arm there is nothing to compare
 * against, but `calls`, `fails` and `rounds` still mean exactly what they mean
 * in the other modes — a solo day that failed to converge has to be countable
 * the same way a shadowed one is, or the ledger stops being comparable across a
 * promotion. Only the comparison is skipped, and only because it is vacuous.
 *
 * The failure is returned rather than thrown because the modes disagree about
 * what it MEANS: `shadow`/`on` degrade to the TS arm, `solo` has no arm to
 * degrade to and must fail the decode. Returning the reason makes each caller
 * state its own policy instead of inheriting one.
 */
async function runLeanDay(
	req: DayRequestInputs,
	inputs: ClassificationInputs,
	ts: { segs: readonly EnrichedSegment[]; states: readonly DayState[]; episodes: readonly EpisodeGeometry[] } | null,
	label: string,
): Promise<{ segs: unknown[]; states: unknown[]; episodes: unknown[] } | { failure: string }> {
	const mode = leanDayMode();
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
			// BOUNDED, and this one runs IN PRODUCTION. The same bridge call
			// wedged the day gate on 2026-08-15 — both processes at 0.0% CPU,
			// no output, no error, no exit — and it is INTERMITTENT, so three
			// clean runs prove nothing. Unbounded here, that deadlock hangs a
			// `decode-recent` CronJob invocation instead of failing it: no
			// output to alert on, and the job never completes.
			//
			// `LEAN_CALL_TIMEOUT_MS` does NOT reach this call — it is honoured
			// by `lean-core`'s request path. This tenant span had no bound at
			// all, which is why the flip to `shadow` had to wait for one.
			//
			// A timeout surfaces as empty `out`, which `converge` already reads
			// as a failed round: the tenant records a `fail`, logs it, and
			// returns `undefined` so the TS answer serves. Degrading to TS is
			// exactly what shadow does anyway, so the bound cannot change a
			// served result — only stop a hang.
			const r = spawnSync(cliPath(), ["day"], {
				input: JSON.stringify(payload),
				maxBuffer: 512 * 1024 * 1024,
				timeout: DAY_TENANT_TIMEOUT_MS,
				encoding: "utf8",
			});
			const err = r.stderr ?? "";
			// The host's stderr is CAPTURED (spawnSync pipes by default) because
			// `missesIn` parses it, which also means `OSM_LOG=1` inside the host
			// prints into a string nobody shows. Forward it when that flag is on,
			// so the host's `osm: MIRROR …` lines and the TS arm's `osm: TS …`
			// lines land in one stream and can be diffed — the comparison that
			// attributes a leg drawing differently in each arm.
			if (process.env.OSM_LOG && err !== "") process.stderr.write(err);
			return { out: r.stdout ?? "", err };
		});
		if (c.rounds < 0) {
			stats.fails += 1;
			const failure = `NOT CONVERGED — ${c.failure ?? "no reason given"}`;
			console.log(`lean-day[${mode}] ${label}: ${failure}`);
			return { failure };
		}
		const res = JSON.parse(c.out) as { segs?: unknown[]; states?: unknown[]; episodes?: unknown[]; error?: string };
		if (res.error !== undefined) {
			stats.fails += 1;
			const failure = `LEAN ERROR — ${res.error}`;
			console.log(`lean-day[${mode}] ${label}: ${failure}`);
			return { failure };
		}
		stats.calls += 1;
		stats.rounds.push(c.rounds);

		const out = { segs: res.segs ?? [], states: res.states ?? [], episodes: res.episodes ?? [] };
		// `solo`: no second arm, so there is nothing to compare and every diff below
		// would be measured against an empty array — which `diffSegs` would report
		// as a total divergence, i.e. the ledger would scream on a perfectly good
		// day. Returning here rather than guarding each diff keeps the comparison
		// written for exactly one situation: two arms exist.
		if (ts === null) return out;

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
		// WHICH segment, not just how many. `diffSegs` counts per FIELD, so a line
		// reads "1/8 segments differ" and cannot say which of the eight — and the
		// first thing anyone attributing a divergence needs is the leg. The gate
		// has always passed a sample; the tenant did not, so the production line
		// was strictly less readable than the offline one about the same defect.
		// First occurrence per field is enough to find the leg; `segWhere` is
		// bounds + mode, so this adds times and a mode, not places.
		const firstAt = new Map<string, string>();
		const sample: Sample = (key, _i, a, b, where) => {
			if (where !== undefined && !firstAt.has(key)) firstAt.set(key, where);
			// `LEAN_DAY_DUMP=<file>` writes BOTH arms' values for every difference,
			// which is the only way to ask WHERE two drawn polylines part rather
			// than just how far apart their worst vertex is. A deviation is one
			// number; the vertex it first appears at names the way each matcher
			// chose. Off unless the variable is set — this is an attribution tool,
			// not telemetry.
			const dump = process.env.LEAN_DAY_DUMP;
			if (dump !== undefined && dump !== "") {
				appendFileSync(dump, `${JSON.stringify({ label, key, where, ts: a, lean: b })}\n`);
			}
		};
		const all = [
			...diffSegs(ts.segs.map(encodeSeg), res.segs ?? [], sample),
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
			for (const d of real) {
				// `diffSegs` emits `<field>: n/N segments differ…`, so the field name
				// is the prefix — that is how a summary line is matched back to the
				// leg the sample recorded it on.
				const at = [...firstAt].find(([k]) => d.startsWith(`${k}:`))?.[1];
				stats.unexplained.push(`${label}/${d}${at === undefined ? "" : ` @ ${at}`}`);
			}
		}
		return out;
	} catch (e) {
		stats.fails += 1;
		const failure = `BRIDGE FAILED — ${e instanceof Error ? e.message : "non-Error throw"}`;
		console.log(`lean-day[${mode}] ${label}: ${failure}`);
		return { failure };
	}
}

/**
 * The `on` path: run the chain and RETURN its answer, or `undefined` to serve TS.
 *
 * Everything `shadowLeanDay` does, plus a decode — the comparison still runs and
 * still records, because a served divergence is more worth counting than a
 * shadowed one, not less. What changes is only what the caller does with it.
 *
 * `undefined` on a bridge failure, a non-convergent round loop, or a count
 * mismatch at either boundary. All three are the house pattern
 * (`lean-station-chain.ts`: serve TS, count it, say so loudly). The third used
 * to be justified as a limit of the graft; it survived the graft's deletion on
 * its own merits, which the guard itself now states.
 *
 * A FIELD divergence is served. That is the point of `on`: shadow already
 * reports it and nothing sees it, and the flip exists to make it user-visible.
 */
export async function serveLeanDay(
	req: DayRequestInputs,
	inputs: ClassificationInputs,
	ts: { segs: readonly EnrichedSegment[]; states: readonly DayState[]; episodes: readonly EpisodeGeometry[] },
	label: string,
): Promise<{ segs: EnrichedSegment[]; states: DayState[]; episodes: EpisodeGeometry[] } | undefined> {
	const res = await runLeanDay(req, inputs, ts, label);
	if ("failure" in res) return undefined;

	// ⚠ THE COUNT GUARD OUTLIVES THE GRAFT (#959), and deliberately.
	//
	// It was written as the graft's precondition — solver geometry the fold did
	// not draw can only be put back POSITIONALLY, and pairing whichever legs
	// share an index across differing counts splices two days together rather
	// than repairing one. That reasoning died with the graft.
	//
	// What it actually guards did not: serving a day whose cascade disagreed
	// with TS about how many segments the day HAS. A fold that returned no
	// segments at all would otherwise serve an EMPTY day, and "a field
	// divergence is served" is not a licence for that — a field divergence is a
	// judgement about geometry, not about whether the day happened.
	if (res.segs.length !== ts.segs.length || res.episodes.length !== ts.episodes.length) {
		stats.fails += 1;
		console.warn(
			`lean-day[on] ${label}: count mismatch — serving TS ` +
				`(segs TS ${ts.segs.length}/Lean ${res.segs.length}, ` +
				`episodes TS ${ts.episodes.length}/Lean ${res.episodes.length})`,
		);
		return undefined;
	}
	return {
		segs: res.segs.map(decodeSeg),
		states: res.states.map(decodeState),
		episodes: res.episodes.map(decodeEpisode),
	};
}

/**
 * The `solo` path: the Lean chain is the ONLY arm, and a failure THROWS.
 *
 * This is the mode the TypeScript deletion waits on. `on` still runs the whole
 * TS cascade — it has to, because the comparison needs both arms — which is why
 * flipping nine tenants to `on` removed no TypeScript at all (#975). Under solo
 * the caller skips the ~1,340-line region between `classifySegments` and here,
 * so the closure that region pulls in becomes dead code rather than a live
 * dependency.
 *
 * ⚠ NO FALLBACK, BY CONSTRUCTION. Every other mode answers `undefined` and lets
 * `velocity.ts` serve `withBiometrics` — but under solo `withBiometrics` was
 * never computed, so there is nothing to fall back TO. Returning an empty day
 * would be the masking fallback the house rules forbid; a decode that fails
 * loudly is recoverable, a day silently recorded as empty is not.
 *
 * @throws LeanBridgeError on a bridge failure, a non-convergent round loop, a
 *         Lean-side error, or an empty cascade from a non-empty input.
 */
export async function soloLeanDay(
	req: DayRequestInputs,
	inputs: ClassificationInputs,
	label: string,
): Promise<{ segs: EnrichedSegment[]; states: DayState[]; episodes: EpisodeGeometry[] }> {
	const res = await runLeanDay(req, inputs, null, label);
	if ("failure" in res) throw new LeanBridgeError(`lean-day[solo] ${label}: ${res.failure}`);

	// ⚠ WHAT REPLACES `serveLeanDay`'s COUNT GUARD, and it is not the same check.
	//
	// That guard compares Lean's segment count against the TS arm's, which under
	// solo does not exist — so it cannot be carried over, and dropping it silently
	// would remove the one thing standing between a broken fold and a day recorded
	// as empty. What it actually protected against survives without a second arm:
	// serving a day with NO segments when the cascade was handed some.
	//
	// The precondition is what makes this honest rather than a guess. A day whose
	// `segsRaw` is empty — no GPS at all — legitimately produces no segments, and
	// asserting over it would fail exactly the days with the least evidence, the
	// same trap the empty-day arm exists to avoid. So the invariant is narrow: the
	// cascade may merge, split and drop segments, but it is not expected to
	// annihilate every one of them.
	//
	// ⚠ That last clause is a DESIGN EXPECTATION, not a measured fact — no day is
	// known to have tripped it, and no run has yet confirmed none does. If a real
	// day ever does, this is the wrong guard rather than a real finding, and it
	// should be replaced by whatever that day shows the invariant actually is.
	if (req.segsRaw.length > 0 && res.segs.length === 0) {
		stats.fails += 1;
		throw new LeanBridgeError(
			`lean-day[solo] ${label}: cascade returned 0 segments for ${req.segsRaw.length} raw — ` +
				`refusing to record an empty day`,
		);
	}

	return {
		segs: res.segs.map(decodeSeg),
		states: res.states.map(decodeState),
		episodes: res.episodes.map(decodeEpisode),
	};
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
	// ⚠ `solo` must not print EXACT. `clean` is VACUOUSLY true with no TS arm —
	// `runLeanDay` returns before the diff counters can be touched — so EXACT
	// would claim an agreement nothing measured, and a reader could not tell
	// "agreed everywhere" from "nothing was compared". Same choice, and the same
	// reason, as `lean-head` and the seven other solo-capable tenants.
	const verdict =
		s.calls === 0
			? "NOT EXERCISED"
			: mode === "solo"
				? "SOLO (no TS arm, nothing compared)"
				: clean
					? "EXACT"
					: `${s.segDiffs + s.lenDiffs} DIVERGED`;
	const depth = s.rounds.length === 0 ? "" : ` — rounds ${Math.min(...s.rounds)}-${Math.max(...s.rounds)}`;
	const shells = s.shellOnly === 0 ? "" : ` — ${s.shellOnly} shell-only`;
	const detail = clean ? "" : ` — len=${s.lenDiffs} segs=${s.segDiffs}`;
	// WHICH fields, not just how many — the same choice `lean-match` makes and
	// for the same reason: "a reader adjudicating a production line has to be
	// able to see what it was adjudicated against".
	//
	// It costs nothing until something diverges, and it is what makes the first
	// host-backed run readable: `diffSegs` now measures a drawn field instead of
	// excusing it, so these lines carry `walkMatchedPath drawn: 2/12 segments
	// differ, worst 14.08 cm` — a magnitude to judge against the corpus envelope
	// rather than a count to guess at.
	//
	// Bounded, because a genuinely broken day would otherwise print one line per
	// field per day into a CronJob log. The count above is always exact; this is
	// the sample.
	const MAX_LINES = 8;
	const lines = s.unexplained.slice(0, MAX_LINES);
	const more = s.unexplained.length - lines.length;
	const which = lines.length === 0 ? "" : ` — ${lines.join("; ")}${more > 0 ? ` (+${more} more)` : ""}`;
	console.log(
		`lean-day[${mode}] ${label}: ${verdict} (${s.calls} day(s), ${s.fails} failed)${depth}${shells}${detail}${which}`,
	);
	const verdictData: LedgerVerdict = {
		tenant: "day",
		mode,
		calls: s.calls,
		fails: s.fails,
		klass: s.calls === 0 ? "not-exercised" : clean ? "exact" : "diverged",
		unexplained: [...s.unexplained],
	};
	// Print AND reset, the house pattern (`lean-match.ts:357`). This did not
	// matter while the only caller was `golden-check.ts`, which calls it once at
	// the end of a whole run — and `resetLeanDayStats` had no caller at all. The
	// serve path calls it PER DAY (`decode-day.ts`), so without this every day's
	// line would carry the previous days' tallies and a run over five days would
	// end with a line claiming five.
	resetLeanDayStats();
	return verdictData;
}
