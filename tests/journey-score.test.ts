import { describe, expect, it } from "vitest";
import type { GroundTruthMode, GroundTruthRow, ParsedTruth } from "../src/eval/ground-truth.js";
import {
	decoderJourneys,
	groundTruthJourneys,
	journeyShapeResults,
	scoreJourneys,
	statesToJourneys,
	statesToMinutes,
} from "../src/eval/journey-score.js";
import type { DecoderMinute } from "../src/eval/score-day.js";

/**
 * Journey-level scorer (`src/eval/journey-score.ts`) — the boundary-robust,
 * trip-structure cutover gate. These pin the two properties per-minute
 * scoring lacks: leg fidelity that survives edge slop, and trip-shape
 * regression detection — while keeping a genuinely wrong mode an honest miss.
 */

const T0 = 1_700_000_000;

function gtRow(
	startMin: number,
	endMin: number,
	mode: GroundTruthMode,
	line: string | null = null,
	status: GroundTruthRow["status"] = "correct",
	fromTo: { from: string; to: string } | null = null,
): GroundTruthRow {
	const truth: ParsedTruth = {
		mode,
		place: null,
		wayName: null,
		placeQualifier: null,
		trainFromTo: fromTo,
		lineName: line,
	};
	return {
		windowText: `${startMin}–${endMin}`,
		startTs: T0 + startMin * 60,
		endTs: T0 + endMin * 60,
		truthText: "(synthetic)",
		truth,
		status,
		provenance: "user",
		statusText: status,
		correctVersionText: null,
	};
}

/** Decoder minutes for [startMin, endMin) of one mode (+ optional line). */
function dec(
	startMin: number,
	endMin: number,
	mode: DecoderMinute["mode"],
	line: string | null = null,
): DecoderMinute[] {
	const out: DecoderMinute[] = [];
	for (let m = startMin; m < endMin; m++) out.push({ ts: T0 + m * 60, mode, placeId: null, lineName: line });
	return out;
}

describe("statesToMinutes + pipeline journey scoring", () => {
	/** A drawn "Your Day" timeline: contiguous start/end/mode windows. */
	const st = (startMin: number, endMin: number, mode: string) => ({
		startTs: T0 + startMin * 60,
		endTs: T0 + endMin * 60,
		mode,
	});

	it("expands a state window into one entry per top-of-minute", () => {
		// Real ground-truth windows are HH:MM → always minute-aligned; align the
		// synthetic base too so the top-of-minute stepping is exact.
		const base = Math.ceil(T0 / 60) * 60;
		const mins = statesToMinutes([{ startTs: base, endTs: base + 180, mode: "walking" }]);
		expect(mins.map((m) => m.ts)).toEqual([base, base + 60, base + 120]);
		expect(mins.every((m) => m.mode === "walking")).toBe(true);
	});

	// The whole point of the journey gate: score the PIPELINE (drawn timeline),
	// not just the HSMM decoder. A tube leg drawn as walking (the underground
	// mislabel) must fail journey reconstruction.
	const gtRows = [gtRow(0, 10, "walking"), gtRow(10, 30, "train", "Metropolitan Line"), gtRow(30, 40, "walking")];

	it("scores a faithfully-drawn journey as reconstructed", () => {
		const states = [
			st(-10, 0, "stationary"),
			st(0, 10, "walking"),
			st(10, 30, "train"),
			st(30, 40, "walking"),
			st(40, 100, "stationary"),
		];
		const score = scoreJourneys(gtRows, statesToMinutes(states));
		expect(score.journeyResults).toHaveLength(1);
		expect(score.journeyResults[0].matched).toBe(true);
		expect(score.journeyResults[0].expectedShape).toEqual(["walking", "train", "walking"]);
		expect(score.journeyResults[0].startTs).toBe(T0);
	});

	it("fails a journey whose tube leg is drawn as walking (the underground mislabel)", () => {
		const states = [st(-10, 0, "stationary"), st(0, 40, "walking"), st(40, 100, "stationary")]; // train drawn as walking → one walk leg
		const score = scoreJourneys(gtRows, statesToMinutes(states));
		expect(score.journeyResults[0].matched).toBe(false);
		expect(score.journeyResults[0].actualShape).toEqual(["walking"]);
	});
});

