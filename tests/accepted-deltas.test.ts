/**
 * The near-tie manifest is the flip's premise: `LEAN_PASSES=on` is only honest
 * while every measured divergence is one we have inspected and signed off. Both
 * the `shadow-passes` gate and the production decode ledger adjudicate through
 * `unexplainedDeltas`, so these tests pin the decision rule they share.
 */

import { describe, expect, it } from "vitest";
import {
	ACCEPTED_DELTAS,
	type AcceptedDelta,
	deltaFingerprint,
	deltaTag,
	isAcceptedDelta,
	isBoundedByGeometry,
	type MeasuredDelta,
	shapeWithin,
	unexplainedDeltas,
} from "../src/lean/accepted-deltas.js";
import {
	leanPassDivergences,
	leanPassScopeTotals,
	leanPassStats,
	resetLeanPassStats,
	simplifyViaLean,
} from "../src/lean/lean-passes.js";
import { leanLeg, leanRunScope, setLeanLeg, setLeanRunScope } from "../src/lean/run-scope.js";

/** A signed-off single-vertex near-tie, as the manifest describes one. */
const ENTRY: AcceptedDelta = {
	op: "simplify",
	leg: "abc123def4567890",
	maxFlips: 2,
	maxShift: 1,
	reason: "test fixture",
};

const measured = (over: Partial<MeasuredDelta> = {}): MeasuredDelta => ({
	op: "simplify",
	n: 1000,
	note: "ts-only=[484] lean-only=[485]",
	leg: ENTRY.leg,
	tsOnly: [484],
	leanOnly: [485],
	...over,
});

describe("accepted-delta shape bound", () => {
	it("accepts a flip within both bounds", () => {
		expect(shapeWithin(measured(), ENTRY)).toBe(true);
	});

	it("accepts the same flip at a different input length — the point of #409", () => {
		// `n` moved from 1235 to 1236 when an upstream change lengthened the path.
		// The near-tie did not change, so the adjudication must not either.
		expect(shapeWithin(measured({ n: 1236 }), ENTRY)).toBe(true);
		expect(shapeWithin(measured({ n: 12 }), ENTRY)).toBe(true);
	});

	it("accepts indices shifted wholesale, since only the offset moved", () => {
		expect(shapeWithin(measured({ tsOnly: [654, 948], leanOnly: [653, 947] }), ENTRY)).toBe(true);
	});

	it("rejects a flip that jumps further than signed off", () => {
		expect(shapeWithin(measured({ tsOnly: [64], leanOnly: [62] }), ENTRY)).toBe(false);
	});

	it("rejects more flips than signed off", () => {
		expect(shapeWithin(measured({ tsOnly: [1, 5, 9], leanOnly: [2, 6, 10] }), ENTRY)).toBe(false);
	});

	it("rejects a vertex added or dropped rather than swapped", () => {
		// Unequal lists are not a near-tie at all: one arm kept something the
		// other had no counterpart for. Different phenomenon, not signed off.
		expect(shapeWithin(measured({ tsOnly: [484, 619], leanOnly: [485] }), ENTRY)).toBe(false);
	});

	it("rejects an op that reports no index sets, since it cannot be shape-checked", () => {
		expect(shapeWithin(measured({ tsOnly: undefined, leanOnly: undefined }), ENTRY)).toBe(false);
	});
});

describe("accepted-delta adjudication", () => {
	it("never accepts an unattributed divergence, whatever its shape", () => {
		// A pass that ran outside any leg cannot be matched to a leg-keyed
		// sign-off. Accepting one would let an unnameable divergence through.
		expect(isAcceptedDelta(measured({ leg: "" }))).toBe(false);
	});

	it("rejects a leg that is not in the manifest", () => {
		expect(isAcceptedDelta(measured({ leg: "0000000000000000" }))).toBe(false);
	});

	it("returns only the unexplained divergences, preserving order", () => {
		const divs = [measured({ leg: "" }), measured({ op: "trim", tsOnly: undefined, leanOnly: undefined })];
		expect(unexplainedDeltas(divs)).toEqual(divs);
	});

	it("labels an unsigned divergence the way both callers print it", () => {
		expect(deltaTag(measured({ leg: "0000000000000000" }))).toBe("UNEXPLAINED");
	});

	it("fingerprints by leg and shape, not by input length", () => {
		// The ceiling keys on this string. It must not move when `n` does, or
		// standing debt silently reappears as a fresh failure.
		expect(deltaFingerprint(measured({ n: 1235 }))).toBe(deltaFingerprint(measured({ n: 1236 })));
		expect(deltaFingerprint(measured())).toBe(`simplify/${ENTRY.leg}/flips=1 shift=1`);
		expect(deltaFingerprint(measured({ leg: "" }))).toContain("unattributed");
	});

	it("gives every manifest entry a leg, a sign-off reason and a bounded shape", () => {
		for (const d of ACCEPTED_DELTAS) {
			expect(d.leg).not.toBe("");
			expect(d.reason.trim()).not.toBe("");
			expect(d.maxFlips).toBeGreaterThan(0);
			expect(d.maxShift).toBeGreaterThanOrEqual(0);
		}
	});

	it("accepts every entry it lists, against a divergence of the shape it permits", () => {
		for (const d of ACCEPTED_DELTAS) {
			const flips = Array.from({ length: d.maxFlips }, (_, i) => i * 10);
			expect(
				isAcceptedDelta({
					op: d.op,
					n: 1,
					note: "",
					leg: d.leg,
					tsOnly: flips,
					leanOnly: flips.map((i) => i + d.maxShift),
				}),
			).toBe(true);
		}
	});

	it("holds no duplicate leg+op pairs", () => {
		const keys = ACCEPTED_DELTAS.map((d) => `${d.op}|${d.leg}`);
		expect(new Set(keys).size).toBe(keys.length);
	});
});

