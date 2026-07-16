import { describe, expect, it } from "vitest";
import type { Observation } from "../src/hmm/observation.js";
import { buildSegmentEvidence } from "../src/hmm/segment-evidence.js";
import type { State } from "../src/hmm/state-space.js";

/**
 * Segment-scoped evidence (C4.2 groundwork, `2026-07-continuity-c4.md`):
 * one bounded z-penalty per candidate segment coupling net GPS
 * displacement, measured step totals, and mode — the physics per-minute
 * emissions can't see (they score instants; this scores the segment's
 * story). Pure penalty (0 when consistent, negative when not, clamped)
 * so no mode carries a generic normalization bias.
 *
 * The two measured target cases it encodes:
 *   - a multi-minute vehicle segment whose bracketing fixes go nowhere
 *     (GPS-drift phantom micro-ride) must pay;
 *   - a "walk" bridging a blackout with far fewer steps than the
 *     displacement demands (the swallowed-hop signature) must pay,
 *     while a slow genuine walk stays cheap.
 */

const T0 = 1_700_000_000;

/** A minimal observation row; only the fields segment evidence reads. */
function ob(
	minute: number,
	over: Partial<Pick<Observation, "cadence" | "prevGpsFix" | "nextGpsFix">> = {},
): Observation {
	return {
		ts: T0 + minute * 60,
		gps: null,
		hr: null,
		cadence: null,
		hourLocal: 12,
		dayOfWeekLocal: 3,
		inBed: false,
		prevGpsFix: null,
		nextGpsFix: null,
		...over,
	};
}

function state(mode: State["mode"]): State {
	return { mode, placeId: null, lineName: null, trainEdgeId: null };
}

// ~1 degree lat ≈ 111 km; 0.001 ≈ 111 m northward.
const at = (minute: number, latOffset: number) => ({ ts: T0 + minute * 60, lat: 51.5 + latOffset, lon: -0.1 });

/** Build a tensor where every minute's prev/next fix brackets the whole
 *  window: prev at `startFix`, next at `endFix`. */
function tensor(
	minutes: number,
	startFix: { ts: number; lat: number; lon: number },
	endFix: { ts: number; lat: number; lon: number },
	cadencePerMin: (m: number) => number | null,
): Observation[] {
	const rows: Observation[] = [];
	for (let m = 0; m < minutes; m++) {
		rows.push(ob(m, { cadence: cadencePerMin(m), prevGpsFix: startFix, nextGpsFix: endFix }));
	}
	return rows;
}

describe("buildSegmentEvidence", () => {
	it("a going-nowhere vehicle segment pays; a stationary one does not", () => {
		// 5-minute window, net displacement ~55 m (GPS drift), zero steps.
		const obs = tensor(6, at(0, 0), at(6, 0.0005), () => 0);
		const ev = buildSegmentEvidence({ observations: obs });
		const drive = ev(state("driving"), 5, 5);
		const still = ev(state("stationary"), 5, 5);
		expect(drive).toBeLessThan(still - 1);
		expect(still).toBeGreaterThan(-0.5);
	});

	it("a real ride's net speed is cheap for the vehicle, expensive for stationary", () => {
		// 20 minutes, ~8.9 km north → ~27 km/h net.
		const obs = tensor(21, at(0, 0), at(20, 0.08), () => 0);
		const ev = buildSegmentEvidence({ observations: obs });
		const train = ev(state("train"), 20, 20);
		const still = ev(state("stationary"), 20, 20);
		expect(train).toBeGreaterThan(-0.5);
		expect(still).toBeLessThanOrEqual(-6);
	});

	it("a blackout 'walk' with half the steps the distance demands pays; the true step count does not", () => {
		// 25 minutes bridging ~1.33 km. 700 steps ≈ 525 m of stride — the
		// swallowed-hop signature. 1800 steps covers it.
		const short = tensor(26, at(0, 0), at(25, 0.012), (m) => (m < 25 ? 28 : 0)); // 700 total
		const enough = tensor(26, at(0, 0), at(25, 0.012), (m) => (m < 25 ? 72 : 0)); // 1800 total
		const evShort = buildSegmentEvidence({ observations: short });
		const evEnough = buildSegmentEvidence({ observations: enough });
		const wShort = evShort(state("walking"), 25, 25);
		const wEnough = evEnough(state("walking"), 25, 25);
		expect(wShort).toBeLessThan(-3);
		expect(wEnough).toBeGreaterThan(-0.5);
	});

	it("a slow genuine walk (few steps, short displacement) stays cheap", () => {
		// 4 minutes, ~250 m, 140 measured steps (~105 m stride estimate —
		// within GPS-noise tolerance of 250 m).
		const obs = tensor(5, at(0, 0), at(4, 0.00225), (m) => [77, 0, 25, 38, 0][m] ?? 0);
		const ev = buildSegmentEvidence({ observations: obs });
		expect(ev(state("walking"), 4, 4)).toBeGreaterThan(-1.5);
	});

	it("no bracketing fixes → no evidence (0 for every mode)", () => {
		const obs = Array.from({ length: 10 }, (_, m) => ob(m, { cadence: 0 }));
		const ev = buildSegmentEvidence({ observations: obs });
		expect(ev(state("driving"), 5, 5)).toBe(0);
		expect(ev(state("walking"), 5, 5)).toBe(0);
	});

	it("unknown mode carries no term", () => {
		const obs = tensor(6, at(0, 0), at(6, 0.0005), () => 0);
		const ev = buildSegmentEvidence({ observations: obs });
		expect(ev(state("unknown"), 5, 5)).toBe(0);
	});

	it("penalty is clamped (never dominates a whole day)", () => {
		// Absurd inconsistency: 60-minute stationary claim across 50 km.
		const obs = tensor(61, at(0, 0), at(60, 0.45), () => 0);
		const ev = buildSegmentEvidence({ observations: obs });
		expect(ev(state("stationary"), 60, 60)).toBeGreaterThanOrEqual(-6);
	});
});
