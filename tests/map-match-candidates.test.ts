/**
 * The per-fix candidate cut, and the tie order that decides it (#406).
 *
 * `candidatesForFix` sorts the in-radius projections and keeps the first
 * `maxCandidatesPerFix`. That cut is the matcher's only discontinuity: every
 * other step moves an answer continuously with its input, but the cut either
 * admits a segment or does not, so an arbitrarily small perturbation can change
 * WHICH corridor the Viterbi is allowed to consider. #398 measured the
 * consequence — the 1.1 cm quantisation between the float arm and its BigInt
 * twin moved one King's Cross leg 120 m.
 *
 * Ties are not a corner case here. Every way node shared by two segments
 * produces one: a fix abreast of the node projects onto the shared endpoint
 * from both sides, and both projections are computed from the same coordinates,
 * so the two distances are equal BIT FOR BIT rather than merely close. On
 * 2026-07-30 that was 16 of the 93 fixes whose candidate list the cut truncates.
 *
 * So the sort has to be a strict total order, and the same one in both arms.
 * These tests assert exactly that, using the diagnostic sinks the two arms
 * expose — not the drawn path, because a tie broken the other way often yields
 * the same LINE while carrying a different segment identity into routing, which
 * is precisely how the defect stayed invisible until it moved a leg.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { setCandidateSink } from "../src/geo/map-match-core.js";
import { qMatchWalkSegment, setQCandidateSink } from "../src/geo/match-twin.js";
import { matchWalkSegment } from "../src/geo/pedestrian-match.js";
import { quantPt } from "../src/geo/quant-twin.js";

/**
 * A street the walk follows, split into many short ways that meet end to end.
 *
 * The split is the point. Each shared node is a guaranteed exact tie — the fix
 * beside it projects to the node itself from the segment on either side, from
 * the same endpoint coordinates — and there are enough ways here to push the
 * in-radius count past `maxCandidatesPerFix: 6`, so the cut has to choose among
 * tied candidates rather than merely order them.
 */
const TIED_WAYS = (() => {
	const ways: Array<{ osmId: number; name: string; subtype: string; coords: Array<[number, number]> }> = [];
	// Ten collinear stubs along lat 51.5600, each one 10 m of longitude long.
	for (let i = 0; i < 10; i++) {
		const lon0 = -0.29 + i * 0.00014;
		ways.push({
			osmId: 100 + i,
			name: `Stub ${i}`,
			subtype: "footway",
			coords: [
				[51.56, lon0],
				[51.56, lon0 + 0.00014],
			],
		});
	}
	// A parallel pavement 4 m north, likewise split, so each fix sees candidates
	// from two lines at once and the list is comfortably longer than the cut.
	for (let i = 0; i < 10; i++) {
		const lon0 = -0.29 + i * 0.00014;
		ways.push({
			osmId: 200 + i,
			name: `Verge ${i}`,
			subtype: "footway",
			coords: [
				[51.560036, lon0],
				[51.560036, lon0 + 0.00014],
			],
		});
	}
	return ways;
})();

/** A walk straight down the middle, one fix every 10 s. */
const FIXES = Array.from({ length: 12 }, (_, i) => ({
	lat: 51.560018,
	lon: -0.29 + i * 0.00012,
	ts: 1_700_000_000 + i * 10,
}));

/** Both arms' emissions for one run: the sorted candidate list per fix. */
interface Capture {
	dist: number[];
	si: number[];
	/** How many of them the cut kept — the sinks report the list BEFORE the cut,
	 *  because the boundary gap is only visible in the candidates it rejected. */
	kept: number;
}

function runBothArms(): { float: Capture[]; quant: Capture[] } {
	const float: Capture[] = [];
	const quant: Capture[] = [];
	setCandidateSink((dist, si, kept) => float.push({ dist: [...dist], si: [...si], kept }));
	setQCandidateSink((dist, si, kept) => quant.push({ dist: dist.map(Number), si: [...si], kept }));
	try {
		matchWalkSegment(FIXES, { ways: TIED_WAYS, buildings: [] });
		qMatchWalkSegment(
			FIXES.map((p) => quantPt(p)),
			TIED_WAYS.map((w) => ({
				coords: w.coords.map(([lat, lon]) => quantPt({ lat, lon })),
				name: w.name,
			})),
			[],
		);
	} finally {
		setCandidateSink(null);
		setQCandidateSink(null);
	}
	return { float, quant };
}

describe("candidate cut", () => {
	let arms: { float: Capture[]; quant: Capture[] };

	beforeEach(() => {
		arms = runBothArms();
	});

	it("puts the fixture in the regime the cut actually decides", () => {
		// Guard against a vacuous suite: if this geometry stopped producing exact
		// ties, or stopped overflowing the cut, every assertion below would pass
		// while testing nothing. Both figures are the fixture's whole purpose.
		expect(arms.float.length).toBeGreaterThan(0);
		const tied = arms.float.filter((c) => c.dist.some((d, i) => i > 0 && d === c.dist[i - 1]));
		expect(tied.length).toBeGreaterThan(0);
		const overflowing = arms.float.filter((c) => c.si.length > 6);
		expect(overflowing.length).toBeGreaterThan(0);
	});

	it("orders equal distances by segment id, so the sort is a strict total order", () => {
		for (const c of arms.float) {
			for (let i = 1; i < c.dist.length; i++) {
				if (c.dist[i] !== c.dist[i - 1]) continue;
				expect(c.si[i]).toBeGreaterThan(c.si[i - 1]);
			}
		}
	});

	it("keeps the same candidates as the BigInt twin", () => {
		// SET, not order. The two arms compute the same distances to within the
		// quantisation, not exactly, so wherever two candidates are separated by
		// less than that they can rank either way — this fixture's two lines are
		// deliberately equidistant from the walk and do exactly that. Within the
		// kept set that is harmless: the Viterbi takes an argmax over candidates,
		// and which index a candidate sits at does not change which one wins.
		//
		// At the CUT it is not harmless, and that is what this asserts: the arms
		// must hand the decoder the same state space. Both graph builders emit
		// segments in the same order over the same deduplicated vertex grid, so
		// `si` names the same segment on both sides.
		expect(arms.quant.length).toBe(arms.float.length);
		for (let i = 0; i < arms.float.length; i++) {
			const f = [...arms.float[i].si.slice(0, arms.float[i].kept)].sort((a, b) => a - b);
			const q = [...arms.quant[i].si.slice(0, arms.quant[i].kept)].sort((a, b) => a - b);
			expect(q).toEqual(f);
		}
	});
});
