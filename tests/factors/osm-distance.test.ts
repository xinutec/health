/**
 * Tests for the osm-distance factor.
 *
 * Scores each candidate by how close its associated way is to the
 * GPS trajectory. The distance lives on the candidate
 * (`wayDistanceM`) because different candidates point at different
 * ways — a "driving on Arterial Road" candidate and a "train on
 * Subway Line" candidate look at distance to different OSM
 * features.
 *
 * The factor implements the distance-aware tie-break that was
 * patched onto refineMode in earlier work (today's Betuweroute fix
 * and the driveable-vs-footway tie-break both rely on relative
 * distances).
 *
 * Mathematical shape: -log(distance / REF). The reference distance
 * is the "perfectly-on-the-way" threshold; closer than that gets a
 * positive (zero-or-better) score, further gets a negative score.
 * Logarithmic falloff keeps a closeby-but-not-perfect candidate
 * from being annihilated by a slightly-closer alternative.
 */

import { describe, expect, it } from "vitest";
import { osmDistance } from "../../src/geo/factors/osm-distance.js";
import type { FactorContext, ModeCandidate } from "../../src/geo/factors/types.js";

const trainAtDistance = (m: number): ModeCandidate => ({
	mode: "train",
	wayName: "Some Tube Line",
	wayDistanceM: m,
});
const drivingAtDistance = (m: number): ModeCandidate => ({
	mode: "driving",
	wayName: "Some Road",
	wayDistanceM: m,
});

const emptyCtx: FactorContext = {};

describe("osmDistance factor", () => {
	it("rewards proximity (closer way → higher score)", () => {
		const close = osmDistance(trainAtDistance(15), emptyCtx);
		const far = osmDistance(trainAtDistance(100), emptyCtx);
		expect(close).not.toBeNull();
		expect(far).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: the asserts above guard
		expect(close!.score).toBeGreaterThan(far!.score);
	});

	it("absorbs the rail-vs-road tie-break: train at 18m beats drive at 32m", () => {
		// Real failure category: subway under arterial road. Old logic
		// rejected train whenever ANY major highway was present; the
		// distance-aware version picks the closer feature.
		const train = osmDistance(trainAtDistance(18), emptyCtx);
		const drive = osmDistance(drivingAtDistance(32), emptyCtx);
		expect(train).not.toBeNull();
		expect(drive).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: the asserts above guard
		expect(train!.score).toBeGreaterThan(drive!.score);
	});

	it("returns null when the candidate has no associated distance", () => {
		const r = osmDistance({ mode: "driving" }, emptyCtx);
		expect(r).toBeNull();
	});

	it("clamps at a small floor so a zero distance doesn't produce +Infinity", () => {
		const onTop = osmDistance(trainAtDistance(0), emptyCtx);
		expect(onTop).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: the assert above guards
		expect(Number.isFinite(onTop!.score)).toBe(true);
		// biome-ignore lint/style/noNonNullAssertion: the assert above guards
		expect(onTop!.score).toBeLessThan(10);
	});

	it("score scales logarithmically: doubling distance subtracts ~0.69 nats", () => {
		const a = osmDistance(trainAtDistance(20), emptyCtx);
		const b = osmDistance(trainAtDistance(40), emptyCtx);
		expect(a).not.toBeNull();
		expect(b).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: the asserts above guard
		const delta = a!.score - b!.score;
		expect(delta).toBeGreaterThan(0.5);
		expect(delta).toBeLessThan(1.0);
	});

	it("populates name and rationale fields", () => {
		const r = osmDistance(trainAtDistance(15), emptyCtx);
		expect(r).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: the assert above guards
		expect(r!.name).toBe("osm-distance");
		// biome-ignore lint/style/noNonNullAssertion: the assert above guards
		expect(r!.rationale).toMatch(/15/);
	});

	it("score is in a reasonable nats range (not raw distance)", () => {
		const r = osmDistance(trainAtDistance(100), emptyCtx);
		expect(r).not.toBeNull();
		// At 100m the score is around -log(10) ≈ -2.3 nats.
		// biome-ignore lint/style/noNonNullAssertion: the assert above guards
		expect(r!.score).toBeGreaterThan(-10);
		// biome-ignore lint/style/noNonNullAssertion: the assert above guards
		expect(r!.score).toBeLessThan(5);
	});
});
