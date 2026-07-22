/**
 * `lean-rail` — the TS tenant for the verified rail shortest path.
 *
 * These tests are deliberately BRIDGE-FREE. A failing bridge call costs 20s
 * (`FIRST_CALL_TIMEOUT_MS`) and the worker never goes warm across failures, so
 * a unit test that drives the real `verified_cli` turns a red suite into a
 * multi-minute hang. What is testable without it — and is what actually
 * broke in the passes/matcher tenants — is the pure part: flag parsing, the
 * quantisation that decides WHICH graph Lean sees, path comparison, and the
 * guarantee that the flag being off touches nothing.
 *
 * The bridge-driven behaviour (does Lean agree with TS on real graphs) is the
 * job of `compare-rail`, which runs every railsnap fixture in both directions.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
	graphFingerprint,
	leanRailDivergences,
	leanRailMode,
	leanRailStats,
	quantiseRailAdj,
	railPathCostQ,
	resetLeanRailStats,
	shortestPathViaLean,
} from "../src/lean/lean-rail.js";

const graph = (adj: Array<Array<{ to: number; w: number }>>) => ({
	vertices: adj.map(() => ({ lat: 0, lon: 0 })),
	adj,
});

describe("leanRailMode", () => {
	beforeEach(() => {
		process.env.LEAN_RAIL = undefined;
		delete process.env.LEAN_RAIL;
	});

	it("defaults to off, so the tenant is dormant until deliberately flipped", () => {
		expect(leanRailMode()).toBe("off");
	});

	it("reads shadow and on, and treats anything else as off", () => {
		process.env.LEAN_RAIL = "shadow";
		expect(leanRailMode()).toBe("shadow");
		process.env.LEAN_RAIL = "on";
		expect(leanRailMode()).toBe("on");
		process.env.LEAN_RAIL = "yes";
		expect(leanRailMode()).toBe("off");
		delete process.env.LEAN_RAIL;
	});
});

describe("quantiseRailAdj", () => {
	it("scales weights by 2^20 and rounds, matching the compare-rail referee", () => {
		const q = quantiseRailAdj([[{ to: 1, w: 1 }], [{ to: 0, w: 0.5 }]]);
		expect(q).toEqual([[[1, 1 << 20]], [[0, 1 << 19]]]);
	});

	it("preserves per-vertex edge insertion order, which is what tie-parity rests on", () => {
		// Two parallel edges to the same neighbour: Lean takes the cheapest, but
		// the ORDER is what makes an argmax tie resolve the same way both sides.
		const q = quantiseRailAdj([
			[
				{ to: 1, w: 2 },
				{ to: 1, w: 1 },
			],
			[],
		]);
		expect(q[0]).toEqual([
			[1, 2 << 20],
			[1, 1 << 20],
		]);
	});

	it("keeps sub-micro weights distinguishable rather than collapsing them to 0", () => {
		// 2^-20 is the resolution floor; anything at or above it must survive.
		const q = quantiseRailAdj([[{ to: 1, w: 2 ** -20 }], []]);
		expect(q[0][0][1]).toBe(1);
	});
});

describe("railPathCostQ", () => {
	const qadj = quantiseRailAdj([[{ to: 1, w: 1 }], [{ to: 2, w: 2 }], []]);

	it("sums the quantised edge weights along the vertex sequence", () => {
		expect(railPathCostQ(qadj, [0, 1, 2])).toBe(3 << 20);
	});

	it("takes the cheapest parallel edge per step, mirroring the Lean pathCost spec", () => {
		const parallel = quantiseRailAdj([
			[
				{ to: 1, w: 5 },
				{ to: 1, w: 1 },
			],
			[],
		]);
		expect(railPathCostQ(parallel, [0, 1])).toBe(1 << 20);
	});

	it("returns null for a sequence with no connecting edge, rather than a wrong number", () => {
		expect(railPathCostQ(qadj, [0, 2])).toBeNull();
	});

	it("costs a single-vertex path as zero", () => {
		expect(railPathCostQ(qadj, [0])).toBe(0);
	});
});

describe("graphFingerprint", () => {
	it("is stable for the same graph and endpoints", () => {
		const q = quantiseRailAdj([[{ to: 1, w: 1 }], []]);
		expect(graphFingerprint(q, 0, 1)).toBe(graphFingerprint(q, 0, 1));
	});

	it("distinguishes different endpoints on the same graph", () => {
		const q = quantiseRailAdj([[{ to: 1, w: 1 }], [{ to: 0, w: 1 }]]);
		expect(graphFingerprint(q, 0, 1)).not.toBe(graphFingerprint(q, 1, 0));
	});

	it("distinguishes graphs that differ only in a weight", () => {
		const a = quantiseRailAdj([[{ to: 1, w: 1 }], []]);
		const b = quantiseRailAdj([[{ to: 1, w: 2 }], []]);
		expect(graphFingerprint(a, 0, 1)).not.toBe(graphFingerprint(b, 0, 1));
	});

	it("emits a digest, not the coordinates — the graph is real movement", () => {
		const q = quantiseRailAdj([[{ to: 1, w: 1 }], []]);
		expect(graphFingerprint(q, 0, 1)).toMatch(/^[0-9a-f]{16}$/);
	});
});

describe("shortestPathViaLean with the flag off", () => {
	beforeEach(() => {
		delete process.env.LEAN_RAIL;
		resetLeanRailStats();
	});

	it("returns the TS path untouched", () => {
		const ts = [0, 1, 2];
		expect(shortestPathViaLean(graph([[{ to: 1, w: 1 }], [{ to: 2, w: 1 }], []]), 0, 2, ts)).toBe(ts);
	});

	it("passes a TS null through unchanged", () => {
		expect(shortestPathViaLean(graph([[], []]), 0, 1, null)).toBeNull();
	});

	it("records nothing at all — no calls, no failures, no divergences", () => {
		shortestPathViaLean(graph([[{ to: 1, w: 1 }], []]), 0, 1, [0, 1]);
		expect(leanRailStats()).toEqual({ calls: 0, fails: 0, pathDiffs: 0, nullFlips: 0, costDiffs: 0 });
		expect(leanRailDivergences()).toEqual([]);
	});
});

describe("resetLeanRailStats", () => {
	it("clears divergences as well as counters, so a ledger cannot leak into the next run", () => {
		resetLeanRailStats();
		expect(leanRailStats()).toEqual({ calls: 0, fails: 0, pathDiffs: 0, nullFlips: 0, costDiffs: 0 });
		expect(leanRailDivergences()).toEqual([]);
	});
});