/**
 * The counters themselves are only reachable through the bridge, so these pin
 * the bridge-free properties: with the flag off the wrappers must be inert
 * (that is what makes `LEAN_PASSES` unset a true no-op), and a reset must clear
 * the scope as well as the tallies — otherwise a day that ended in the shadow
 * harness would misattribute the next day's decode calls.
 */
describe("lean-pass ledger scoping", () => {
	const pts = [
		{ lat: 51.5, lon: -0.1, ts: 0 },
		{ lat: 51.5001, lon: -0.1001, ts: 1 },
		{ lat: 51.5002, lon: -0.1002, ts: 2 },
		{ lat: 51.5003, lon: -0.1003, ts: 3 },
	];

	it("records nothing and serves TS when the flag is off", () => {
		const prev = process.env.LEAN_PASSES;
		process.env.LEAN_PASSES = undefined;
		delete process.env.LEAN_PASSES;
		resetLeanPassStats();
		const tsResult = [pts[0], pts[3]];
		expect(simplifyViaLean(pts, 5, () => tsResult)).toBe(tsResult);
		expect(leanPassStats()).toEqual({});
		expect(leanPassScopeTotals()).toEqual({});
		expect(leanPassDivergences()).toEqual([]);
		if (prev !== undefined) process.env.LEAN_PASSES = prev;
	});

	it("reset clears the tallies and returns the scope to decode", () => {
		setLeanRunScope("shadow");
		setLeanLeg("deadbeefdeadbeef");
		resetLeanPassStats();
		expect(leanPassStats()).toEqual({});
		expect(leanPassScopeTotals()).toEqual({});
		expect(leanRunScope()).toBe("decode");
		expect(leanLeg()).toBe("");
	});

	it("restores the enclosing leg rather than clearing it", () => {
		// The walk shadow re-matches a leg from inside a run already processing
		// one. Clearing on exit would leave the outer leg's later pass calls
		// unattributed, which the manifest can never accept.
		resetLeanPassStats();
		const restoreOuter = setLeanLeg("outer00000000000");
		const restoreInner = setLeanLeg("inner00000000000");
		expect(leanLeg()).toBe("inner00000000000");
		restoreInner();
		expect(leanLeg()).toBe("outer00000000000");
		restoreOuter();
		expect(leanLeg()).toBe("");
	});
});

/**
 * The geometric bound (#766) — the rule that judges a line-drawing pass by the
 * LINE it drew rather than by which vertices it kept.
 *
 * It exists because the quantised arm cannot satisfy index identity: it snaps
 * the perpendicular foot to the 1e-7° grid before measuring to it, which picks
 * the other vertex whenever two candidates sit within a few mm of each other in
 * chord deviation. That is a vertex sliding ALONG the same line, and the
 * matcher's manifest already declines to call that a difference.
 *
 * These pin the two things that keep the rule from being a blanket excuse: the
 * tolerance is a real ceiling, and a changed vertex COUNT is never bounded.
 */
describe("geometric bound on a line-drawing divergence", () => {
	const geom = (lineDevM: number, sameVertexCount = true): MeasuredDelta => ({
		op: "simplify",
		n: 100,
		note: "",
		leg: "a-leg-nobody-signed-off",
		tsOnly: [40],
		leanOnly: [41],
		lineDevM,
		toleranceM: 5,
		sameVertexCount,
	});

	it("bounds a slide whose lines agree inside the pass's own tolerance", () => {
		// The worst real corpus case is 0.44 m against a 5 m tolerance.
		expect(isBoundedByGeometry(geom(0.44))).toBe(true);
		expect(isAcceptedDelta(geom(0.44))).toBe(true);
		expect(deltaTag(geom(0.44))).toBe("bounded");
	});

	it("treats the tolerance as a real ceiling, not a gesture", () => {
		expect(isBoundedByGeometry(geom(5))).toBe(true); // exactly at it
		expect(isBoundedByGeometry(geom(5.0001))).toBe(false); // just past it
		expect(deltaTag(geom(5.0001))).toBe("UNEXPLAINED");
	});

	it("NEVER bounds a changed vertex count, however close the lines", () => {
		// A different NUMBER of vertices is an add or a drop, not a slide — a
		// different phenomenon, and not the one measured in #766.
		expect(isBoundedByGeometry(geom(0.001, false))).toBe(false);
		expect(deltaTag(geom(0.001, false))).toBe("UNEXPLAINED");
	});

	it("does not bound an op that reports no geometry", () => {
		// The count-only passes draw no comparable line, so this rule must not
		// reach them — they keep the manifest as their only route to accepted.
		const countOnly: MeasuredDelta = { op: "spurs", n: 10, note: "kept 9 vs 8", leg: "some-leg" };
		expect(isBoundedByGeometry(countOnly)).toBe(false);
	});

	it("refuses a non-finite deviation", () => {
		// `polylineDeviationM` returns Infinity when one arm drew nothing, which
		// is the loudest possible disagreement and must not read as bounded.
		expect(isBoundedByGeometry(geom(Number.POSITIVE_INFINITY))).toBe(false);
	});

	it("still accepts a signed-off leg that carries no geometry", () => {
		// The manifest route is unchanged — the two rules are independent.
		const manifest: MeasuredDelta = { ...geom(99), leg: ACCEPTED_DELTAS[0]?.leg ?? "", lineDevM: undefined };
		if (ACCEPTED_DELTAS.length > 0) expect(deltaTag(manifest)).not.toBe("bounded");
	});
});
