/**
 * Tests for the DayState bottom layer.
 *
 * Per the three-altitude design (state / attribute / overlay):
 *
 *   - State: what the person is doing in one non-overlapping interval.
 *     Mode is mutually exclusive at any moment; "sleeping" is one mode.
 *   - Attribute: a qualifier on the current state (asleep=true on a
 *     train-mode state means sleeping-while-in-transit).
 *   - Overlay: spans that enclose many states (city, journey,
 *     day-part). Not in scope here — separate layer.
 *
 * The converter takes the EnrichedSegment[] from velocity.ts plus
 * sleep windows, and produces DayState[]. Rules:
 *
 *   - Sleep window fully inside a stationary-at-X segment, where X
 *     is the user's sleep-place: the stationary mode is rewritten
 *     to "sleeping" for the overlap; the segment splits at sleep
 *     boundaries.
 *   - Sleep window overlaps a moving segment: state keeps the
 *     motion mode; an `asleep: true` attribute is set on the
 *     overlapping portion.
 *   - Adjacent same-state runs merge.
 *   - Non-overlapping. One body, one state at a time.
 */

import { describe, expect, it } from "vitest";
import type { EnrichedSegment } from "../../src/geo/velocity.js";
import { type SleepWindow, segmentsToDayStates } from "../../src/sleep/day-state.js";

function stationary(startTs: number, endTs: number, place: string): EnrichedSegment {
	return {
		startTs,
		endTs,
		mode: "stationary",
		confidence: 1,
		confidenceMargin: Number.POSITIVE_INFINITY,
		avgSpeed: 0,
		maxSpeed: 0,
		linearity: 0,
		pointCount: 10,
		place,
	};
}

function walking(startTs: number, endTs: number): EnrichedSegment {
	return {
		startTs,
		endTs,
		mode: "walking",
		confidence: 0.8,
		confidenceMargin: 4,
		avgSpeed: 5,
		maxSpeed: 6,
		linearity: 0.6,
		pointCount: 5,
	};
}

function train(startTs: number, endTs: number, route: string): EnrichedSegment {
	return {
		startTs,
		endTs,
		mode: "train",
		refinedMode: "train",
		confidence: 0.9,
		confidenceMargin: Number.POSITIVE_INFINITY,
		avgSpeed: 70,
		maxSpeed: 100,
		linearity: 0.95,
		pointCount: 20,
		wayName: route,
	};
}

describe("segmentsToDayStates — base cases", () => {
	it("converts a single segment into one DayState", () => {
		const segs = [stationary(1000, 2000, "Home")];
		const states = segmentsToDayStates(segs, []);
		expect(states).toHaveLength(1);
		expect(states[0]).toMatchObject({
			startTs: 1000,
			endTs: 2000,
			mode: "stationary",
			place: "Home",
		});
	});

	it("preserves wayName on moving segments", () => {
		const segs = [train(1000, 2000, "Station W → Station K")];
		const states = segmentsToDayStates(segs, []);
		expect(states[0].mode).toBe("train");
		expect(states[0].wayName).toBe("Station W → Station K");
	});

	it("merges adjacent same-mode same-place segments", () => {
		const segs = [stationary(1000, 1500, "Home"), stationary(1500, 2000, "Home")];
		const states = segmentsToDayStates(segs, []);
		expect(states).toHaveLength(1);
		expect(states[0].startTs).toBe(1000);
		expect(states[0].endTs).toBe(2000);
	});

	it("does not merge adjacent same-mode different-place segments", () => {
		const segs = [stationary(1000, 1500, "Home"), stationary(1500, 2000, "Work")];
		const states = segmentsToDayStates(segs, []);
		expect(states).toHaveLength(2);
	});
});

