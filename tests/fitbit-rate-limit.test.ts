import { describe, expect, it } from "vitest";
import { decideRateLimitWait, MAX_INPROCESS_WAIT_MS } from "../src/fitbit/rate-limit.js";

/**
 * `decideRateLimitWait` is the policy that keeps the sync cron job's runs
 * short. The job has a hard ~55-min deadline and Fitbit replenishes its
 * whole budget at once at the top of the hour, so once the budget is
 * spent the client must NOT block in-process until reset (that overruns
 * the deadline → the job is killed and shows Failed). These pin the three
 * outcomes: proceed, ride out a short wait, or bail out as exhausted.
 */

describe("decideRateLimitWait", () => {
	it("proceeds while budget is above the floor", () => {
		expect(decideRateLimitWait(6, 3_600_000)).toEqual({ kind: "proceed" });
		expect(decideRateLimitWait(150, 3_600_000)).toEqual({ kind: "proceed" });
	});

	it("proceeds when the budget is spent but the window has already reset", () => {
		// resetAt in the past → msUntilReset <= 0 → the next call refills it.
		expect(decideRateLimitWait(0, 0)).toEqual({ kind: "proceed" });
		expect(decideRateLimitWait(0, -5_000)).toEqual({ kind: "proceed" });
	});

	it("rides out a short end-of-window wait in-process", () => {
		expect(decideRateLimitWait(5, 10_000)).toEqual({ kind: "sleep", ms: 10_000 });
		// Exactly at the cap is still a (long-ish but permitted) sleep.
		expect(decideRateLimitWait(0, MAX_INPROCESS_WAIT_MS)).toEqual({ kind: "sleep", ms: MAX_INPROCESS_WAIT_MS });
	});

	it("bails out as exhausted when the reset is beyond the in-process cap", () => {
		// The real-world case: budget at 5, ~58 min to reset — must not sleep.
		expect(decideRateLimitWait(5, 3_500_000)).toEqual({ kind: "exhausted", resumeInSec: 3500 });
		// One ms past the cap flips sleep → exhausted.
		expect(decideRateLimitWait(0, MAX_INPROCESS_WAIT_MS + 1)).toEqual({
			kind: "exhausted",
			resumeInSec: Math.ceil((MAX_INPROCESS_WAIT_MS + 1) / 1000),
		});
	});

	it("honours an override cap", () => {
		expect(decideRateLimitWait(0, 5_000, 1_000)).toEqual({ kind: "exhausted", resumeInSec: 5 });
		expect(decideRateLimitWait(0, 500, 1_000)).toEqual({ kind: "sleep", ms: 500 });
	});
});
