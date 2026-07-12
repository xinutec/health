import { describe, expect, it } from "vitest";
import {
	fixSpreadM,
	judgeVenueCase,
	normalizeVenueName,
	reportVenues,
	type VenueCase,
	venueNameMatches,
} from "../src/eval/venue-referee.js";
import type { NearbyLandmark } from "../src/geo/osm.js";
import type { VenueCandidateScore } from "../src/geo/venue-prior.js";

const cand = (
	name: string,
	total: number,
	opts: { nearField?: boolean; distanceM?: number; subtype?: string } = {},
): VenueCandidateScore => ({
	landmark: {
		name,
		type: "amenity",
		subtype: opts.subtype ?? "cafe",
		distanceM: opts.distanceM ?? 20,
	} satisfies NearbyLandmark,
	total,
	parts: { distance: total, venue: 0, shape: null, hours: null },
	nearField: opts.nearField ?? false,
});

/** A stay the venue scorer decided: the timeline shows its winner. */
const caseOf = (truthPlace: string, ranked: VenueCandidateScore[], accepted = true): VenueCase => ({
	date: "2026-07-12",
	window: "12:00–13:20",
	durationSec: 4800,
	truthPlace,
	finalPlace: accepted && ranked[0] ? ranked[0].landmark.name : null,
	layer: accepted && ranked[0] ? "scorer" : "other",
	ranked,
	accepted,
	fixSpreadM: 30,
	medianAccM: 6,
});

describe("venueNameMatches — the narrative names a venue, OSM carries the signage", () => {
	it("matches an exact name", () => {
		expect(venueNameMatches("Urban Social", "Urban Social")).toBe(true);
	});
	it("matches the human name against the fuller OSM name", () => {
		expect(venueNameMatches("Urban Social", "Urban Social Coffee")).toBe(true);
		expect(venueNameMatches("Pret", "Pret A Manger")).toBe(true);
	});
	it("ignores a leading article and punctuation", () => {
		expect(venueNameMatches("The Library", "Library")).toBe(true);
		expect(venueNameMatches("Benita's Bakery", "Benita s Bakery")).toBe(true);
	});
	it("does not match different venues that share a word", () => {
		expect(venueNameMatches("Urban Social", "Urban Outfitters")).toBe(false);
		expect(venueNameMatches("Green Shop", "Green Shop Islington")).toBe(true); // word-aligned prefix
		expect(venueNameMatches("Library", "Librarium")).toBe(false); // not word-aligned
	});
	it("normalizes case, punctuation and the article", () => {
		expect(normalizeVenueName("The Library!")).toBe("library");
	});
});

