import { describe, expect, it } from "vitest";
import type { GroundTruthRow } from "../../src/eval/ground-truth.js";
import type { DecoderMinute } from "../../src/eval/score-day.js";
import { scoreDay } from "../../src/eval/score-day.js";

/**
 * Scorer tests: given resolved ground-truth rows and per-minute
 * decoder output, validate that the score function reports correct
 * matching/scorable counts per category (mode/place/line) and
 * recognises `sleeping`↔`stationary` as equivalent modes.
 *
 * The scorer is pure — name-resolution and DB lookups live in the
 * CLI wrapper.
 */

const TS_START = 1_716_000_000;
const MIN = 60;

function gt(
	startMin: number,
	endMin: number,
	status: GroundTruthRow["status"],
	truth: GroundTruthRow["truth"],
): GroundTruthRow {
	return {
		windowText: `${startMin} – ${endMin}`,
		startTs: TS_START + startMin * MIN,
		endTs: TS_START + endMin * MIN,
		status,
		provenance: "unspecified",
		statusText: status,
		truthText: "",
		truth,
		correctVersionText: null,
	};
}

function dec(
	startMin: number,
	endMin: number,
	mode: DecoderMinute["mode"],
	placeId: number | null = null,
	lineName: string | null = null,
): DecoderMinute[] {
	const out: DecoderMinute[] = [];
	for (let m = startMin; m < endMin; m++) {
		out.push({ ts: TS_START + m * MIN, mode, placeId, lineName });
	}
	return out;
}

describe("scoreDay", () => {
	it("reports 100% mode match when decoder agrees on a correct stationary row", () => {
		const rows = [
			gt(0, 60, "correct", {
				mode: "stationary",
				place: "Home",
				wayName: null,
				placeQualifier: null,
				trainFromTo: null,
				lineName: null,
			}),
		];
		const decoder = dec(0, 60, "stationary", 42);
		const score = scoreDay(rows, decoder, new Map([["Home", 42]]));
		expect(score.scorableMinutes).toBe(60);
		expect(score.modeMatching).toBe(60);
		expect(score.placeScorable).toBe(60);
		expect(score.placeMatching).toBe(60);
	});

	it("treats ground-truth sleeping as equivalent to decoder stationary", () => {
		const rows = [
			gt(0, 60, "correct", {
				mode: "sleeping",
				place: "Home",
				wayName: null,
				placeQualifier: null,
				trainFromTo: null,
				lineName: null,
			}),
		];
		const decoder = dec(0, 60, "stationary", 42);
		const score = scoreDay(rows, decoder, new Map([["Home", 42]]));
		expect(score.modeMatching).toBe(60); // sleeping ↔ stationary
		expect(score.placeMatching).toBe(60);
	});

	it("skips minutes from rows with unclear or partial status (not scorable)", () => {
		const rows = [
			gt(0, 30, "correct", {
				mode: "stationary",
				place: "Home",
				wayName: null,
				placeQualifier: null,
				trainFromTo: null,
				lineName: null,
			}),
			gt(30, 60, "unclear", {
				mode: "walking",
				place: null,
				wayName: null,
				placeQualifier: null,
				trainFromTo: null,
				lineName: null,
			}),
		];
		const decoder = [...dec(0, 30, "stationary", 42), ...dec(30, 60, "walking")];
		const score = scoreDay(rows, decoder, new Map([["Home", 42]]));
		expect(score.scorableMinutes).toBe(30);
		expect(score.modeMatching).toBe(30);
	});

	it("counts mismatching minutes in scorable counts but not matching", () => {
		const rows = [
			gt(0, 60, "correct", {
				mode: "stationary",
				place: "Home",
				wayName: null,
				placeQualifier: null,
				trainFromTo: null,
				lineName: null,
			}),
		];
		// Decoder says walking — wrong mode.
		const decoder = dec(0, 60, "walking");
		const score = scoreDay(rows, decoder, new Map([["Home", 42]]));
		expect(score.scorableMinutes).toBe(60);
		expect(score.modeMatching).toBe(0);
		expect(score.placeScorable).toBe(0); // place only scored when expected mode is stationary AND decoder is stationary too
	});

	it("scores place attribution: matching id counts, different id is mismatch", () => {
		const rows = [
			gt(0, 60, "correct", {
				mode: "stationary",
				place: "Home",
				wayName: null,
				placeQualifier: null,
				trainFromTo: null,
				lineName: null,
			}),
		];
		// Decoder picks the wrong focus place (#99 instead of Home's #42).
		const decoder = dec(0, 60, "stationary", 99);
		const score = scoreDay(rows, decoder, new Map([["Home", 42]]));
		expect(score.modeMatching).toBe(60); // mode is right
		expect(score.placeScorable).toBe(60);
		expect(score.placeMatching).toBe(0); // place is wrong
	});

	it("reports unresolved place names so the user can fix the focus-places table", () => {
		const rows = [
			gt(0, 60, "correct", {
				mode: "stationary",
				place: "MysteryPlace",
				wayName: null,
				placeQualifier: null,
				trainFromTo: null,
				lineName: null,
			}),
		];
		const decoder = dec(0, 60, "stationary", 42);
		const score = scoreDay(rows, decoder, new Map()); // no resolution for MysteryPlace
		expect(score.scorableMinutes).toBe(60); // mode is still scorable
		expect(score.placeScorable).toBe(0); // unresolved → can't score place
		expect(score.unresolvedPlaceNames).toEqual(["MysteryPlace"]);
	});

	it("resolves places case-insensitively (lowercased map keys vs title-case GT)", () => {
		// The golden harness keys placeNameToId by displayName.toLowerCase();
		// ground-truth cells are written title-case ("Home"). An exact-case
		// lookup silently scored every place dimension 0/0 — this pins the
		// case-insensitive resolution that fixes it.
		const rows = [
			gt(0, 60, "correct", {
				mode: "stationary",
				place: "Home",
				wayName: null,
				placeQualifier: null,
				trainFromTo: null,
				lineName: null,
			}),
		];
		const decoder = dec(0, 60, "stationary", 42);
		const score = scoreDay(rows, decoder, new Map([["home", 42]])); // lowercased key
		expect(score.placeScorable).toBe(60);
		expect(score.placeMatching).toBe(60);
		expect(score.unresolvedPlaceNames).toEqual([]);
	});

	it("scores train line matching when both ground truth and decoder name a line", () => {
		const rows = [
			gt(0, 10, "correct", {
				mode: "train",
				place: null,
				wayName: null,
				placeQualifier: null,
				trainFromTo: { from: "A", to: "B" },
				lineName: "Metropolitan Line",
			}),
		];
		const decoder = dec(0, 10, "train", null, "Metropolitan Line");
		const score = scoreDay(rows, decoder, new Map());
		expect(score.lineScorable).toBe(10);
		expect(score.lineMatching).toBe(10);
	});

	it("reports per-row breakdown including correctness", () => {
		const rows = [
			gt(0, 60, "correct", {
				mode: "stationary",
				place: "Home",
				wayName: null,
				placeQualifier: null,
				trainFromTo: null,
				lineName: null,
			}),
		];
		const decoder = dec(0, 60, "stationary", 42);
		const score = scoreDay(rows, decoder, new Map([["Home", 42]]));
		expect(score.rowResults.length).toBe(1);
		const r = score.rowResults[0];
		expect(r.modeAgreementMinutes).toBe(60);
		expect(r.placeAgreement).toBe("match");
	});
});
