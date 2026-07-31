/**
 * What a Lean tenant's ledger RETURNS, and the gate that reads it.
 *
 * Every `logLean*Ledger` printed a line and returned `void`, so the ledgers
 * were a thing a human could read and nothing else. The corpus gate could go
 * green with a tenant that never ran, a tenant whose every bridge call failed
 * and fell back to TS, or a tenant serving a real divergence — because
 * `golden-check`'s exit code was computed entirely from the snapshot diff and
 * the four ratchets, none of which can see the Lean arm at all.
 *
 * That is the same hazard the ledger lines themselves were added for (#387),
 * one layer up: printing evidence is not the same as ENFORCING it. A line
 * nobody's build fails on is a line that eventually nobody reads.
 *
 * So a ledger now returns its verdict as data, and {@link gateLedgers} decides.
 * The printed line is unchanged and stays the human-facing artefact; this is
 * the machine-facing one.
 */

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
	 *  gate nothing and can never fail it. */
	mode: "shadow" | "on";
	/** Successful bridge calls — for `hsmm`, days shadowed. Zero is the whole
	 *  point of `not-exercised`. */
	calls: number;
	/** Bridge failures that were caught and fallen back to TS. In production
	 *  this is a resilience feature; in a deterministic offline corpus it is a
	 *  broken bridge, and it is silent by construction, since both `shadow` and
	 *  `on` swallow `LeanBridgeError`. */
	fails: number;
	klass: LedgerClass;
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
			reasons.push(`${v.fails} bridge failure(s) swallowed and fallen back to TS`);
		}
		if (v.klass === "diverged") {
			reasons.push(`diverged — see the ledger line above`);
		}
		if (reasons.length > 0) failures.push(`lean-${v.tenant}[${v.mode}]: ${reasons.join("; ")}`);
	}
	return { failures, notes };
}
