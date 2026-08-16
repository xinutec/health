/**
 * What a Lean tenant's ledger RETURNS, and the gate that reads it.
 *
 * Every `logLean*Ledger` printed a line and returned `void`, so the ledgers
 * were a thing a human could read and nothing else. The corpus gate could go
 * green with a tenant that never ran, a tenant whose every bridge call failed
 * and fell back to TS, or a tenant serving a real divergence — because
 * `golden-check`'s exit code was computed entirely from the snapshot diff and
 * the ratchets, none of which could see the Lean arm at all. (There is now a
 * fifth ratchet that CAN — the delta ceiling in `delta-ceiling.ts`, which this
 * gate consults. It grades divergences; it does not replace any of the checks
 * below, which is why a ceiling can never excuse a dead bridge.)
 *
 * That is the same hazard the ledger lines themselves were added for (#387),
 * one layer up: printing evidence is not the same as ENFORCING it. A line
 * nobody's build fails on is a line that eventually nobody reads.
 *
 * So a ledger now returns its verdict as data, and {@link gateLedgers} decides.
 * The printed line is unchanged and stays the human-facing artefact; this is
 * the machine-facing one.
 */

import type { DeltaCeiling } from "./delta-ceiling.js";

/**
 * Which of the four outcomes a run landed in. The gate cares about the class,
 * not the wording, so the wording stays free to improve without moving a gate.
 *
 *   not-exercised  the tenant is staged but made zero calls. NOT a pass —
 *                  indistinguishable from a pass in the printed line until
 *                  #392, and the reason this type exists.
 *   exact          every call agreed.
 *   accepted       calls differed, but every difference fell inside a measured,
 *                  documented class the tenant declares (today only
 *                  `lean-kalman`'s libm ULP band). A pass, but a graded one.
 *   diverged       read it.
 */
export type LedgerClass = "not-exercised" | "exact" | "accepted" | "diverged";

/** One tenant's accounting for one run, as the gate sees it. */
export interface LedgerVerdict {
	/** Bare tenant name — `kalman`, `rail`, … — matching the `lean-<name>[mode]`
	 *  prefix of the printed line and the `LEAN_<NAME>` flag. */
	tenant: string;
	/** The staging mode that produced it. `off` never yields a verdict at all;
	 *  a ledger returns `null` in that case, so an untouched tenant costs the
	 *  gate nothing and can never fail it.
	 *
	 *  `solo` (#975) reports CALLS and nothing comparative: with no TS arm there
	 *  is no comparison, so it can never be `diverged` and its `unexplained` is
	 *  always empty. Zero calls still fails — a tenant serving alone that never
	 *  ran is the most serious version of that fault, not an exempt one. */
	mode: "shadow" | "on" | "solo";
	/** Successful bridge calls — for `hsmm`, days shadowed. Zero is the whole
	 *  point of `not-exercised`. */
	calls: number;
	/** Bridge failures that were caught and fallen back to TS. In production
	 *  this is a resilience feature; in a deterministic offline corpus it is a
	 *  broken bridge, and it is silent by construction, since both `shadow` and
	 *  `on` swallow `LeanBridgeError`. */
	fails: number;
	klass: LedgerClass;
	/** The content fingerprints of the divergences this run could NOT explain —
	 *  the ones `isAcceptedMatchDelta` / `unexplainedDeltas` rejected. Empty for
	 *  every class but `diverged`.
	 *
	 *  Carried as data rather than left inside the printed line because the
	 *  ceiling (`delta-ceiling.ts`) has to compare them set-wise against a
	 *  committed file. Counting them was not enough: a run that fixed one leg
	 *  and broke another holds its count steady, which is exactly the case a
	 *  count-based ceiling cannot see. */
	unexplained: readonly string[];
}

/**
 * The phrase that says what a divergence on the PERSISTED run actually means,
 * given which arm was serving (#399).
 *
 * Every tenant used to build this itself, identically and identically wrong:
 * count the divergences whose run scope is `decode` — the pass whose output is
 * kept, as against the throwaway observational pass — and print
 * `N IN SERVED OUTPUT`. But the run scope answers "was this a real leg of the
 * user's day?", not "did the Lean answer reach them?". That second question is
 * the MODE's: `on` serves Lean, `shadow` serves TS and keeps Lean purely as
 * measurement.
 *
 * Under `on` the two coincide, which is why five call sites carried it for
 * months. It goes false the instant a tenant is rolled back — and for `kalman`,
 * `gpsquality` and `biolabels`, shadow since the day they were staged, it had
 * never been true at all.
 *
 * The COUNT is deliberately identical either way. A rollback narrows what a
 * divergence costs; it must not narrow what gets reported, or the line becomes
 * a way to make a tenant quieter by demoting it (#398).
 */
