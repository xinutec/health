/**
 * Tests for the factor aggregator.
 *
 * Takes a list of ModeCandidate, a FactorContext, and a list of
 * Factor functions. Runs every factor against every candidate, sums
 * non-null scores per candidate, returns:
 *
 *   {
 *     best: ScoredCandidate,           // highest total
 *     alternatives: ScoredCandidate[], // remaining, descending by total
 *     margin: number,                  // best.totalScore - alternatives[0].totalScore
 *   }
 *
 * This is the pure aggregator — no candidate generation, no production
 * wiring. Phase 1 next steps build a generator that produces candidates
 * for `refineMode` and wire the aggregator behind a feature flag.
 */

import { describe, expect, it } from "vitest";
import { scoreCandidates } from "../../src/geo/factors/aggregator.js";
import type { Factor, FactorContext, ModeCandidate } from "../../src/geo/factors/types.js";

const candidate = (mode: string, wayName?: string, extra: Partial<ModeCandidate> = {}): ModeCandidate => ({
	mode: mode as ModeCandidate["mode"],
	wayName,
	...extra,
});

/** Test factor that returns a constant score for the named mode, null otherwise. */
const constFactor =
	(name: string, mode: string, score: number): Factor =>
	(c) =>
		c.mode === mode ? { name, score, rationale: `const-${name}` } : null;

/** Test factor that returns a constant score regardless of mode. */
const flatFactor =
	(name: string, score: number): Factor =>
	() => ({ name, score, rationale: `flat-${name}` });

/** Test factor that always returns null. */
const nullFactor: Factor = () => null;

const emptyCtx: FactorContext = {};

describe("scoreCandidates aggregator", () => {
	it("returns a single candidate as best with empty alternatives and infinite margin", () => {
		const r = scoreCandidates([candidate("driving", "M25")], emptyCtx, [flatFactor("speed-emission", 1.5)]);
		expect(r.best.mode).toBe("driving");
		expect(r.best.wayName).toBe("M25");
		expect(r.best.totalScore).toBeCloseTo(1.5);
		expect(r.alternatives).toEqual([]);
		expect(r.margin).toBe(Number.POSITIVE_INFINITY);
	});

	it("picks the candidate with the higher total score as best", () => {
		const candidates = [candidate("walking"), candidate("driving")];
		const factors = [constFactor("speed-emission", "driving", 2), constFactor("speed-emission", "walking", -0.5)];
		const r = scoreCandidates(candidates, emptyCtx, factors);
		expect(r.best.mode).toBe("driving");
		expect(r.alternatives[0].mode).toBe("walking");
	});

	it("computes margin as best.totalScore - alternatives[0].totalScore", () => {
		const candidates = [candidate("driving"), candidate("walking")];
		const factors = [constFactor("f", "driving", 3), constFactor("f", "walking", 1)];
		const r = scoreCandidates(candidates, emptyCtx, factors);
		expect(r.margin).toBeCloseTo(2.0);
	});

	it("sums multiple factors per candidate", () => {
		const candidates = [candidate("driving")];
		const factors = [
			flatFactor("speed-emission", 1.5),
			flatFactor("osm-distance", 0.8),
			flatFactor("mode-coherence", -0.3),
		];
		const r = scoreCandidates(candidates, emptyCtx, factors);
		expect(r.best.totalScore).toBeCloseTo(2.0);
		expect(r.best.factors).toHaveLength(3);
	});

	it("treats null-returning factors as no contribution (not as zero penalty)", () => {
		const candidates = [candidate("driving")];
		const factors = [flatFactor("f1", 1.0), nullFactor, flatFactor("f2", 0.5)];
		const r = scoreCandidates(candidates, emptyCtx, factors);
		// nulled factor is omitted from the breakdown
		expect(r.best.factors).toHaveLength(2);
		expect(r.best.factors.map((f) => f.name)).toEqual(["f1", "f2"]);
		expect(r.best.totalScore).toBeCloseTo(1.5);
	});

	it("sorts alternatives descending by totalScore", () => {
		const candidates = [candidate("walking"), candidate("driving"), candidate("train")];
		const factors = [constFactor("f", "driving", 3), constFactor("f", "train", 2), constFactor("f", "walking", -1)];
		const r = scoreCandidates(candidates, emptyCtx, factors);
		expect(r.best.mode).toBe("driving");
		expect(r.alternatives.map((a) => a.mode)).toEqual(["train", "walking"]);
		expect(r.alternatives.map((a) => a.totalScore)).toEqual([2, -1]);
	});

	it("preserves input order for tied candidates (stable ranking)", () => {
		// Two candidates with identical total → first-in-input wins as best.
		const candidates = [candidate("walking"), candidate("driving")];
		const factors = [flatFactor("f", 1.0)];
		const r = scoreCandidates(candidates, emptyCtx, factors);
		expect(r.best.mode).toBe("walking");
		expect(r.alternatives[0].mode).toBe("driving");
	});

	it("yields zero-total candidates when every factor returns null", () => {
		const candidates = [candidate("walking"), candidate("driving")];
		const factors = [nullFactor, nullFactor];
		const r = scoreCandidates(candidates, emptyCtx, factors);
		expect(r.best.totalScore).toBe(0);
		expect(r.best.factors).toHaveLength(0);
	});

	it("throws on an empty candidate list (caller must supply at least one)", () => {
		expect(() => scoreCandidates([], emptyCtx, [flatFactor("f", 1)])).toThrow();
	});

	it("propagates candidate fields (wayName, waySubtype, wayDistanceM) to the scored output", () => {
		const c = candidate("driving", "M25", { waySubtype: "motorway", wayDistanceM: 25 });
		const r = scoreCandidates([c], emptyCtx, [flatFactor("f", 1)]);
		expect(r.best.wayName).toBe("M25");
		expect(r.best.waySubtype).toBe("motorway");
		expect(r.best.wayDistanceM).toBe(25);
	});

	it("passes the context unchanged to each factor (no mutation)", () => {
		const candidates = [candidate("driving")];
		let seenCtx: FactorContext | null = null;
		const recordingFactor: Factor = (_c, ctx) => {
			seenCtx = ctx;
			return null;
		};
		const ctx: FactorContext = {};
		scoreCandidates(candidates, ctx, [recordingFactor]);
		// Same reference, untouched
		expect(seenCtx).toBe(ctx);
	});
});
