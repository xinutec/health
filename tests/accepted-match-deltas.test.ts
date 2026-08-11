/**
 * The matcher delta manifest is the flip's premise: `LEAN_MATCH=on` is only
 * honest while every measured divergence is one we have inspected and signed
 * off. Both `compare-match --gate` and the production matcher ledger adjudicate
 * through `isAcceptedMatchDelta`, so these pin the decision rule they share.
 *
 * The load-bearing case is the LAST one in the first block. Until #395 wired the
 * measurement in, acceptance turned on `(leg, coarse, path, note)` alone — and
 * `note` is a vertex COUNT, so a leg could keep its counts, move a hundred
 * metres, and still be tagged `accepted`. That is not hypothetical: it is the
 * shape of leg 71e5544efa614a06 (#398), whose coarse note stayed `17v vs 17v`
 * while the line moved 120 m and production stopped drawing the match at all.
 */

import { describe, expect, it } from "vitest";
import {
	ACCEPTED_MATCH_DELTAS,
	type AcceptedMatchDelta,
	isAcceptedMatchDelta,
	matchDeltaTag,
} from "../src/lean/accepted-match-deltas.js";

/** Find one entry by fingerprint. Pinned by ID rather than by position or by a
 *  predicate over the array: reordering the manifest must not silently change
 *  which leg these tests are about. */
const byLeg = (leg: string): AcceptedMatchDelta => {
	const d = ACCEPTED_MATCH_DELTAS.find((x) => x.leg === leg);
	if (d === undefined) throw new Error(`manifest no longer holds leg ${leg}`);
	return d;
};

/** 2026-05-22 14:14 — a `magnitude` entry with a non-zero figure at BOTH layers
 *  (0.01 m each), so "smaller passes / larger fails" is testable in both
 *  directions on a real signature. */
const entry = byLeg("2742a9a5725284a7");

/** 2026-06-28 10:35 — the 17.52 m route-choice flip, signed off on the measured
 *  quality of one replayed corridor, so its figure is an EQUALITY. */
const flip = byLeg("91167e4cf16f9ea8");

/** Adjudicate a manifest entry at a chosen pair of measured deviations. */
const at = (d: AcceptedMatchDelta, coarse: number | null, path: number | null): boolean =>
	isAcceptedMatchDelta(d.leg, d.coarse, d.path, d.note, { coarse, path });

