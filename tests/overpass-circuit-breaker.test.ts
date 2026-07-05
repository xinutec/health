/**
 * Tests for the Overpass circuit breaker. The breaker tracks recent
 * Overpass failures and, after enough failures land in a short
 * window, "opens" — subsequent attempts reject immediately for a
 * cooldown period instead of paying the full 20s-per-mirror timeout.
 *
 * Why this exists: when the public Overpass mirrors start rate-
 * limiting us (which happens after a few rapid large-bbox queries),
 * each subsequent call hangs until it times out. With a typical
 * day's 25+ ensureCovered calls serialised at concurrency 2, the
 * pipeline can wait 4-8 minutes on calls that will never succeed.
 * The breaker turns that worst-case wait into a fail-fast.
 *
 * Contract:
 *   - Fresh breaker is closed; fetches go through.
 *   - Each recorded failure adds a timestamp; failures older than the
 *     window are pruned.
 *   - When failure count in the window reaches the threshold, breaker
 *     opens for the cooldown period.
 *   - While open, isOpen() returns true (so callers can skip).
 *   - After cooldown, breaker closes again.
 *   - A recorded success resets the failure tally (closes
 *     pre-emptively if open? no — once open, stays open for cooldown.
 *     A success during cooldown doesn't help because we'd have to
 *     observe one, which we can't if we're not calling Overpass).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetOverpassBreaker,
	isOverpassBreakerOpen,
	recordOverpassFailure,
	recordOverpassSuccess,
} from "../src/geo/osm-overpass-breaker.js";

beforeEach(() => {
	_resetOverpassBreaker();
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("overpass circuit breaker", () => {
	it("starts closed (fetches allowed)", () => {
		expect(isOverpassBreakerOpen()).toBe(false);
	});

	it("stays closed below the failure threshold", () => {
		// Threshold is 3 failures; one or two should not trip.
		recordOverpassFailure();
		recordOverpassFailure();
		expect(isOverpassBreakerOpen()).toBe(false);
	});

	it("opens once the failure threshold is reached within the window", () => {
		recordOverpassFailure();
		recordOverpassFailure();
		recordOverpassFailure();
		expect(isOverpassBreakerOpen()).toBe(true);
	});

	it("does NOT open if the failures are spread across more than the window", () => {
		// First failure, advance past the window, then two more
		// fresh ones — only the latter two count, below threshold.
		recordOverpassFailure();
		vi.advanceTimersByTime(31_000); // > 30s window
		recordOverpassFailure();
		recordOverpassFailure();
		expect(isOverpassBreakerOpen()).toBe(false);
	});

	it("closes again after the cooldown elapses", () => {
		recordOverpassFailure();
		recordOverpassFailure();
		recordOverpassFailure();
		expect(isOverpassBreakerOpen()).toBe(true);
		// Advance past the 60s cooldown.
		vi.advanceTimersByTime(61_000);
		expect(isOverpassBreakerOpen()).toBe(false);
	});

	it("a recorded success resets the failure tally while still below threshold", () => {
		recordOverpassFailure();
		recordOverpassFailure();
		recordOverpassSuccess();
		// After success, we should be able to absorb 2 more without
		// tripping (because the prior 2 were forgotten).
		recordOverpassFailure();
		recordOverpassFailure();
		expect(isOverpassBreakerOpen()).toBe(false);
	});

	it("breaker stays open during cooldown even if a (hypothetical) success arrives", () => {
		// Open the breaker.
		recordOverpassFailure();
		recordOverpassFailure();
		recordOverpassFailure();
		expect(isOverpassBreakerOpen()).toBe(true);
		// A success in the middle of the cooldown shouldn't re-close
		// it — we want the cooldown to fully elapse so the world has
		// time to recover. Otherwise one accidental success could
		// invite us back into the storm immediately.
		recordOverpassSuccess();
		expect(isOverpassBreakerOpen()).toBe(true);
		// Cooldown then closes it.
		vi.advanceTimersByTime(61_000);
		expect(isOverpassBreakerOpen()).toBe(false);
	});

	it("after re-closing, the breaker needs a fresh batch of failures to re-open", () => {
		// Open + cooldown.
		recordOverpassFailure();
		recordOverpassFailure();
		recordOverpassFailure();
		vi.advanceTimersByTime(61_000);
		expect(isOverpassBreakerOpen()).toBe(false);
		// Two failures should be below threshold again (no stale
		// counts from before the cooldown).
		recordOverpassFailure();
		recordOverpassFailure();
		expect(isOverpassBreakerOpen()).toBe(false);
		recordOverpassFailure();
		expect(isOverpassBreakerOpen()).toBe(true);
	});
});
