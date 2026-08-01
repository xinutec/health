/**
 * What the Lean arm COSTS — the second question a shadow soak has to answer.
 *
 * The ledgers were built to answer "does Lean agree?", and they answer it well.
 * They say nothing about "can we afford to serve it?", and that is the other
 * half of every flip decision: a tenant that agrees perfectly but takes ten
 * times as long is not ready, and nothing in the ledger would have said so.
 *
 * **This times the LEAN arm only, and the asymmetry is structural rather than
 * an omission.** Every `*ViaLean` wrapper receives `tsResult` already computed
 * by its call site — that is what lets `shadow` serve TS unchanged — so by the
 * time the wrapper runs, the TS arm is already over and its duration was never
 * observed. Timing "both arms" here would mean timing one arm and inventing the
 * other.
 *
 * The TS side is recoverable anyway, without touching a call site: the velocity
 * log already prints per-pass wall time (`gpsQuality=4ms kalman=4ms
 * walkMatch=7109ms`), and those figures INCLUDE the Lean bridge call made
 * inside the pass. So pass-time minus the figure reported here is the TS arm,
 * and both numbers are measured rather than modelled.
 *
 * `max` is not decoration. `LEAN_CALL_TIMEOUT_MS` is enforced per call, the
 * fallback to TS on expiry is silent by construction, and a mean hides exactly
 * the outlier that trips it — the 5 s default expiring on one heavy walk leg is
 * what made the deploy gate nondeterministic (#403). The tail is the operative
 * statistic; the mean is context.
 *
 * Pure module. No IO, no clock reading of its own — callers pass durations in,
 * so this stays testable without faking time.
 */

/** Accumulated cost of one tenant's (or one op's) Lean-arm calls. */
export interface ArmTiming {
	/** Calls timed. May be below the tenant's call count if some path skipped
	 *  the bridge entirely — the average is over THIS number, not that one. */
	calls: number;
	/** Total wall time across those calls, milliseconds. */
	totalMs: number;
	/** Slowest single call, milliseconds — the timeout-relevant figure. */
	maxMs: number;
}

export const freshArmTiming = (): ArmTiming => ({ calls: 0, totalMs: 0, maxMs: 0 });

/** Fold one call's duration in. */
export function recordArmMs(t: ArmTiming, ms: number): void {
	t.calls += 1;
	t.totalMs += ms;
	if (ms > t.maxMs) t.maxMs = ms;
}

/**
 * The ledger fragment, or `""` when nothing was timed.
 *
 * Empty rather than `perf 0 calls` so a tenant that never reached the bridge
 * prints exactly what it printed before — a zero-cost line is indistinguishable
 * from a tenant that did not run, and `not-exercised` is already the loud way
 * to say the latter.
 */
export function formatArmTiming(t: ArmTiming): string {
	if (t.calls === 0) return "";
	const avg = t.totalMs / t.calls;
	return ` [lean-arm ${t.totalMs.toFixed(0)}ms/${t.calls} avg ${avg.toFixed(1)}ms max ${t.maxMs.toFixed(0)}ms]`;
}

/**
 * Time `fn`, fold the duration into `t`, and return whatever it returned.
 *
 * The duration is recorded even when `fn` THROWS, and that is deliberate: a
 * bridge call that times out is the single most expensive call the tenant will
 * ever make, and it is precisely the one a flip decision needs to see. Dropping
 * it would make the tail look better exactly when it is worst.
 */
export function timeArm<T>(t: ArmTiming, fn: () => T): T {
	const started = performance.now();
	try {
		return fn();
	} finally {
		recordArmMs(t, performance.now() - started);
	}
}
