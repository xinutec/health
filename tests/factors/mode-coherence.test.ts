/**
 * Tests for the mode-coherence factor.
 *
 * Penalises candidates whose `mode` doesn't fit their `waySubtype`.
 * Concrete failure category this absorbs: "driving on footway at
 * 60 km/h" — geographically the closest way might be a footway,
 * but at urban-driving speed it's overwhelmingly likely a road,
 * not a pedestrian path. The osm-distance factor by itself would
 * pick the closer footway; mode-coherence is the corrective term.
 *
 * The combined effect of `osm-distance + mode-coherence` reproduces
 * what `pickBestHighway` does today in `refineMode`, but as a
 * weighted scoring rather than a hard rule.
 */

import { describe, expect, it } from "vitest";
import { modeCoherence } from "../../src/geo/factors/mode-coherence.js";
import type { ModeCandidate } from "../../src/geo/factors/types.js";

const driving = (subtype: string): ModeCandidate => ({ mode: "driving", waySubtype: subtype });
const walking = (subtype: string): ModeCandidate => ({ mode: "walking", waySubtype: subtype });
const train = (subtype: string): ModeCandidate => ({ mode: "train", waySubtype: subtype });
const cycling = (subtype: string): ModeCandidate => ({ mode: "cycling", waySubtype: subtype });

describe("modeCoherence factor", () => {
	it("penalises driving on a footway", () => {
		const r = modeCoherence(driving("footway"), {});
		expect(r).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: the assert above guards
		expect(r!.score).toBeLessThan(-1);
	});

	it("scores driving on a motorway as a positive fit", () => {
		const r = modeCoherence(driving("motorway"), {});
		expect(r).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: the assert above guards
		expect(r!.score).toBeGreaterThan(0);
	});

	it("scores walking on a footway as a strong positive fit", () => {
		const r = modeCoherence(walking("footway"), {});
		expect(r).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: the assert above guards
		expect(r!.score).toBeGreaterThan(0);
	});

	it("penalises walking on a motorway (not a pedestrian way)", () => {
		const r = modeCoherence(walking("motorway"), {});
		expect(r).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: the assert above guards
		expect(r!.score).toBeLessThan(-1);
	});

	it("scores train on a rail subtype as a strong positive fit", () => {
		expect(modeCoherence(train("rail"), {})?.score).toBeGreaterThan(0);
		expect(modeCoherence(train("subway"), {})?.score).toBeGreaterThan(0);
		expect(modeCoherence(train("light_rail"), {})?.score).toBeGreaterThan(0);
	});

	it("penalises train on a non-rail subtype heavily (a train must be on rail)", () => {
		const r = modeCoherence(train("primary"), {});
		expect(r).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: the assert above guards
		expect(r!.score).toBeLessThan(-2);
	});

	it("scores cycling on a cycleway positively, on a motorway negatively", () => {
		expect(modeCoherence(cycling("cycleway"), {})?.score).toBeGreaterThan(0);
		const m = modeCoherence(cycling("motorway"), {});
		expect(m).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: the assert above guards
		expect(m!.score).toBeLessThan(-1);
	});

	it("returns null when the candidate has no waySubtype", () => {
		expect(modeCoherence({ mode: "driving" }, {})).toBeNull();
	});

	it("returns 0 (neutral) for an unknown subtype on a known mode", () => {
		// e.g. mode=driving, waySubtype="exotic". Without a rule for the
		// subtype we shouldn't penalise or boost arbitrarily.
		const r = modeCoherence(driving("aeroway"), {});
		expect(r).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: the assert above guards
		expect(r!.score).toBe(0);
	});

	it("populates name and rationale fields", () => {
		const r = modeCoherence(driving("motorway"), {});
		expect(r).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: the assert above guards
		expect(r!.name).toBe("mode-coherence");
		// biome-ignore lint/style/noNonNullAssertion: the assert above guards
		expect(r!.rationale.length).toBeGreaterThan(0);
	});

	it("absorbs the driveable-vs-footway story when paired with osm-distance", () => {
		// Phase 1 design: osm-distance prefers the closer way, mode-
		// coherence corrects when the closer way is the wrong class.
		// This test pins the per-factor scores; the consumer sums them.
		const drivingOnFootwayAt20m = modeCoherence(driving("footway"), {});
		const drivingOnSecondaryAt30m = modeCoherence(driving("secondary"), {});
		// Footway penalty is large enough that even 10m closer it loses.
		// (10m closer = ~+0.4 nats of osm-distance; footway penalty
		// for driving is < -1 nats.)
		// biome-ignore lint/style/noNonNullAssertion: factors return non-null with valid input
		const delta = drivingOnSecondaryAt30m!.score - drivingOnFootwayAt20m!.score;
		expect(delta).toBeGreaterThan(0.5);
	});
});