describe("accepted-match-delta adjudication", () => {
	it("accepts an entry measured at exactly its recorded deviation", () => {
		expect(at(entry, entry.coarseDevM, entry.pathDevM)).toBe(true);
	});

	it("accepts every entry in the manifest at its own recorded figures", () => {
		for (const d of ACCEPTED_MATCH_DELTAS) expect(at(d, d.coarseDevM, d.pathDevM)).toBe(true);
	});

	// A `magnitude` figure is a CEILING: the reason argues that a line this far
	// apart cannot reach the 18 m / 40 m thresholds downstream, and that argument
	// only gets stronger as the deviation shrinks. Demanding equality there would
	// make the manifest reject an improvement.
	it("accepts a SMALLER deviation than a magnitude entry was signed off at", () => {
		expect(entry.basis).toBe("magnitude");
		expect(at(entry, 0, 0)).toBe(true);
	});

	// A `corridor` figure is NOT a ceiling, and this is the asymmetry: the two
	// route flips are signed off on the measured quality of ONE replayed route
	// (building intrusion, stray p85, off-network distance). "Smaller than
	// 17.52 m" does not imply "the same corridor" — a quant arm that picked a
	// third route 9 m away would slip under a ceiling carrying a sign-off that
	// measured something else entirely.
	it("REJECTS a smaller deviation on a corridor entry — the figure is its identity", () => {
		expect(flip.basis).toBe("corridor");
		expect(at(flip, flip.coarseDevM, flip.pathDevM)).toBe(true);
		expect(at(flip, 9, flip.pathDevM)).toBe(false);
		expect(at(flip, 0, 0)).toBe(false);
	});

	// THE #398 SHAPE, and the reason this rule exists. Same leg, same classes,
	// same vertex counts — a line that moved 120 m.
	it("REJECTS the same leg and the same vertex counts once the line moves further", () => {
		expect(at(entry, 120, entry.pathDevM)).toBe(false);
	});

	it("enforces each layer separately — a clean coarse arm does not cover the display arm", () => {
		expect(at(entry, entry.coarseDevM, 120)).toBe(false);
		expect(at(entry, 120, entry.pathDevM)).toBe(false);
	});

	// A `null` deviation means one arm matched and the other did not, so there is
	// no distance between the two lines. You cannot bound what was never
	// measured, so it fails — which also means no null-flip can be waived here.
	it("rejects an unmeasurable (null) deviation rather than waiving it", () => {
		expect(at(entry, null, entry.pathDevM)).toBe(false);
		expect(at(entry, entry.coarseDevM, null)).toBe(false);
		expect(at(entry, null, null)).toBe(false);
	});

	// The manifest records what the gate PRINTS (two decimals), so the comparison
	// is made on the figure the sign-off was written against — not the raw double,
	// which would fail on a difference the reviewer could never have seen. The
	// cost is half a printed unit of slop on the measured side; pinned here in
	// both directions so its MAGNITUDE is a stated property, not a side effect.
	it("compares at the printed resolution, with half a unit of slop and no more", () => {
		expect(entry.coarseDevM).toBe(0.01);
		expect(at(entry, 0.0149, entry.pathDevM)).toBe(true);
		expect(at(entry, 0.0151, entry.pathDevM)).toBe(false);
	});

	it("still rejects an unknown leg, a changed class and a changed note", () => {
		const ok = { coarse: entry.coarseDevM, path: entry.pathDevM };
		expect(isAcceptedMatchDelta("0000000000000000", entry.coarse, entry.path, entry.note, ok)).toBe(false);
		expect(isAcceptedMatchDelta(entry.leg, "DIFF", entry.path, `${entry.note} `, ok)).toBe(false);
		expect(isAcceptedMatchDelta(entry.leg, entry.coarse, entry.path, "coarse 1v vs 1v, path 1v vs 1v", ok)).toBe(false);
	});

	it("labels each divergence the way both callers print it", () => {
		expect(matchDeltaTag(entry.leg, entry.coarse, entry.path, entry.note, { coarse: 0, path: 0 })).toBe("accepted");
		expect(matchDeltaTag(entry.leg, entry.coarse, entry.path, entry.note, { coarse: 120, path: 0 })).toBe(
			"UNEXPLAINED",
		);
	});
});

/**
 * Properties of the manifest itself. An entry that cannot be adjudicated — no
 * reason, a negative or absent measurement, a duplicate key — is worse than no
 * entry: it reads as a sign-off while bounding nothing, which is exactly the
 * state #395 found this file in.
 */
