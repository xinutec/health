/**
 * Tests for `biometricCoherence` — the per-segment "actually sitting"
 * signal used by the magnetic-focus-place mechanism to modulate the
 * location magnet's pull.
 *
 * See `docs/proposals/2026-06-magnetic-focus-places.md` §2.
 */

import { describe, expect, it } from "vitest";
import { biometricCoherence } from "../src/geo/biometric-coherence.js";
import type { HrPoint, StepPoint } from "../src/geo/biometrics.js";

function restingHr(startTs: number, endTs: number, bpm = 68): HrPoint[] {
	const out: HrPoint[] = [];
	for (let t = startTs; t <= endTs; t += 5) out.push({ ts: t, bpm });
	return out;
}

function elevatedHr(startTs: number, endTs: number, bpm = 100): HrPoint[] {
	const out: HrPoint[] = [];
	for (let t = startTs; t <= endTs; t += 5) out.push({ ts: t, bpm });
	return out;
}

function steadyStepsPerMin(startTs: number, endTs: number, perMin: number): StepPoint[] {
	const out: StepPoint[] = [];
	for (let t = startTs; t <= endTs; t += 60) out.push({ ts: t, steps: perMin });
	return out;
}

describe("biometricCoherence", () => {
	const t0 = 1_700_000_000;
	const t60 = t0 + 60 * 60; // 1 hour

	it("returns ~1 for a 1h segment with resting HR and zero steps (sitting)", () => {
		const result = biometricCoherence({
			startTs: t0,
			endTs: t60,
			hr: restingHr(t0, t60),
			steps: [],
		});
		expect(result).toBeGreaterThan(0.95);
	});

	it("returns ~0 for elevated HR + walking-rate steps (clearly moving)", () => {
		const result = biometricCoherence({
			startTs: t0,
			endTs: t60,
			hr: elevatedHr(t0, t60, 100),
			steps: steadyStepsPerMin(t0, t60, 90),
		});
		expect(result).toBeLessThan(0.05);
	});

	it("returns a middle value for a borderline case (~50 steps/min, slightly elevated HR)", () => {
		const result = biometricCoherence({
			startTs: t0,
			endTs: t60,
			hr: elevatedHr(t0, t60, 82),
			steps: steadyStepsPerMin(t0, t60, 50),
		});
		expect(result).toBeGreaterThan(0.2);
		expect(result).toBeLessThan(0.8);
	});

	it("returns ~1 (no information penalty) when biometric data is empty", () => {
		const result = biometricCoherence({
			startTs: t0,
			endTs: t60,
			hr: [],
			steps: [],
		});
		expect(result).toBeGreaterThan(0.95);
	});

	it("ignores HR + steps outside the segment window", () => {
		// HR + steps active BEFORE the segment, nothing inside it.
		// Coherence should reflect the empty-inside case (~1, no info).
		const result = biometricCoherence({
			startTs: t60,
			endTs: t60 + 60 * 60,
			hr: elevatedHr(t0, t60 - 60, 120),
			steps: steadyStepsPerMin(t0, t60 - 60, 100),
		});
		expect(result).toBeGreaterThan(0.95);
	});

	it("the 05-25 Varley window (resting + 5 steps/min) gives high coherence", () => {
		// User confirmed: sitting at Dasha's, making pancakes. Some movement
		// (pancake flipping, walking to the kitchen) but no sustained
		// walking. Expected coherence high — closer to 0.9 than to 0.5.
		const result = biometricCoherence({
			startTs: t0,
			endTs: t60,
			hr: restingHr(t0, t60, 72),
			steps: steadyStepsPerMin(t0, t60, 5),
		});
		expect(result).toBeGreaterThan(0.85);
	});

	it("the hypothetical 05-25-walking-past-Varley window gives low coherence", () => {
		// Walking past on the way to the playground — 100 steps/min, HR
		// 95. Coherence should be well below 0.5 — the magnet should not
		// pull this segment to Varley.
		const result = biometricCoherence({
			startTs: t0,
			endTs: t60,
			hr: elevatedHr(t0, t60, 95),
			steps: steadyStepsPerMin(t0, t60, 100),
		});
		expect(result).toBeLessThan(0.1);
	});
});
