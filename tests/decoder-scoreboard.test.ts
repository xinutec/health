import { describe, expect, it } from "vitest";
import { countPhantomRides, scoreStations } from "../src/eval/decoder-scoreboard.js";
import type { GroundTruthMode, GroundTruthRow, ParsedTruth, Provenance } from "../src/eval/ground-truth.js";
import { groundTruthJourneys, type Journey } from "../src/eval/journey-score.js";

/**
 * C4.0 shadow scoreboard (`src/eval/decoder-scoreboard.ts`) — the two
 * journey-structure dimensions the existing scorers lack:
 *
 *   - station correctness: does the decoder emit the board/alight the
 *     narrative asserts? Today the decoder emits NO stations, so the
 *     honest baseline is "missing", distinct from "wrong" — C4.3's job
 *     is to move missing → matching.
 *   - phantom rides: decoder vehicle legs during windows the ground
 *     truth asserts as non-vehicle (a ride invented inside a confirmed
 *     stay must be counted, not amortised away).
 *
 * Stations here are fictional (privacy: tests never carry real journeys).
 */

const T0 = 1_700_000_000;
const ts = (min: number) => T0 + min * 60;

function gtRow(
	startMin: number,
	endMin: number,
	mode: GroundTruthMode,
	opts: {
		line?: string | null;
		fromTo?: { from: string; to: string } | null;
		status?: GroundTruthRow["status"];
		provenance?: Provenance;
	} = {},
): GroundTruthRow {
	const truth: ParsedTruth = {
		mode,
		place: null,
		wayName: null,
		placeQualifier: null,
		trainFromTo: opts.fromTo ?? null,
		lineName: opts.line ?? null,
	};
	const status = opts.status ?? "correct";
	return {
		windowText: `${startMin}–${endMin}`,
		startTs: ts(startMin),
		endTs: ts(endMin),
		truthText: "(synthetic)",
		truth,
		status,
		provenance: opts.provenance ?? "user",
		statusText: status,
		correctVersionText: null,
	};
}

/** A decoder-side journey literal. Legs default to stationless (what the
 *  decoder emits today). */
function decJourney(
	legs: { s: number; e: number; mode: string; line?: string; board?: string; alight?: string }[],
): Journey {
	return {
		startTs: ts(legs[0].s),
		endTs: ts(legs[legs.length - 1].e),
		legs: legs.map((l) => ({
			startTs: ts(l.s),
			endTs: ts(l.e),
			mode: l.mode,
			line: l.line ?? null,
			board: l.board ?? null,
			alight: l.alight ?? null,
		})),
	};
}

describe("groundTruthJourneys station carry", () => {
	it("carries the truth cell's board/alight onto the leg", () => {
		const rows = [
			gtRow(0, 5, "walking"),
			gtRow(5, 15, "train", { line: "Ashvale Line", fromTo: { from: "Ashvale", to: "Carfax" } }),
			gtRow(15, 20, "walking"),
		];
		const [j] = groundTruthJourneys(rows);
		expect(j.legs[1].board).toBe("Ashvale");
		expect(j.legs[1].alight).toBe("Carfax");
		expect(j.legs[0].board).toBeNull();
	});

	it("a partial row's stations are not asserted", () => {
		const rows = [
			gtRow(0, 5, "train", { fromTo: { from: "Deepwell", to: "Farvale" }, status: "partial" }),
			gtRow(5, 10, "train", { fromTo: { from: "Farvale", to: "Carfax" }, status: "wrong" }),
		];
		const [j] = groundTruthJourneys(rows);
		expect(j.legs[0].board).toBeNull();
		expect(j.legs[1].board).toBe("Farvale");
	});
});