describe("segmentsToDayStates — sleep-as-mode (sleep at home)", () => {
	const sleepAtHome: SleepWindow = {
		startTs: 100,
		endTs: 1500,
		place: "Home",
		minutesAsleep: 23,
		tz: "Europe/London",
	};

	it("rewrites a stationary-at-Home segment fully inside the sleep window to sleeping", () => {
		// Stationary @ Home from 0 to 2000; sleep is 100-1500. The
		// segment splits into pre-sleep (boring), sleeping (the
		// sleep window), and post-wake stationary.
		const segs = [stationary(0, 2000, "Home")];
		const states = segmentsToDayStates(segs, [sleepAtHome]);
		expect(states.map((s) => ({ start: s.startTs, end: s.endTs, mode: s.mode }))).toEqual([
			{ start: 0, end: 100, mode: "stationary" },
			{ start: 100, end: 1500, mode: "sleeping" },
			{ start: 1500, end: 2000, mode: "stationary" },
		]);
	});

	it("merges adjacent sleeping states from multiple short stationary segments", () => {
		// Two stationary-at-Home segments separated only by the sleep
		// window: after rewriting, they coalesce into one sleeping run
		// (assuming the rewrites are adjacent).
		const segs = [stationary(0, 500, "Home"), stationary(500, 1000, "Home"), stationary(1000, 2000, "Home")];
		const states = segmentsToDayStates(segs, [{ ...sleepAtHome, startTs: 0, endTs: 1500 }]);
		// All three originals merged: sleep window covers most; the
		// post-wake remainder is one stationary block.
		expect(states.map((s) => s.mode)).toEqual(["sleeping", "stationary"]);
		expect(states[0]).toMatchObject({ startTs: 0, endTs: 1500, mode: "sleeping", place: "Home" });
		expect(states[1]).toMatchObject({ startTs: 1500, endTs: 2000, mode: "stationary", place: "Home" });
	});

	it("does NOT rewrite a stationary segment at a different place", () => {
		// Sleep place is Home but the segment overlapping the sleep
		// window is at Work — the user fell asleep at the desk
		// briefly. Don't rewrite the Work segment to sleeping; the
		// sleep window applies to a different place.
		const segs = [stationary(0, 2000, "Work")];
		const states = segmentsToDayStates(segs, [sleepAtHome]);
		// Work stationary stays as stationary throughout — no rewrite.
		expect(states).toHaveLength(1);
		expect(states[0].mode).toBe("stationary");
		expect(states[0].place).toBe("Work");
	});
});

describe("segmentsToDayStates — sleep-as-attribute (sleep while moving)", () => {
	it("sets asleep=true on a train segment fully inside the sleep window", () => {
		// Sleeping on an overnight train. State keeps mode=train; the
		// attribute records the sleep.
		const segs = [train(1000, 2000, "Night Train")];
		const sleepOnTrain: SleepWindow = {
			startTs: 1000,
			endTs: 2000,
			place: null,
			minutesAsleep: 16,
			tz: "Europe/London",
		};
		const states = segmentsToDayStates(segs, [sleepOnTrain]);
		expect(states).toHaveLength(1);
		expect(states[0].mode).toBe("train");
		expect(states[0].asleep).toBe(true);
	});

	it("splits a moving segment that overlaps the sleep window partially", () => {
		// Train 1000-2000; sleep 1500-2500. The first half of the
		// train is awake, the second half is asleep.
		const segs = [train(1000, 2000, "Some Line")];
		const sleepLate: SleepWindow = {
			startTs: 1500,
			endTs: 2500,
			place: null,
			minutesAsleep: 16,
			tz: "Europe/London",
		};
		const states = segmentsToDayStates(segs, [sleepLate]);
		expect(states).toHaveLength(2);
		expect(states[0].startTs).toBe(1000);
		expect(states[0].endTs).toBe(1500);
		expect(states[0].mode).toBe("train");
		expect(states[0].asleep).toBeUndefined();
		expect(states[1].startTs).toBe(1500);
		expect(states[1].endTs).toBe(2000);
		expect(states[1].mode).toBe("train");
		expect(states[1].asleep).toBe(true);
	});
});

describe("segmentsToDayStates — non-overlapping invariant", () => {
	it("output states never overlap in time", () => {
		const segs = [stationary(0, 2000, "Home"), walking(2000, 2500), train(2500, 3500, "Line A")];
		const sleep: SleepWindow = {
			startTs: 100,
			endTs: 1500,
			place: "Home",
			minutesAsleep: 23,
			tz: "Europe/London",
		};
		const states = segmentsToDayStates(segs, [sleep]);
		for (let i = 1; i < states.length; i++) {
			expect(states[i].startTs).toBeGreaterThanOrEqual(states[i - 1].endTs);
		}
	});
});

