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
import type { DayState, VelocityData } from "../../services/health.service";
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

function setup(states: DayState[]) {
	const fixture = TestBed.createComponent(TimelineComponent);
	fixture.componentRef.setInput("data", { segments: [], states } as unknown as VelocityData);
	fixture.componentRef.setInput("referenceDate", null);
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
		const fixture = setup(commuteDay());
		const c = fixture.componentInstance;

		const journeys = c.rows().filter((r) => r.kind === "journey");
		expect(journeys.length).toBe(1);
		expect(c.journeyCount()).toBe(1);

		const j = journeys[0].kind === "journey" ? journeys[0].journey : null;
		expect(j).not.toBeNull();
		expect(j?.icons).toEqual(["directions_walk", "train", "directions_walk"]);
		expect(j?.legs.length).toBe(3);
		// 10 + 20 + 10 minutes of travel, pointed at the arrival visit.
		expect(j?.summaryLabel).toBe("→ University College Hospital · 40m");
	});

	it("keeps visits as their own rows and does not fold a lone leg", () => {
		const fixture = setup(commuteDay());
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
		const fixture = setup(commuteDay());
		const c = fixture.componentInstance;

		expect(fixture.nativeElement.textContent).not.toContain("Barn Rise");

		c.toggleJourney(0);
		fixture.detectChanges();
		const text = fixture.nativeElement.textContent ?? "";
		expect(text).toContain("Barn Rise");
		expect(text).toContain("Metropolitan Line");

		c.toggleJourney(0);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).not.toContain("Barn Rise");
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
		]);
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
		]);
		const c = fixture.componentInstance;
		const j = c.rows().find((r) => r.kind === "journey");
		expect(j?.kind === "journey" && j.journey.inferred).toBe(true);
	});
});
