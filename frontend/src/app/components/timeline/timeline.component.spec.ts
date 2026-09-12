/**
 * Journey-grouping contract for the "Your Day" timeline.
 *
 * A run of ≥2 consecutive moving states (walk/train/walk and the like)
 * between two visits collapses into ONE journey row by default, with the
 * individual legs revealed on expand. This is a display-only view-model
 * transform — the underlying DayState[] is never touched — so the tests
 * assert on the derived `rows()`, the expand controls, and the rendered
 * DOM.
 *
 *   - a multi-leg run between two visits becomes a single journey row
 *   - visits (stationary/sleeping) always stay their own rows
 *   - a lone single moving leg is NOT collapsed (nothing to hide)
 *   - the collapsed summary names the destination visit
 *   - a city change / a visit between legs breaks a run (no cross-visit
 *     journeys)
 *   - expand reveals exactly the legs; expand-all / collapse-all work
 *   - an inferred (no-data) leg flags the journey so it isn't hidden
 *     silently
 */

import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vitest";
import type { DayState, ServedJourney } from "../../services/health.service";
import { todayLocal } from "../../time-utils";
import { TimelineComponent } from "./timeline.component";

let cursor = 1_700_000_000; // arbitrary fixed epoch; tests are relative

function reset() {
	cursor = 1_700_000_000;
}

/** Append a state spanning `minutes`, advancing the shared cursor. */
function state(mode: DayState["mode"], minutes: number, extra: Partial<DayState> = {}): DayState {
	const startTs = cursor;
	const endTs = cursor + minutes * 60;
	cursor = endTs;
	return { startTs, endTs, mode, tz: "Europe/London", ...extra };
}

/** Build the fixture with the journeys the BACKEND would have served.
 *
 *  The grouping rule lives in `Verified.Geo.ServedJourneys` now, so a test here
 *  STATES which states form a journey rather than recomputing it — recomputing
 *  would put a third copy of the rule in the tree, which is the thing #339 is
 *  about. Spans are inclusive state indices. */
function setup(
	states: DayState[],
	journeySpans: [number, number][] = [],
	referenceDate: string | null = null,
) {
	const journeys: ServedJourney[] = journeySpans.map(([from, to]) => ({
		startTs: states[from].startTs,
		endTs: states[to].endTs,
		legs: states.slice(from, to + 1).map((s) => ({
			startTs: s.startTs,
			endTs: s.endTs,
			mode: s.mode,
		})),
	}));
	const fixture = TestBed.createComponent(TimelineComponent);
	fixture.componentRef.setInput("data", { segments: [], states, journeys });
	fixture.componentRef.setInput("referenceDate", referenceDate);
	fixture.detectChanges();
	return fixture;
}

/** A canonical commute day: Home → walk/train/walk → University College
 *  Hospital → lone walk → Work. */
function commuteDay(): DayState[] {
	reset();
	return [
		state("sleeping", 7 * 60, { place: "Home" }),
		state("stationary", 20, { place: "Home" }),
		state("walking", 10, { wayName: "Barn Rise" }),
		state("train", 20, { wayName: "Wembley Park → Euston Square · Metropolitan Line" }),
		state("walking", 10),
		state("stationary", 90, { place: "University College Hospital" }),
		state("walking", 5),
		state("stationary", 2 * 60, { place: "Work" }),
	];
}