export function servedNote(mode: LedgerVerdict["mode"], count: number): string {
	if (count === 0) return "";
	// `ON THE SERVED PATH` rather than a bare `observed`: these legs are the
	// user's real days out of the persisted decode, not measurement scratch, and
	// that distinction is the one worth keeping greppable. `(TS served)` then
	// removes any doubt about which arm drew what they actually saw.
	// `solo` is unreachable here today — with no TS arm nothing can be recorded
	// as a divergence, so `count` is structurally zero. It is named anyway
	// because the fallthrough would label it `(TS served)`, which is the one
	// thing that is certainly false under `solo`, and the next tenant ported to
	// it would inherit that wrong label rather than a type error.
	if (mode === "solo") return ` ${count} IN SERVED OUTPUT (no TS arm)`;
	return mode === "on" ? ` ${count} IN SERVED OUTPUT` : ` ${count} ON THE SERVED PATH (TS served)`;
}

export interface LedgerGateResult {
	/** One entry per failing tenant, already worded for the console. Empty means
	 *  the run may exit 0 as far as the Lean tenants are concerned. */
	failures: string[];
	/** Non-failing remarks — a waived tenant naming why it is waived, and a
	 *  waiver that has gone stale. Printed either way. */
	notes: string[];
}

/**
 * Judge every tenant's verdict for one run.
 *
 * `unexercisable` waives the zero-calls failure for tenants a given harness
 * STRUCTURALLY cannot reach, keyed by tenant name with the reason as the value.
 * The reason is required rather than optional on purpose: a waiver whose
 * justification is not written down is one nobody can re-audit, and these two
 * (`hsmm`, `rail` on the golden corpus) exist because of a deliberate
 * determinism decision (#233) that could be revisited.
 *
 * A waiver excuses ZERO CALLS and nothing else. A waived tenant that diverges
 * still fails, and a waived tenant that records calls is reported as a STALE
 * waiver — the corpus grew a path to it, and the waiver should come out.
 */
export function gateLedgers(
	verdicts: readonly (LedgerVerdict | null)[],
	unexercisable: Readonly<Record<string, string>>,
	ceiling?: DeltaCeiling | null,
): LedgerGateResult {
	const failures: string[] = [];
	const notes: string[] = [];
	for (const v of verdicts) {
		if (v === null) continue; // off — never staged, nothing to judge
		const waiver = unexercisable[v.tenant];
		// Collect every reason before emitting, so one tenant produces one line.
		// A skipped HSMM day, for instance, is both a swallowed failure and a
		// divergence, and reporting it twice would overstate the damage.
		const reasons: string[] = [];
		if (v.klass === "not-exercised") {
			if (waiver === undefined) {
				reasons.push(`declared ${v.mode} but made zero calls — the verified arm never ran`);
			} else {
				notes.push(`lean-${v.tenant}: not exercised here, as expected — ${waiver}`);
			}
		} else if (waiver !== undefined) {
			notes.push(
				`lean-${v.tenant}: STALE WAIVER — ${v.calls} call(s) recorded, but this harness claims it cannot reach the tenant (${waiver})`,
			);
		}
		if (v.fails > 0) {
			// The wording is the finding. Under `shadow`/`on` a failure is
			// SWALLOWED and TS is served, so the run completed and the count is
			// the only trace. Under `solo` there is no TS to fall back to and the
			// call THREW — so a non-zero count here means a decode aborted, and
			// describing that as "fallen back to TS" would name a repair that
			// cannot have happened.
			reasons.push(
				v.mode === "solo"
					? `${v.fails} bridge failure(s) — no TS arm to fall back to, so the call threw`
					: `${v.fails} bridge failure(s) swallowed and fallen back to TS`,
			);
		}
		if (v.klass === "diverged") {
			// Split the unexplained set against the committed ceiling. Debt the
			// ceiling already carries is a NOTE — recorded, not adjudicated, and
			// not permitted to grow; anything above it is the failure.
			//
			// `ceiling` absent (or null, the bootstrap case) keeps the original
			// behaviour: every divergence fails. A harness that has not opted in
			// must not be made quieter by this mechanism merely existing.
			//
			// A tenant that diverged WITHOUT fingerprints (kalman, rail, hsmm,
			// gpsquality, biolabels — they compare whole outputs, not per-leg)
			// cannot be ceilinged at all, and falls through to the unconditional
			// failure. Anything else would let an unnameable divergence pass on
			// the strength of an empty set, which is the one outcome a ceiling
			// must never produce: silence that looks like a clean bill.
			const known = new Set(ceiling?.[v.tenant] ?? []);
			const above =
				ceiling == null || v.unexplained.length === 0 ? [...v.unexplained] : v.unexplained.filter((f) => !known.has(f));
			if (v.unexplained.length === 0) {
				reasons.push(`diverged — see the ledger line above`);
			} else if (above.length > 0) {
				reasons.push(
					`diverged — ${above.length} unexplained above the ceiling: ${above.join(", ")}. See the ledger line above`,
				);
			} else if (v.unexplained.length > 0) {
				notes.push(
					`lean-${v.tenant}: ${v.unexplained.length} unexplained divergence(s) at the committed ceiling — ` +
						`standing debt, NOT an accepted delta: ${v.unexplained.join(", ")}`,
				);
			}
		}
		if (reasons.length > 0) failures.push(`lean-${v.tenant}[${v.mode}]: ${reasons.join("; ")}`);
	}
	return { failures, notes };
}
