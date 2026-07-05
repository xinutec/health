import { describe, expect, it } from "vitest";
import type { GroundTruthRow, ParsedBlessed } from "../src/eval/ground-truth.js";
import { type DecoderMinute, scoreDay } from "../src/eval/score-day.js";

/**
 * Scorer coverage for road-vehicle modes — measurement-foundation phase of
 * `docs/proposals/decoder-roadmap.md`.
 *
 * `bus` is a `GroundTruthMode` (the user rides the 38) but was NOT a
 * `DecoderMode`, so a blessed `bus` row could never match any decoder
 * output — the flagship metric literally could not move. These tests pin
 * that `bus` is now scorable AND distinct from `driving` (calling a bus a
 * taxi is a real error, scored as a miss, not excused).
 */

const T0 = 1_700_000_000;

function blessed(over: Partial<ParsedBlessed>): ParsedBlessed {
	return {
		mode: "bus",
		place: null,
		wayName: null,
		placeQualifier: null,
		trainFromTo: null,
		lineName: null,
		...over,
	};
}

/** A `correct`, enforceable ground-truth row spanning [startMin, endMin) minutes. */
function row(startMin: number, endMin: number, b: ParsedBlessed): GroundTruthRow {
	return {
		windowText: `${startMin}–${endMin}`,
		startTs: T0 + startMin * 60,
		endTs: T0 + endMin * 60,
		blessedText: "(synthetic)",
		blessed: b,
		status: "correct",
		provenance: "user",
		statusText: "correct",
		correctVersionText: null,
	};
}

/** Per-minute decoder output of a single mode over [startMin, endMin). */
function minutes(startMin: number, endMin: number, mode: DecoderMinute["mode"]): DecoderMinute[] {
	const out: DecoderMinute[] = [];
	for (let m = startMin; m < endMin; m++) out.push({ ts: T0 + m * 60, mode, placeId: null, lineName: null });
	return out;
}

describe("scoreDay — road-vehicle modes", () => {
	it("scores a blessed bus row against a decoder that says bus (match)", () => {
		const rows = [row(0, 10, blessed({ mode: "bus" }))];
		const decoder = minutes(0, 10, "bus");
		const score = scoreDay(rows, decoder, new Map());
		expect(score.scorableMinutes).toBe(10);
		expect(score.modeMatching).toBe(10);
	});

	it("counts a bus mislabelled as driving as a mode miss (bus ≠ driving)", () => {
		const rows = [row(0, 10, blessed({ mode: "bus" }))];
		const decoder = minutes(0, 10, "driving");
		const score = scoreDay(rows, decoder, new Map());
		expect(score.scorableMinutes).toBe(10);
		expect(score.modeMatching).toBe(0);
	});

	it("counts a bus read as walking (the 06-12 failure) as a miss", () => {
		const rows = [row(0, 10, blessed({ mode: "bus" }))];
		const decoder = minutes(0, 10, "walking");
		const score = scoreDay(rows, decoder, new Map());
		expect(score.modeMatching).toBe(0);
	});
});