describe("judgeVenueCase — adjudicate one stay against its narrative", () => {
	it("scores the right venue as correct", () => {
		const r = judgeVenueCase(caseOf("Urban Social", [cand("Urban Social Coffee", 1.2), cand("The Library", 0.8)]));
		expect(r.verdict).toBe("correct");
		expect(r.chosen).toBe("Urban Social Coffee");
	});

	it("scores a neighbouring venue as wrong, and reports where the truth ranked", () => {
		const r = judgeVenueCase(caseOf("Urban Social", [cand("The Library", 1.5), cand("Urban Social Coffee", 0.9)]));
		expect(r.verdict).toBe("wrong");
		expect(r.truthRank).toBe(1);
		expect(r.truthGapNats).toBeCloseTo(0.6);
		expect(r.blockedByNearField).toBe(false); // the score genuinely preferred the pub
	});

	it("flags the V1 case: the truth OUTSCORED the winner and lost to the short-circuit", () => {
		// The pub's wall is 3.6 m away (near-field); the cafe's pin is 16 m
		// away and scores higher — but never gets to win.
		const r = judgeVenueCase(
			caseOf("Urban Social", [
				cand("The Library", -0.4, { nearField: true, distanceM: 3.6, subtype: "pub" }),
				cand("Urban Social Coffee", 0.9, { distanceM: 16 }),
			]),
		);
		expect(r.verdict).toBe("wrong");
		expect(r.wonByNearField).toBe(true);
		expect(r.truthGapNats).toBeCloseTo(-1.3); // the winner scores LOWER than the truth
		expect(r.blockedByNearField).toBe(true);
	});

	it("does not call it blocked when the near-field winner also outscores the truth", () => {
		const r = judgeVenueCase(
			caseOf("Urban Social", [
				cand("The Library", 2.0, { nearField: true, distanceM: 3.6 }),
				cand("Urban Social Coffee", 0.9),
			]),
		);
		expect(r.wonByNearField).toBe(true);
		expect(r.blockedByNearField).toBe(false); // V1 would not save this one
	});

	it("separates a non-answer from a wrong answer", () => {
		const r = judgeVenueCase(caseOf("Urban Social", [cand("The Library", -3)], false));
		expect(r.verdict).toBe("declined");
		expect(r.chosen).toBeNull();
	});

	it("reports a truth that is not a candidate at all — unreachable by ranking", () => {
		const r = judgeVenueCase(caseOf("Urban Social", [cand("The Library", 1.5), cand("KFC", 0.2)]));
		expect(r.verdict).toBe("wrong");
		expect(r.truthRank).toBeNull();
		expect(r.truthGapNats).toBeNull();
	});

	// The real Urban Social case (2026-06-28): a mined focus place named the
	// stay and the venue scorer was never consulted. No change to rankVenues
	// can reach this — the referee has to be able to SAY that.
	it("reports a stay the venue scorer never ran on", () => {
		const r = judgeVenueCase({
			...caseOf("Urban Social", []),
			finalPlace: "The Library",
			layer: "focus-place",
			accepted: false,
		});
		expect(r.verdict).toBe("wrong");
		expect(r.chosen).toBe("The Library");
		expect(r.case.ranked).toHaveLength(0);
		expect(r.wonByNearField).toBe(false);
		expect(r.truthRank).toBeNull();
	});

	// The scorer got it RIGHT and a focus place overrode it with the wrong
	// name. Judging the scorer's opinion would score this correct; judging the
	// timeline — what the user sees — scores it wrong. The timeline wins.
	it("judges the label the timeline shows, not the scorer's opinion", () => {
		const r = judgeVenueCase({
			...caseOf("Urban Social", [cand("Urban Social Coffee", 1.2, { nearField: true })]),
			finalPlace: "The Library",
			layer: "focus-place",
		});
		expect(r.verdict).toBe("wrong");
		expect(r.chosen).toBe("The Library");
		expect(r.wonByNearField).toBe(false); // the scorer's winner did not survive
	});
});

describe("reportVenues — the corpus number every later phase moves", () => {
	it("aggregates verdicts, near-field decisions and unreachable truths", () => {
		const rep = reportVenues([
			caseOf("Urban Social", [cand("Urban Social Coffee", 1.2)]),
			caseOf("Urban Social", [cand("The Library", -0.4, { nearField: true }), cand("Urban Social Coffee", 0.9)]),
			caseOf("Starbucks", [cand("Truedan", 1.0), cand("KFC", 0.1)]), // truth absent
			caseOf("Pret", [cand("Pret A Manger", -3)], false), // declined
			// The scorer never ran: a focus place named it.
			{ ...caseOf("Urban Social", []), finalPlace: "The Library", layer: "focus-place", accepted: false },
		]);
		expect(rep.total).toBe(5);
		expect(rep.correct).toBe(1);
		expect(rep.wrong).toBe(3);
		expect(rep.declined).toBe(1);
		expect(rep.byLayer.scorer).toEqual({ total: 3, correct: 1 });
		expect(rep.byLayer["focus-place"]).toEqual({ total: 1, correct: 0 });
		expect(rep.scorerNeverRan).toBe(1);
		expect(rep.nearFieldDecided).toBe(1);
		expect(rep.nearFieldWrong).toBe(1);
		expect(rep.blockedByNearField).toBe(1);
		// Starbucks only. The declined Pret WAS a candidate; the focus-place
		// case has no candidate set at all, so "truth not a candidate" would be
		// a lie — it is counted as scorerNeverRan instead.
		expect(rep.truthMissing).toBe(1);
	});
});

describe("fixSpreadM — how smeared is this sit", () => {
	it("is a few metres for a tight cluster and tens for a smeared indoor sit", () => {
		const tight = [
			{ lat: 51.5, lon: -0.1 },
			{ lat: 51.50002, lon: -0.10002 },
			{ lat: 51.50001, lon: -0.10001 },
		];
		expect(fixSpreadM(tight) as number).toBeLessThan(5);

		const smeared = [
			{ lat: 51.5, lon: -0.1 },
			{ lat: 51.5003, lon: -0.1 },
			{ lat: 51.4997, lon: -0.1 },
		];
		expect(fixSpreadM(smeared) as number).toBeGreaterThan(20);
	});
	it("is null when there is nothing to measure", () => {
		expect(fixSpreadM([{ lat: 51.5, lon: -0.1 }])).toBeNull();
	});
});