describe("accepted-match-delta manifest shape", () => {
	it("gives every entry a non-empty sign-off reason", () => {
		for (const d of ACCEPTED_MATCH_DELTAS) expect(d.reason.trim()).not.toBe("");
	});

	it("gives every entry a finite, non-negative measurement at both layers", () => {
		for (const d of ACCEPTED_MATCH_DELTAS) {
			expect(Number.isFinite(d.coarseDevM)).toBe(true);
			expect(Number.isFinite(d.pathDevM)).toBe(true);
			expect(d.coarseDevM).toBeGreaterThanOrEqual(0);
			expect(d.pathDevM).toBeGreaterThanOrEqual(0);
		}
	});

	// `printedM` rounds the MEASURED side to two decimals and compares it against
	// the RECORDED side raw, so the documented "compare at the resolution the gate
	// prints" only holds while every recorded figure is itself at that resolution.
	// A hand-typed 0.015 would quietly create a finer second threshold underneath
	// the one the header describes. All 22 are ≤2dp today; this keeps it that way.
	it("records every figure at the printed resolution the comparison assumes", () => {
		for (const d of ACCEPTED_MATCH_DELTAS) {
			expect(Number(d.coarseDevM.toFixed(2))).toBe(d.coarseDevM);
			expect(Number(d.pathDevM.toFixed(2))).toBe(d.pathDevM);
		}
	});

	// The manifest is keyed by leg fingerprint, so a duplicate would mean one of
	// the two entries silently adjudicates nothing — the failure mode that let 11
	// dead entries accumulate before #395.
	it("holds no duplicate leg fingerprints", () => {
		const legs = ACCEPTED_MATCH_DELTAS.map((d) => d.leg);
		expect(new Set(legs).size).toBe(legs.length);
	});

	// The review invariant that keeps `basis` honest, and the reason it is a test
	// rather than a comment: `basis` decides which enforcement rule an entry gets,
	// so an entry claiming the wrong one is a silently weaker gate. Everything at
	// or below a decimetre argues from size, so `magnitude`. Above it, an entry
	// must have been LOOKED AT and named here — which is the mechanism, and it
	// fired as designed on 2026-08-11.
	//
	// It used to assert that every entry above 0.1 m was a route-choice flip with
	// `basis: "corridor"`, on the evidence that the corpus's two big entries
	// (17.52 m and 14.37 m) were exactly that. c907b7bb2e0c96f9 falsified the
	// PROXY without touching the principle: it measures 0.14 m, and a
	// vertex-by-vertex inspection showed both arms bit-identical on every vertex
	// of both layers except the last, which sits 13.6 cm away. A single endpoint
	// is not a corridor, and `corridor`'s equality enforcement would have been
	// wrong for it — it would fail the gate if the leg IMPROVED to 0.13 m, which
	// is what the magnitude/ceiling split exists to avoid.
	//
	// So the bar is unchanged and the classification is now explicit per leg. A
	// NEW leg above 0.1 m still fails this test until someone puts it in one of
	// the two lists, which is the noticing this test is for. What is no longer
	// assumed is that size alone tells you which list it belongs in.
	const CORRIDOR_FLIPS = ["77277765451f43f5", "91167e4cf16f9ea8"];
	const INSPECTED_MAGNITUDE = ["c907b7bb2e0c96f9"];
	it("ties the enforcement basis to the kind of argument the entry actually makes", () => {
		const big = ACCEPTED_MATCH_DELTAS.filter((d) => Math.max(d.coarseDevM, d.pathDevM) > 0.1);
		expect(big.map((d) => d.leg).sort()).toEqual([...CORRIDOR_FLIPS, ...INSPECTED_MAGNITUDE].sort());
		for (const d of big) {
			if (CORRIDOR_FLIPS.includes(d.leg)) {
				expect(d.basis).toBe("corridor");
				expect(d.reason).toContain("MEASURED 2026-07-22");
			} else {
				// The exception earns its ceiling by having been inspected, so the
				// reason must carry the vertex-level evidence rather than a bound.
				expect(d.basis).toBe("magnitude");
				expect(d.reason).toContain("BIT-FOR-BIT");
			}
		}
		for (const d of ACCEPTED_MATCH_DELTAS) {
			if (Math.max(d.coarseDevM, d.pathDevM) <= 0.1) expect(d.basis).toBe("magnitude");
		}
	});
});

/** The two axes the LINE deviation cannot see (#401), and the reason they are
 *  enforced rather than merely recorded. `polylineDeviationM` is insensitive to
 *  where along a straight run a vertex sits, so a leg can hold a 0.01 m line
 *  bound while a vertex travels metres and its interpolated timestamp travels
 *  seconds — and that timestamp is not an intermediate: `episode-geometry`
 *  CLIPS the drawn path by it, and the map's tap-inspector renders it to the
 *  second. */
