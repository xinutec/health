/**
 * The ledger phrase that says whether a divergence reached the user (#399).
 *
 * Every tenant computed this the same wrong way: count the divergences whose
 * RUN SCOPE is `decode` — the pass whose output is persisted, as opposed to the
 * throwaway observational pass — and call that "IN SERVED OUTPUT". The run
 * scope answers "was this a real leg of the user's day?". It does not answer
 * "did the Lean arm's answer reach them?", which is the tenant MODE's question:
 * `on` serves Lean, `shadow` serves TS and keeps Lean only as measurement.
 *
 * Under `on` the two coincide, which is why it went unnoticed. It became false
 * the moment a tenant was rolled back — measured 2026-07-31, minutes after
 * `LEAN_MATCH` went on→shadow (#398), when the re-decode printed
 * `lean-match[shadow] 2026-07-30 … 2 UNEXPLAINED 2 IN SERVED OUTPUT` while TS
 * was the arm serving every one of those legs. For `kalman`, `gpsquality` and
 * `biolabels` — shadow since the day they were staged — it had never once been
 * true.
 *
 * These pin both halves: the count never shrinks (a rollback must not quieten
 * the tenant), and the words never claim service that did not happen.
 */

import { describe, expect, it } from "vitest";
import { servedNote } from "../src/lean/ledger-verdict.js";

describe("servedNote", () => {
	it("says nothing when nothing diverged", () => {
		expect(servedNote("on", 0)).toBe("");
		expect(servedNote("shadow", 0)).toBe("");
	});

	it("claims served output only when Lean is the arm being served", () => {
		expect(servedNote("on", 2)).toBe(" 2 IN SERVED OUTPUT");
	});

	// THE #399 CASE. Same legs, same count, same persisted decode — but TS drew
	// them, so the reader must not be told the Lean answer is what they saw.
	it("does not claim served output under shadow", () => {
		const note = servedNote("shadow", 2);
		expect(note).not.toContain("IN SERVED OUTPUT");
		expect(note).toContain("TS served");
	});

	// The guard on the above. #398's whole lesson is that the honest boundary
	// stays where it is; re-wording a rollback must not be a way to report less.
	// Whatever the mode, the number of divergences on the persisted run is
	// printed verbatim.
	it("reports the same count under either mode", () => {
		for (const n of [1, 2, 17]) {
			expect(servedNote("on", n)).toContain(String(n));
			expect(servedNote("shadow", n)).toContain(String(n));
		}
	});

	// The phrase is read by a human scanning a wall of cron log, so both forms
	// have to survive as one greppable token rather than dissolving into prose.
	it("keeps the persisted-run distinction visible in both forms", () => {
		expect(servedNote("on", 1)).toContain("SERVED");
		expect(servedNote("shadow", 1)).toContain("SERVED");
	});

	// `solo` (#975) has no TS arm at all, so the one thing that is certainly
	// false about it is the `shadow` phrasing. The count is structurally zero
	// today — nothing can be recorded as a divergence without a second arm — so
	// this pins the wording against the day a tenant DOES reach it, rather than
	// against current behaviour.
	it("never says TS served under solo", () => {
		const note = servedNote("solo", 2);
		expect(note).not.toContain("TS served");
		expect(note).toContain("SERVED");
		expect(note).toContain("no TS arm");
	});
});