describe("scoreStations", () => {
	const gt = (fromTo: { from: string; to: string } | null, status: GroundTruthRow["status"] = "correct") =>
		groundTruthJourneys([gtRow(0, 3, "walking"), gtRow(3, 13, "train", { fromTo, status }), gtRow(13, 16, "walking")]);

	it("decoder leg with no stations counts as missing, not wrong", () => {
		const s = scoreStations(gt({ from: "Ashvale", to: "Carfax" }), [decJourney([{ s: 3, e: 13, mode: "train" }])]);
		expect(s).toEqual({ stationsAsserted: 1, stationsMatching: 0, stationsMissing: 1 });
	});

	it("matching board+alight (case-insensitive) counts as matching", () => {
		const s = scoreStations(gt({ from: "Ashvale", to: "Carfax" }), [
			decJourney([{ s: 4, e: 12, mode: "train", board: "ashvale", alight: "Carfax" }]),
		]);
		expect(s).toEqual({ stationsAsserted: 1, stationsMatching: 1, stationsMissing: 0 });
	});

	it("a wrong alight is wrong (neither matching nor missing)", () => {
		const s = scoreStations(gt({ from: "Ashvale", to: "Carfax" }), [
			decJourney([{ s: 3, e: 13, mode: "train", board: "Ashvale", alight: "Deepwell" }]),
		]);
		expect(s).toEqual({ stationsAsserted: 1, stationsMatching: 0, stationsMissing: 0 });
	});

	it("no overlapping decoder leg of the same mode counts as missing", () => {
		const s = scoreStations(gt({ from: "Ashvale", to: "Carfax" }), [decJourney([{ s: 3, e: 13, mode: "walking" }])]);
		expect(s).toEqual({ stationsAsserted: 1, stationsMatching: 0, stationsMissing: 1 });
	});

	it("a leg without a station assertion contributes nothing", () => {
		const s = scoreStations(gt(null), [decJourney([{ s: 3, e: 13, mode: "train" }])]);
		expect(s).toEqual({ stationsAsserted: 0, stationsMatching: 0, stationsMissing: 0 });
	});

	it("a neighbouring ride's boundary sliver cannot convict: sub-majority overlap is missing", () => {
		// The truth's second ride (3–13) brushes the decoder's FIRST ride
		// (which ends at 4) by one boundary minute. That decoder leg
		// represents the previous ride, not this one — matching it here
		// would score its stations as "wrong" off pure boundary slop
		// (same rationale as countPhantomRides' majority rule).
		const s = scoreStations(gt({ from: "Ashvale", to: "Carfax" }), [
			decJourney([{ s: 0, e: 4, mode: "train", board: "Deepwell", alight: "Ashvale" }]),
		]);
		expect(s).toEqual({ stationsAsserted: 1, stationsMatching: 0, stationsMissing: 1 });
	});

	it("picks the best-overlapping decoder leg when the ride is fragmented", () => {
		// Fragmented decode: a 2-min head + the 7-min body. The body has the
		// right stations; the head must not shadow it.
		const s = scoreStations(gt({ from: "Ashvale", to: "Carfax" }), [
			decJourney([
				{ s: 3, e: 5, mode: "train", board: "Deepwell", alight: "Deepwell" },
				{ s: 6, e: 13, mode: "train", board: "Ashvale", alight: "Carfax" },
			]),
		]);
		expect(s).toEqual({ stationsAsserted: 1, stationsMatching: 1, stationsMissing: 0 });
	});
});

describe("countPhantomRides", () => {
	it("a decoder ride inside an enforceable stay is a phantom", () => {
		const rows = [gtRow(0, 60, "stationary")];
		const n = countPhantomRides(rows, [decJourney([{ s: 20, e: 45, mode: "train", line: "Ashvale Line" }])]);
		expect(n).toBe(1);
	});

	it("a decoder ride matching a truth ride is not a phantom", () => {
		const rows = [gtRow(0, 10, "walking"), gtRow(10, 20, "train"), gtRow(20, 30, "walking")];
		const n = countPhantomRides(rows, [decJourney([{ s: 10, e: 20, mode: "train" }])]);
		expect(n).toBe(0);
	});

	it("boundary slop does not create a phantom (majority rule)", () => {
		// Ride overruns the truth ride by 2 min into the following walk:
		// contradicted 2/12 minutes — not a phantom.
		const rows = [gtRow(0, 10, "walking"), gtRow(10, 20, "train"), gtRow(20, 30, "walking")];
		const n = countPhantomRides(rows, [decJourney([{ s: 10, e: 22, mode: "train" }])]);
		expect(n).toBe(0);
	});

	it("an inferred-provenance row cannot convict a phantom", () => {
		const rows = [gtRow(0, 60, "stationary", { provenance: "inferred" })];
		const n = countPhantomRides(rows, [decJourney([{ s: 20, e: 45, mode: "train" }])]);
		expect(n).toBe(0);
	});

	it("a ride over unaudited time is not a phantom", () => {
		const rows = [gtRow(0, 10, "stationary")];
		const n = countPhantomRides(rows, [decJourney([{ s: 30, e: 45, mode: "bus" }])]);
		expect(n).toBe(0);
	});

	it("a decoder ride contradicted by a confirmed walk is a phantom", () => {
		const rows = [gtRow(0, 30, "walking")];
		const n = countPhantomRides(rows, [decJourney([{ s: 5, e: 25, mode: "driving" }])]);
		expect(n).toBe(1);
	});

	it("walking legs are never phantoms (walks are not rides)", () => {
		const rows = [gtRow(0, 60, "stationary")];
		const n = countPhantomRides(rows, [decJourney([{ s: 20, e: 45, mode: "walking" }])]);
		expect(n).toBe(0);
	});

	it("counts each phantom ride leg once", () => {
		const rows = [gtRow(0, 120, "stationary")];
		const n = countPhantomRides(rows, [
			decJourney([{ s: 10, e: 20, mode: "train" }]),
			decJourney([{ s: 60, e: 80, mode: "bus" }]),
		]);
		expect(n).toBe(2);
	});
});