describe("groundTruthJourneys", () => {
	it("groups consecutive movement rows into one journey, split by a stay", () => {
		const rows = [
			gtRow(0, 10, "walking"),
			gtRow(10, 30, "train", "Jubilee Line"),
			gtRow(30, 40, "walking"),
			gtRow(40, 100, "stationary"), // a stay — breaks the journey
			gtRow(100, 110, "walking"),
			gtRow(110, 130, "bus", "38"),
		];
		const journeys = groundTruthJourneys(rows);
		expect(journeys).toHaveLength(2);
		expect(journeys[0].legs.map((l) => l.mode)).toEqual(["walking", "train", "walking"]);
		expect(journeys[1].legs.map((l) => l.mode)).toEqual(["walking", "bus"]);
	});

	// A `partial` movement row names the right MODE — it must EXTEND a journey,
	// not shatter it (the 2026-05-22 walk→train→train→walk case).
	it("keeps a partial movement row in the journey (does not flush)", () => {
		const rows = [
			gtRow(0, 14, "walking"),
			gtRow(14, 24, "train", "Metropolitan Line", "partial"),
			gtRow(24, 33, "train", "Jubilee Line"),
			gtRow(33, 49, "walking"),
			gtRow(50, 130, "stationary"),
		];
		const journeys = groundTruthJourneys(rows);
		expect(journeys).toHaveLength(1);
		expect(journeys[0].legs.map((l) => l.mode)).toEqual(["walking", "train", "train", "walking"]);
	});

	it("does NOT seed a journey from partial rows alone (needs a definite anchor)", () => {
		const rows = [
			gtRow(0, 10, "stationary"),
			gtRow(10, 12, "driving", null, "partial"),
			gtRow(12, 15, "train", "Metropolitan Line", "partial"),
			gtRow(15, 20, "stationary", null, "unclear"),
		];
		expect(groundTruthJourneys(rows)).toHaveLength(0);
	});

	// One physical ride can span two audit rows when the pipeline lies about
	// the boundary: a correct head row + a wrong tail row (the 2026-07-14
	// ride-tail stranding). Same mode + line + station pair, contiguous →
	// ONE leg, or the metric double-counts the ride and its station pair.
	it("merges contiguous rows of the same ride (mode+line+pair) into one leg", () => {
		const pair = { from: "Wembley Park", to: "Euston Square" };
		const head = gtRow(0, 13, "train", "Metropolitan Line", "correct", pair);
		const tail = gtRow(13, 18, "train", "Metropolitan Line", "wrong", pair);
		const rows = [gtRow(-10, 0, "walking"), head, tail, gtRow(18, 25, "walking"), gtRow(25, 100, "stationary")];
		const journeys = groundTruthJourneys(rows);
		expect(journeys).toHaveLength(1);
		expect(journeys[0].legs.map((l) => l.mode)).toEqual(["walking", "train", "walking"]);
		const train = journeys[0].legs[1];
		expect(train.startTs).toBe(T0 + 0 * 60);
		expect(train.endTs).toBe(T0 + 18 * 60);
		expect(train.board).toBe("Wembley Park");
		expect(train.alight).toBe("Euston Square");
	});

	// Two DIFFERENT consecutive rides never merge — differing line or pair
	// keeps them distinct legs even when contiguous.
	it("does not merge contiguous train rows with different pairs", () => {
		const a = gtRow(0, 10, "train", "Metropolitan Line", "correct", { from: "Wembley Park", to: "Baker Street" });
		const b = gtRow(10, 15, "train", "Metropolitan Line", "correct", { from: "Baker Street", to: "Euston Square" });
		const journeys = groundTruthJourneys([a, b]);
		expect(journeys).toHaveLength(1);
		expect(journeys[0].legs).toHaveLength(2);
	});

	// Minute-quantised audit tables can leave a 1-min seam inside one ride
	// (the 2026-07-15 evening rows 19:40–19:42 / 19:43–19:53). A ≤60 s gap
	// between same-pair rows still merges — no real ride cycles that fast.
	it("merges same-ride rows across a one-minute quantisation gap", () => {
		const pair = { from: "King's Cross St Pancras", to: "Wembley Park" };
		const a = gtRow(0, 8, "train", "Metropolitan Line", "wrong", pair);
		const b = gtRow(9, 19, "train", "Metropolitan Line", "correct", pair);
		const journeys = groundTruthJourneys([a, b]);
		expect(journeys).toHaveLength(1);
		expect(journeys[0].legs).toHaveLength(1);
		expect(journeys[0].legs[0].endTs).toBe(T0 + 19 * 60);
	});

	it("a wrong row is a true leg the pipeline misses — it seeds and shapes the journey", () => {
		// The cell is the truth even on a `wrong` row (the status only says the
		// pipeline deviates), so the metric must keep DEMANDING the leg.
		const rows = [
			gtRow(0, 10, "walking"),
			gtRow(10, 20, "train", "Victoria Line", "wrong"), // decoded as unknown today
			gtRow(20, 25, "walking", null, "wrong"),
			gtRow(25, 120, "stationary"),
		];
		const journeys = groundTruthJourneys(rows);
		expect(journeys).toHaveLength(1);
		expect(journeys[0].legs.map((l) => l.mode)).toEqual(["walking", "train", "walking"]);
	});

	it("does not concatenate trips across an unaudited multi-hour gap between rows", () => {
		// Sparse audit table: no stay row between a midday trip and an
		// afternoon one — the builder must not demand them as one journey.
		const rows = [gtRow(0, 15, "walking"), gtRow(16, 30, "driving"), gtRow(180, 226, "driving", null, "wrong")];
		const journeys = groundTruthJourneys(rows);
		expect(journeys).toHaveLength(2);
		expect(journeys[0].legs.map((l) => l.mode)).toEqual(["walking", "driving"]);
		expect(journeys[1].legs.map((l) => l.mode)).toEqual(["driving"]);
	});

	it("an unclear row breaks the journey (no continuity claim)", () => {
		const rows = [gtRow(0, 10, "walking"), gtRow(10, 20, "walking", null, "unclear"), gtRow(20, 30, "walking")];
		expect(groundTruthJourneys(rows)).toHaveLength(2);
	});
});

