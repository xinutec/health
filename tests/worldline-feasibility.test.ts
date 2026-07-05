/**
 * Worldline-feasibility invariants (`src/eval/worldline-feasibility.ts`).
 *
 * Phase 0 of `docs/proposals/decoder-roadmap.md`: a
 * model-independent assertion on the *output* timeline that catches
 * physically-impossible journeys the cascade can emit. These are facts a
 * real worldline cannot violate, checked regardless of how the timeline was
 * produced:
 *
 *   - a train cannot board where you are not — two train legs with no
 *     relocating travel between them must share a station
 *     (`alight(prev) == board(next)`);
 *   - a train cannot ride from a station to itself.
 *
 * This is the regression baseline / standing gate for the journey-worldline
 * migration; it would have caught the 2026-06-22 "one Met ride emitted as two
 * legs both alighting at the same station" bug.
 */

import { describe, expect, it } from "vitest";
import { checkWorldlineFeasibility, type FeasibilityLeg } from "../src/eval/worldline-feasibility.js";

/** Compact leg builder; ts values are arbitrary but contiguous. */
function leg(over: Partial<FeasibilityLeg> & { mode: string }): FeasibilityLeg {
	return { startTs: 0, endTs: 60, ...over };
}

function train(board: string, alight: string, line?: string, ts = 0): FeasibilityLeg {
	return { startTs: ts, endTs: ts + 600, mode: "train", wayName: `${board} → ${alight}${line ? ` · ${line}` : ""}` };
}

describe("checkWorldlineFeasibility", () => {
	it("passes a clean interchange — alight == next board", () => {
		const legs = [train("Ashvale", "Carfax", "Metropolitan Line", 0), train("Carfax", "Farvale", "Jubilee Line", 600)];
		expect(checkWorldlineFeasibility(legs)).toEqual([]);
	});

	it("flags the 2026-06-22 bug: adjacent train legs that do NOT share a station", () => {
		// One Met ride mis-cut into two legs both alighting at Deepwell,
		// the second spuriously boarding mid-route at Carfax.
		const legs = [
			train("Ashvale", "Deepwell", "Metropolitan Line", 0),
			train("Carfax", "Deepwell", "Circle, Hammersmith & City and Metropolitan Lines", 600),
		];
		const v = checkWorldlineFeasibility(legs);
		expect(v).toHaveLength(1);
		expect(v[0].kind).toBe("rail-discontinuity");
		expect(v[0].detail).toContain("Carfax");
		expect(v[0].detail).toContain("Deepwell");
	});

	it("allows a different boarding station when a walking leg relocates the user between trains", () => {
		const legs = [
			train("Ashvale", "Deepwell", "Metropolitan Line", 0),
			leg({ mode: "walking", wayName: "Deepwell Road", startTs: 600, endTs: 900 }),
			train("Elmford", "Finsbury Park", "Victoria Line", 900),
		];
		expect(checkWorldlineFeasibility(legs)).toEqual([]);
	});

	it("flags trains separated only by a stationary leg (a sit does not relocate you between stations)", () => {
		const legs = [
			train("Ashvale", "Deepwell", "Metropolitan Line", 0),
			leg({ mode: "stationary", startTs: 600, endTs: 780 }),
			train("Carfax", "Farvale", "Jubilee Line", 780),
		];
		const v = checkWorldlineFeasibility(legs);
		expect(v).toHaveLength(1);
		expect(v[0].kind).toBe("rail-discontinuity");
	});

	it("allows trains separated by a stationary leg when they DO share the station (platform wait)", () => {
		const legs = [
			train("Ashvale", "Carfax", "Metropolitan Line", 0),
			leg({ mode: "stationary", startTs: 600, endTs: 780 }),
			train("Carfax", "Farvale", "Jubilee Line", 780),
		];
		expect(checkWorldlineFeasibility(legs)).toEqual([]);
	});

	it("flags a degenerate train leg that boards and alights at the same station", () => {
		const legs = [train("Deepwell", "Deepwell", "Metropolitan Line", 0)];
		const v = checkWorldlineFeasibility(legs);
		expect(v).toHaveLength(1);
		expect(v[0].kind).toBe("degenerate-train-leg");
	});

	it("does not assert continuity through a bare-line train leg with no board/alight", () => {
		// A train leg labelled only by line (e.g. an underground hop) carries no
		// station pair to chain on — we cannot assert, so we must not fabricate a
		// violation.
		const legs = [
			train("Ashvale", "Deepwell", "Metropolitan Line", 0),
			leg({ mode: "train", wayName: "Hammersmith & City Line", startTs: 600, endTs: 660 }),
			train("Carfax", "Farvale", "Jubilee Line", 660),
		];
		expect(checkWorldlineFeasibility(legs)).toEqual([]);
	});

	it("returns no violations for a day with no train legs", () => {
		const legs = [leg({ mode: "stationary" }), leg({ mode: "walking", startTs: 60, endTs: 120 })];
		expect(checkWorldlineFeasibility(legs)).toEqual([]);
	});
});
