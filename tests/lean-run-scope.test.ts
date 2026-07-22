/**
 * The run scope is what lets a ledger say whether a divergence reached served
 * output or only the observational shadow run. It is shared by the pass and
 * matcher ledgers precisely so the two cannot drift, so these tests pin that
 * sharing: one `setLeanRunScope` must steer both, and either reset must return
 * both to `decode`.
 *
 * Everything here is bridge-free — no `verified_cli`, no flags on — so it runs
 * anywhere `npm run verify` does.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	leanMatchScopeTotals,
	leanMatchStats,
	matchWalkSegmentViaLean,
	resetLeanMatchStats,
} from "../src/lean/lean-match.js";
import { resetLeanPassStats } from "../src/lean/lean-passes.js";
import { leanRunScope, resetLeanRunScope, setLeanRunScope } from "../src/lean/run-scope.js";

afterEach(() => {
	resetLeanPassStats();
	resetLeanMatchStats();
});

describe("shared run scope", () => {
	it("defaults to decode, so an untaught call site attributes to served output", () => {
		resetLeanRunScope();
		expect(leanRunScope()).toBe("decode");
	});

	it("is a single scope, not one per ledger", () => {
		setLeanRunScope("shadow");
		expect(leanRunScope()).toBe("shadow");
		// Resetting the PASS ledger must also clear the scope the MATCH ledger
		// reads — the whole reason the scope lives in one module.
		resetLeanPassStats();
		expect(leanRunScope()).toBe("decode");
	});

	it("resets from the matcher ledger too", () => {
		setLeanRunScope("shadow");
		resetLeanMatchStats();
		expect(leanRunScope()).toBe("decode");
	});
});

describe("matcher ledger tallies", () => {
	const fixes = [
		{ lat: 51.5, lon: -0.1, ts: 1000 },
		{ lat: 51.5001, lon: -0.1, ts: 1060 },
		{ lat: 51.5002, lon: -0.1, ts: 1120 },
	];
	const geo = { ways: [], buildings: [] };

	it("records nothing with the flag off", () => {
		expect(matchWalkSegmentViaLean(fixes, geo, null)).toBe(null);
		expect(leanMatchScopeTotals()).toEqual({});
		expect(leanMatchStats()).toEqual({ calls: 0, fails: 0, coarseDiffs: 0, pathDiffs: 0, nullFlips: 0 });
	});

	// The scope SPLIT itself is not unit-testable: every counter but the
	// flag-off case needs a live bridge, and pointing `LEAN_CLI` at a missing
	// binary costs `FIRST_CALL_TIMEOUT_MS` (20 s) per call — measured, because
	// a failed call never leaves the worker warm. It is verified end-to-end
	// instead, by reading the `[by run: …]` split a real decode prints.
});