describe("statesToJourneys + journeyShapeResults (pipeline gate, minute-free)", () => {
	const st = (startTs: number, endTs: number, mode: string) => ({ startTs, endTs, mode });

	it("preserves a sub-minute leg that minute-quantisation would drop (the 06-22 bug)", () => {
		// A zero-duration train between two walks: the pipeline drew the right
		// shape; statesToMinutes dropped the instant train → [walking].
		const base = Math.ceil(T0 / 60) * 60;
		const states = [
			st(base, base + 540, "walking"),
			st(base + 540, base + 540, "train"), // zero-duration station change
			st(base + 540, base + 1020, "walking"),
		];
		const journeys = statesToJourneys(states);
		expect(journeys).toHaveLength(1);
		expect(journeys[0].legs.map((l) => l.mode)).toEqual(["walking", "train", "walking"]);
	});

	it("matches a GT journey to the pipeline journey of the same shape", () => {
		const gt = groundTruthJourneys([
			gtRow(0, 10, "walking"),
			gtRow(10, 30, "train", "Metropolitan Line"),
			gtRow(30, 40, "walking"),
			gtRow(41, 130, "stationary"),
		]);
		const pipe = statesToJourneys([
			st(T0, T0 + 600, "walking"),
			st(T0 + 600, T0 + 1800, "train"),
			st(T0 + 1800, T0 + 2400, "walking"),
		]);
		const res = journeyShapeResults(gt, pipe);
		expect(res).toHaveLength(1);
		expect(res[0].matched).toBe(true);
		expect(res[0].expectedShape).toEqual(["walking", "train", "walking"]);
	});

	it("fails a GT journey whose tube leg the pipeline drew as one long walk", () => {
		const gt = groundTruthJourneys([
			gtRow(0, 10, "walking"),
			gtRow(10, 30, "train", "Metropolitan Line"),
			gtRow(30, 40, "walking"),
			gtRow(41, 130, "stationary"),
		]);
		const pipe = statesToJourneys([st(T0, T0 + 2400, "walking")]);
		const res = journeyShapeResults(gt, pipe);
		expect(res[0].matched).toBe(false);
		expect(res[0].actualShape).toEqual(["walking"]);
	});
});