describe("accepted-match-delta vertex and timestamp axes (#401)", () => {
	/** 2026-04-29 17:44 — the corpus's largest along-line slide, 12.22 m at
	 *  0.01 m of line, signed off with an explicit `vtxM`. */
	const slide = byLeg("480b1b141d902740");
	/** 2026-04-30 15:16 — #401's own leg: 5.87 m of slide DECLARED, and a 27 s
	 *  timestamp shift deliberately NOT declared. */
	const shift = byLeg("cf8fa2efd60d5dc6");

	const atAll = (d: AcceptedMatchDelta, dev: [number, number], vtx: [number, number], dts: [number, number]): boolean =>
		isAcceptedMatchDelta(
			d.leg,
			d.coarse,
			d.path,
			d.note,
			{ coarse: dev[0], path: dev[1] },
			{ coarse: vtx[0], path: vtx[1] },
			{ coarse: dts[0], path: dts[1] },
		);

	it("accepts the declared slide at its recorded figure", () => {
		expect(atAll(slide, [0.0, 0.01], [0.0, 12.22], [0, 1])).toBe(true);
	});

	// The check that makes the field worth having: without it this leg passes on
	// its 0.01 m line bound no matter how far the vertex goes, which is the hole
	// #401 was filed about.
	it("REFUSES a slide beyond the recorded vtxM, on an unchanged line", () => {
		expect(atAll(slide, [0.0, 0.01], [0.0, 12.23], [0, 1])).toBe(false);
		expect(atAll(slide, [0.0, 0.01], [0.0, 50.0], [0, 1])).toBe(false);
	});

	// An entry that declares no vtxM is asserting the vertices stayed inside the
	// line deviation it DID record. That assertion is tested, not trusted.
	it("holds an undeclared entry to its own line deviation", () => {
		expect(atAll(entry, [0.01, 0.01], [0.01, 0.01], [0, 0])).toBe(true);
		expect(atAll(entry, [0.01, 0.01], [0.01, 5.0], [0, 0])).toBe(false);
	});

	// THE BUG THE FIRST VERSION OF THIS RULE HAD, pinned so it cannot come back.
	// An implicit bound of "no further than the line moved" failed six signed-off
	// legs: they are recorded at dev 0.00 and measure vtx 0.01, which is one step
	// of the two-decimal resolution both figures are printed at, not a slide. The
	// floor is read off the corpus gap (25 legs <= 0.14 m, then 0.79 / 5.87 /
	// 12.22), so it separates a last-decimal disagreement from a vertex that
	// travelled.
	it("does not fail a zero-deviation entry on one rounding step of separation", () => {
		const zero = byLeg("2d288f1de88f721d");
		expect(Math.max(zero.coarseDevM, zero.pathDevM)).toBe(0);
		expect(atAll(zero, [0.0, 0.0], [0.0, 0.01], [0, 0])).toBe(true);
		expect(atAll(zero, [0.0, 0.0], [0.0, 0.2], [0, 0])).toBe(true);
		// ...and still catches a real slide on the same entry.
		expect(atAll(zero, [0.0, 0.0], [0.0, 0.21], [0, 0])).toBe(false);
	});

	// One second is the floor of a timestamp both arms round to whole seconds,
	// so it is free; 27 s is not, and this pins that #401's leg stays RED until
	// someone signs that number specifically rather than inheriting a metre bound.
	it("accepts the 27 s shift it is signed off at, and REFUSES anything past it", () => {
		expect(shift.dtsS).toBe(27);
		expect(atAll(shift, [0.01, 0.01], [0.01, 5.87], [1, 27])).toBe(true);
		expect(atAll(shift, [0.01, 0.01], [0.01, 5.87], [1, 28])).toBe(false);
		// The sign-off is a CEILING on a consequence, not a claim that 27 s is
		// right, so a smaller shift passes and a larger one does not.
		expect(atAll(shift, [0.01, 0.01], [0.01, 5.87], [1, 1])).toBe(true);
	});

	// An entry that declares no dtsS inherits the 1 s floor and nothing more —
	// 27 s must not become the file-wide allowance because one leg carries it.
	it("does not let one signed-off shift loosen every other entry", () => {
		expect(entry.dtsS).toBeUndefined();
		expect(atAll(entry, [0.01, 0.01], [0.01, 0.01], [0, 1])).toBe(true);
		expect(atAll(entry, [0.01, 0.01], [0.01, 0.01], [0, 2])).toBe(false);
		expect(atAll(entry, [0.01, 0.01], [0.01, 0.01], [0, 27])).toBe(false);
	});

	// The measured corpus figures, so the gate's actual verdict on these two legs
	// is pinned here and not only in a run nobody re-reads.
	it("matches what compare-match measures on the corpus today", () => {
		expect(atAll(slide, [0.0, 0.01], [0.0, 12.22], [0, 1])).toBe(true);
		expect(atAll(shift, [0.01, 0.01], [0.01, 5.87], [1, 27])).toBe(true);
	});
});