describe("TimelineComponent journey grouping", () => {
	it("collapses a walk/train/walk run into one journey naming the destination", () => {
		const fixture = setup(commuteDay(), [[2, 4]]);
		const c = fixture.componentInstance;

		const journeys = c.rows().filter((r) => r.kind === "journey");
		expect(journeys.length).toBe(1);
		expect(c.journeyCount()).toBe(1);

		const j = journeys[0].kind === "journey" ? journeys[0].journey : null;
		expect(j).not.toBeNull();
		expect(j?.icons).toEqual(["directions_walk", "train", "directions_walk"]);
		expect(j?.legs.length).toBe(3);
		// Transports by mode (walk dropped), 10 + 20 + 10 minutes total.
		expect(j?.summaryLabel).toBe("Train · 40m");
	});

	it("lists distinct transports in order and collapses a same-mode interchange", () => {
		reset();
		// walk, train, train (interchange), bus, walk — one journey.
		const fixture = setup([
			state("stationary", 20, { place: "Home" }),
			state("walking", 5),
			state("train", 10, { wayName: "A → B · Victoria Line" }),
			state("train", 8, { wayName: "B → C · Northern Line" }),
			state("bus", 12, { wayName: "Route 24" }),
			state("walking", 4),
			state("stationary", 30, { place: "Work" }),
		], [[1, 5]]);
		const c = fixture.componentInstance;
		const j = c.rows().find((r) => r.kind === "journey");
		// Two trains collapse to one "Train"; bus kept; walks dropped.
		expect(j?.kind === "journey" && j.journey.summaryLabel).toBe("Train · Bus · 39m");
	});

	it("keeps visits as their own rows and does not fold a lone leg", () => {
		const fixture = setup(commuteDay(), [[2, 4]]);
		const c = fixture.componentInstance;

		const kinds = c.rows().map((r) => r.kind);
		// sleeping, Home, JOURNEY, UCH, lone walk (entry), Work
		expect(kinds).toEqual(["entry", "entry", "journey", "entry", "entry", "entry"]);

		// The single walk between UCH and Work stays a plain moving entry.
		const lone = c.rows()[4];
		expect(lone.kind).toBe("entry");
		if (lone.kind === "entry") expect(lone.entry.mode).toBe("walking");
	});

	it("defaults collapsed; toggle reveals exactly the legs", () => {
		const fixture = setup(commuteDay(), [[2, 4]]);
		const c = fixture.componentInstance;

		expect((fixture.nativeElement as HTMLElement).textContent).not.toContain("Barn Rise");

		c.toggleJourney(0);
		fixture.detectChanges();
		const text = (fixture.nativeElement as HTMLElement).textContent ?? "";
		expect(text).toContain("Barn Rise");
		expect(text).toContain("Metropolitan Line");

		c.toggleJourney(0);
		fixture.detectChanges();
		expect((fixture.nativeElement as HTMLElement).textContent).not.toContain("Barn Rise");
	});

	it("expandAll / collapseAll flip every journey", () => {
		reset();
		const fixture = setup([
			state("stationary", 30, { place: "Home" }),
			state("walking", 5),
			state("train", 15, { wayName: "A → B" }),
			state("stationary", 60, { place: "Work" }),
			state("walking", 5),
			state("bus", 15, { wayName: "Route 12" }),
			state("stationary", 30, { place: "Gym" }),
		], [[1, 2], [4, 5]]);
		const c = fixture.componentInstance;

		expect(c.journeyCount()).toBe(2);
		expect(c.anyExpanded()).toBe(false);

		c.expandAll();
		fixture.detectChanges();
		expect(c.isExpanded(0)).toBe(true);
		expect(c.isExpanded(1)).toBe(true);
		expect(c.anyExpanded()).toBe(true);

		c.collapseAll();
		fixture.detectChanges();
		expect(c.anyExpanded()).toBe(false);
	});

	it("does not fold two moving legs split by a visit", () => {
		reset();
		const fixture = setup([
			state("stationary", 30, { place: "Home" }),
			state("walking", 10),
			state("stationary", 20, { place: "Shop" }),
			state("walking", 10),
			state("stationary", 30, { place: "Work" }),
		]);
		const c = fixture.componentInstance;
		// Each walk is a lone leg on its own side of the Shop visit.
		expect(c.journeyCount()).toBe(0);
		expect(c.rows().every((r) => r.kind === "entry")).toBe(true);
	});

	it("flags a journey containing an inferred leg", () => {
		reset();
		const fixture = setup([
			state("stationary", 30, { place: "Home" }),
			state("walking", 10),
			state("train", 15, { wayName: "A → B", inferred: true }),
			state("stationary", 60, { place: "Work" }),
		], [[1, 2]]);
		const c = fixture.componentInstance;
		const j = c.rows().find((r) => r.kind === "journey");
		expect(j?.kind === "journey" && j.journey.inferred).toBe(true);
	});
});

/**
 * The day still being written says so (#1271).
 *
 * Every other day on this page is history. Today is an inference in progress —
 * measured 2026-08-30, a row served as `stationary place=null` at 12:20 came
 * back as `train` when the same day was recomputed an hour later — and nothing
 * on the card said the difference.
 *
 * ⚠ ONE NOTE, NOT A PER-ROW MARKER. `· no data (inferred)` already means
 * something narrower: THIS row was asserted rather than observed. A day-level
 * hedge on every row would be true of all of them and would drown the one that
 * distinguishes.
 */
