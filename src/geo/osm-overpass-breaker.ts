/**
 * Circuit breaker for Overpass fetches.
 *
 * When the public Overpass mirrors start rate-limiting us (typically
 * after a burst of large-bbox queries), each subsequent fetch hangs
 * until the per-request timeout. The velocity pipeline can have 25+
 * ensureCovered calls queued for one rare-day request; with the
 * concurrency cap of 2 and a 20s timeout each, that's 4-8 minutes of
 * wasted waiting on calls that won't succeed.
 *
 * The breaker tracks recent failures. When too many land in a short
 * window it "opens" — `isOverpassBreakerOpen()` then returns true,
 * and callers can short-circuit (skip Overpass, fall back to whatever
 * the local mirror already has). After a cooldown the breaker closes
 * automatically so a single transient pop doesn't permanently disable
 * the path.
 *
 * Design notes:
 *
 *   - **Module-level mutable state.** This is process-wide singleton
 *     behaviour by nature; every velocity request shares the same
 *     view of Overpass health.
 *
 *   - **Failure pruning by window.** Failures older than the window
 *     don't count toward the threshold. So a slow trickle of
 *     occasional errors won't accumulate to a trip; only a tight
 *     burst does.
 *
 *   - **Success only resets while closed.** Once the breaker is open,
 *     it stays open for the full cooldown regardless of any (somehow)
 *     successful intervening call. The cooldown is the recovery
 *     window — re-opening on the first success would invite us right
 *     back into the storm.
 */

const FAILURE_THRESHOLD = 3;
const WINDOW_MS = 30_000;
const COOLDOWN_MS = 60_000;

let failureTimestamps: number[] = [];
let openUntilMs = 0;

/** Did enough failures recently cluster to put us in fail-fast mode? */
export function isOverpassBreakerOpen(): boolean {
	return Date.now() < openUntilMs;
}

/** Record one Overpass failure (timeout, dropped connection, 5xx,
 *  429). If this pushes us past the threshold inside the window, the
 *  breaker opens for COOLDOWN_MS. */
export function recordOverpassFailure(): void {
	if (isOverpassBreakerOpen()) return; // already open, no point counting more
	const now = Date.now();
	failureTimestamps = failureTimestamps.filter((t) => now - t < WINDOW_MS);
	failureTimestamps.push(now);
	if (failureTimestamps.length >= FAILURE_THRESHOLD) {
		openUntilMs = now + COOLDOWN_MS;
		failureTimestamps = []; // reset so the next batch is fresh
		console.warn(
			`Overpass circuit breaker OPENED for ${COOLDOWN_MS / 1000}s after ${FAILURE_THRESHOLD} failures in ${WINDOW_MS / 1000}s window`,
		);
	}
}

/** Record one Overpass success. Resets the failure tally — but only
 *  when the breaker is closed. While open, the cooldown is the only
 *  thing that can restore service. */
export function recordOverpassSuccess(): void {
	if (isOverpassBreakerOpen()) return;
	failureTimestamps = [];
}

/** Test seam: clear all state between test runs. */
export function _resetOverpassBreaker(): void {
	failureTimestamps = [];
	openUntilMs = 0;
}
