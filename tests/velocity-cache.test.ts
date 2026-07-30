/**
 * Tests for the in-memory /api/velocity result cache.
 *
 * Spec:
 *   - First call for a key is a MISS — runs the compute fn,
 *     stores the result, returns it.
 *   - Second call within TTL is a HIT — returns the stored
 *     result without running compute again.
 *   - Call after TTL expires is a MISS again.
 *   - LRU eviction at MAX_ENTRIES — oldest entry drops.
 *   - LRU bump — recent HIT moves the entry to most-recent so
 *     it survives subsequent evictions.
 *   - In-flight dedup — concurrent calls for the same key share
 *     one compute promise.
 *   - _resetVelocityCache clears both cache and in-flight maps.
 *   - invalidateVelocityCache drops cached AND in-flight entries,
 *     and a compute that spans an invalidation is not seated in
 *     the cache afterwards — see #391: the verified-core toggle
 *     changes the pipeline's answer without a pod restart, and a
 *     result computed by the old engine must not outlive the flip.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VelocityResult } from "../src/geo/velocity.js";
import { _resetVelocityCache, getVelocityCached, invalidateVelocityCache } from "../src/routes/velocity-cache.js";

function makeResult(tag: string): VelocityResult {
	// Carry a tag so tests can tell different results apart. The shape
	// is otherwise minimal — the cache treats VelocityResult as opaque.
	return {
		points: [],
		rawFixes: [],
		segments: [],
		states: [{ startTs: 0, endTs: 1, mode: "stationary", place: tag }],
		episodes: [],
		battery: [],
		timing: {},
	};
}

beforeEach(() => {
	_resetVelocityCache();
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("velocity-cache", () => {
	it("first call is a MISS and runs the compute fn", async () => {
		const compute = vi.fn(async () => makeResult("first"));
		const result = await getVelocityCached("u1|2026-05-12|UTC", compute);
		expect(result.states?.[0].place).toBe("first");
		expect(compute).toHaveBeenCalledTimes(1);
	});

	it("second call within TTL is a HIT and does not re-run compute", async () => {
		const compute = vi.fn(async () => makeResult("v1"));
		await getVelocityCached("u1|2026-05-12|UTC", compute);
		await getVelocityCached("u1|2026-05-12|UTC", compute);
		expect(compute).toHaveBeenCalledTimes(1);
	});

	it("returns the cached result on HIT (not a fresh compute)", async () => {
		let counter = 0;
		const compute = vi.fn(async () => makeResult(`run-${++counter}`));
		const first = await getVelocityCached("u1|2026-05-12|UTC", compute);
		const second = await getVelocityCached("u1|2026-05-12|UTC", compute);
		expect(first.states?.[0].place).toBe("run-1");
		expect(second.states?.[0].place).toBe("run-1");
	});

	it("recomputes after the TTL elapses", async () => {
		let counter = 0;
		const compute = vi.fn(async () => makeResult(`run-${++counter}`));
		const first = await getVelocityCached("u1|2026-05-12|UTC", compute);
		expect(first.states?.[0].place).toBe("run-1");
		// Past the 5-minute TTL.
		vi.advanceTimersByTime(5 * 60 * 1000 + 1);
		const second = await getVelocityCached("u1|2026-05-12|UTC", compute);
		expect(second.states?.[0].place).toBe("run-2");
		expect(compute).toHaveBeenCalledTimes(2);
	});

	it("evicts the oldest entry when capacity (32) is exceeded", async () => {
		// Fill to capacity with distinct keys.
		const compute = vi.fn(async (tag: string) => makeResult(tag));
		for (let i = 0; i < 32; i++) {
			await getVelocityCached(`u1|date-${i}|UTC`, () => compute(`v-${i}`));
		}
		// Insert one more — date-0 should be evicted.
		await getVelocityCached("u1|date-32|UTC", () => compute("v-32"));
		expect(compute).toHaveBeenCalledTimes(33);
		// Asking for date-0 again now should MISS (was evicted) and
		// run compute. Asking for date-1 should still HIT.
		await getVelocityCached("u1|date-1|UTC", () => compute("re-1"));
		await getVelocityCached("u1|date-0|UTC", () => compute("re-0"));
		expect(compute).toHaveBeenCalledTimes(34); // date-1 was a hit, date-0 was a miss
	});

	it("LRU bump: a HIT moves the entry to most-recent so it survives eviction", async () => {
		const compute = vi.fn(async (tag: string) => makeResult(tag));
		for (let i = 0; i < 32; i++) {
			await getVelocityCached(`u1|date-${i}|UTC`, () => compute(`v-${i}`));
		}
		// Touch date-0 — bumps it to most-recent.
		await getVelocityCached("u1|date-0|UTC", () => compute("touch-0"));
		// Now insert a NEW key. Cap is 32 entries. With date-0 bumped,
		// date-1 is now the oldest and gets evicted.
		await getVelocityCached("u1|date-32|UTC", () => compute("v-32"));
		// date-0 should STILL be cached (bumped survives eviction).
		await getVelocityCached("u1|date-0|UTC", () => compute("re-0"));
		// date-1 should be evicted and MISS.
		await getVelocityCached("u1|date-1|UTC", () => compute("re-1"));
		// compute was called: 32 (initial fills) + 1 (date-32) + 1 (date-1 miss) = 34.
		// date-0 was a HIT both times (initial + bump and re-check), no extra calls.
		expect(compute).toHaveBeenCalledTimes(34);
	});

	it("dedups concurrent calls for the same key (single in-flight compute)", async () => {
		let resolveCompute!: (r: VelocityResult) => void;
		const compute = vi.fn(
			() =>
				new Promise<VelocityResult>((resolve) => {
					resolveCompute = resolve;
				}),
		);
		// Fire two concurrent gets BEFORE the compute resolves.
		const p1 = getVelocityCached("u1|2026-05-12|UTC", compute);
		const p2 = getVelocityCached("u1|2026-05-12|UTC", compute);
		// Compute should have been called only once — second caller
		// joined the in-flight promise.
		expect(compute).toHaveBeenCalledTimes(1);
		// Resolve and assert both callers see the same result.
		resolveCompute(makeResult("shared"));
		const [r1, r2] = await Promise.all([p1, p2]);
		expect(r1.states?.[0].place).toBe("shared");
		expect(r2.states?.[0].place).toBe("shared");
	});

	it("clears the in-flight entry after the compute settles (next call recomputes after TTL)", async () => {
		const compute = vi.fn(async () => makeResult("v"));
		await getVelocityCached("u1|2026-05-12|UTC", compute);
		// Past TTL: a fresh call should MISS, run compute again, and
		// not be stuck waiting on a stale in-flight promise.
		vi.advanceTimersByTime(5 * 60 * 1000 + 1);
		await getVelocityCached("u1|2026-05-12|UTC", compute);
		expect(compute).toHaveBeenCalledTimes(2);
	});

	// ─── Invalidation (#391) ──────────────────────────────────────────
	// The engine can change under a running pod (the verified-core master
	// toggle), so "only a deploy changes the answer" no longer holds on its
	// own. These pin the three ways a pre-flip result could survive.

	it("invalidation drops cached entries — the next call recomputes inside the TTL", async () => {
		const compute = vi.fn(async () => makeResult("lean"));
		await getVelocityCached("u1|2026-05-12|UTC", compute);
		invalidateVelocityCache("test");
		// No clock advance: without the invalidation this would be a HIT.
		const after = await getVelocityCached("u1|2026-05-12|UTC", async () => makeResult("ts"));
		expect(after.states?.[0].place).toBe("ts");
		expect(compute).toHaveBeenCalledTimes(1);
	});

	it("a compute spanning an invalidation is returned but not cached", async () => {
		let resolveCompute!: (r: VelocityResult) => void;
		const slow = vi.fn(
			() =>
				new Promise<VelocityResult>((resolve) => {
					resolveCompute = resolve;
				}),
		);
		const inflight = getVelocityCached("u1|2026-05-12|UTC", slow);
		// Flip mid-compute, then let the old-engine run finish.
		invalidateVelocityCache("test");
		resolveCompute(makeResult("pre-flip"));
		// The caller who asked before the flip still gets their answer …
		expect((await inflight).states?.[0].place).toBe("pre-flip");
		// … but it must not be seated in the cache with a fresh TTL.
		const next = await getVelocityCached("u1|2026-05-12|UTC", async () => makeResult("post-flip"));
		expect(next.states?.[0].place).toBe("post-flip");
	});

	it("invalidation drops the in-flight slot — a later caller does not join the old-engine run", async () => {
		let resolveCompute!: (r: VelocityResult) => void;
		const slow = vi.fn(
			() =>
				new Promise<VelocityResult>((resolve) => {
					resolveCompute = resolve;
				}),
		);
		const inflight = getVelocityCached("u1|2026-05-12|UTC", slow);
		invalidateVelocityCache("test");
		// Arrives after the flip: must start its own compute, not JOIN the
		// pre-flip promise, which would serve it the other engine's answer.
		const fresh = getVelocityCached("u1|2026-05-12|UTC", async () => makeResult("post-flip"));
		expect(await fresh).toMatchObject({ states: [{ place: "post-flip" }] });
		resolveCompute(makeResult("pre-flip"));
		expect((await inflight).states?.[0].place).toBe("pre-flip");
		// The abandoned run's `finally` must not have evicted the replacement's
		// slot — a third caller inside the TTL is a plain HIT.
		const third = vi.fn(async () => makeResult("never"));
		await getVelocityCached("u1|2026-05-12|UTC", third);
		expect(third).not.toHaveBeenCalled();
	});
});