describe("TimelineComponent day-in-progress note", () => {
	// ⚠ THE APP'S OWN `todayLocal`, not a second copy of it. A copy would agree
	// with the component for the same reason rather than as a check, and it would
	// inherit the runner's zone independently — two date derivations that can
	// disagree at midnight. What is under test is the COMPARISON; `todayLocal`
	// has its own tests in `time-utils.spec.ts`.

	it("says the day is still being recorded when it is today", () => {
		const fixture = setup(commuteDay(), [[2, 4]], todayLocal());
		expect(fixture.componentInstance.stillRecording()).toBe(true);
		const note = (fixture.nativeElement as HTMLElement).querySelector(".provisional");
		expect(note?.textContent).toContain("Still being recorded");
	});

	it("says nothing on a settled day", () => {
		const fixture = setup(commuteDay(), [[2, 4]], "2026-06-16");
		expect(fixture.componentInstance.stillRecording()).toBe(false);
		expect((fixture.nativeElement as HTMLElement).querySelector(".provisional")).toBeNull();
	});

	// ⚠ The date is computed in the BROWSER'S zone, not read off a state's `tz`.
	// The reader is looking at their own clock when they ask "is this today", and
	// a day recorded abroad is still their today or not by that clock.
	it("says nothing when no day is named at all", () => {
		const fixture = setup(commuteDay(), [[2, 4]], null);
		expect(fixture.componentInstance.stillRecording()).toBe(false);
	});

	// The note is about the DAY, so it must not add a row or disturb the
	// grouping the rest of this file pins.
	it("adds no row and changes no journey", () => {
		const today = setup(commuteDay(), [[2, 4]], todayLocal());
		const settled = setup(commuteDay(), [[2, 4]], "2026-06-16");
		expect(today.componentInstance.rows().length).toBe(settled.componentInstance.rows().length);
		expect(today.componentInstance.journeyCount()).toBe(settled.componentInstance.journeyCount());
	});
});

/**
 * A DEGRADED DAY STILL DRAWS (#1153).
 *
 * ⚠ THIS BLANKED THE WHOLE DASHBOARD IN PRODUCTION on 2026-09-12. The backend
 * derives a state's `tz` from a geo lookup and serialises a missing one as
 * `null`; `formatTime` guarded with `tz === undefined`, so `null` sailed through
 * to `Intl.DateTimeFormat({ timeZone: null })`, which THROWS. The throw happened
 * inside the `rows()` computed, so Angular rendered nothing at all — header, and
 * an empty page.
 *
 * ⚠ The server had degraded CORRECTLY and said so: "day served with unanswered
 * lookups ... reverseGeocode: 42", a 200 with usable states. Only the client
 * could not cope. The lesson is the asymmetry — the moment the UI most needs to
 * draw is the moment its inputs are thinnest.
 */
describe("TimelineComponent with a degraded day", () => {
	it("renders states whose tz the backend could not derive", () => {
		reset();
		const states: DayState[] = [
			state("stationary", 30, { place: "Home", tz: null as unknown as string }),
			state("walking", 15, { tz: null as unknown as string }),
			state("stationary", 45, { place: "Work", tz: null as unknown as string }),
		];
		const fixture = setup(states);
		// The bug was a THROW, so reaching an assertion at all is most of the test.
		expect(fixture.componentInstance.rows().length).toBe(3);
		const text = (fixture.nativeElement as HTMLElement).textContent ?? "";
		expect(text).toContain("Home");
		expect(text).toContain("Work");
	});

	// ⚠ A null tz must fall back to the same label an absent one gives, not to
	// some third behaviour — otherwise a degraded day would render times that
	// silently disagree with a complete one.
	it("labels a null tz exactly as an absent tz", () => {
		reset();
		const withNull = setup([state("stationary", 30, { place: "A", tz: null as unknown as string })]);
		reset();
		const withAbsent = setup([state("stationary", 30, { place: "A", tz: undefined })]);
		const label = (f: typeof withNull) => {
			const r = f.componentInstance.rows()[0];
			return r.kind === "entry" ? r.entry.startLabel : "";
		};
		expect(label(withNull)).toBe(label(withAbsent));
	});
});
