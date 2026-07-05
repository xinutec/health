/**
 * Tests for the mode-prior factor.
 *
 * Encodes asymmetric per-mode priors that the legacy biometric
 * corrector enforced via hard rules. Today's binding constraint is
 * the cascade's NEVER_FLIP_TARGET set — never flip *into* cycling
 * — which under the factor scorer becomes a fixed negative prior on
 * cycling candidates that the cycling-signature factor (when added)
 * can overcome with strong evidence.
 */

import { describe, expect, it } from "vitest";
import { modePrior } from "../../src/geo/factors/mode-prior.js";
import type { FactorContext, ModeCandidate } from "../../src/geo/factors/types.js";

const NO_CTX: FactorContext = {};
const cand = (mode: ModeCandidate["mode"]): ModeCandidate => ({ mode });

describe("modePrior", () => {
	it("returns a negative prior on cycling — the binding case", () => {
		const score = modePrior(cand("cycling"), NO_CTX);
		expect(score).not.toBeNull();
		expect(score?.score).toBeLessThan(0);
	});

	it("returns null for modes without a prior (mode-prior doesn't apply)", () => {
		// `null` is meaningful: it means "the factor doesn't apply,
		// don't include it in the breakdown". Distinct from a 0
		// score, which would clutter every candidate's factor list.
		expect(modePrior(cand("walking"), NO_CTX)).toBeNull();
		expect(modePrior(cand("driving"), NO_CTX)).toBeNull();
		expect(modePrior(cand("train"), NO_CTX)).toBeNull();
		expect(modePrior(cand("stationary"), NO_CTX)).toBeNull();
		expect(modePrior(cand("plane"), NO_CTX)).toBeNull();
	});

	it("does not depend on context (mode-prior is mode-only)", () => {
		const richCtx: FactorContext = { speedKmh: 25, windowFeatures: undefined };
		const a = modePrior(cand("cycling"), NO_CTX);
		const b = modePrior(cand("cycling"), richCtx);
		expect(a?.score).toBe(b?.score);
	});

	it("does not depend on candidate fields beyond mode", () => {
		const minimal: ModeCandidate = { mode: "cycling" };
		const decorated: ModeCandidate = {
			mode: "cycling",
			wayName: "Some Cycleway",
			waySubtype: "cycleway",
			wayDistanceM: 5,
		};
		expect(modePrior(minimal, NO_CTX)?.score).toBe(modePrior(decorated, NO_CTX)?.score);
	});

	it("carries a human-readable rationale that names the mode and the bias", () => {
		const score = modePrior(cand("cycling"), NO_CTX);
		expect(score?.rationale).toBeDefined();
		expect(score?.rationale).toMatch(/cycling/i);
	});

	it("the cycling penalty is large enough to overcome classifier-prior + biometric-LL combined", () => {
		// The cascade's hard rule was "never flip INTO cycling".
		// As a soft factor, the cycling prior must be large enough
		// that the *combined* upside of `classifier-prior` (up to
		// +4 nats when segments.ts itself confidently labelled the
		// short urban segment as cycling) and `biometric-ll` (~+1 nat
		// on an ambiguous low-cadence sitting segment) does NOT
		// produce a positive total for cycling. Only the future
		// `cycling-signature` factor with explicit joint evidence
		// should be allowed to override the prior.
		//
		// The 2026-05-23 backtest exposed multiple Ashvale-Park-tube-
		// labelled-as-cycling cases at the original `-1.5` because
		// classifier-prior + biometric-ll out-scored the penalty.
		const score = modePrior(cand("cycling"), NO_CTX);
		expect(score?.score ?? 0).toBeLessThanOrEqual(-4);
	});
});
