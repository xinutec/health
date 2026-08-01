/**
 * What the two arms COST — the second question a shadow soak has to answer.
 *
 * The ledgers were built to answer "does Lean agree?", and they answer it well.
 * They say nothing about "can we afford to serve it?", and that is the other
 * half of every flip decision: a tenant that agrees perfectly but takes ten
 * times as long is not ready, and nothing in the ledger would have said so.
 *
 * The operative figure is the RATIO, not the Lean cost. "match costs 276 ms a
 * leg" is unreadable on its own — the TS matcher is not free either, and the
 * question is whether swapping one for the other is affordable. So both arms
 * are timed over the SAME set of calls and the line reports `ts X lean Y N×`.
 *
 * (Until 2026-08-01 this module timed the Lean arm alone, because every
 * `*ViaLean` wrapper received `tsResult` already computed by its call site —
 * the TS arm was over before the wrapper was entered, and there was nothing
 * left to time. The wrappers now take the TS arm as a THUNK for exactly this
 * reason; see the note on {@link timeTsArm}.)
 *
 * Only calls where BOTH arms ran are counted. A wrapper that returns early —
 * flag off, degenerate input — runs TS without consulting Lean, and folding
 * those in would inflate the TS side with work the comparison never covered.
 * The counts are printed rather than assumed equal, so if they ever diverge the
 * reader sees it instead of reading a ratio over mismatched sets.
 *
 * `max` is not decoration. `LEAN_CALL_TIMEOUT_MS` is enforced per call, the
 * fallback to TS on expiry is silent by construction, and a mean hides exactly
 * the outlier that trips it — the 5 s default expiring on one heavy walk leg is
 * what made the deploy gate nondeterministic (#403). The tail is the operative
 * statistic; the mean is context.
 */

/** Accumulated cost of one arm's calls. */
export interface ArmTiming {
	/** Calls timed. */
	calls: number;
	/** Total wall time across those calls, milliseconds. */
	totalMs: number;
	/** Slowest single call, milliseconds — the timeout-relevant figure. */
	maxMs: number;
}

/** One tenant's two arms over the same set of calls. */
export interface ArmPair {
	ts: ArmTiming;
	lean: ArmTiming;
}

export const freshArmTiming = (): ArmTiming => ({ calls: 0, totalMs: 0, maxMs: 0 });

/** Fold one call's duration in. */
export function recordArmMs(t: ArmTiming, ms: number): void {
	t.calls += 1;
	t.totalMs += ms;
	if (ms > t.maxMs) t.maxMs = ms;
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

/**
 * Per-tenant accounting, keyed by the bridge `mode` that names the tenant
 * (`geo`, `match`, `rail`, `kalman`, `gpsquality`, `biolabels`).
 *
 * A registry rather than a field on each tenant module because the two arms are
 * timed in different places — the Lean arm at the single bridge choke point in
 * `lean-core.ts`, the TS arm in the wrapper that owns the thunk — and the mode
 * string is the only thing both ends already have. Timing the Lean arm at the
 * choke point is what stops a new tenant arriving silently untimed, which is
 * how the ledgers ended up able to say "Lean agrees" without anyone knowing
 * what it cost.
 */
const pairs = new Map<string, ArmPair>();

function pairFor(mode: string): ArmPair {
	const p = pairs.get(mode) ?? { ts: freshArmTiming(), lean: freshArmTiming() };
	if (!pairs.has(mode)) pairs.set(mode, p);
	return p;
}

/**
 * Time the LEAN arm of one call. Called from the bridge, so what it measures is
 * the full cost of consulting Lean: quantised payload across the
 * SharedArrayBuffer, the Lean computation, the reply, and the JSON decode.
 *
 * That is the right boundary for a flip decision — it is what serving would
 * actually add — but it is not "how fast Lean is", and the two should not be
 * quoted for each other.
 */
export function timeLeanArm<T>(mode: string, fn: () => T): T {
	return timeArm(pairFor(mode).lean, fn);
}

/**
 * Time the TS arm of one call.
 *
 * Called from inside the `*ViaLean` wrapper, on the thunk the call site handed
 * over. The thunk exists solely so this measurement is possible: with an
 * eagerly-evaluated `tsResult` argument the TS arm finished before the wrapper
 * was entered. Wrappers must invoke it EXACTLY once and on every path that
 * consults Lean — `shadow` and `on` both compare against the TS result, so
 * skipping it is not an optimisation available today.
 */
export function timeTsArm<T>(mode: string, fn: () => T): T {
	return timeArm(pairFor(mode).ts, fn);
}

/** This process's two arms for one tenant; all-zero if never called. */
export function armPair(mode: string): ArmPair {
	return pairs.get(mode) ?? { ts: freshArmTiming(), lean: freshArmTiming() };
}

/** Clear one tenant's timing — each ledger reset calls this, so a per-day line
 *  reports that day rather than everything since boot. */
export function resetArmPair(mode: string): void {
	pairs.delete(mode);
}

/** Milliseconds, with a decimal only where dropping it would round to nothing. */
function ms(x: number): string {
	return `${x < 10 ? x.toFixed(1) : x.toFixed(0)}ms`;
}

/**
 * The ledger fragment, or `""` when nothing was timed.
 *
 * Empty rather than `arm 0 calls` so a tenant that never reached the bridge
 * prints exactly what it printed before — a zero-cost line is indistinguishable
 * from a tenant that did not run, and `not-exercised` is already the loud way
 * to say the latter.
 */
export function formatArmPair(p: ArmPair): string {
	if (p.lean.calls === 0 && p.ts.calls === 0) return "";
	// Equal counts are the invariant, not the assumption: both arms are timed on
	// the same calls. Printing them separately when they disagree turns a broken
	// instrument into a visible one instead of a plausible ratio.
	const calls = p.ts.calls === p.lean.calls ? `${p.lean.calls} calls` : `ts ${p.ts.calls} / lean ${p.lean.calls} calls`;
	// A TS arm too fast to measure makes the ratio meaningless rather than
	// infinite — say so instead of printing a number nobody can act on.
	const ratio = p.ts.totalMs > 0 ? `${(p.lean.totalMs / p.ts.totalMs).toFixed(1)}×` : "ratio n/a";
	const avg = p.lean.calls === 0 ? 0 : p.lean.totalMs / p.lean.calls;
	return (
		` [arm ${calls} · ts ${ms(p.ts.totalMs)} lean ${ms(p.lean.totalMs)} ${ratio}` +
		` · lean avg ${ms(avg)} max ${ms(p.lean.maxMs)}]`
	);
}