describe("decoderJourneys", () => {
	it("collapses per-minute runs into legs and drops non-movement", () => {
		const minutes = [...dec(0, 5, "walking"), ...dec(5, 15, "train", "Jubilee Line"), ...dec(15, 20, "stationary")];
		const journeys = decoderJourneys(minutes);
		expect(journeys).toHaveLength(1);
		expect(journeys[0].legs.map((l) => l.mode)).toEqual(["walking", "train"]);
	});
});

describe("scoreJourneys — leg fidelity (boundary robust)", () => {
	it("credits a leg whose decoder mode is offset by a few minutes", () => {
		// GT train 10:00–10:10; decoder train shifted to 10:02–10:12.
		const rows = [gtRow(0, 10, "train", "Victoria Line")];
		const decoder = dec(2, 12, "train", "Victoria Line");
		const score = scoreJourneys(rows, decoder);
		// 8 of 10 GT minutes are train (10:02–10:10) — dominant → leg matches,
		// where per-minute would only score 8/10.
		expect(score.legModeMatching).toBe(1);
		expect(score.legModeScorable).toBe(1);
		expect(score.legLineMatching).toBe(1);
	});

	it("keeps a genuinely wrong mode an honest miss (no fudge)", () => {
		// GT train 10:00–10:10; decoder mostly walking (the real failure mode).
		const rows = [gtRow(0, 10, "train", "Victoria Line")];
		const decoder = [...dec(0, 7, "walking"), ...dec(7, 10, "train", "Victoria Line")];
		const score = scoreJourneys(rows, decoder);
		expect(score.legModeMatching).toBe(0); // walking dominates → miss
		expect(score.legLineMatching).toBe(0); // line can't be credited on a missed mode
	});

	it("scores a transit line mismatch as a line miss but mode match", () => {
		const rows = [gtRow(0, 10, "train", "Victoria Line")];
		const decoder = dec(0, 10, "train", "Circle Line");
		const score = scoreJourneys(rows, decoder);
		expect(score.legModeMatching).toBe(1);
		expect(score.legLineScorable).toBe(1);
		expect(score.legLineMatching).toBe(0);
	});

	it("scores bus distinct from driving (the 06-12 case)", () => {
		const rows = [gtRow(0, 10, "bus", "38")];
		expect(scoreJourneys(rows, dec(0, 10, "bus", "38")).legModeMatching).toBe(1);
		expect(scoreJourneys(rows, dec(0, 10, "driving")).legModeMatching).toBe(0);
		expect(scoreJourneys(rows, dec(0, 10, "walking")).legModeMatching).toBe(0);
	});
});

