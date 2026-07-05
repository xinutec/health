/**
 * Duration prior with the one-stop-hop relaxation
 * (`src/hmm/train-hop-duration.ts`).
 *
 * The 2-minute movement floor normally crushes a 1-minute `train`
 * segment as a bridge artifact. A generator-vouched station-to-station
 * hop is real, though — GPS occlusion just truncates the observed ride
 * to one minute — so a *covered* sub-floor train segment escapes the
 * floor and gets a flat (0-nat) duration prior. Everything else is
 * unchanged.
 */

import { describe, expect, it } from "vitest";
import { type GammaFit, HARD_FLOOR_LOG_PROB, logDurationProb } from "../src/hmm/duration-dist.js";
import type { State } from "../src/hmm/state-space.js";
import { buildDurationLogProb, type DurationPriorOpts } from "../src/hmm/train-hop-duration.js";

const FITS: Record<State["mode"], GammaFit> = {
	stationary: { alpha: 0.85, beta: 0.0043, sampleCount: 132 },
	walking: { alpha: 1.07, beta: 0.034, sampleCount: 60 },
	cycling: { alpha: 1.0, beta: 0.05, sampleCount: 0 },
	driving: { alpha: 0.42, beta: 0.008, sampleCount: 24 },
	train: { alpha: 1.74, beta: 0.053, sampleCount: 24 },
	plane: { alpha: 1.0, beta: 0.011, sampleCount: 0 },
	unknown: { alpha: 0.45, beta: 0.0034, sampleCount: 15 },
};

const MIN_BY_MODE: Record<State["mode"], number> = {
	stationary: 2,
	walking: 2,
	cycling: 2,
	driving: 2,
	train: 2,
	plane: 30,
	unknown: 1,
};

// The covered minute is index 5 (ts 1000 + 5*60); everything else is
// uncovered.
const COVERED_TS = 1000 + 5 * 60;
const baseOpts: DurationPriorOpts = {
	fits: FITS,
	minByMode: MIN_BY_MODE,
	tsAt: (i) => (i >= 0 && i < 10 ? 1000 + i * 60 : undefined),
	isTrainCovered: (ts) => ts === COVERED_TS,
};

function trainState(lineName: string | null): State {
	return { mode: "train", lineName, placeId: null } as unknown as State;
}
function modeState(mode: State["mode"]): State {
	return { mode, lineName: null, placeId: null } as unknown as State;
}

describe("buildDurationLogProb — one-stop-hop relaxation", () => {
	const duration = buildDurationLogProb(baseOpts);

	it("flattens a 1-minute train segment on a named line at a covered minute", () => {
		expect(duration(trainState("Victoria Line"), 1, 5)).toBe(0);
	});

	it("still floors a 1-minute train segment at an UNcovered minute", () => {
		expect(duration(trainState("Victoria Line"), 1, 4)).toBe(HARD_FLOOR_LOG_PROB);
	});

	it("does not relax a multi-minute train even when covered (≥ floor uses the Gamma)", () => {
		const d3 = duration(trainState("Victoria Line"), 3, 5);
		expect(d3).toBe(logDurationProb(3, "train", FITS.train, 2));
		expect(d3).not.toBe(0);
	});

	it("does not relax an unnamed / unknown_rail train (generator never vouches those)", () => {
		expect(duration(trainState(null), 1, 5)).toBe(HARD_FLOOR_LOG_PROB);
		expect(duration(trainState("unknown_rail"), 1, 5)).toBe(HARD_FLOOR_LOG_PROB);
	});

	it("leaves non-train modes on the floor (driving 1-min stays an artifact)", () => {
		expect(duration(modeState("driving"), 1, 5)).toBe(HARD_FLOOR_LOG_PROB);
		expect(duration(modeState("walking"), 1, 5)).toBe(HARD_FLOOR_LOG_PROB);
	});

	it("matches the plain Gamma prior for every non-relaxed case (parity)", () => {
		// A normal multi-minute train, well clear of the floor.
		expect(duration(trainState("Victoria Line"), 12, 5)).toBe(logDurationProb(12, "train", FITS.train, 2));
		// Stationary of any length is untouched.
		expect(duration(modeState("stationary"), 1, 5)).toBe(logDurationProb(1, "stationary", FITS.stationary, 2));
	});
});
