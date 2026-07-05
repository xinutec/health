/**
 * Fitbit rate-limit policy for the sync process.
 *
 * The sync runs as an every-15-minutes Kubernetes CronJob with
 * `concurrencyPolicy: Forbid` and a hard `activeDeadlineSeconds` of ~55
 * min. Fitbit's budget (~150 calls/hour) replenishes all at once at the
 * top of each hour — there is no gradual refill to wait out. So when the
 * budget is spent the right move is NOT to block in-process until the
 * reset (that would overrun the job deadline and the job is killed,
 * surfacing as a spurious `Failed`), but to stop cleanly and let the
 * next cron tick resume from each stream's stored cursor.
 *
 * `decideRateLimitWait` is the pure decision; `RateLimitExhaustedError`
 * is the signal a depleted client raises so the orchestrator can bail
 * out of the run without mistaking it for a per-item failure.
 */

/** Raised by the Fitbit client when the budget is spent and the reset is
 *  further out than this process should block for. Callers treat it as
 *  "stop now, the next cron run resumes" — never as a failure of the
 *  specific day/stream being fetched (so no cursor is advanced past
 *  data that was never actually retrieved). */
export class RateLimitExhaustedError extends Error {
	constructor(readonly resumeInSec: number) {
		super(`Fitbit rate budget exhausted; resets in ${resumeInSec}s`);
		this.name = "RateLimitExhaustedError";
	}
}

/** Longest the client will block in-process for the budget to reset.
 *  Comfortably under the job's `activeDeadlineSeconds`, so a short
 *  end-of-window wait can be ridden out, but anything approaching the
 *  hour-long reset becomes a clean bail-out instead of a deadline
 *  overrun. */
export const MAX_INPROCESS_WAIT_MS = 60_000;

/** Below this remaining count the client stops issuing calls. Matches the
 *  proactive `<= 5` guard the client has always used; the stream-level
 *  backfill loops gate higher (`> 15`) so they exit before reaching it. */
export const RATE_LIMIT_FLOOR = 5;

export type RateLimitAction =
	| { kind: "proceed" }
	| { kind: "sleep"; ms: number }
	| { kind: "exhausted"; resumeInSec: number };

/**
 * Decide what a depleted-or-not client should do before its next call.
 *
 *   - budget above the floor, or the window has already reset → proceed
 *   - budget spent, reset within the in-process cap → sleep it out
 *   - budget spent, reset beyond the cap → exhausted (bail; resume later)
 *
 * Pure so it can be exhaustively unit-tested without a live client.
 */
export function decideRateLimitWait(
	remaining: number,
	msUntilReset: number,
	maxWaitMs = MAX_INPROCESS_WAIT_MS,
): RateLimitAction {
	if (remaining > RATE_LIMIT_FLOOR || msUntilReset <= 0) return { kind: "proceed" };
	if (msUntilReset > maxWaitMs) return { kind: "exhausted", resumeInSec: Math.ceil(msUntilReset / 1000) };
	return { kind: "sleep", ms: msUntilReset };
}
