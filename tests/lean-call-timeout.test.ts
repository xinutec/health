/**
 * The bridge's per-call ceiling must be read PER CALL, not once at module load.
 *
 * #402's fix moves `compare-match --gate` off a per-leg `spawnSync` — which
 * could wedge indefinitely — onto the persistent `lean-core` worker, where every
 * call is bounded. But the gate replays the corpus's HEAVIEST legs (measured
 * 2026-08-02: `lean avg 275ms max 4843ms`) against a default tuned for the
 * interactive request path (5 s). At 97% of budget that would have converted an
 * intermittent hang into an intermittent timeout, so the gate raises the ceiling
 * during its own startup.
 *
 * ESM hoisting means a CLI's `process.env` assignment runs AFTER the imports it
 * triggers. While the ceiling was a module-load `const`, that assignment was
 * silently ignored and the caller kept the 5 s default — a setting that looks
 * applied, reads correctly in the source, and does nothing. This pins the
 * lazy read so it cannot regress to a const.
 */

import { afterEach, describe, expect, it } from "vitest";
import { callTimeoutMs } from "../src/lean/lean-core.js";

const ORIGINAL = process.env.LEAN_CALL_TIMEOUT_MS;

afterEach(() => {
	if (ORIGINAL === undefined) delete process.env.LEAN_CALL_TIMEOUT_MS;
	else process.env.LEAN_CALL_TIMEOUT_MS = ORIGINAL;
});

describe("lean bridge call timeout", () => {
	it("defaults to the interactive-path ceiling when unset", () => {
		delete process.env.LEAN_CALL_TIMEOUT_MS;
		expect(callTimeoutMs()).toBe(5000);
	});

	it("honours a value set AFTER this module was imported — the #402 trap", () => {
		delete process.env.LEAN_CALL_TIMEOUT_MS;
		expect(callTimeoutMs()).toBe(5000);
		// Exactly what compare-match does at startup, long after `import`.
		process.env.LEAN_CALL_TIMEOUT_MS = "60000";
		expect(callTimeoutMs()).toBe(60000);
	});

	it("re-reads on every call, so a later change also takes effect", () => {
		process.env.LEAN_CALL_TIMEOUT_MS = "1000";
		expect(callTimeoutMs()).toBe(1000);
		process.env.LEAN_CALL_TIMEOUT_MS = "30000";
		expect(callTimeoutMs()).toBe(30000);
	});

	it("falls back to the default on a non-numeric or zero value rather than 0ms", () => {
		// A 0 ms ceiling would time out every call instantly — worse than the
		// hang it replaces, so an unusable value must read as "unset".
		process.env.LEAN_CALL_TIMEOUT_MS = "not-a-number";
		expect(callTimeoutMs()).toBe(5000);
		process.env.LEAN_CALL_TIMEOUT_MS = "0";
		expect(callTimeoutMs()).toBe(5000);
	});
});
