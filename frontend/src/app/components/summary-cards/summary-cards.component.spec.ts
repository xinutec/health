import { TestBed } from "@angular/core/testing";
import { describe, expect, it } from "vitest";
import { SummaryCardsComponent } from "./summary-cards.component";

const ALL_LABELS = ["Steps", "Resting HR", "Active Minutes", "Calories", "Sleep", "Sleep Efficiency"];

describe("SummaryCardsComponent", () => {
	it("renders every card even when both inputs are null", () => {
		const fixture = TestBed.createComponent(SummaryCardsComponent);
		fixture.detectChanges();

		const text = (fixture.nativeElement as HTMLElement).textContent ?? "";
		for (const label of ALL_LABELS) {
			expect(text).toContain(label);
		}
		// Every value slot should fall back to em dash
		expect((text.match(/—/g) ?? []).length).toBeGreaterThanOrEqual(6);
	});

	it("renders activity values when present, em dashes for missing sleep", () => {
		const fixture = TestBed.createComponent(SummaryCardsComponent);
		fixture.componentRef.setInput("latestActivity", {
			date: "2026-05-10",
			steps: 8500,
			calories_total: 2200,
			calories_active: 600,
			distance_km: 5,
			minutes_sedentary: 600,
			minutes_lightly_active: 100,
			minutes_fairly_active: 25,
			minutes_very_active: 35,
			resting_heart_rate: 58,
		});
		fixture.componentRef.setInput("latestSleep", null);
		fixture.detectChanges();

		const text = (fixture.nativeElement as HTMLElement).textContent ?? "";
		expect(text).toContain("8,500"); // steps
		expect(text).toContain("60"); // active minutes (25 + 35)
		expect(text).toContain("58"); // resting HR
		expect(text).toContain("2,200"); // calories
		// Sleep cards still rendered, with em dash values
		expect(text).toMatch(/Sleep[\s\S]*—/);
	});

	it("formats sleep duration as Xh Ym", () => {
		const fixture = TestBed.createComponent(SummaryCardsComponent);
		fixture.componentRef.setInput("latestActivity", null);
		fixture.componentRef.setInput("latestSleep", {
			log_id: "1",
			date: "2026-05-10",
			start_time: "",
			end_time: "",
			duration_ms: 489 * 60_000,
			efficiency: 92,
			minutes_asleep: 489, // 8h 9m
			minutes_awake: 10,
			minutes_deep: null,
			minutes_light: null,
			minutes_rem: null,
			minutes_wake: null,
			is_main_sleep: true,
		});
		fixture.detectChanges();

		const text = (fixture.nativeElement as HTMLElement).textContent ?? "";
		expect(text).toContain("8h 9m");
		expect(text).toContain("92");
	});

	it("shows em dash for resting HR when activity row exists but the field is null", () => {
		const fixture = TestBed.createComponent(SummaryCardsComponent);
		fixture.componentRef.setInput("latestActivity", {
			date: "2026-05-10",
			steps: 100,
			calories_total: 1000,
			calories_active: 100,
			distance_km: 1,
			minutes_sedentary: 100,
			minutes_lightly_active: 10,
			minutes_fairly_active: 0,
			minutes_very_active: 0,
			resting_heart_rate: null,
		});
		fixture.detectChanges();

		const text = (fixture.nativeElement as HTMLElement).textContent ?? "";
		// The Resting HR value should be em dash, not "null bpm"
		expect(text).toMatch(/Resting HR\s*—\s*bpm/);
	});
});
