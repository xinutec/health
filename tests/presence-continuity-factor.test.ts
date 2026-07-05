/**
 * Tests for the presence-continuity emission factor.
 * Phase 3 of `docs/proposals/2026-06-presence-continuity.md`.
 */

import { describe, expect, it } from "vitest";
import { continuityLogLikelihood } from "../src/hmm/factors/presence-continuity.js";
import type { Observation } from "../src/hmm/observation.js";
import type { State } from "../src/hmm/state-space.js";

const T = 1_700_000_000;

function stat(placeId: number | null): State {
	return { mode: "stationary", placeId, lineName: null, trainEdgeId: null };
}

function obsNoFix(): Observation {
	return {
		ts: T,
		gps: null,
		hr: null,
		cadence: null,
		hourLocal: 13,
		dayOfWeekLocal: 4,
		inBed: false,
		prevGpsFix: null,
		nextGpsFix: null,
	};
}

function obsWithFix(): Observation {
	return { ...obsNoFix(), gps: { lat: 51.5, lon: -0.1, speedKmh: 0 } };
}

function ctxBase(): {
	priorPlaceId: number;
	priorPlaceCoord: null;
	hoursSinceLastConfirmedFix: number;
	priorPosterior: number;
} {
	return { priorPlaceId: 42, priorPlaceCoord: null, hoursSinceLastConfirmedFix: 0, priorPosterior: 0.95 };
}

describe("continuityLogLikelihood", () => {
	it("returns 0 with no continuity context (factor silent)", () => {
		expect(continuityLogLikelihood(stat(42), obsNoFix(), null)).toBe(0);
	});

	it("returns 0 when priorPlaceId is null", () => {
		const ctx = { ...ctxBase(), priorPlaceId: null };
		expect(continuityLogLikelihood(stat(42), obsNoFix(), ctx)).toBe(0);
	});

	it("returns 0 for a state at a different place than the prior", () => {
		expect(continuityLogLikelihood(stat(99), obsNoFix(), ctxBase())).toBe(0);
	});

	it("returns 0 for non-stationary states", () => {
		const driving: State = { mode: "driving", placeId: null, lineName: null, trainEdgeId: null };
		expect(continuityLogLikelihood(driving, obsNoFix(), ctxBase())).toBe(0);
	});

	it("returns 0 when the observation has a GPS fix (place-distance handles it)", () => {
		expect(continuityLogLikelihood(stat(42), obsWithFix(), ctxBase())).toBe(0);
	});

	it("returns a non-negative log-bonus for a matching state under no-fix evidence", () => {
		const result = continuityLogLikelihood(stat(42), obsNoFix(), ctxBase());
		expect(result).toBeCloseTo(Math.log(1 + 0.1 * 1 * 0.95), 3);
		expect(result).toBeGreaterThan(0);
	});

	it("decays with time-since-last-confirmed-fix", () => {
		const fresh = continuityLogLikelihood(stat(42), obsNoFix(), { ...ctxBase(), hoursSinceLastConfirmedFix: 0 });
		const oneDay = continuityLogLikelihood(stat(42), obsNoFix(), { ...ctxBase(), hoursSinceLastConfirmedFix: 24 });
		const threeDays = continuityLogLikelihood(stat(42), obsNoFix(), {
			...ctxBase(),
			hoursSinceLastConfirmedFix: 72,
		});
		expect(fresh).toBeGreaterThan(oneDay);
		expect(oneDay).toBeGreaterThan(threeDays);
	});

	it("scales with priorPosterior — a 0.5 seed gives less boost than a 0.95 seed", () => {
		const highSeed = continuityLogLikelihood(stat(42), obsNoFix(), { ...ctxBase(), priorPosterior: 0.95 });
		const lowSeed = continuityLogLikelihood(stat(42), obsNoFix(), { ...ctxBase(), priorPosterior: 0.5 });
		expect(highSeed).toBeGreaterThan(lowSeed);
	});

	it("returns 0 when priorPosterior is 0 (no information to transfer)", () => {
		const ctx = { ...ctxBase(), priorPosterior: 0 };
		expect(continuityLogLikelihood(stat(42), obsNoFix(), ctx)).toBe(0);
	});

	it("contradiction gate: bonus fires when prevGpsFix is near priorPlaceCoord", () => {
		const ctx = { ...ctxBase(), priorPlaceCoord: { lat: 51.5, lon: -0.15 } };
		const obs: Observation = {
			...obsNoFix(),
			prevGpsFix: { ts: T - 600, lat: 51.5, lon: -0.15 },
		};
		expect(continuityLogLikelihood(stat(42), obs, ctx)).toBeGreaterThan(0);
	});

	it("contradiction gate: bonus is silenced when prevGpsFix is far (>1500m) from priorPlaceCoord", () => {
		// Prior place at CC, but a today's fix has appeared ~17km away (at Home).
		// The bonus must not fire on subsequent no-fix minutes — today's
		// evidence has superseded yesterday's.
		const ctx = { ...ctxBase(), priorPlaceCoord: { lat: 51.5, lon: -0.15 } };
		const obs: Observation = {
			...obsNoFix(),
			prevGpsFix: { ts: T - 600, lat: 51.57, lon: -0.28 },
		};
		expect(continuityLogLikelihood(stat(42), obs, ctx)).toBe(0);
	});

	it("contradiction gate: no-op when priorPlaceCoord is null", () => {
		// Same fix that would be contradicting if coords were present —
		// here we have no coords so the gate is inactive; bonus fires.
		const obs: Observation = {
			...obsNoFix(),
			prevGpsFix: { ts: T - 600, lat: 51.57, lon: -0.28 },
		};
		expect(continuityLogLikelihood(stat(42), obs, ctxBase())).toBeGreaterThan(0);
	});
});