describe("scoreJourneys — trip structure", () => {
	const rows = [gtRow(0, 5, "walking"), gtRow(5, 20, "train", "Jubilee Line"), gtRow(20, 25, "walking")];

	it("matches a journey reconstructed with the same mode sequence", () => {
		const decoder = [...dec(0, 5, "walking"), ...dec(5, 20, "train", "Jubilee Line"), ...dec(20, 25, "walking")];
		const score = scoreJourneys(rows, decoder);
		expect(score.journeysExpected).toBe(1);
		expect(score.journeysModeSequenceMatched).toBe(1);
	});

	it("fails the structure gate when the decoder drops a leg", () => {
		// Decoder omits the exit walk → shape [walk, train] ≠ [walk, train, walk].
		const decoder = [...dec(0, 5, "walking"), ...dec(5, 25, "train", "Jubilee Line")];
		const score = scoreJourneys(rows, decoder);
		expect(score.journeysModeSequenceMatched).toBe(0);
	});

	it("fails the structure gate when the decoder invents a leg", () => {
		// Decoder splits the train with a phantom driving leg in the middle.
		const decoder = [
			...dec(0, 5, "walking"),
			...dec(5, 12, "train", "Jubilee Line"),
			...dec(12, 14, "driving"),
			...dec(14, 20, "train", "Jubilee Line"),
			...dec(20, 25, "walking"),
		];
		const score = scoreJourneys(rows, decoder);
		expect(score.journeysModeSequenceMatched).toBe(0);
	});

	it("smooths a same-vehicle interchange (Met→change→Jubilee) into one train", () => {
		// GT says one `train`; decoder splits it with an interchange walk.
		// Per the 2026-06-13 decision, that interchange smooths away → match.
		const decoder = [
			...dec(0, 5, "walking"),
			...dec(5, 12, "train", "Metropolitan Line"),
			...dec(12, 14, "walking"), // interchange at Carfax
			...dec(14, 20, "train", "Jubilee Line"),
			...dec(20, 25, "walking"),
		];
		const score = scoreJourneys(rows, decoder);
		expect(score.journeysModeSequenceMatched).toBe(1);
	});

	it("keeps a real multi-modal transfer (tube→bus) as distinct legs", () => {
		// A walk between DIFFERENT vehicles is a genuine transfer, not an
		// interchange — it must not smooth. GT here is a single train, so a
		// train→walk→bus decoder correctly does NOT match.
		const decoder = [
			...dec(0, 5, "walking"),
			...dec(5, 12, "train", "Jubilee Line"),
			...dec(12, 14, "walking"),
			...dec(14, 20, "bus", "38"),
			...dec(20, 25, "walking"),
		];
		const score = scoreJourneys(rows, decoder);
		expect(score.journeysModeSequenceMatched).toBe(0);
	});
});

describe("journeyShapeResults — coverage gate", () => {
	const st = (startMin: number, endMin: number, mode: string) => ({
		startTs: T0 + startMin * 60,
		endTs: T0 + endMin * 60,
		mode,
	});

	it("a same-shape fragment covering a third of the journey is NOT a match (the 06-16 return)", () => {
		// GT: walk + train + (4-min interchange gap) + train + walk over ~76
		// min (shape dedupes to [walking, train, walking]). Pipeline: the ride
		// fragments at a 6-min station stay; the first fragment has the
		// identical shape but ends two-thirds early.
		const gt = groundTruthJourneys([
			gtRow(0, 14, "walking"),
			gtRow(14, 23, "train", "Victoria Line"),
			gtRow(27, 51, "train", "Metropolitan Line", "wrong"),
			gtRow(51, 76, "walking"),
		]);
		const pipeline = statesToJourneys([
			st(3, 13, "walking"),
			st(13, 24, "train"),
			st(24, 26, "walking"),
			// 6-min stay 26–32 splits the pipeline journeys
			st(32, 42, "walking"),
			st(44, 48, "train"),
			st(49, 74, "walking"),
		]);
		const res = journeyShapeResults(gt, pipeline);
		expect(res).toHaveLength(1);
		expect(res[0].matched).toBe(false);
	});

	it("ignores pipeline legs entirely outside the audited journey window", () => {
		// GT audits walk+train ending at min 21; the pipeline continues with a
		// short walk at min 22 (unaudited time — possibly true, unverifiable).
		const gt = groundTruthJourneys([gtRow(0, 11, "walking"), gtRow(11, 21, "train", "Metropolitan Line")]);
		const pipeline = statesToJourneys([st(0, 10, "walking"), st(11, 21, "train"), st(22, 27, "walking")]);
		expect(journeyShapeResults(gt, pipeline)[0].matched).toBe(true);
	});

	it("a full-coverage same-shape journey IS a match despite minor boundary slop", () => {
		const gt = groundTruthJourneys([
			gtRow(0, 14, "walking"),
			gtRow(14, 33, "train", "Metropolitan Line"),
			gtRow(33, 46, "walking"),
		]);
		const pipeline = statesToJourneys([st(1, 15, "walking"), st(15, 32, "train"), st(32, 45, "walking")]);
		expect(journeyShapeResults(gt, pipeline)[0].matched).toBe(true);
	});
});