describe("segmentsToDayStates — full sleep window beyond segment coverage", () => {
	const sleepAtHome = (startTs: number, endTs: number): SleepWindow => ({
		startTs,
		endTs,
		place: "Home",
		minutesAsleep: 480,
		tz: "Europe/London",
	});

	it("synthesizes sleeping state for the morning gap before the first segment", () => {
		// Morning sleep 00:06 → 08:51. First location fix is at 07:47
		// (also at Home). The full sleep window should appear as one
		// sleeping state, not just the slice after 07:47.
		const segs = [stationary(7 * 3600, 12 * 3600, "Home")];
		const sleep = sleepAtHome(0 * 3600 + 360, 8 * 3600 + 3060);
		const states = segmentsToDayStates(segs, [sleep]);
		expect(states.map((s) => ({ s: s.startTs, e: s.endTs, mode: s.mode, place: s.place }))).toEqual([
			{ s: 360, e: 8 * 3600 + 3060, mode: "sleeping", place: "Home" },
			{ s: 8 * 3600 + 3060, e: 12 * 3600, mode: "stationary", place: "Home" },
		]);
	});

	it("synthesizes sleeping state for the evening gap after the last segment", () => {
		// Evening sleep 23:43 today → 08:51 tomorrow. Last segment
		// ends at 23:30. The sleep state should cover 23:43 to 08:51
		// next day; the +1d marker is the frontend's responsibility.
		const segs = [stationary(20 * 3600, 23 * 3600 + 1800, "Home")];
		const sleep = sleepAtHome(23 * 3600 + 2580, 32 * 3600 + 3060);
		const states = segmentsToDayStates(segs, [sleep]);
		expect(states.map((s) => ({ s: s.startTs, e: s.endTs, mode: s.mode, place: s.place }))).toEqual([
			{ s: 20 * 3600, e: 23 * 3600 + 1800, mode: "stationary", place: "Home" },
			{ s: 23 * 3600 + 2580, e: 32 * 3600 + 3060, mode: "sleeping", place: "Home" },
		]);
	});

	it("propagates the sleep window tz onto a synthesized sleeping state", () => {
		const sleep = sleepAtHome(0, 1000);
		const states = segmentsToDayStates([], [sleep]);
		expect(states).toHaveLength(1);
		expect(states[0]).toMatchObject({ mode: "sleeping", place: "Home", tz: "Europe/London" });
	});

	it("propagates Fitbit minutesAsleep onto sleeping states (synthesized + rewritten)", () => {
		// Sleep window with 7h 18m of actual sleep across an 8h 45m bed
		// span. The window straddles the first GPS fix: pre-fix half
		// is synthesized from the window alone, post-fix half is a
		// stationary-at-Home segment rewritten to sleeping. Both halves
		// should carry the same minutesAsleep; merge folds them.
		const sleep: SleepWindow = {
			startTs: 0,
			endTs: 31_500,
			place: "Home",
			minutesAsleep: 438,
			tz: "Europe/London",
		};
		const segs = [stationary(20_000, 40_000, "Home")];
		const states = segmentsToDayStates(segs, [sleep]);
		const sleeping = states.find((s) => s.mode === "sleeping");
		expect(sleeping).toBeDefined();
		expect(sleeping?.minutesAsleep).toBe(438);
		// The synthesized + rewritten halves should have merged into one
		// continuous sleeping state spanning the full window.
		expect(sleeping?.startTs).toBe(0);
		expect(sleeping?.endTs).toBe(31_500);
	});

	it("does not synthesize sleeping for an in-transit (place=null) gap", () => {
		// Overnight train sleep with no location fixes after the
		// train segment ended: we have no idea where you slept the
		// remaining hours, so don't fabricate a place.
		const sleep: SleepWindow = {
			startTs: 1000,
			endTs: 3000,
			place: null,
			minutesAsleep: 33,
			tz: "Europe/London",
		};
		const segs = [train(1000, 2000, "Night Train")];
		const states = segmentsToDayStates(segs, [sleep]);
		// Only the train segment shows up (with asleep=true); the
		// 2000-3000 gap is dropped.
		expect(states).toHaveLength(1);
		expect(states[0]).toMatchObject({ startTs: 1000, endTs: 2000, mode: "train", asleep: true });
	});

	it("merges synthesized + rewritten sleeping halves even when segment.displayTz != sleep.tz", () => {
		// Sleep window covers a stretch where the first half has no
		// GPS coverage (synthesized state, tz from sleep.tz) and the
		// second half has a stationary-at-sleep-place segment
		// (rewritten state, tz from segment.displayTz). When the two
		// tz strings happen to differ but represent the same offset
		// (e.g. two equivalent IANA names for the same wall clock),
		// the old `sameState` failed strict-equality on tz and the
		// two halves stayed as separate rows in the timeline. Both
		// halves are the same sleep at the same place — they should
		// merge.
		const stationaryWithTz = (startTs: number, endTs: number, place: string, displayTz: string): EnrichedSegment => ({
			startTs,
			endTs,
			mode: "stationary",
			confidence: 1,
			confidenceMargin: Number.POSITIVE_INFINITY,
			avgSpeed: 0,
			maxSpeed: 0,
			linearity: 0,
			pointCount: 10,
			place,
			displayTz,
		});
		const sleep: SleepWindow = {
			startTs: 1000,
			endTs: 4000,
			place: "P",
			minutesAsleep: 45,
			tz: "Tz/A",
		};
		const segs = [stationaryWithTz(2000, 5000, "P", "Tz/B")];
		const states = segmentsToDayStates(segs, [sleep]);
		// One merged sleeping state spanning the full window, plus the
		// remaining stationary tail.
		const sleeping = states.filter((s) => s.mode === "sleeping");
		expect(sleeping).toHaveLength(1);
		expect(sleeping[0].startTs).toBe(1000);
		expect(sleeping[0].endTs).toBe(4000);
		expect(sleeping[0].minutesAsleep).toBe(45);
		expect(sleeping[0].place).toBe("P");
	});

	it("does not attach minutesAsleep to a sleeping state that covers only part of the sleep window", () => {
		// minutesAsleep is the aggregate for the whole sleep window.
		// If the timeline ends up splitting one window into multiple
		// rows (e.g. because the user moved between two stationary
		// places mid-window and the place tag breaks the merge),
		// none of the partial rows alone represents the whole
		// asleep total. Only attach minutesAsleep to a row whose
		// range matches the sleep window exactly.
		const sleep: SleepWindow = {
			startTs: 0,
			endTs: 21_600, // 6h window in seconds
			place: "P",
			minutesAsleep: 320,
			tz: "Tz/A",
		};
		// Positive case: stationary at the sleep place covers the
		// second half. After merge: one state 0..21_600. minutesAsleep
		// should be set.
		const segs = [stationary(8000, 21_600, "P")];
		// Negative case: a middle stationary at a DIFFERENT place
		// splits the run. Hotel P halves can't merge across the
		// Hotel Q stationary between them, so no sleeping row spans
		// the full window.
		const segsSplit = [stationary(8000, 16_000, "Q"), stationary(16_000, 21_600, "P")];
		const split = segmentsToDayStates(segsSplit, [sleep]);
		for (const s of split) {
			if (s.mode === "sleeping" && (s.startTs !== sleep.startTs || s.endTs !== sleep.endTs)) {
				expect(s.minutesAsleep).toBeUndefined();
			}
		}
		// Positive case still works.
		const merged = segmentsToDayStates(segs, [sleep]);
		const fullSleep = merged.find((s) => s.mode === "sleeping" && s.startTs === 0 && s.endTs === 21_600);
		expect(fullSleep?.minutesAsleep).toBe(320);
	});

	it("merges synthesized sleeping with a downstream stationary-at-home sleeping segment", () => {
		// Morning case where the sleep window starts before the first
		// fix at 07:47 and the first segment is stationary at Home
		// during the remaining sleep. The synthesized gap and the
		// rewritten segment should merge into one sleeping state.
		const segs = [stationary(7 * 3600 + 2820, 12 * 3600, "Home")];
		const sleep = sleepAtHome(0, 8 * 3600 + 3060);
		const states = segmentsToDayStates(segs, [sleep]);
		expect(states).toHaveLength(2);
		expect(states[0]).toMatchObject({ startTs: 0, endTs: 8 * 3600 + 3060, mode: "sleeping", place: "Home" });
		expect(states[1]).toMatchObject({ startTs: 8 * 3600 + 3060, endTs: 12 * 3600, mode: "stationary" });
	});
});
