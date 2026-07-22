/**
 * The near-tie manifest is the flip's premise: `LEAN_PASSES=on` is only honest
 * while every measured divergence is one we have inspected and signed off. Both
 * the `shadow-passes` gate and the production decode ledger adjudicate through
 * `unexplainedDeltas`, so these tests pin the decision rule they share.
 */

import { describe, expect, it } from "vitest";
import { ACCEPTED_DELTAS, deltaTag, isAcceptedDelta, unexplainedDeltas } from "../src/lean/accepted-deltas.js";

const anAccepted = ACCEPTED_DELTAS[0];

describe("accepted-delta adjudication", () => {
	it("accepts an exact op+n+note fingerprint", () => {
		expect(isAcceptedDelta(anAccepted.op, anAccepted.n, anAccepted.note)).toBe(true);
	});

	it("rejects the same note at a different input length", () => {
		expect(isAcceptedDelta(anAccepted.op, anAccepted.n + 1, anAccepted.note)).toBe(false);
	});

	it("rejects the same note from a different op", () => {
		expect(isAcceptedDelta("trim", anAccepted.n, anAccepted.note)).toBe(false);
	});

	it("rejects a divergence whose symmetric difference differs", () => {
		expect(isAcceptedDelta(anAccepted.op, anAccepted.n, "ts-only=[1] lean-only=[2]")).toBe(false);
	});

	it("returns only the unexplained divergences, preserving order", () => {
		const measured = [
			{ op: anAccepted.op, n: anAccepted.n, note: anAccepted.note },
			{ op: "simplify", n: 7, note: "ts-only=[3] lean-only=[4]" },
			{ op: "trim", n: 9, note: "ts-only=[1] lean-only=[]" },
		];
		expect(unexplainedDeltas(measured)).toEqual([measured[1], measured[2]]);
	});

	it("is empty when every divergence is signed off", () => {
		const measured = ACCEPTED_DELTAS.map((d) => ({ op: d.op, n: d.n, note: d.note }));
		expect(unexplainedDeltas(measured)).toEqual([]);
	});

	it("labels each divergence the way both callers print it", () => {
		expect(deltaTag(anAccepted)).toBe("accepted");
		expect(deltaTag({ op: "simplify", n: 7, note: "ts-only=[3] lean-only=[4]" })).toBe("UNEXPLAINED");
	});

	it("gives every accepted entry a non-empty sign-off reason", () => {
		for (const d of ACCEPTED_DELTAS) expect(d.reason.trim()).not.toBe("");
	});

	it("holds no duplicate fingerprints", () => {
		const keys = ACCEPTED_DELTAS.map((d) => `${d.op}|${d.n}|${d.note}`);
		expect(new Set(keys).size).toBe(keys.length);
	});
});
